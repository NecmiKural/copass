/**
 * Built from upstream source; not verified against local data (OpenCode is not
 * installed on the machine this was written on).
 *
 * OpenCode adapter.
 *
 * Upstream: github.com/anomalyco/opencode (formerly sst/opencode), read at dev
 * 6ac6549 (2026-10-24, CLI 2.1.4) and at the latest 1.x release, tag v1.19.4
 * (2026-10-22):
 *   packages/util/src/global-roots.ts, packages/cli/src/database-path.ts   where the database lives
 *   packages/core/src/session/sql.ts                                       session_v2, session_message, session_inbox
 *   packages/schema/src/session-message.ts, session-error.ts, session-inbox.ts   V2 message, error and inbox shapes
 *   packages/core/src/tool/plugin/*.ts                                     V2 tool names and inputs
 *   packages/core/src/database/v1-migration.bun.ts                         how V1 rows map onto V2 (compaction pairs, synthetic text)
 *   packages/schema/src/v1/session.ts                                      V1 message, part and tool-state shapes
 *   packages/core/src/database/migration/20260127222353_*.ts, v1.19.4 packages/core/src/session/sql.ts   V1 tables
 *   packages/cli/src/commands/commands.ts, v1.19.4 packages/opencode/src/cli/cmd/tui.ts   --session / --prompt flags
 *
 * Store: <XDG_DATA_HOME|~/.local/share>/opencode/opencode.db, the same path on
 * macOS, Linux and Windows ($OPENCODE_DB overrides the file name). One SQLite
 * file holds two eras side by side:
 *   V2 (2.x): session_v2 + session_message (typed rows: user, assistant with
 *     text/reasoning/tool content, compaction, shell, idle) + session_inbox
 *     (prompts typed but not yet delivered).
 *   V1 (1.x, still the latest release): session + message + part + todo. 2.x
 *     imports these into V2 and leaves the V1 rows in place, so V1 sessions are
 *     only listed when V2 does not have the id.
 * Subagent sessions (parent_id) and archived sessions are never listed. The
 * pre-SQLite JSON storage (storage/{session,message,part}) and the V2 preview
 * database opencode-next.db are not read.
 */

import { isAbsolute, resolve } from 'node:path';

import { statSafe, tryJson } from '../lib/fsx.js';
import { openReadOnly } from '../lib/sqlite.js';

export const name = 'opencode';
export const label = 'OpenCode';

const MAX_PROBES = 40;
const MAX_ERROR = 1500;
const DEFAULT_TITLE = /^(?:New session|Child session) - \d{4}-\d\d-\d\dT/;

const ACTIONS = {
  read: 'read',
  list: 'read',
  glob: 'search',
  grep: 'search',
  websearch: 'search',
  codesearch: 'search',
  write: 'edit',
  edit: 'edit',
  multiedit: 'edit',
  patch: 'edit',
  apply_patch: 'edit',
  shell: 'command', // V2
  bash: 'command', // V1, and still the permission key
};
const actionOf = (tool) => (Object.hasOwn(ACTIONS, tool) ? ACTIONS[tool] : 'other');
const PLAN_STATUS = { completed: 'done', in_progress: 'active', pending: 'pending' }; // 'cancelled' is dropped
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

// Harness text that can sit inside a user message without being typed by the user.
const NOISE_BLOCK = /<(system-reminder|environment_context|user_instructions|ide_[a-z_]+|task-notification)\b[^>]*>[\s\S]*?<\/\1>/gi;
const INSTRUCTIONS_DUMP = /^# AGENTS\.md instructions for [^\n]*\n+<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/i;
const IDE_REQUEST = /^[\s\S]*?## My request for [^\n]*:[ \t]*\n/;

// Every statement below is read-only; only the tables that exist are queried.
const V2_SESSIONS =
  'SELECT id, directory, title, time_created FROM session_v2 WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC';
const V2_LAST =
  "SELECT time_created, json_extract(data, '$.time.completed') AS done FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant') ORDER BY time_created DESC, id DESC LIMIT 1";
const V2_PROMPTS =
  "SELECT json_extract(data, '$.text') AS text FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq LIMIT 5";
// 2.x copies V1 sessions into V2 and leaves the V1 rows behind: where V2 exists, list those only when it has no messages for them.
const V1_SESSIONS = (skipMigrated) =>
  `SELECT id, directory, title, time_created FROM session WHERE parent_id IS NULL AND time_archived IS NULL${
    skipMigrated ? ' AND NOT EXISTS (SELECT 1 FROM session_message m WHERE m.session_id = session.id)' : ''
  } ORDER BY time_updated DESC`;
const V1_LAST =
  "SELECT time_created, json_extract(data, '$.time.completed') AS done FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1";
const V1_USERS =
  "SELECT id FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY time_created, id LIMIT 3";
const V1_TEXT = `SELECT json_extract(data, '$.text') AS text FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text'
  AND COALESCE(json_extract(data, '$.synthetic'), 0) = 0 AND COALESCE(json_extract(data, '$.ignored'), 0) = 0 ORDER BY id`;

function dbPath(ctx) {
  const data = resolve(ctx.env.XDG_DATA_HOME || resolve(ctx.home, '.local', 'share'), 'opencode');
  const file = ctx.env.OPENCODE_DB;
  return file && file !== ':memory:' ? resolve(data, file) : resolve(data, 'opencode.db');
}

/** Rows of a read-only query; [] when the table or column is missing in this version. */
function all(db, sql, ...params) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

const tableNames = (db) => new Set(all(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));

/** What the user actually typed: harness wrappers, instruction dumps and IDE envelopes removed. */
function cleanPrompt(text) {
  return String(text ?? '').replace(INSTRUCTIONS_DUMP, '').replace(NOISE_BLOCK, '').replace(IDE_REQUEST, '').trim();
}

const tail = (text) => {
  const s = String(text ?? '').trim();
  return s.length > MAX_ERROR ? s.slice(-MAX_ERROR) : s;
};

const firstText = (rows) => rows.map((r) => cleanPrompt(r.text)).find(Boolean);

/** What the first user prompt of a V1 session said: its first non-synthetic text part. */
function previewV1(db, id) {
  for (const m of all(db, V1_USERS, id)) {
    const text = all(db, V1_TEXT, m.id).map((r) => cleanPrompt(r.text)).filter(Boolean).join('\n');
    if (text) return text;
  }
  return undefined;
}

/** A candidate for each matching session of one era, newest first. */
function probe(db, project, sessions, lastSql, previewOf, memo) {
  const out = [];
  for (const s of sessions) {
    if (out.length >= MAX_PROBES) break;
    if (!memo.has(s.directory)) memo.set(s.directory, project.match(s.directory));
    const score = memo.get(s.directory);
    if (!score) continue;
    const last = all(db, lastSql, s.id)[0];
    if (!last) continue; // never used: a stub
    const preview = previewOf(s.id);
    out.push({ s, score, preview, lastActivity: Math.max(last.time_created, Number(last.done) || 0) });
  }
  return out;
}

/**
 * @param {import('../lib/project.js').Project} project
 * @param {import('./index.js').Context} ctx
 * @returns {Promise<import('./index.js').Candidate[]>}
 */
export async function findSessions(project, ctx) {
  const file = dbPath(ctx);
  if (!statSafe(file)) return [];
  const db = await openReadOnly(file);
  if (!db) return [];
  try {
    const tables = tableNames(db);
    const memo = new Map();
    const found = [];
    if (tables.has('session_v2') && tables.has('session_message')) {
      const rows = probe(db, project, all(db, V2_SESSIONS), V2_LAST, (id) => firstText(all(db, V2_PROMPTS, id)), memo);
      found.push(...rows.map((r) => ({ ...r, kind: 'v2' })));
    }
    if (tables.has('session') && tables.has('message') && tables.has('part')) {
      const rows = probe(db, project, all(db, V1_SESSIONS(tables.has('session_v2'))), V1_LAST, (id) => previewV1(db, id), memo);
      found.push(...rows.map((r) => ({ ...r, kind: 'v1' })));
    }
    return found
      .map(({ s, score, preview, lastActivity, kind }) => ({
        agent: name,
        id: s.id,
        lastActivity,
        score,
        cwd: s.directory,
        title: s.title && !DEFAULT_TITLE.test(s.title) ? s.title : undefined,
        preview: preview || undefined,
        current: ctx.env.OPENCODE_SESSION_ID === s.id,
        ref: { file, kind, startedAt: s.time_created },
      }))
      .sort((a, b) => b.lastActivity - a.lastActivity);
  } finally {
    db.close();
  }
}

// ── Tools ────────────────────────────────────────────────────────────────

const where = (p, cwd) => (typeof p === 'string' && cwd && !isAbsolute(p) ? resolve(cwd, p) : p);

function planEvent(todos, ts) {
  const items = (Array.isArray(todos) ? todos : [])
    .filter((t) => Object.hasOwn(PLAN_STATUS, t?.status))
    .map((t) => ({ text: String(t.content ?? ''), status: PLAN_STATUS[t.status] }));
  return { kind: 'plan', items, ts };
}

/** One tool call as events: a patch touches several files, todowrite is a plan snapshot. */
function toolEvents(tool, input, ts, cwd, outcome) {
  const i = input && typeof input === 'object' ? input : {};
  if (tool === 'todowrite') return [planEvent(i.todos, ts)];
  const action = actionOf(tool);
  const base = { kind: 'tool', tool, action, ts, ...outcome };
  if (typeof i.patchText === 'string') {
    const paths = [...i.patchText.matchAll(PATCH_FILE)].map((m) => m[1] ?? m[2]);
    return paths.map((p) => ({ ...base, target: where(p.trim(), cwd) }));
  }
  if (action === 'command') return [{ ...base, target: i.command }];
  if (action === 'edit' || action === 'read') return [{ ...base, target: where(i.path ?? i.filePath ?? i.file_path, cwd) }];
  if (action === 'search') return [{ ...base, target: i.pattern ?? i.query }];
  return [{ ...base, target: i.description ?? i.url ?? i.query ?? i.name ?? i.id }];
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');

/** Result of a V2 tool state. A shell command that exits non-zero still completes, with metadata.exit. */
function outcomeV2(state) {
  if (state?.status === 'error') return { ok: false, error: tail(state.error?.message || textOf(state.content)) };
  if (state?.status !== 'completed') return {}; // streaming or interrupted
  const m = state.metadata ?? {};
  if (m.status === 'running') return {}; // background shell
  const exit = typeof m.exit === 'number' ? { exit: m.exit } : {};
  const failed = (exit.exit !== undefined && exit.exit !== 0) || m.timeout === true || typeof m.signal === 'string';
  return failed ? { ok: false, ...exit, error: tail(textOf(state.content)) } : { ok: true, ...exit };
}

/** Result of a V1 tool state; the bash tool records its exit code in metadata.exit (null = killed). */
function outcomeV1(tool, state) {
  if (state?.status === 'error') return { ok: false, error: tail(state.error || state.metadata?.output) };
  if (state?.status !== 'completed') return {};
  if (actionOf(tool) !== 'command') return { ok: true };
  const exit = state.metadata?.exit;
  if (exit === 0) return { ok: true, exit };
  if (exit === undefined) return {}; // a command the user ran with ! records no exit code
  return { ok: false, ...(typeof exit === 'number' ? { exit } : {}), error: tail(state.output) };
}

// ── Errors ───────────────────────────────────────────────────────────────

/** A V1 assistant error ({ name, data }) in the V2 shape { type, message, status?, retryAfterMs? }, plus whether the user aborted. */
function v1Error(err) {
  const d = err?.data ?? {};
  const h = d.responseHeaders ?? {};
  const secs = Number(h['retry-after']);
  const retryAfterMs = Number.isFinite(secs) ? secs * 1000 : Number(h['retry-after-ms']) || undefined;
  return { type: err?.name ?? 'unknown', message: d.message ?? '', status: d.statusCode, retryAfterMs, aborted: err?.name === 'MessageAbortedError' };
}

const QUOTA = /quota|free-limit|budget-limit|billing|credit|insufficient|usage limit|spend limit/i;

function stopEvent(e, ts) {
  let reason = 'error';
  if (e.type === 'provider.rate-limit') reason = 'rate_limit';
  else if (QUOTA.test(e.type) || ([402, 403, 429].includes(e.status) && QUOTA.test(e.message))) reason = 'quota';
  else if (e.status === 429) reason = 'rate_limit';
  else if (e.type === 'provider.internal' || e.status >= 500) reason = 'overloaded';
  return { kind: 'stop', reason, message: e.message, ts, ...(e.retryAfterMs ? { resetsAt: ts + e.retryAfterMs } : {}) };
}

// ── V2 messages ──────────────────────────────────────────────────────────

function promptText(text, hasImage) {
  const clean = cleanPrompt(text);
  return hasImage ? `${clean}\n[image attached]`.trim() : clean;
}

function addReply(out, text, ts) {
  if (typeof text !== 'string' || !text.trim()) return;
  const last = out.at(-1);
  if (last?.kind === 'reply') out[out.length - 1] = { ...last, text: `${last.text}\n${text}` };
  else out.push({ kind: 'reply', text, ts });
}

/** The message's last reply is its answer when the model stopped on its own, partial when it was cut off. */
function markFinal(out, finish, failed) {
  const i = out.findLastIndex((e) => e.kind === 'reply');
  if (i >= 0) out[i] = { ...out[i], final: finish === 'stop', partial: finish === 'length' || failed };
  return out;
}

function assistantV2(d, ts, cwd) {
  const out = [];
  for (const c of d.content ?? []) {
    if (c?.type === 'text') addReply(out, c.text, ts);
    else if (c?.type === 'tool') out.push(...toolEvents(c.name, c.state?.input, c.time?.created ?? ts, cwd, outcomeV2(c.state)));
  }
  markFinal(out, d.finish, Boolean(d.error));
  if (d.error) out.push(stopEvent(d.error, d.time?.completed ?? ts));
  return out;
}

/** A command the user ran with ! in the prompt. */
function shellMessage(d, ts) {
  const base = { kind: 'tool', tool: 'shell', action: 'command', target: d.command, ts };
  if (typeof d.exit === 'number') {
    return d.exit === 0 ? { ...base, ok: true, exit: 0 } : { ...base, ok: false, exit: d.exit, error: tail(d.output?.output) };
  }
  return d.status === 'timeout' || d.status === 'killed' ? { ...base, ok: false, error: tail(d.output?.output) } : base;
}

function compactionV2(d, ts) {
  if (d.status === 'failed') return stopEvent(d.error ?? { type: 'unknown', message: 'Compaction failed' }, ts);
  if (d.status !== 'completed') return null; // still running: nothing was cut yet
  const summary = typeof d.summary === 'string' ? d.summary.trim() : '';
  // A provider-native compaction stores its replacement window encrypted in native.messages.
  const content = summary ? { summary } : d.native ? { encrypted: true } : {};
  return { kind: 'compaction', trigger: d.reason, ts, ...content };
}

/** An idle marker repeats the error the failed assistant message already carried. */
function idleEvents(d, ts, lastStop) {
  if (d.outcome === 'interrupted') return [{ kind: 'interrupt', ts }];
  if (d.outcome === 'failed' && d.error && d.error.message !== lastStop) return [stopEvent(d.error, ts)];
  return [];
}

function v2Events(rows, queued, cwd) {
  const events = [];
  let model;
  let lastStop;
  for (const row of rows) {
    const d = tryJson(row.data);
    if (!d) continue;
    const ts = row.time_created;
    let next = [];
    if (row.type === 'user') {
      const text = promptText(d.text, (d.files ?? []).some((f) => f?.mime?.startsWith('image/')));
      if (text) next = [{ kind: 'prompt', text, ts }];
    } else if (row.type === 'assistant') {
      if (d.model?.id) model = `${d.model.providerID}/${d.model.id}`;
      next = assistantV2(d, ts, cwd);
    } else if (row.type === 'shell') {
      next = [shellMessage(d, ts)];
    } else if (row.type === 'compaction') {
      next = [compactionV2(d, ts)].filter(Boolean);
    } else if (row.type === 'idle') {
      next = idleEvents(d, ts, lastStop);
    }
    lastStop = next.findLast((e) => e.kind === 'stop')?.message ?? lastStop;
    events.push(...next);
  }
  for (const q of queued) events.push({ kind: 'prompt', source: 'queued', text: q.text, ts: q.ts });
  return { events, model };
}

/** Prompts typed while the agent was busy: rows leave these tables once they become messages. */
function queuedV2(db, tables, id) {
  const rows = [];
  if (tables.has('session_inbox')) {
    rows.push(...all(db, "SELECT payload AS body, time_created FROM session_inbox WHERE session_id = ? AND type = 'user' ORDER BY enqueued_seq", id));
  }
  if (tables.has('session_pending')) {
    rows.push(...all(db, "SELECT data AS body, time_created FROM session_pending WHERE session_id = ? AND type = 'user' ORDER BY admitted_seq", id));
  }
  return rows.map((r) => ({ text: cleanPrompt(tryJson(r.body)?.text), ts: r.time_created })).filter((q) => q.text);
}

// ── V1 messages ──────────────────────────────────────────────────────────

/** Text the user typed in a V1 user message; synthetic and ignored parts are harness text. */
function promptV1(parts) {
  const typed = parts.filter((p) => p.type === 'text' && !p.synthetic && !p.ignored).map((p) => cleanPrompt(p.text));
  if (parts.some((p) => p.type === 'file' && p.mime?.startsWith('image/'))) typed.push('[image attached]');
  const text = typed.filter(Boolean).join('\n');
  const subtask = parts.find((p) => p.type === 'subtask' && p.command);
  return text || (subtask ? `/${subtask.command}` : '');
}

function assistantV1(info, parts, ts, cwd) {
  const out = [];
  for (const p of parts) {
    if (p.type === 'text') addReply(out, p.text, ts);
    else if (p.type === 'tool') {
      out.push(...toolEvents(p.tool, p.state?.input, p.state?.time?.start ?? ts, cwd, outcomeV1(p.tool, p.state)));
    }
  }
  markFinal(out, info.finish, Boolean(info.error));
  if (info.error) {
    const done = info.time?.completed ?? ts;
    const e = v1Error(info.error);
    out.push(e.aborted ? { kind: 'interrupt', ts: done } : stopEvent(e, done));
  }
  return out;
}

function v1Events(messages, parts, todos, cwd) {
  const byMessage = new Map();
  for (const row of parts) {
    const p = tryJson(row.data);
    if (!p) continue;
    const list = byMessage.get(row.message_id);
    if (list) list.push(p);
    else byMessage.set(row.message_id, [p]);
  }
  const msgs = messages.map((row) => ({ id: row.id, ts: row.time_created, info: tryJson(row.data) })).filter((m) => m.info);
  // A compaction is a user message holding a compaction part, answered by an assistant message with summary: true.
  const summaries = new Map(msgs.filter((m) => m.info.role === 'assistant' && m.info.summary === true).map((m) => [m.info.parentID, m]));
  const summaryIds = new Set([...summaries.values()].map((m) => m.id));

  const events = [];
  let model;
  for (const m of msgs) {
    const own = byMessage.get(m.id) ?? [];
    if (summaryIds.has(m.id)) continue;
    if (m.info.role === 'user') {
      const compaction = own.find((p) => p.type === 'compaction');
      const done = summaries.get(m.id);
      if (compaction && done && !done.info.error && done.info.time?.completed) {
        const summary = (byMessage.get(done.id) ?? []).filter((p) => p.type === 'text').map((p) => p.text.trim()).filter(Boolean).join('\n\n');
        events.push({ kind: 'compaction', trigger: compaction.auto ? 'auto' : 'manual', ts: m.ts, ...(summary ? { summary } : {}) });
      }
      const text = compaction ? '' : promptV1(own);
      if (text) events.push({ kind: 'prompt', text, ts: m.ts });
    } else if (m.info.role === 'assistant') {
      if (m.info.modelID) model = `${m.info.providerID}/${m.info.modelID}`;
      events.push(...assistantV1(m.info, own, m.ts, cwd));
    }
  }
  // The todo table holds the list as it stands now, newer than any todowrite call in the log.
  if (todos.length) events.push(planEvent(todos, events.at(-1)?.ts));
  return { events, model };
}

/**
 * @param {import('./index.js').Candidate} candidate
 * @param {import('./index.js').Context} ctx
 */
export async function loadSession(candidate, ctx) {
  const { file, startedAt } = candidate.ref;
  const id = candidate.id;
  const db = await openReadOnly(file);
  let loaded = { events: [], model: undefined };
  if (db) {
    try {
      const tables = tableNames(db);
      const v1 = candidate.ref.kind === 'v1' ? all(db, 'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id', id) : [];
      if (v1.length) {
        const parts = all(db, 'SELECT message_id, data FROM part WHERE session_id = ? ORDER BY message_id, id', id);
        const todos = tables.has('todo') ? all(db, 'SELECT content, status FROM todo WHERE session_id = ? ORDER BY position', id) : [];
        loaded = v1Events(v1, parts, todos, candidate.cwd);
      } else {
        // V2, or a legacy session row whose history lives only in session_message.
        const rows = all(db, 'SELECT type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq', id);
        loaded = v2Events(rows, queuedV2(db, tables, id), candidate.cwd);
      }
    } finally {
      db.close();
    }
  }

  return {
    meta: {
      agent: name,
      sessionId: id,
      title: candidate.title,
      cwd: candidate.cwd,
      logFile: file,
      startedAt,
      lastActivity: candidate.lastActivity,
      model: loaded.model,
      resumeCommand: `opencode --session ${id}`,
    },
    events: loaded.events,
  };
}

/** Start OpenCode's TUI interactively with a first prompt (both the 1.x and 2.x CLI take --prompt). */
export function launch(prompt) {
  return ['opencode', ['--prompt', prompt]];
}
