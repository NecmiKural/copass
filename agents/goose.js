/**
 * Goose (Block) adapter.
 *
 * Built from upstream source; not verified against local data (Goose is not installed on the
 * machine this was written on). Sources, block/goose at 2b17adc (2026-10-24):
 *   crates/goose/src/session/session_manager.rs   SQLite schema v17: sessions + messages tables,
 *                                                 SessionType, created_timestamp (seconds, or ms in old rows)
 *   crates/goose/src/session/legacy.rs            pre-1.10 <id>.jsonl: a metadata line, then one message per line
 *   crates/goose/src/config/paths.rs + etcetera   data dir: XDG on macOS/Linux, %APPDATA%\Block\goose\data on Windows
 *   crates/goose-provider-types/src/conversation/message.rs   Message, MessageMetadata, content blocks
 *   crates/goose/src/context_mgmt/mod.rs          compaction: old messages become agentVisible:false, the
 *                                                 summary is a userVisible:false user message
 *   crates/goose/src/agents/platform_extensions/  developer (shell/write/edit/tree), todo (todo_write)
 *   crates/goose/src/acp/server.rs                IDE context blocks injected into prompts
 *   crates/goose-cli/src/cli.rs                   `session --resume --session-id`, `run -s -t`
 *
 * Sessions: <data>/sessions/sessions.db, where <data> is $GOOSE_PATH_ROOT/data, or
 * $XDG_DATA_HOME|~/.local/share/goose, or %APPDATA%\Block\goose\data. Every message row holds a JSON array
 * of content blocks (text, image, toolRequest, toolResponse, thinking, error, systemNotification…) and a
 * metadata object: userVisible=false marks harness-only messages (per-turn context, compaction summary,
 * expanded recipe prompts); agentVisible=false marks messages a compaction folded into its summary.
 * The legacy <id>.jsonl files are only read for sessions the database does not already hold.
 */

import { isAbsolute, join, resolve } from 'node:path';

import { linesFromEnd, listDir, readFirstLine, readJsonl, statSafe, tryJson } from '../lib/fsx.js';
import { openReadOnly } from '../lib/sqlite.js';

export const name = 'goose';
export const label = 'Goose';

const MAX_PROBES = 40;
const MAX_ERROR = 1500;
const MS_THRESHOLD = 10_000_000_000; // session_manager.rs: created_timestamp above this is milliseconds
const SKIPPED_TYPES = new Set(['sub_agent', 'hidden']);
const PLACEHOLDER_TITLES = new Set(['', 'CLI Session', 'New Chat', 'ACP Session']);
const VISIBLE_MESSAGE = "COALESCE(json_extract(metadata_json, '$.userVisible'), 1) != 0 AND COALESCE(json_extract(metadata_json, '$.turnContext'), 0) = 0";

// Tool names carry an optional "<extension>__" prefix; categorize_tool in ops_toolcalling.rs uses the last segment.
const COMMAND_TOOLS = new Set(['shell', 'bash', 'exec', 'run']);
const READ_TOOLS = new Set(['read', 'view', 'cat', 'read_file', 'read_image', 'analyze']);
const EDIT_TOOLS = new Set(['write', 'edit', 'patch', 'write_file', 'edit_file']);
const SEARCH_TOOLS = new Set(['tree', 'grep', 'glob', 'find', 'search']);

// Text blocks goose's own ACP converter adds around the prompt the user typed.
const IDE_CONTEXT_BLOCK = [
  /^\s*--- Resource: /,
  /^\s*--- Resource link \(not inlined\) ---/,
  /^\n\n# [^\n]+\n```\n[\s\S]*\n```$/,
];
// Error strings goose writes when the user cuts a tool call short (session/mod.rs in goose-cli).
const INTERRUPTED_TOOL = /(?:^|: )(?:Interrupted by the user to make a correction|Tool call cancelled by user)$/;
const INTERRUPT_FOLLOW_UP = 'Yes — what would you like me to do?';

/** Directories that may hold sessions.db, most likely first. */
function sessionsDirs(ctx) {
  const root = ctx.env.GOOSE_PATH_ROOT;
  if (root && isAbsolute(root)) return [join(root, 'data', 'sessions')];
  if (ctx.platform === 'win32') {
    return [join(ctx.env.APPDATA ?? join(ctx.home, 'AppData', 'Roaming'), 'Block', 'goose', 'data', 'sessions')];
  }
  const xdg = ctx.env.XDG_DATA_HOME;
  const dirs = [join(xdg && isAbsolute(xdg) ? xdg : join(ctx.home, '.local', 'share'), 'goose', 'sessions')];
  // Goose's docs name this macOS path; etcetera's choose_app_strategy uses XDG there, so it is only a fallback.
  if (ctx.platform === 'darwin') dirs.push(join(ctx.home, 'Library', 'Application Support', 'Block', 'goose', 'data', 'sessions'));
  return dirs;
}

/** SQLite CURRENT_TIMESTAMP ('2026-10-25 09:00:00', UTC) or RFC 3339 → epoch ms. */
function sqlTime(s) {
  if (typeof s !== 'string' || !s) return undefined;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? undefined : t;
}

const secToMs = (n) => (n > MS_THRESHOLD ? n : n * 1000);

const textBlocks = (content) => (Array.isArray(content) ? content : []).filter((b) => b?.type === 'text' && typeof b.text === 'string');

/** ACP clients tag blocks with an audience; a block that excludes the user was never shown to them. */
const forUser = (b) => !Array.isArray(b.annotations?.audience) || b.annotations.audience.includes('user');

/** What the user actually typed in a user message, without IDE context blocks. */
function promptText(content) {
  const parts = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (b?.type === 'image') parts.push('[image attached]');
    else if (b?.type === 'document') parts.push('[document attached]');
    else if (b?.type === 'text' && typeof b.text === 'string' && forUser(b) && !IDE_CONTEXT_BLOCK.some((re) => re.test(b.text))) parts.push(b.text);
  }
  return parts.join('\n').trim();
}

const isTurnContext = (m) => m?.turnContext === true;

/** First real prompt of a session, for `copass list` when the session has no title. */
function firstPrompt(db, id) {
  const rows = db
    .prepare("SELECT content_json, metadata_json FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_timestamp, id LIMIT 8")
    .all(id);
  for (const r of rows) {
    const m = tryJson(r.metadata_json) ?? {};
    if (m.userVisible === false || isTurnContext(m)) continue;
    const text = promptText(tryJson(r.content_json));
    if (text) return text;
  }
  return undefined;
}

/** Last visible message time (epoch seconds) and user-message count per session. */
function activity(db, ids) {
  const marks = ids.map(() => '?').join(',');
  const select =
    `SELECT session_id, MAX(CASE WHEN created_timestamp > ${MS_THRESHOLD} THEN created_timestamp / 1000 ELSE created_timestamp END) AS last, ` +
    `SUM(role = 'user') AS users FROM messages WHERE session_id IN (${marks})`;
  const run = (where) => db.prepare(`${select}${where} GROUP BY session_id`).all(...ids);
  let rows = [];
  try {
    rows = run(` AND ${VISIBLE_MESSAGE}`);
  } catch {
    try {
      rows = run(''); // no JSON1, or a malformed metadata row: count the hidden messages too
    } catch {
      rows = [];
    }
  }
  return new Map(rows.map((r) => [r.session_id, r]));
}

const titleOf = (r) => {
  const title = String(r.name || r.description || '').replace(/\s+/g, ' ').trim();
  return r.user_set_name || !PLACEHOLDER_TITLES.has(title) ? title || undefined : undefined;
};

async function fromDatabase(file, project, ctx, known) {
  const db = await openReadOnly(file);
  if (!db) return [];
  try {
    const rows = db.prepare('SELECT * FROM sessions').all();
    const scores = new Map(); // project.match touches the file system: once per working directory
    const matched = [];
    for (const r of rows) {
      known.add(r.id);
      if (SKIPPED_TYPES.has(r.session_type) || r.archived_at || !r.working_dir) continue;
      if (!scores.has(r.working_dir)) scores.set(r.working_dir, project.match(r.working_dir));
      const score = scores.get(r.working_dir);
      if (score) matched.push({ r, score, updated: sqlTime(r.updated_at) ?? sqlTime(r.created_at) ?? 0 });
    }
    matched.sort((a, b) => b.updated - a.updated);
    const top = matched.slice(0, MAX_PROBES);
    const stats = top.length ? activity(db, top.map((m) => m.r.id)) : new Map();

    return top.flatMap(({ r, score }) => {
      const s = stats.get(r.id);
      if (!s?.users || !s.last) return []; // never prompted: an empty or stub session
      return [
        {
          agent: name,
          id: r.id,
          lastActivity: secToMs(s.last),
          score,
          cwd: r.working_dir,
          title: titleOf(r),
          preview: firstPrompt(db, r.id) || undefined,
          current: ctx.env.AGENT_SESSION_ID === r.id, // developer__shell exports it to every command
          background: r.session_type === 'scheduled' || Boolean(r.schedule_id),
          ref: { file, startedAt: sqlTime(r.created_at), model: tryJson(r.model_config_json)?.model_name },
        },
      ];
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Pre-1.10 sessions: the database imports them once, so only files it does not know are listed. */
function fromLegacyFiles(dir, known, project, ctx) {
  const files = listDir(dir)
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl') && !known.has(e.name.slice(0, -'.jsonl'.length)))
    .map((e) => ({ path: join(dir, e.name), id: e.name.slice(0, -'.jsonl'.length), mtime: statSafe(join(dir, e.name))?.mtimeMs ?? 0 }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_PROBES);

  return files.flatMap((f) => {
    const head = tryJson(readFirstLine(f.path));
    const score = project.match(head?.working_dir);
    if (!score) return [];
    let last;
    for (const line of linesFromEnd(f.path, 64 * 1024)) {
      const r = tryJson(line);
      if (r?.role && r.created) {
        last = secToMs(r.created);
        break;
      }
    }
    if (!last) return [];
    const title = titleOf({ name: head.description });
    return [
      {
        agent: name,
        id: f.id,
        lastActivity: last,
        score,
        cwd: head.working_dir,
        title,
        current: ctx.env.AGENT_SESSION_ID === f.id,
        background: Boolean(head.schedule_id),
        ref: { file: f.path, legacy: true, startedAt: sqlTime(head.created_at) },
      },
    ];
  });
}

/**
 * @param {import('../lib/project.js').Project} project
 * @param {import('./index.js').Context} ctx
 * @returns {Promise<import('./index.js').Candidate[]>}
 */
export async function findSessions(project, ctx) {
  const out = [];
  for (const dir of sessionsDirs(ctx)) {
    const known = new Set();
    const file = join(dir, 'sessions.db');
    if (statSafe(file)) out.push(...(await fromDatabase(file, project, ctx, known)));
    out.push(...fromLegacyFiles(dir, known, project, ctx));
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}

// ── loading ─────────────────────────────────────────────────────────────

const resolveIn = (cwd, p) => (typeof p === 'string' && cwd && !isAbsolute(p) ? resolve(cwd, p) : p);

const tail = (text) => {
  const s = String(text ?? '');
  return s.length > MAX_ERROR ? s.slice(-MAX_ERROR) : s;
};

function toolEvent(block, ts, cwd) {
  const call = block.toolCall?.status === 'success' ? block.toolCall.value : null;
  const input = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  const tool = call?.name ?? 'unknown';
  const prefix = tool.lastIndexOf('__');
  const base = prefix < 0 ? tool : tool.slice(prefix + 2);
  const ev = { kind: 'tool', tool, ts, id: block.id };

  if (block.toolCall?.status === 'error') return { ...ev, action: 'other', ok: false, error: tail(block.toolCall.error) };

  if (base === 'text_editor') return { ...ev, action: input.command === 'view' ? 'read' : 'edit', target: resolveIn(cwd, input.path) };
  if (EDIT_TOOLS.has(base)) return { ...ev, action: 'edit', target: resolveIn(cwd, input.path) };
  if (COMMAND_TOOLS.has(base)) return { ...ev, action: 'command', target: input.command };
  if (READ_TOOLS.has(base)) return { ...ev, action: 'read', target: resolveIn(cwd, input.path ?? input.source) };
  if (SEARCH_TOOLS.has(base)) return { ...ev, action: 'search', target: input.pattern ?? resolveIn(cwd, input.path) };
  return { ...ev, action: 'other', target: input.description ?? input.query ?? input.url ?? input.name ?? undefined };
}

/** Fold a toolResponse into the matching tool event: ok, exit code and the tail of the error output. */
function applyResult(ev, block) {
  const result = block.toolResult;
  if (result?.status === 'error') {
    ev.ok = false;
    ev.error = tail(result.error);
    return;
  }
  const value = result?.value;
  const content = Array.isArray(value) ? value : (value?.content ?? []); // older rows store the bare content list
  const out = value?.structuredContent; // developer__shell: {stdout, stderr, exit_code, timed_out}
  const exit = typeof out?.exit_code === 'number' ? out.exit_code : undefined;
  if (exit !== undefined) ev.exit = exit;
  ev.ok = value?.isError !== true && !out?.timed_out && !exit;
  if (!ev.ok) ev.error = tail(out?.stderr || textBlocks(content).map((b) => b.text).join('\n'));
}

/** `- [x] done`, `- [ ] todo`, `- [~] doing` and plain bullets of the todo extension's free-form notes. */
function planFromNotes(content, ts) {
  const items = [];
  for (const line of String(content ?? '').split('\n')) {
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([^\]]?)\]\s*)?(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    const status = m[1] === undefined ? 'pending' : /x/i.test(m[1]) ? 'done' : /[~>/]/.test(m[1]) ? 'active' : 'pending';
    items.push({ text: m[2], status });
  }
  return items.length ? { kind: 'plan', ts, items } : null;
}

function stopEvent(block, ts) {
  if (block.type === 'systemNotification') return { kind: 'stop', reason: 'quota', message: block.msg, ts };
  const message = block.message ?? '';
  let reason = 'error';
  if (block.kind === 'creditsExhausted') reason = 'quota';
  else if (/Rate limit exceeded:/.test(message)) reason = 'rate_limit'; // ProviderError's Display strings
  else if (/Server error:/.test(message)) reason = 'overloaded';
  return { kind: 'stop', reason, message, ts };
}

const hasText = (row) => textBlocks(row.content).some((b) => b.text.trim());
const hasTool = (row) => row.content.some((b) => b?.type === 'toolRequest' || b?.type === 'toolResponse');
const agentOnly = (row) => row.metadata.userVisible === false && row.metadata.agentVisible !== false && !isTurnContext(row.metadata);

/**
 * compact_messages() folds every message into agentVisible:false, then appends the summary (a user
 * message) and a continuation (an assistant message), both userVisible:false. A recipe's expanded
 * prompt also follows a folded message, but its answer is visible, so the pair test tells them apart.
 */
function isCompactionSummary(rows, i) {
  const row = rows[i];
  const [prev, next] = [rows[i - 1], rows[i + 1]];
  return (
    row.role === 'user' && agentOnly(row) && hasText(row) && !hasTool(row) &&
    prev?.metadata.agentVisible === false && next?.role === 'assistant' && agentOnly(next)
  );
}

/** The summary is readable text; a `/compact` typed just before it makes the compaction manual. */
function compactionEvent(row, lastPrompt, ts) {
  const summary = textBlocks(row.content).map((b) => b.text).join('\n').trim();
  return { kind: 'compaction', summary, trigger: /^\/compact\b/.test(lastPrompt?.text ?? '') ? 'manual' : 'auto', ts };
}

/** Consecutive rows of one message (same message_id, as streaming can leave them) become one row. */
function mergeFragments(rows) {
  const out = [];
  for (const row of rows) {
    const prev = out.at(-1);
    if (prev && row.id && prev.id === row.id && prev.role === row.role) out[out.length - 1] = { ...prev, content: [...prev.content, ...row.content] };
    else out.push(row);
  }
  return out;
}

/** Message rows ({role, content, created, metadata, id}) → events and the last model seen. */
function translate(allRows, cwd) {
  const rows = mergeFragments(allRows);
  const events = [];
  const tools = new Map();
  let model;
  let openReply = null; // goose has no end_turn flag: a text-only message ends the loop, so the last reply of a turn is the answer
  let openRow = -1;
  let skipReply = false;

  rows.forEach((row, i) => {
    const m = row.metadata;
    const ts = secToMs(row.created);
    if (m.inference) model = m.inference.resolvedModel ?? m.inference.requestedModel ?? model;
    if (isCompactionSummary(rows, i)) {
      events.push(compactionEvent(row, events.findLast((e) => e.kind === 'prompt'), ts));
      return;
    }

    if (row.role === 'user') {
      for (const b of row.content) {
        if (b?.type !== 'toolResponse') continue;
        const ev = tools.get(b.id);
        if (ev) applyResult(ev, b);
        if (b.toolResult?.status === 'error' && INTERRUPTED_TOOL.test(b.toolResult.error ?? '')) {
          events.push({ kind: 'interrupt', ts });
          skipReply = true;
        }
      }
      if (m.userVisible === false || isTurnContext(m)) return;
      const text = promptText(row.content);
      if (text) {
        events.push({ kind: 'prompt', text, ts });
        openReply = null;
        skipReply = false;
      }
      return;
    }

    if (row.role !== 'assistant' || m.operations?.entry_hook?.session_start || isTurnContext(m)) return; // session-start hook banner
    const partial = m.outputTokenLimitReached === true;
    for (const b of row.content) {
      if (b?.type === 'text' && m.userVisible !== false && forUser(b) && b.text?.trim()) {
        if (skipReply && b.text.trim() === INTERRUPT_FOLLOW_UP) continue;
        if (openReply && openRow === i && events.at(-1) === openReply) {
          openReply.text += `\n${b.text}`;
          continue;
        }
        if (openReply) openReply.final = false;
        openReply = { kind: 'reply', text: b.text, ts, final: !partial, partial };
        openRow = i;
        events.push(openReply);
      } else if (b?.type === 'toolRequest') {
        if (openReply) openReply.final = false;
        openReply = null;
        const call = b.toolCall?.status === 'success' ? b.toolCall.value : null;
        if (call?.name?.endsWith('todo_write')) {
          const plan = planFromNotes(call.arguments?.content, ts);
          if (plan) events.push(plan);
          continue;
        }
        const ev = toolEvent(b, ts, cwd);
        tools.set(b.id, ev);
        events.push(ev);
      } else if (b?.type === 'error' || (b?.type === 'systemNotification' && b.notificationType === 'creditsExhausted')) {
        events.push(stopEvent(b, ts));
      }
    }
  });
  return { events, model };
}

function databaseRows(db, id) {
  const sql = 'SELECT role, content_json, created_timestamp, metadata_json, message_id FROM messages WHERE session_id = ? ORDER BY created_timestamp, id';
  return db.prepare(sql).all(id).flatMap((r) => {
    const content = tryJson(r.content_json);
    return Array.isArray(content) ? [{ role: r.role, content, created: r.created_timestamp, metadata: tryJson(r.metadata_json) ?? {}, id: r.message_id }] : [];
  });
}

/** The todo extension keeps its latest notes in sessions.extension_data under "todo.v0". */
function savedNotes(db, id) {
  const state = tryJson(db.prepare('SELECT extension_data FROM sessions WHERE id = ?').get(id)?.extension_data)?.['todo.v0'];
  return typeof state === 'string' ? state : state?.content;
}

/**
 * @param {import('./index.js').Candidate} candidate
 */
export async function loadSession(candidate) {
  const { file, legacy, startedAt, model: configured } = candidate.ref;
  let rows = [];
  let notes;
  if (legacy) {
    rows = readJsonl(file).slice(1).filter((r) => r?.role && Array.isArray(r.content)).map((r) => ({ ...r, metadata: r.metadata ?? {} }));
  } else {
    const db = await openReadOnly(file);
    if (db) {
      try {
        rows = databaseRows(db, candidate.id);
        notes = savedNotes(db, candidate.id);
      } catch {
        rows = [];
      } finally {
        db.close();
      }
    }
  }

  const { events, model } = translate(rows, candidate.cwd);
  const plan = planFromNotes(notes, candidate.lastActivity);
  if (plan) events.push(plan);

  return {
    meta: {
      agent: name,
      sessionId: candidate.id,
      title: candidate.title,
      cwd: candidate.cwd,
      logFile: file,
      startedAt,
      lastActivity: candidate.lastActivity,
      model: model ?? configured,
      resumeCommand: `goose session --resume --session-id ${candidate.id}`,
    },
    events,
  };
}

/** `goose session` takes no prompt; `run -s` processes one and stays interactive (cli.rs RunBehavior). */
export function launch(prompt) {
  return ['goose', ['run', '-s', `--text=${prompt}`]];
}
