/**
 * Factory Droid adapter.
 *
 * Built from upstream source; not verified against local data (the droid CLI is not installed on
 * the machine this was written on and ~/.factory/sessions is empty). Droid is closed source, so the
 * format comes from docs.factory.ai and from maintained third-party readers, newest evidence first:
 *   Glubiz/zirv-cli ea83829 (2026-09-29) src/commands/ctx/adapters/droid.rs and
 *     tests/fixtures/droid/session.jsonl (7af9828): a transcript written by the real droid 0.213.0
 *     binary: sessions/<cwd slug>/<uuid>.jsonl, row envelopes, assistant modelId, context-<uuid> rows
 *   maddada/Ghostex 086df9d (2026-10-17) packages/find/src/scan/droid.rs: callingSessionId marks
 *     subagent runs, `visibility` marks rows nobody typed, injected-prompt prefixes
 *   ignaciojimenez/agent-sessions c06d09e (2026-10-09) docs/design.md (droid 0.231.0): line 1 is
 *     rewritten in place when a title is set, `droid --resume <id>`, `droid exec` leaves no marker
 *   mindfold-ai/Trellis cb3d039 research/platform-session-identity.md: droid has no session-id
 *     environment variable (FACTORY_SESSION_ID / DROID_SESSION_ID do not exist)
 *   TeichAI/teich 21e836c (2026-06-19) examples/example_droid_session.jsonl: a real interactive
 *     session: tool names and inputs, todo_state, visibility values, cancelled-tool rows
 *   yigitkonur/cli-continues cabedb9 (2026-04-28) src/parsers/droid.ts + src/types/schemas.ts:
 *     todo_state, compaction_state, the <id>.settings.json sidecar, ~/.factory/projects fallback
 *   theadriann/oxox 8dd57f6 toolContextLabel.ts: tool input keys (file_path, directory_path, input…)
 *   SeuPut0705/TokenCat c7cae37 DroidLog.swift: older builds wrote straight into sessions/, title rules
 *   docs.factory.ai cli-reference and hooks-reference: `droid "prompt"`, `droid --resume <id>`
 *
 * Sessions: ~/.factory/sessions/<launch dir with / and \ turned into '-'>/<uuid>.jsonl on every OS,
 * with a <uuid>.settings.json sidecar (model, token usage). JSONL, append-only except line 1:
 *   session_start     {id, title, sessionTitle?, cwd, isSessionTitleManuallySet, callingSessionId? …}
 *   message           {id, parentId, timestamp, message: {role, content, visibility?, modelId? …}}
 *                     content is Anthropic-style blocks (text, thinking, tool_use, tool_result) or a string
 *   todo_state        {timestamp, todos: {todos: '1. [in_progress] …\n2. [pending] …'}}
 *   compaction_state  {timestamp, summaryText, summaryTokens, summaryKind, anchorMessage, removedCount}
 * A message row with `visibility` (llm_only: injected context, user_only: notices, errors) or
 * `hookEventName` was never typed by a person. Subagents are their own sessions (callingSessionId)
 * and are skipped. The slug is only used to narrow the search; every match is confirmed against
 * the cwd recorded in session_start.
 *
 * Checked against the two real transcripts above (an interactive session and a 0.213.0 `droid exec`
 * run). Not derivable from the log: `current` (no session id in the environment), `background`
 * (an exec run leaves no marker), queued or draft prompts. The shape of an API-failure notice is
 * unknown, so stops are recognised from user_only rows by their wording.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { linesFromEnd, listDir, readFirstLine, readJson, readJsonl, statSafe, tryJson } from '../lib/fsx.js';

export const name = 'factory';
export const label = 'Factory Droid';

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const STORES = ['sessions', 'projects']; // the hooks docs name projects/, the 0.213.0 binary writes sessions/
const MAX_PROBES = 40;
const TAIL_LINES = 3000;
const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 256 * 1024;
const MAX_ERROR = 1500;

const EDIT_TOOLS = new Set(['Create', 'Edit', 'ApplyPatch']);
const READ_TOOLS = new Set(['Read', 'LS']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const PLAN_STATUS = {
  completed: 'done',
  complete: 'done',
  done: 'done',
  in_progress: 'active',
  'in-progress': 'active',
  active: 'active',
  pending: 'pending',
  todo: 'pending',
  blocked: 'blocked',
};

// Harness text that arrives inside user rows without a visibility flag.
const NOISE_TAGS =
  'system-reminder|system-notification|project_context|ide_opened_file|ide_selection|ide_diagnostics|local-command-(?:stdout|stderr|caveat)|command-message|bash-(?:stdout|stderr)|user-prompt-submit-hook';
const NOISE_PAIR = new RegExp(`<(${NOISE_TAGS})\\b[^>]*>[\\s\\S]*?</\\1>`, 'g');
const NOISE_START = new RegExp(`^\\s*<(?:${NOISE_TAGS})\\b`);
// Rows the pi bridge (pi-droid-sdk) sends when pi drives droid: pi's own prompts, not a person's.
const BRIDGE_PROMPT = /^(?:Droid pi bridge contract:|You are an expert coding assistant operating inside pi|You are a context summarization assistant)/;
// Left behind when a system-reminder carried the tool list (cli-continues stripDroidInjectedText).
const TOOL_LIST_DUMP = /^[ \t]*TodoWrite\b(?:\r?\n[ \t]*[A-Z][A-Za-z0-9]+\b)*[ \t]*\r?$/m;
const INTERRUPT = /^Request (?:interrupted|cancelled|canceled) by user\b/;
const CANCELLED = /^Error: Tool execution cancelled by user/;
const EXIT_CODE = /\[Process exited with code (-?\d+)\]\s*$/;
const PATCH_FILE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;
const TODO_LINE = /^\s*(?:\d+[.)]|[-*])\s*\[([A-Za-z_-]+)\]\s*(.+?)\s*$/;
// The startup context ends with `git status -b --porcelain | head -n1`, i.e. the branch at launch.
const GIT_BRANCH = /^% git status -b --porcelain[^\n]*\n## (?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.\S*)?(?: \[.*\])?\s*$/m;

const STOP_REASONS = [
  ['quota', /quota|usage limit|out of (?:credits|tokens)|insufficient (?:credits|funds|balance)|credit balance|billing/i],
  ['rate_limit', /rate.?limit|too many requests|\b429\b/i],
  ['overloaded', /overloaded|service unavailable|at capacity|\b(?:503|529)\b/i],
];

/** Droid's folder name for a launch directory: separators become '-', a drive letter becomes a segment. */
export function slug(p) {
  const posix = /^[A-Za-z]:/.test(p) ? `/${p[0]}${p.slice(2)}` : p;
  return posix.replace(/[\\/]/g, '-');
}

// Tolerates lossy renderings of '.', '_', spaces and accents; the recorded cwd has the final say.
const squash = (s) => s.replace(/[^a-zA-Z0-9-]/gu, '-');

/** Launch-directory folders of a store whose name could belong to one of the project's roots (or a subdirectory). */
function candidateDirs(store, project, ctx) {
  const fold = ctx.platform === 'darwin' || ctx.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const keys = new Set();
  for (const root of project.roots) {
    for (const form of ['NFC', 'NFD']) keys.add(fold(squash(slug(root.normalize(form)))));
  }
  return listDir(store)
    .filter((d) => d.isDirectory())
    .filter((d) => {
      const f = fold(squash(d.name));
      for (const k of keys) if (f === k || f.startsWith(`${k}-`)) return true;
      return false;
    })
    .map((d) => join(store, d.name));
}

/** A row a person or the agent produced, as opposed to injected context, notices and hook output. */
const isInjected = (r) =>
  Boolean(r.message?.visibility || r.message?.hookEventName || String(r.id).startsWith('context-'));
const isTurn = (r) => r?.type === 'message' && (r.message?.role === 'user' || r.message?.role === 'assistant') && !isInjected(r);

const cleanTitle = (t) => (typeof t === 'string' && t.trim() && t.trim().toLowerCase() !== 'new session' ? t.trim() : null);

/** A name the person chose or droid generated; before that `title` only holds the first prompt's opening. */
function titleOf(start) {
  if (start.isSessionTitleManuallySet === true) return cleanTitle(start.title);
  return cleanTitle(start.sessionTitle) ?? (typeof start.sessionTitleAutoStage === 'string' ? cleanTitle(start.title) : null);
}

/** First records of a file; the first prompt sits after a ~10 KB injected context row. */
function headRecords(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const lines = buf.toString('utf8', 0, n).split('\n');
    if (n === HEAD_BYTES) lines.pop(); // possibly cut mid-line
    return lines.map(tryJson).filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Read just enough of a session to rank it: header, last activity, title. Null for stubs and subagents. */
function probe(file) {
  const start = tryJson(readFirstLine(file, HEAD_BYTES) ?? '');
  if (start?.type !== 'session_start' || start.callingSessionId) return null;
  let lastActivity = null;
  let scanned = 0;
  for (const line of linesFromEnd(file, TAIL_BYTES)) {
    if (++scanned > TAIL_LINES) break;
    const r = tryJson(line);
    const ts = isTurn(r) && r.timestamp ? Date.parse(r.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      lastActivity = ts;
      break;
    }
  }
  if (lastActivity === null) return null;
  const title = titleOf(start);
  const preview = title ? null : headRecords(file).map(promptOf).find(Boolean);
  return { lastActivity, title, preview, cwd: typeof start.cwd === 'string' ? start.cwd : null };
}

/**
 * @param {import('../lib/project.js').Project} project
 * @param {import('./index.js').Context} ctx
 * @returns {Promise<import('./index.js').Candidate[]>}
 */
export async function findSessions(project, ctx) {
  const files = [];
  for (const store of STORES.map((s) => join(ctx.home, '.factory', s))) {
    // Older builds wrote straight into the store, newer ones into one folder per launch directory.
    for (const dir of [store, ...candidateDirs(store, project, ctx)]) {
      for (const entry of listDir(dir)) {
        if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue;
        const path = join(dir, entry.name);
        const st = statSafe(path);
        if (st && st.size > 0) files.push({ path, id: entry.name.slice(0, -'.jsonl'.length), mtime: st.mtimeMs });
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const byId = new Map();
  for (const f of files.slice(0, MAX_PROBES)) {
    const p = probe(f.path);
    const score = p ? project.match(p.cwd) : 0;
    if (!score || (byId.get(f.id)?.lastActivity ?? 0) >= p.lastActivity) continue;
    byId.set(f.id, {
      agent: name,
      id: f.id,
      lastActivity: p.lastActivity,
      score,
      cwd: p.cwd,
      title: p.title ?? undefined,
      preview: p.preview || undefined,
      ref: { file: f.path },
    });
  }
  return [...byId.values()].sort((a, b) => b.lastActivity - a.lastActivity);
}

const textBlocks = (content) =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];

/** What the user actually typed in message content, without harness wrappers. */
function promptText(content) {
  const blocks = textBlocks(content);
  const raw = blocks.map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n');
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(raw);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim();
    return `${command[1].trim()}${args ? ` ${args}` : ''}`;
  }
  const parts = [];
  for (const b of blocks) {
    if (b?.type === 'image') {
      parts.push('[image attached]');
      continue;
    }
    if (b?.type !== 'text' || typeof b.text !== 'string') continue;
    let text = b.text.replace(NOISE_PAIR, '');
    if (text !== b.text) text = text.replace(TOOL_LIST_DUMP, '');
    text = text.trim();
    if (text && !NOISE_START.test(text) && !BRIDGE_PROMPT.test(text)) parts.push(text);
  }
  return parts.join('\n').trim();
}

/** The typed prompt of a user row, '' for anything else. */
function promptOf(r) {
  return r?.type === 'message' && r.message?.role === 'user' && !isInjected(r) ? promptText(r.message.content) : '';
}

function resultText(block) {
  const c = block.content;
  const text =
    typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n') : '';
  return text.length > MAX_ERROR ? text.slice(-MAX_ERROR) : text;
}

/** Plan items from droid's todo text ('1. [in_progress] …'), a list of items, or either wrapped in {todos}. */
function planItems(todos) {
  if (todos && typeof todos === 'object' && !Array.isArray(todos)) return planItems(todos.todos ?? todos.items);
  if (typeof todos === 'string') {
    return todos.split('\n').flatMap((line) => {
      const m = TODO_LINE.exec(line);
      const status = m && PLAN_STATUS[m[1].toLowerCase()];
      return status ? [{ text: m[2], status }] : [];
    });
  }
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((t) => {
    const text = t?.content ?? t?.text ?? t?.title ?? t?.description ?? t?.subject;
    return text ? [{ text: String(text), status: PLAN_STATUS[String(t.status ?? '').toLowerCase()] ?? 'pending' }] : [];
  });
}

/** One tool event per call (per file for ApplyPatch); null for TodoWrite, which becomes a plan. */
function toolEvents(block, ts, cwd) {
  const input = block.input ?? {};
  const base = { kind: 'tool', tool: block.name, ts };
  const abs = (p) => (typeof p === 'string' && p && !isAbsolute(p) && cwd && isAbsolute(cwd) ? join(cwd, p) : p);
  const one = (action, target) => [{ ...base, action, target }];
  if (block.name === 'TodoWrite') return null;
  if (block.name === 'ApplyPatch') {
    const files = [...String(input.input ?? input.patch ?? '').matchAll(PATCH_FILE)].map((m) => abs(m[1].trim()));
    return (files.length ? files : [undefined]).map((target) => ({ ...base, action: 'edit', target }));
  }
  if (EDIT_TOOLS.has(block.name)) return one('edit', abs(input.file_path));
  if (block.name === 'Execute') return one('command', input.command);
  if (READ_TOOLS.has(block.name)) return one('read', abs(input.file_path ?? input.directory_path));
  if (SEARCH_TOOLS.has(block.name)) return one('search', [input.pattern ?? input.patterns].flat().join(', '));
  if (block.name === 'Task') return one('other', [input.subagent_type, input.description].filter(Boolean).join(': '));
  if (block.name === 'AskUser') return one('other', /\[question\]\s*(.+)/.exec(input.questionnaire ?? '')?.[1]);
  return one('other', input.skill ?? input.query ?? input.url ?? input.title ?? input.description ?? undefined);
}

/** Fill ok/exit/error on a tool's events from its result block; returns true when the user cancelled it. */
function finishTool(events, block) {
  const text = resultText(block);
  if (CANCELLED.test(text)) return true;
  const exit = EXIT_CODE.exec(text)?.[1];
  const failed = block.is_error === true || (exit !== undefined && Number(exit) !== 0) || /^Command timed out after/.test(text);
  for (const ev of events ?? []) {
    ev.ok = !failed;
    if (exit !== undefined) ev.exit = Number(exit);
    if (failed) ev.error = text;
  }
  return false;
}

// Words that make a limit notice a hard stop rather than a usage warning ("80% of your usage limit").
const HARD_STOP = /reached|exceeded|\bhit\b|exhaust|ran out|out of|insufficient|too many|overloaded|unavailable|at capacity|failed|\b(?:402|429|503|529)\b/i;

/** A stop event from a user_only notice that reports an API failure; null for ordinary notices. */
function stopOf(text, flagged, ts) {
  const reason = STOP_REASONS.find(([, re]) => re.test(text))?.[0];
  if (reason && (flagged || HARD_STOP.test(text))) return { kind: 'stop', reason, message: text, ts };
  if (flagged || /^\s*(?:api\s+)?error\b/i.test(text)) return { kind: 'stop', reason: 'error', message: text, ts };
  return null;
}

function compactionOf(r, ts) {
  const s = r.summary;
  const text = r.summaryText ?? (typeof s === 'string' ? s : (s?.text ?? s?.body ?? s?.summary ?? s?.content));
  const ev = { kind: 'compaction', ts };
  if (/^(?:auto|manual)$/i.test(r.summaryKind ?? '')) ev.trigger = r.summaryKind.toLowerCase();
  if (typeof text === 'string' && text.trim()) ev.summary = text.trim();
  else if (Object.entries(r).some(([k, v]) => /encrypted/i.test(k) && v)) ev.encrypted = true;
  return ev;
}

/** Assistant row: visible text (one reply per run of text blocks), tool calls, TodoWrite plans. */
function assistantRow(st, r, ts) {
  const m = r.message;
  const model = m.modelId ?? m.model;
  if (model) st.model = model;
  let reply = null;
  const replies = [];
  let usedTool = false;
  for (const b of textBlocks(m.content)) {
    if (b?.type === 'text' && b.text?.trim()) {
      if (reply) {
        reply.text += `\n${b.text}`;
      } else {
        reply = { kind: 'reply', text: b.text, ts };
        replies.push(reply);
        st.events.push(reply);
      }
    } else if (b?.type === 'tool_use') {
      usedTool = true;
      reply = null;
      if (b.name === 'TodoWrite' && !st.hasTodoState) st.events.push({ kind: 'plan', ts, items: planItems(b.input?.todos) });
      const evs = toolEvents(b, ts, st.cwd);
      if (!evs) continue;
      st.tools.set(b.id, evs);
      st.events.push(...evs);
    }
  }
  // A message with text and no tool call is the turn's answer.
  if (replies.length && !usedTool) replies.at(-1).final = true;
}

/** User row: tool results, then the typed prompt, or what a flagged row says (interrupt, API failure, launch branch). */
function userRow(st, r, ts) {
  const m = r.message;
  const blocks = textBlocks(m.content);
  const interrupt = () => st.events.at(-1)?.kind !== 'interrupt' && st.events.push({ kind: 'interrupt', ts });
  for (const b of blocks) {
    if (b?.type === 'tool_result' && finishTool(st.tools.get(b.tool_use_id), b)) interrupt();
  }
  const text = promptOf(r);
  const note = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
  if (text) {
    st.events.push({ kind: 'prompt', text, ts });
  } else if (INTERRUPT.test(note)) {
    interrupt();
  } else if (m.visibility === 'user_only' && !m.hookEventName && !blocks.some((b) => b?.type === 'tool_result')) {
    const stop = stopOf(note, Boolean(m.isError || m.error), ts);
    if (stop) st.events.push(stop);
  } else if (isInjected(r)) {
    // The startup context names the launch branch and the model (a display name, the last resort).
    const branch = GIT_BRANCH.exec(note)?.[1];
    if (branch && !/^HEAD\b/.test(branch)) st.branch ??= branch;
    st.contextModel ??= /^Model: (.+)$/m.exec(note)?.[1].trim();
  }
}

/** Translate the records of one session file into events plus the facts meta needs. */
function translate(records, cwd) {
  const st = {
    events: [],
    tools: new Map(),
    cwd,
    hasTodoState: records.some((r) => r.type === 'todo_state'),
    model: undefined,
    contextModel: undefined,
    branch: undefined,
    startedAt: undefined,
  };
  for (const r of records) {
    const ts = r.timestamp ? Date.parse(r.timestamp) : undefined;
    if (r.type === 'todo_state') {
      st.events.push({ kind: 'plan', ts, items: planItems(r.todos) });
    } else if (r.type === 'compaction_state') {
      st.events.push(compactionOf(r, ts));
    } else if (r.type === 'message' && r.message) {
      st.startedAt ??= ts;
      if (r.message.role === 'user') userRow(st, r, ts);
      else if (r.message.role === 'assistant' && r.message.visibility !== 'llm_only') assistantRow(st, r, ts);
    }
  }
  return st;
}

/**
 * @param {import('./index.js').Candidate} candidate
 * @param {import('./index.js').Context} ctx
 */
export async function loadSession(candidate, ctx) {
  const file = candidate.ref.file;
  const { events, model, contextModel, branch, startedAt } = translate(readJsonl(file), candidate.cwd);
  return {
    meta: {
      agent: name,
      sessionId: candidate.id,
      title: candidate.title,
      cwd: candidate.cwd,
      logFile: file,
      startedAt,
      lastActivity: candidate.lastActivity,
      model: model ?? readJson(file.replace(/\.jsonl$/, '.settings.json'))?.model ?? contextModel,
      branch,
      resumeCommand: `droid --resume ${candidate.id}`,
    },
    events,
  };
}

/** Start Droid's interactive REPL with a first prompt (`droid "query"`, per `droid --help`). */
export function launch(prompt) {
  return ['droid', [prompt]];
}
