/**
 * assemble.js — turn an adapter's normalized event stream into the facts a
 * hand-over is built from.
 *
 * Adapters (agents/*.js) only translate native records into events. Every
 * semantic rule — turn grouping, the compaction cut, the unanswered last
 * prompt, the artifact trail — lives here, so all agents behave the same.
 */

import { isCorrection, isNudge } from './text.js';

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

// A command segment that runs tests, a build or a type/lint check.
const TEST_RUNNER = new RegExp(
  '^(?:[A-Z_][A-Z0-9_]*=\\S*\\s+)*(?:' +
    [
      '(?:npm|pnpm|yarn|bun)(?:\\s+run)?\\s+(?:test|build|lint|typecheck|check)\\b',
      '(?:npx\\s+|bunx\\s+)?(?:jest|vitest|mocha|tsc|eslint|playwright|ava)\\b',
      '(?:python3?\\s+-m\\s+|uv\\s+run\\s+|poetry\\s+run\\s+)?(?:pytest|tox|nox)\\b',
      'node\\s+--test\\b',
      'cargo\\s+(?:test|build|check|clippy|nextest)\\b',
      'go\\s+(?:test|build|vet)\\b',
      '(?:\\./)?gradlew?\\s|mvnw?\\s|dotnet\\s+(?:test|build)\\b',
      'flutter\\s+(?:test|analyze)\\b|dart\\s+test\\b',
      'make\\b|rspec\\b|phpunit\\b|swift\\s+(?:test|build)\\b|xcodebuild\\b',
    ].join('|') +
    ')',
);

/** True when a shell command (first line, any `&&`/`;` segment) runs tests or a build. */
function isTestCommand(command) {
  const firstLine = String(command).split('\n')[0];
  return firstLine.split(/&&|\|\||;/).some((segment) => TEST_RUNNER.test(segment.trim()));
}

/**
 * @param {SessionMeta} meta
 * @param {Event[]} events
 */
export function assemble(meta, events) {
  const evs = events.filter(Boolean);

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
  const lastPrompt = prompts.at(-1) ?? null;
  const lastTurn = turns.findLast((t) => t.prompt) ?? null;
  const substantive = lastPrompt && isNudge(lastPrompt.text) ? prompts.findLast((p) => !isNudge(p.text)) : null;

  // Queued prompts only matter if they came after the last prompt that ran.
  const lastPromptIndex = lastPrompt ? evs.indexOf(lastPrompt) : -1;
  const queued = evs.filter((e, i) => e.kind === 'prompt' && e.source === 'queued' && i > lastPromptIndex);
  const draft = evs.findLast((e) => e.kind === 'prompt' && e.source === 'draft') ?? null;

  // ── Artifact trail ──────────────────────────────────────────────────
  const tools = evs.filter((e) => e.kind === 'tool');
  const fileMap = new Map();
  tools.forEach((t, i) => {
    if (t.action !== 'edit' || !t.target) return;
    const f = fileMap.get(t.target) ?? { path: t.target, count: 0 };
    fileMap.set(t.target, { ...f, count: f.count + 1, order: i, ts: t.ts });
  });
  const files = [...fileMap.values()].sort((a, b) => b.order - a.order);
  const commands = tools.filter((t) => t.action === 'command' && t.target);
  const failures = tools.filter((t) => t.ok === false);
  const testCommand = commands.findLast((c) => isTestCommand(c.target)) ?? null;

  const plan = evs.findLast((e) => e.kind === 'plan') ?? null;
  const stopIndex = evs.findLastIndex((e) => e.kind === 'stop');
  const stop = stopIndex > lastPromptIndex ? evs[stopIndex] : null;

  return {
    meta,
    prompts,
    first: prompts[0] ?? null,
    latest: {
      prompt: lastPrompt,
      started: Boolean(lastTurn && lastTurn.prompt === lastPrompt && (lastTurn.replies.length || lastTurn.tools.length)),
      answered: Boolean(lastTurn && lastTurn.prompt === lastPrompt && lastTurn.replies.length),
      interrupted: Boolean(lastTurn && lastTurn.interrupted),
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
