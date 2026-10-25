/**
 * assemble.js — turn an adapter's normalized event stream into the facts a
 * hand-over is built from.
 *
 * Adapters (agents/*.js) only translate native records into events. Every
 * semantic rule — turn grouping, the compaction cut, the unanswered last
 * prompt, the artifact trail — lives here, so all agents behave the same.
 */

import { isCommand, isCorrection, isNudge } from './text.js';

/**
 * @typedef {object} Event  One step of a session, in chronological order.
 * @property {'prompt'|'reply'|'tool'|'compaction'|'plan'|'stop'|'interrupt'} kind
 * @property {number} [ts]  epoch milliseconds
 *
 * kind 'prompt'     {text, source?}  Genuine user words only: harness wrappers, injected
 *                    instruction files, slash-command plumbing and tool results removed.
 *                    source 'queued' = typed while the agent was busy and never sent;
 *                    source 'draft' = unsent text left in the input box.
 * kind 'reply'      {text, final?, partial?}  Visible assistant text (never thinking).
 *                    final = the agent marked it as the turn's answer; partial = cut off.
 * kind 'tool'       {tool, action, target?, ok?, exit?, error?}  action is 'edit' (any file
 *                    write, patch, create or delete), 'command' (shell), 'read', 'search' or
 *                    'other'. target = file path, or the command line for commands.
 *                    ok/exit/error come from the matching tool result when known.
 * kind 'compaction' {summary?, trigger?, encrypted?}  A context-compaction boundary; summary
 *                    only when the agent stored readable text.
 * kind 'plan'       {items: [{text, status}]}  Plan/todo snapshot, status one of
 *                    'done' | 'active' | 'pending' | 'blocked'. The latest one wins.
 * kind 'stop'       {reason, message?, resetsAt?}  Why the session stopped. reason is one of
 *                    'quota' | 'rate_limit' | 'overloaded' | 'error' | 'interrupted' | 'aborted'.
 * kind 'interrupt'  {}  The user cut the current turn short.
 */

/**
 * @typedef {object} SessionMeta
 * @property {string} agent            adapter name, e.g. 'claude-code'
 * @property {string} sessionId
 * @property {string} [title]
 * @property {string} [cwd]            working directory the agent recorded
 * @property {string} [logFile]        native log path, for digging into details
 * @property {number} [startedAt]      epoch ms
 * @property {number} lastActivity     epoch ms of the last user/assistant record (not file mtime)
 * @property {string} [model]
 * @property {string} [branch]         git branch recorded at session time
 * @property {string} [commit]         git commit recorded at session time
 * @property {string} [resumeCommand]  how to reopen this session natively
 */

// The hand-over tells the next agent to re-run the last test command, so only
// a single, side-effect-free test run qualifies: no chaining, pipes,
// redirects, watch modes, snapshot updates, deploys or publishes.
const SAFE_TEST = new RegExp(
  '^(?:' +
    [
      '(?:npm|pnpm|yarn|bun)(?:\\s+run)?\\s+test(?::[\\w-]+)?',
      '(?:npx\\s+|bunx\\s+|pnpm\\s+exec\\s+)?(?:vitest\\s+run|jest|mocha|playwright\\s+test|ava)',
      '(?:python3?\\s+-m\\s+|uv\\s+run\\s+|poetry\\s+run\\s+)?pytest',
      'node\\s+--test',
      'cargo\\s+(?:test|nextest\\s+run)',
      'go\\s+test',
      'dotnet\\s+test',
      '(?:flutter|dart|swift)\\s+test',
      'rspec|phpunit|tox',
    ].join('|') +
    ')(?:\\s[^\\n]*)?$',
);
const UNSAFE_SHELL = /&&|\|\||[;|`<>\n]|\$\(|--watch\b|--fix\b|--update|(?:^|\s)-u(?:\s|$)/;

/** True for a single, safe test-run command worth suggesting to re-run. */
function isTestCommand(command) {
  const s = String(command ?? '').trim();
  return s.length <= 200 && !UNSAFE_SHELL.test(s) && SAFE_TEST.test(s);
}

const KINDS = new Set(['prompt', 'reply', 'tool', 'compaction', 'plan', 'stop', 'interrupt']);

/** Coerce adapter output into well-formed events: string text, ms timestamps, no empty messages. */
function normalize(events) {
  const out = [];
  for (const e of events ?? []) {
    if (!e || typeof e !== 'object' || !KINDS.has(e.kind)) continue;
    let ts = Number(e.ts);
    if (!Number.isFinite(ts) || ts <= 0) ts = undefined;
    else if (ts < 1e11) ts *= 1000; // seconds, not milliseconds
    if (e.kind === 'prompt' || e.kind === 'reply') {
      const text = typeof e.text === 'string' ? e.text : e.text == null ? '' : String(e.text);
      if (!text.trim()) continue;
      out.push({ ...e, text, ts });
    } else if (e.kind === 'plan') {
      // An empty snapshot is kept: it means the agent cleared its list.
      const items = (Array.isArray(e.items) ? e.items : []).filter((i) => i && String(i.text ?? '').trim());
      out.push({ ...e, items: items.map((i) => ({ ...i, text: String(i.text) })), ts });
    } else {
      out.push({ ...e, ts });
    }
  }
  return out;
}

/**
 * @param {SessionMeta} meta
 * @param {Event[]} events
 */
export function assemble(meta, events) {
  const evs = normalize(events);

  let cut = -1;
  for (let i = evs.length - 1; i >= 0; i--) {
    if (evs[i].kind === 'compaction') {
      cut = i;
      break;
    }
  }

  // ── Turns: a genuine prompt plus everything until the next one ──────
  const turns = [];
  let turn = null;
  evs.forEach((e, i) => {
    if (e.kind === 'prompt' && !e.source) {
      turn = { start: i, end: i, prompt: e, replies: [], tools: [], interrupted: false };
      turns.push(turn);
      return;
    }
    if (e.kind !== 'reply' && e.kind !== 'tool' && e.kind !== 'interrupt') return;
    if (!turn) {
      turn = { start: i, end: i, prompt: null, replies: [], tools: [], interrupted: false };
      turns.push(turn);
    }
    turn.end = i;
    if (e.kind === 'reply') turn.replies.push(e);
    else if (e.kind === 'tool') turn.tools.push(e);
    else turn.interrupted = true;
  });

  const prompts = evs.filter((e) => e.kind === 'prompt' && !e.source);
  const turnOf = new Map(turns.filter((t) => t.prompt).map((t) => [t.prompt, t]));
  const worked = (t) => Boolean(t && (t.replies.length || t.tools.length));

  // The latest request: a slash command nobody answered ("/model sonnet" right
  // after a quota stop) is plumbing, not the request to continue.
  const latestPrompt = prompts.findLast((p) => !isCommand(p.text) || worked(turnOf.get(p))) ?? prompts.at(-1) ?? null;
  const latestTurn = latestPrompt ? turnOf.get(latestPrompt) : null;
  const latestIndex = latestTurn ? latestTurn.start : -1;
  const commandsAfter = prompts.filter((p) => turnOf.get(p).start > latestIndex);
  const substantive = latestPrompt && isNudge(latestPrompt.text) ? prompts.findLast((p) => !isNudge(p.text)) : null;

  // Queued prompts only matter if they came after the last prompt that ran.
  const lastPromptIndex = prompts.length ? turnOf.get(prompts.at(-1)).start : -1;
  const queued = evs.filter((e, i) => e.kind === 'prompt' && e.source === 'queued' && i > lastPromptIndex);
  const draft = evs.findLast((e) => e.kind === 'prompt' && e.source === 'draft') ?? null;

  // ── Artifact trail ──────────────────────────────────────────────────
  const tools = evs.filter((e) => e.kind === 'tool');
  const fileMap = new Map();
  tools.forEach((t, i) => {
    if (t.action !== 'edit' || !t.target || t.ok === false) return;
    const f = fileMap.get(t.target) ?? { path: t.target, count: 0 };
    fileMap.set(t.target, { ...f, count: f.count + 1, order: i, ts: t.ts });
  });
  const files = [...fileMap.values()].sort((a, b) => b.order - a.order);
  const commands = tools.filter((t) => t.action === 'command' && t.target);
  const failures = tools.filter((t) => t.ok === false);
  const testCommand = commands.findLast((c) => isTestCommand(c.target)) ?? null;

  // A stop only counts when the session never got going again afterwards.
  const plan = evs.findLast((e) => e.kind === 'plan') ?? null;
  const stopIndex = evs.findLastIndex((e) => e.kind === 'stop');
  const resumed = evs.some((e, i) => i > stopIndex && (e.kind === 'reply' || e.kind === 'tool'));
  const stop = stopIndex > latestIndex && !resumed ? evs[stopIndex] : null;

  return {
    meta,
    prompts,
    first: prompts[0] ?? null,
    latest: {
      prompt: latestPrompt,
      started: worked(latestTurn),
      answered: Boolean(latestTurn?.replies.length),
      interrupted: Boolean(latestTurn?.interrupted),
      commandsAfter,
      substantive,
      queued,
      draft,
    },
    turns,
    cut,
    compaction: cut >= 0 ? evs[cut] : null,
    files,
    commands,
    failures,
    testCommand,
    plan,
    stop,
    corrections: prompts.filter((p) => isCorrection(p.text)),
    events: evs,
  };
}

/** @typedef {ReturnType<typeof assemble>} Session */
