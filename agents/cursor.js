/**
 * Cursor adapter — the Cursor CLI (`cursor-agent`, now also `agent`) and the Agents Window.
 *
 * Built from upstream source; not verified against local data (Cursor is not installed on
 * the machine this was written on). Cursor is closed source, so the formats below come from
 * the community readers of its stores and from Cursor's own docs, all read in October 2026:
 *   - nodeterm @42d1192 (2026-10-24) src/core/cursor-chat.ts, docs/cursor-agent.md — measured on
 *     cursor-agent 2026.09.23-2026.10.01: store layout, message shapes, config-dir rule, resume
 *   - agentsview @46eef86 (2026-10-24) docs/internal/session-format-sources.md, internal/parser/cursor_store.go
 *   - agent-sessions @7749661 (2026-10-23) AgentSessions/{Cursor,Services}/Cursor*.swift and
 *     AgentSessionsTests/Fixtures/Cursor (jsonl fixtures, test-store.db)
 *   - Ghostex @d7e8af9 (2026-10-25) server/src/session_chat_decode_cursor.rs, session_chat_cursor_mirror.rs
 *   - OpenBitFun @1f78b81 (2026-10-24) cursor-adapter/src/session/translate.rs (tool results, isSummary)
 *   - observer @f80c1a3 (2026-10-14) internal/adapter/cursor/storedb.go (rowid order, modelName)
 *   - rootcell CURSOR_BUGS.md (summary message), ChatBridge docs/FORMATS.md (Cursor 3.23.12)
 *   - cursor.com/docs/cli/{overview,reference/parameters,reference/configuration}, /docs/hooks,
 *     and the installer cursor.com/install (2026.10.22), which links `agent` and `cursor-agent`
 *
 * Layout, under <config> = $CURSOR_CONFIG_DIR, else $XDG_CONFIG_HOME/cursor, else ~/.cursor:
 *   chats/<md5(physical cwd)>/<chatId>/store.db   the conversation. SQLite: meta (key '0' = hex
 *       JSON {agentId, name, createdAt, lastUsedModel, subagentInfo?, …}) and blobs(id, data),
 *       content-addressed: the model log as AI-SDK JSON messages ({role, content, providerOptions}),
 *       interleaved with protobuf tree blobs. Read in rowid order (as observer and VibeLens do)
 *       rather than through the root blob's current-context list: that should keep the history
 *       before a compaction and a prompt whose request failed, assuming Cursor never prunes old
 *       blobs — no reader confirms that. A compaction is the message flagged
 *       providerOptions.cursor.isSummary.
 *   projects/<slug>/agent-transcripts/<chatId>/<chatId>.jsonl   (flat <chatId>.jsonl in older
 *       builds) a lossy export: no tool results, tool_use ids are null, assistant text can read
 *       [REDACTED] and the user line of a failed turn can be missing. It still carries minute
 *       timestamps and a closing {"type":"turn_ended","status","error"} record, so it supplies
 *       discovery, stops, and the whole conversation when no store exists.
 *   acp-sessions/<chatId>/{store.db, meta.json}   sessions driven over ACP; same store format
 *       (agent-sessions, garcon); only meta.json's `cwd` and `title` are read, as Ghostex does.
 * The Agents Window writes the same stores as the CLI (agent-sessions' guide), so it is covered too.
 * <slug> is the path with every run of non-alphanumerics turned into '-', '_' dropped and the
 * Windows drive letter removed, so it is lossy and never decoded: it is matched against the
 * project's roots and walked on disk.
 *
 * Not supported: the IDE's own chats (state.vscdb cursorDiskKV composerData/bubbleId — the layout
 * moved between Cursor versions and could not be verified), legacy text transcripts, per-record
 * timestamps (Cursor stores none besides the user's minute-level <timestamp> tags).
 */

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { linesFromEnd, listDir, readFirstLine, readJson, readJsonl, statSafe, tryJson } from '../lib/fsx.js';
import { openReadOnly } from '../lib/sqlite.js';

export const name = 'cursor';
export const label = 'Cursor';

const MAX_PROBES = 25;
const MAX_ERROR = 1500;
const MAX_BLOB = 8 * 1024 * 1024;
const TAIL_LINES = 200;
const DEFAULT_TITLE = 'New Agent';
const PLACEHOLDER_MODEL = /^(?:default|auto)$/i;

const md5 = (s) => createHash('md5').update(s).digest('hex');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fileOf = (p) => (statSafe(p)?.isFile() ? p : undefined);
const blobText = (d) => (typeof d === 'string' ? d : Buffer.from(d).toString('utf8'));
const tail = (s) => (s.length > MAX_ERROR ? s.slice(-MAX_ERROR) : s).trim();

// ── Locating sessions ──────────────────────────────────────────────────────────

/** The directories the CLI may keep its data in (it uses the first that is set; all are cheap to try). */
function configDirs(ctx) {
  const { CURSOR_CONFIG_DIR: custom, XDG_CONFIG_HOME: xdg } = ctx.env;
  return [...new Set([custom, xdg && join(xdg, 'cursor'), join(ctx.home, '.cursor')].filter(Boolean))];
}

/** Cursor's projects/<slug> name for an absolute path. */
export function slug(p) {
  let out = '';
  let dash = true;
  for (const c of p.replace(/^[A-Za-z]:(?=[\\/])/, '')) {
    if (/[A-Za-z0-9]/.test(c)) {
      out += c;
      dash = false;
    } else if (c !== '_' && !dash) {
      out += '-';
      dash = true;
    }
  }
  return out.replace(/-$/, '');
}

/** The directory below `dir` whose slug path is `rest` — the slug is lossy, so the disk decides. */
function walkSlug(dir, rest, fold) {
  for (const e of listDir(dir)) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const s = fold(slug(e.name));
    if (!s) continue;
    if (rest === s) return join(dir, e.name);
    if (rest.startsWith(`${s}-`)) {
      const hit = walkSlug(join(dir, e.name), rest.slice(s.length + 1), fold);
      if (hit) return hit;
    }
  }
  return null;
}

/** projects/<slug> directories that belong to the project, each with the working directory it encodes. */
function slugOwners(projectsDir, project, fold) {
  const keys = project.roots.map((root) => ({ root, key: fold(slug(root)) }));
  const out = [];
  for (const d of listDir(projectsDir)) {
    if (!d.isDirectory()) continue;
    const n = fold(d.name);
    for (const { root, key } of keys) {
      if (n === key) out.push({ dir: join(projectsDir, d.name), cwd: root });
      else if (n.startsWith(`${key}-`)) {
        // A subdirectory — or a sibling such as "app-api" for "app", which the walk rules out.
        const cwd = walkSlug(root, n.slice(key.length + 1), fold);
        if (cwd) out.push({ dir: join(projectsDir, d.name), cwd });
      } else continue;
      break;
    }
  }
  return out;
}

/** Transcripts of one projects/<slug>: nested <id>/<id>.jsonl, or flat <id>.jsonl. Subagent files are never read. */
function transcriptsIn(slugDir) {
  const base = join(slugDir, 'agent-transcripts');
  const out = [];
  for (const e of listDir(base)) {
    const id = e.isDirectory() ? e.name : e.name.endsWith('.jsonl') ? e.name.slice(0, -'.jsonl'.length) : null;
    if (!id) continue;
    const path = e.isDirectory() ? join(base, id, `${id}.jsonl`) : join(base, e.name);
    const st = statSafe(path);
    if (st?.isFile() && st.size > 0) out.push({ id, path });
  }
  return out;
}

/** store.db of a chat id: the cwd's own md5 bucket first, then every bucket (the id alone is the identity). */
function locateStore(cfgs, id, cwd) {
  for (const cfg of cfgs) {
    const chats = join(cfg, 'chats');
    const buckets = [md5(cwd), ...listDir(chats).filter((d) => d.isDirectory()).map((d) => d.name)];
    for (const b of buckets) {
      const p = fileOf(join(chats, b, id, 'store.db'));
      if (p) return p;
    }
  }
  return undefined;
}

/** Every session that could belong to the project, by chat id: {id, cwd, jsonl?, store?, title?}. */
function collect(project, ctx) {
  const fold = ctx.platform === 'darwin' || ctx.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const cfgs = configDirs(ctx);
  const found = new Map();
  const put = (id, patch) => {
    const defined = Object.entries(patch).filter(([, v]) => v !== undefined);
    found.set(id, { ...found.get(id), id, ...Object.fromEntries(defined) });
  };

  for (const cfg of cfgs) {
    for (const o of slugOwners(join(cfg, 'projects'), project, fold)) {
      for (const t of transcriptsIn(o.dir)) put(t.id, { cwd: o.cwd, jsonl: t.path });
    }
    for (const root of project.roots) {
      const bucket = join(cfg, 'chats', md5(root));
      for (const d of listDir(bucket)) {
        if (d.isDirectory()) put(d.name, { cwd: root, store: fileOf(join(bucket, d.name, 'store.db')) });
      }
    }
    for (const d of listDir(join(cfg, 'acp-sessions'))) {
      if (!d.isDirectory()) continue;
      const dir = join(cfg, 'acp-sessions', d.name);
      const meta = readJson(join(dir, 'meta.json'));
      if (isObject(meta) && typeof meta.cwd === 'string' && project.match(meta.cwd)) {
        put(d.name, { cwd: meta.cwd, store: fileOf(join(dir, 'store.db')), title: meta.title ?? meta.name });
      }
    }
  }
  for (const c of [...found.values()]) {
    if (c.jsonl && !c.store) put(c.id, { store: locateStore(cfgs, c.id, c.cwd) });
  }
  return [...found.values()].filter((c) => c.jsonl || c.store);
}

// ── Reading a store ────────────────────────────────────────────────────────────

/** meta.value is hex-encoded JSON (older builds) or plain JSON text. */
function decodeMeta(value) {
  const s = (typeof value === 'string' ? value : Buffer.from(value).toString('utf8')).trim();
  const plain = tryJson(s);
  if (isObject(plain)) return plain;
  const hex = /^(?:[0-9a-f]{2})+$/i.test(s) ? tryJson(Buffer.from(s, 'hex').toString('utf8')) : null;
  return isObject(hex) ? hex : null;
}

const toMs = (v) => (typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : typeof v === 'string' ? Date.parse(v) || undefined : undefined);

/** The session header: {name, createdAt (ms), lastUsedModel, subagentInfo, …}, or null. */
function readMeta(db) {
  for (const row of db.prepare('SELECT value FROM meta').all()) {
    const m = decodeMeta(row.value);
    if (m && (m.agentId || m.latestRootBlobId !== undefined || m.name)) return { ...m, createdAt: toMs(m.createdAt) };
  }
  return null;
}

// JSON blobs are the model's messages; everything else is a protobuf tree node.
const MESSAGES_SQL = `SELECT data FROM blobs WHERE hex(substr(data, 1, 1)) = '7B' AND length(data) < ${MAX_BLOB} ORDER BY rowid`;

/** Header and every message of a store, oldest first; null when it cannot be read. */
async function readStore(path) {
  const db = await openReadOnly(path);
  if (!db) return null;
  try {
    const messages = [];
    for (const row of db.prepare(MESSAGES_SQL).all()) {
      const m = tryJson(blobText(row.data));
      if (isObject(m) && typeof m.role === 'string') messages.push(m);
    }
    return { meta: readMeta(db), messages };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** The first or last typed prompt of a store, found without reading the whole log. */
function storedPrompt(db, order) {
  const sql = `SELECT data FROM blobs WHERE instr(CAST(data AS TEXT), '<user_query>') > 0 ORDER BY rowid ${order} LIMIT 40`;
  for (const row of db.prepare(sql).all()) {
    const m = tryJson(blobText(row.data));
    const p = isObject(m) && m.role === 'user' ? userPrompt(m, true) : null;
    if (p) return p;
  }
  return null;
}

// ── Prompts ────────────────────────────────────────────────────────────────────

const QUERY_OPEN = '<user_query>';
const QUERY_CLOSE = '</user_query>';
// Cursor's "Build" button sends "<plan title>\n\nImplement the plan as specified, it is attached…".
const PLAN_BUILD = /^([^\n]+)\n\nImplement the plan as specified, it is attached for your reference\./;
// Context blocks Cursor puts around (or instead of) the typed request.
const HARNESS_BLOCK =
  /<(timestamp|system_reminder|user_info|image_files|attached_files|open_and_recently_viewed_files|agent_skills|rules|available_subagent_types|available_subagent_models|dynamic_tools)\b[^>]*>[\s\S]*?<\/\1>/g;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// <timestamp>Wednesday, Oct 7, 2026, 4:19 AM (UTC+4)</timestamp> — minute resolution, local clock plus offset.
const STAMP =
  /<timestamp>\s*(?:\w+,\s*)?(?<mon>[A-Za-z]{3})\w*\s+(?<day>\d{1,2}),\s*(?<year>\d{4}),\s*(?<hour>\d{1,2}):(?<min>\d{2})\s*(?<ap>[AP]M)?\s*\(UTC(?:(?<sign>[+-])(?<oh>\d{1,2})(?::?(?<om>\d{2}))?)?\)\s*<\/timestamp>/i;

/** Epoch ms of a <timestamp> tag inside `text`, or undefined. */
function stampOf(text) {
  const g = STAMP.exec(text)?.groups;
  const month = g ? MONTHS.indexOf(g.mon.toLowerCase()) : -1;
  if (month < 0) return undefined;
  const hour = g.ap ? (Number(g.hour) % 12) + (g.ap.toUpperCase() === 'PM' ? 12 : 0) : Number(g.hour);
  const offset = g.sign ? (g.sign === '-' ? -1 : 1) * (Number(g.oh) * 60 + Number(g.om ?? 0)) : 0;
  return Date.UTC(Number(g.year), month, Number(g.day), hour, Number(g.min)) - offset * 60000;
}

/** What was typed in one text part. `strict` (the store) trusts only a <user_query> wrapper. */
function typedText(raw, strict) {
  const open = raw.indexOf(QUERY_OPEN);
  let text;
  if (open >= 0) {
    const start = open + QUERY_OPEN.length;
    const end = raw.lastIndexOf(QUERY_CLOSE);
    text = raw.slice(start, end >= start ? end : undefined).trim();
  } else if (strict) return '';
  else text = raw.replace(HARNESS_BLOCK, '').replace(/^\[Image\]\s*/gm, '').trim();
  const plan = PLAN_BUILD.exec(text);
  return plan ? `Implement the plan: ${plan[1].trim()}` : text;
}

/** {text, ts} of a user message when a person typed it, else null. String content is injected context. */
function userPrompt(m, strict) {
  if (!Array.isArray(m.content)) return null;
  let ts;
  let image = false;
  const texts = [];
  for (const p of m.content) {
    if (p?.type === 'image') image = true;
    if (p?.type !== 'text' || typeof p.text !== 'string') continue;
    ts ??= stampOf(p.text);
    if (/<image_files>|^\[Image\]/m.test(p.text)) image = true;
    const t = typedText(p.text, strict);
    if (t) texts.push(t);
  }
  if (!texts.length) return null;
  return { text: `${texts.join('\n\n')}${image ? '\n[image attached]' : ''}`, ts };
}

// ── Discovery ──────────────────────────────────────────────────────────────────

const activityOf = (c) =>
  c.jsonl ? (statSafe(c.jsonl)?.mtimeMs ?? 0) : Math.max(...[c.store, `${c.store}-wal`].map((p) => statSafe(p)?.mtimeMs ?? 0));

/** A transcript's first prompt and last user timestamp, from its two ends. Null for stubs. */
function probeLog(path) {
  const first = tryJson(readFirstLine(path) ?? '');
  if (first?.role !== 'user' && first?.role !== 'assistant') return null;
  const firstPrompt = first.role === 'user' ? userPrompt(fromLog(first), false) : null;
  let lastStamp;
  let n = 0;
  for (const line of linesFromEnd(path, 64 * 1024)) {
    if (++n > TAIL_LINES) break;
    const r = tryJson(line);
    const ts = r?.role === 'user' ? userPrompt(fromLog(r), false)?.ts : undefined;
    if (ts) {
      lastStamp = ts;
      break;
    }
  }
  return { first: firstPrompt, lastStamp };
}

/** A store's header and, when asked, its first and last typed prompt. */
async function probeStore(path, withPrompts) {
  const db = await openReadOnly(path);
  if (!db) return null;
  try {
    const meta = readMeta(db);
    if (!withPrompts) return { meta };
    return { meta, first: storedPrompt(db, 'ASC'), last: storedPrompt(db, 'DESC') };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** @returns {Promise<import('./index.js').Candidate|null>} */
async function probe(c, score) {
  const log = c.jsonl ? probeLog(c.jsonl) : null;
  const store = c.store ? await probeStore(c.store, !log) : null;
  const first = log ? log.first : store?.first;
  if (store?.meta?.subagentInfo || (!log && !store?.first)) return null;

  const meta = store?.meta;
  const sidecar = c.store ? readJson(join(dirname(c.store), 'meta.json')) : null;
  const named = (t) => (typeof t === 'string' && t.trim() && t.trim() !== DEFAULT_TITLE ? t.trim().slice(0, 200) : undefined);
  const stamp = log?.lastStamp ?? store?.last?.ts ?? 0;
  return {
    agent: name,
    id: c.id,
    lastActivity: Math.max(stamp, activityOf(c)),
    score,
    cwd: c.cwd,
    title: named(meta?.name) ?? named(sidecar?.title) ?? named(c.title),
    preview: first?.text || undefined,
    ref: { jsonl: c.jsonl, store: c.store, startedAt: meta?.createdAt ?? first?.ts },
  };
}

/**
 * @param {import('../lib/project.js').Project} project
 * @param {import('./index.js').Context} ctx
 * @returns {Promise<import('./index.js').Candidate[]>}
 */
export async function findSessions(project, ctx) {
  const owned = collect(project, ctx)
    .map((c) => ({ c, score: project.match(c.cwd) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => activityOf(b.c) - activityOf(a.c))
    .slice(0, MAX_PROBES);
  const out = [];
  for (const { c, score } of owned) {
    const found = await probe(c, score);
    if (found) out.push(found);
  }
  return out;
}

// ── Messages → events ──────────────────────────────────────────────────────────

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const EDIT_TOOLS = new Set(['strreplace', 'write', 'delete', 'editnotebook', 'applypatch', 'edit', 'editfile', 'searchreplace', 'multiedit', 'deletefile']);
const COMMAND_TOOLS = new Set(['shell', 'bash', 'runterminalcmd', 'runterminalcommand']);
const READ_TOOLS = new Set(['read', 'readfile', 'readlints', 'ls', 'listdir']);
const SEARCH_TOOLS = new Set(['grep', 'glob', 'semanticsearch', 'codebasesearch', 'filesearch', 'grepsearch']);
const TODO_TOOLS = new Set(['todowrite', 'updatetodos']);
const TODO_STATUS = { completed: 'done', in_progress: 'active', pending: 'pending' }; // cancelled items are dropped
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
// The model's copy of a shell result: "Exit code: 1\n\nCommand output:\n\n```\n…\n```".
const SHELL_RESULT = /^Exit code: (-?\d+)\s*\n\s*Command output:\s*\n+```\n?([\s\S]*?)\n*```/;

const visible = (text) =>
  text
    .split('\n')
    .filter((l) => l.trim() !== '[REDACTED]')
    .join('\n')
    .trim();

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (Array.isArray(content) ? content : [])
        .filter((p) => p?.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n');

/** A transcript line as a store-style message; turn_ended records pass through; anything else is null. */
function fromLog(r) {
  if (r?.type === 'turn_ended') return r;
  if ((r?.role !== 'user' && r?.role !== 'assistant') || !r.message) return null;
  const raw = r.message.content;
  const parts = typeof raw === 'string' ? [{ type: 'text', text: raw }] : Array.isArray(raw) ? raw : [];
  const content = parts.map((p) =>
    p?.type === 'tool_use' ? { type: 'tool-call', toolCallId: p.id ?? undefined, toolName: p.name, args: p.input } : p,
  );
  return { role: r.role, content };
}

function stopReason(message = '') {
  if (/usage limit|hit your .*limit|out of (?:usage|credits)|quota|spend limit|plan limit/i.test(message)) return 'quota';
  if (/rate.?limit|too many requests|\b429\b/i.test(message)) return 'rate_limit';
  if (/overload|at capacity|\b(?:502|503|529)\b|temporarily unavailable/i.test(message)) return 'overloaded';
  return 'error';
}

/** Events for a turn_ended record: nothing on success, an interrupt when aborted, a stop on error. */
function endEvents(r) {
  if (r.status === 'success' || r.status === 'completed') return [];
  if (r.status === 'aborted') return [{ kind: 'interrupt' }];
  const message = typeof r.error === 'string' && r.error ? r.error : undefined;
  return [{ kind: 'stop', reason: stopReason(message), message }];
}

/** Plan snapshot after a todo call. `merge` updates items by id; otherwise the list is replaced. */
function todoPlan(args, state) {
  if (!Array.isArray(args?.todos)) return null;
  if (!args.merge) state.clear();
  args.todos.forEach((t, i) => {
    const key = String(t?.id ?? t?.content ?? i);
    if (t?.status === 'cancelled') {
      state.delete(key);
      return;
    }
    const prev = state.get(key);
    state.set(key, { text: t?.content ?? prev?.text ?? '', status: TODO_STATUS[t?.status] ?? prev?.status ?? 'pending' });
  });
  return { kind: 'plan', items: [...state.values()] };
}

function classify(tool, args) {
  const key = norm(tool);
  const a = isObject(args) ? args : {};
  const path = a.path ?? a.file_path ?? a.target_file ?? a.target_notebook ?? a.notebook_path;
  if (EDIT_TOOLS.has(key)) return { action: 'edit', targets: [path] };
  if (COMMAND_TOOLS.has(key)) return { action: 'command', targets: [a.command] };
  if (READ_TOOLS.has(key)) return { action: 'read', targets: [path ?? (Array.isArray(a.paths) ? a.paths[0] : undefined) ?? a.target_directory] };
  if (SEARCH_TOOLS.has(key)) return { action: 'search', targets: [a.pattern ?? a.glob_pattern ?? a.query ?? a.search_term ?? a.path] };
  return { action: 'other', targets: [a.description ?? a.url ?? a.query ?? a.search_term ?? a.name] };
}

/** One tool-call part → tool events (several for a multi-file patch), or a plan snapshot for todos. */
function toolEvents(part, calls, todos) {
  let tool = part.toolName ?? 'tool';
  let args = part.args ?? {};
  // Tools loaded on demand (the to-do list among them) arrive wrapped in CallDynamicTool.
  if (tool === 'CallDynamicTool' && isObject(args) && typeof args.toolName === 'string') {
    tool = args.toolName;
    args = args.arguments ?? {};
  }
  if (TODO_TOOLS.has(norm(tool))) {
    const plan = todoPlan(args, todos);
    return plan ? [plan] : [];
  }
  const { action, targets } = classify(tool, args);
  const patchText = typeof args === 'string' ? args : (args?.patch ?? args?.input);
  const files = norm(tool) === 'applypatch' && typeof patchText === 'string' ? [...patchText.matchAll(PATCH_FILE)].map((m) => m[1].trim()) : targets;
  const events = (files.length ? files : [undefined]).map((target) => ({
    kind: 'tool',
    tool,
    action,
    ...(typeof target === 'string' && target ? { target } : {}),
  }));
  if (typeof part.toolCallId === 'string') calls.set(part.toolCallId, events);
  return events;
}

function resultText(p) {
  if (typeof p.result === 'string') return p.result;
  if (Array.isArray(p.experimental_content)) {
    const text = p.experimental_content.map((c) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
    if (text) return text;
  }
  return p.result === undefined ? '' : JSON.stringify(p.result);
}

/** ok / exit / error of a tool call, from its tool-result part. */
function outcome(ev, p, hl) {
  const text = resultText(p);
  let exit;
  let body = text;
  if (ev.action === 'command') {
    const sh = SHELL_RESULT.exec(text);
    if (sh) {
      exit = Number(sh[1]);
      body = sh[2];
    } else if (hl?.output?.success?.exitCode !== undefined) exit = Number(hl.output.success.exitCode);
  }
  const failed = p.isError === true || hl?.isError === true || String(p.output?.type ?? '').startsWith('error-');
  const ok = !failed && (exit === undefined || exit === 0);
  return { ok, ...(exit === undefined ? {} : { exit }), ...(ok ? {} : { error: tail(body) || (exit === undefined ? 'failed' : `exit code ${exit}`) }) };
}

function applyResults(m, calls) {
  const hl = m.providerOptions?.cursor?.highLevelToolCallResult;
  for (const p of Array.isArray(m.content) ? m.content : []) {
    const events = p?.type === 'tool-result' ? calls.get(p.toolCallId) : undefined;
    for (const ev of events ?? []) Object.assign(ev, outcome(ev, p, hl));
  }
}

function assistantEvents(m, calls, todos) {
  const parts = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
  const hasCall = parts.some((p) => p?.type === 'tool-call');
  const out = [];
  let buf = [];
  // Text without a tool call ends the turn: that is the final answer. Reasoning parts are never read.
  const flush = (final) => {
    const text = visible(buf.join('\n'));
    buf = [];
    if (text) out.push({ kind: 'reply', text, final });
  };
  for (const p of parts) {
    if (p?.type === 'text' && typeof p.text === 'string') buf.push(p.text);
    else if (p?.type === 'tool-call') {
      flush(false);
      out.push(...toolEvents(p, calls, todos));
    }
  }
  flush(!hasCall);
  return out;
}

function modelOf(m) {
  for (const o of [m, ...(Array.isArray(m.content) ? m.content : [])]) {
    const v = o?.providerOptions?.cursor?.modelName;
    if (typeof v === 'string' && !PLACEHOLDER_MODEL.test(v)) return v;
  }
  return undefined;
}

/** Translate messages (store-style, oldest first) into events. */
function eventsFrom(messages, strict) {
  const events = [];
  const calls = new Map();
  const todos = new Map();
  let model;
  for (const m of messages) {
    if (m.type === 'turn_ended') events.push(...endEvents(m));
    else if (m.providerOptions?.cursor?.isSummary === true) {
      const summary = textOf(m.content).replace(/^\s*\[Previous conversation summary\]:\s*/i, '').trim();
      events.push({ kind: 'compaction', ...(summary ? { summary } : {}) });
    } else if (m.role === 'user') {
      const p = userPrompt(m, strict);
      if (p) events.push({ kind: 'prompt', ...p });
    } else if (m.role === 'assistant') {
      model = modelOf(m) ?? model;
      events.push(...assistantEvents(m, calls, todos));
    } else if (m.role === 'tool') applyResults(m, calls);
  }
  return { events, model };
}

/**
 * @param {import('./index.js').Candidate} candidate
 * @param {import('./index.js').Context} ctx
 */
export async function loadSession(candidate, ctx) {
  const { jsonl, store, startedAt } = candidate.ref;
  const records = jsonl ? readJsonl(jsonl) : [];
  const saved = store ? await readStore(store) : null;

  let built;
  if (saved?.messages.length) {
    built = eventsFrom(saved.messages, true);
    // The store has no error records; how the last turn ended is only in the transcript.
    const last = records.at(-1);
    if (last?.type === 'turn_ended') built.events.push(...endEvents(last));
  } else {
    built = eventsFrom(records.map(fromLog).filter(Boolean), false);
  }

  const lastUsed = saved?.meta?.lastUsedModel;
  return {
    meta: {
      agent: name,
      sessionId: candidate.id,
      title: candidate.title,
      cwd: candidate.cwd,
      logFile: jsonl ?? store,
      startedAt,
      lastActivity: candidate.lastActivity,
      model: built.model ?? (typeof lastUsed === 'string' && !PLACEHOLDER_MODEL.test(lastUsed) ? lastUsed : undefined),
      resumeCommand: `cursor-agent --resume ${candidate.id}`,
    },
    events: built.events,
  };
}

/** Start the Cursor CLI interactively with a first prompt (`agent` is the same binary under its newer name). */
export function launch(prompt) {
  return ['cursor-agent', [prompt]];
}
