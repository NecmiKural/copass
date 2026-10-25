/**
 * Antigravity adapter (the Google Antigravity IDE and its `agy` CLI).
 *
 * Store: ~/.gemini/antigravity, shared by the IDE and the CLI (the standalone CLI may use
 * ~/.gemini/antigravity-cli, older builds ~/.gemini/jetski; *-backup and antigravity-ide are
 * frozen copies and never read). Discovery reads the language server's index,
 * conversation_summaries.db: one row per conversation with its workspace folder URIs, last
 * user input time, nesting depth (subagents are > 0) and a raw_summary protobuf holding the
 * title and the git branch. Without SQLite the same index is decoded from
 * agyhub_summaries_proto.pb; without either, brain/ is scanned and matched by the paths the
 * agent's tools touched.
 *
 * Steps: brain/<id>/.system_generated/logs/transcript_full.jsonl, one JSON record per step
 * {step_index, source, type, status, created_at, content?, tool_calls?, …}. transcript.jsonl is
 * a lossy copy (fields cut at ~4 KB, sometimes only a tail window) and logs/overview.txt the
 * pre-June-2026 layout; both only fill steps missing from _full. conversations/<id>.db holds the
 * same steps as protobuf (only its gen_metadata is read, for the exact model id when the input
 * never named one); legacy <id>.pb files are encrypted and never read.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { linesFromEnd, listDir, readJson, readJsonl, readText, statSafe, tryJson } from '../lib/fsx.js';
import { isInside } from '../lib/project.js';
import { queryAll } from '../lib/sqlite.js';

export const name = 'antigravity';
export const label = 'Antigravity';

const ROOT_NAMES = ['antigravity', 'antigravity-cli', 'jetski'];
const LOG_FILES = ['transcript_full.jsonl', 'transcript.jsonl', 'overview.txt'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SCAN = 40;
const MAX_CURRENT_PROBES = 5;
const TAIL_LINES = 2000;
const ERROR_TAIL = 1500;

const INDEX_SQL = `SELECT conversation_id AS id, title, workspace_uris AS ws, last_user_input_time AS lu,
  last_modified_time AS lm, nesting_depth AS depth, raw_summary AS rs
  FROM conversation_summaries`;

const EDIT_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);
const READ_ARG = { view_file: 'AbsolutePath', read_file: 'Path', list_dir: 'DirectoryPath', read_url_content: 'Url' };
const SEARCH_ARG = { grep_search: 'Query', find_by_name: 'Pattern', search_web: 'query' };
const PLAN_STATUS = { x: 'done', X: 'done', '/': 'active', ' ': 'pending' };

// Harness blocks wrapped around what the user typed (local time, open files, model switches…).
const REQUEST_OPEN = '<USER_REQUEST>';
const REQUEST_CLOSE = '</USER_REQUEST>';
const WRAPPER = /<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|EPHEMERAL_MESSAGE)>[\s\S]*?(?:<\/\1>|$)/g;
const WRAPPER_OPEN = /<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|EPHEMERAL_MESSAGE)>/;
const SETTINGS_BLOCK = /<USER_SETTINGS_CHANGE>([\s\S]*?)(?:<\/USER_SETTINGS_CHANGE>|$)/g;
const MODEL_SWITCH = /`Model Selection` from .*? to (.+?)\.(?:\s|$)/g;
const TRUNCATED = /<truncated \d+ bytes>/g;
const RESULT_HEADER = /^\s*(?:Created|Completed) At:.*\n?/gm;
const CHECKPOINT_HEADER = /^\{\{ CHECKPOINT (\d+) \}\}\s*/;
// The objective anchor Antigravity writes early in the first turn uses this template; real compactions
// use '# Previous Session Summary:' or '# Resuming from a compaction' (both templates are in the agy binary).
const ANCHOR_TEMPLATE = /^# USER Objective:/m;
// Notices the harness splices into a model step: "The following is a <SYSTEM_MESSAGE> not actually sent by the user…".
const SYSTEM_NOTICE = /(?:[^\n]*<SYSTEM_MESSAGE>[^\n]+\n+)?<SYSTEM_MESSAGE>[\s\S]*?(?:<\/SYSTEM_MESSAGE>|$)/g;
const EXIT_LINE = /^\s*(?:The )?[Cc]ommand (?:exited with code (-?\d+)\.|failed with exit code: (-?\d+)|(completed successfully)\.)/m;
const OUTPUT_LINE = /^\s*(?:Output|Stdout|Command output):[^\S\n]*\n/m;
const RESETS_IN = /Resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/;
// Tool arguments that hold absolute paths; used only when a conversation has no workspace.
const PATH_ARG = /"(Cwd|TargetFile|AbsolutePath|DirectoryPath|SearchPath|SearchDirectory)":"((?:[^"\\]|\\.)*)"/g;

function storeRoots(ctx) {
  return ROOT_NAMES.map((n) => join(ctx.home, '.gemini', n)).filter((r) => statSafe(r)?.isDirectory());
}

const logsDir = (root, id) => join(root, 'brain', id, '.system_generated', 'logs');

/** The first log file that exists, newest layout first. */
function mainLog(logs) {
  return LOG_FILES.map((f) => join(logs, f)).find((f) => statSafe(f)?.isFile()) ?? null;
}

// ── Protobuf (raw_summary and agyhub_summaries_proto.pb) ───────────────

/** Top-level fields of a protobuf message as [field, value]: varints as numbers, length-delimited as Buffers. */
export function pbFields(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let r = 0;
    let shift = 0;
    let b;
    do {
      if (i >= buf.length) throw new RangeError('truncated varint');
      b = buf[i++];
      r += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return r;
  };
  try {
    while (i < buf.length) {
      const key = varint();
      const field = Math.floor(key / 8);
      const wire = key % 8;
      if (wire === 0) out.push([field, varint()]);
      else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else if (wire === 2) {
        const n = varint();
        out.push([field, buf.subarray(i, i + n)]);
        i += n;
      } else break;
    }
  } catch {
    // A torn message keeps the fields read so far.
  }
  return out;
}

const pbGet = (fields, n) => fields.find(([f]) => f === n)?.[1];
const pbAll = (fields, n) => fields.filter(([f]) => f === n).map(([, v]) => v);
const pbStr = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : undefined);

/** google.protobuf.Timestamp {1: seconds, 2: nanos} → epoch ms. */
function pbTime(v) {
  if (!Buffer.isBuffer(v)) return undefined;
  const t = pbFields(v);
  const sec = pbGet(t, 1);
  return typeof sec === 'number' ? sec * 1000 + Math.floor((pbGet(t, 2) ?? 0) / 1e6) : undefined;
}

/**
 * The conversation summary message: 1 title, 2 step count, 3 last modified, 7 created,
 * 9 workspaces {1 folder URI, 4 git branch} (repeated),
 * 17 trajectory {5 parent conversation (subagents only), 7 folder URI}.
 */
function readSummary(buf) {
  const f = pbFields(buf);
  const workspaces = pbAll(f, 9).map(pbFields);
  const trajectory = pbFields(pbGet(f, 17) ?? Buffer.alloc(0));
  const uris = [...workspaces.map((w) => pbStr(pbGet(w, 1))), pbStr(pbGet(trajectory, 7))].filter(Boolean);
  return {
    title: pbStr(pbGet(f, 1)) || undefined,
    branch: workspaces.map((w) => pbStr(pbGet(w, 4))).find(Boolean),
    startedAt: pbTime(pbGet(f, 7)),
    lastModified: pbTime(pbGet(f, 3)),
    uris: [...new Set(uris)],
    subagent: pbGet(trajectory, 5) !== undefined,
  };
}

// ── Index ───────────────────────────────────────────────────────────────

/** SQLite datetime text; '0001-01-01…' means "never" (V8 would read it as 2001). */
function dbTime(s) {
  if (!s || s.startsWith('0001')) return undefined;
  const t = Date.parse(String(s).replace(' ', 'T'));
  return Number.isNaN(t) ? undefined : t;
}

function fromRow(r) {
  const summary = r.rs ? Buffer.from(r.rs) : null;
  const uris = tryJson(r.ws);
  return {
    id: r.id,
    uris: Array.isArray(uris) ? uris : [],
    lastModified: dbTime(r.lm),
    subagent: r.depth > 0,
    info: () => {
      const s = summary ? readSummary(summary) : {};
      return { ...s, title: s.title || r.title || undefined };
    },
  };
}

function fromProto(buf) {
  return pbAll(pbFields(buf), 1).map((entry) => {
    const e = pbFields(entry);
    const s = readSummary(pbGet(e, 2) ?? Buffer.alloc(0));
    return { id: pbStr(pbGet(e, 1)), uris: s.uris, lastModified: s.lastModified, subagent: s.subagent, info: () => s };
  });
}

/** Every conversation the language server indexed, or null when there is no readable index. */
async function readIndex(root) {
  const rows = await queryAll(join(root, 'conversation_summaries.db'), INDEX_SQL);
  if (rows) return rows.map(fromRow);
  try {
    return fromProto(readFileSync(join(root, 'agyhub_summaries_proto.pb'))).filter((e) => e.id);
  } catch {
    return null;
  }
}

/** Conversations in brain/ the index does not know yet (written after its last sync, or no index at all). */
function unindexed(root, known, since) {
  return listDir(join(root, 'brain'))
    .filter((d) => d.isDirectory() && UUID.test(d.name) && !known.has(d.name))
    .map((d) => ({ id: d.name, mtime: statSafe(mainLog(logsDir(root, d.name)) ?? '')?.mtimeMs ?? 0 }))
    .filter((d) => d.mtime > since)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_SCAN)
    .map((d) => ({ id: d.id, uris: [], info: () => ({}) }));
}

// ── Matching ────────────────────────────────────────────────────────────

/** Best project.match over a conversation's workspace folders (multi-root workspaces have several). */
function matchUris(uris, match) {
  let best = { score: 0, cwd: undefined };
  for (const uri of uris) {
    let path;
    try {
      path = fileURLToPath(uri);
    } catch {
      continue;
    }
    const score = match(path);
    if (score > best.score) best = { score, cwd: path };
  }
  return best;
}

/**
 * For conversations without a workspace: the directories its tools worked in. It belongs to the
 * project only when most of them are inside it — one stray read of another repo does not count.
 * The agent's own brain/ artifacts (task.md, plans) say nothing about the project and are not counted.
 */
function matchToolPaths(root, id, project, match) {
  const none = { score: 0, cwd: undefined };
  const own = join(root, 'brain') + sep;
  const file = mainLog(logsDir(root, id));
  const text = file && readText(file);
  // ponytail: case-sensitive prefilter; a store that spells the project dir in another case is skipped.
  if (!text || !project.roots.some((r) => text.includes(basename(r)))) return none;
  const counts = new Map();
  for (const m of text.matchAll(PATH_ARG)) {
    const p = tryJson(`"${m[2]}"`);
    if (typeof p !== 'string' || !isAbsolute(p)) continue;
    const dir = m[1] === 'TargetFile' || m[1] === 'AbsolutePath' ? dirname(p) : p;
    if (dir.startsWith(own)) continue;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  let total = 0;
  let inside = 0;
  let best = none;
  for (const [dir, n] of counts) {
    total += n;
    const score = match(dir);
    if (!score) continue;
    inside += n;
    if (score > best.score) best = { score, cwd: dir };
  }
  return inside * 2 > total ? best : none;
}

const isTurn = (s) =>
  (s.source === 'USER_EXPLICIT' && s.type === 'USER_INPUT') || (s.source === 'MODEL' && s.type === 'PLANNER_RESPONSE');

/** Time of the last user/assistant step, or null when the conversation has none (a stub). */
function lastTurnTime(logs) {
  const file = mainLog(logs);
  if (!file) return null;
  let scanned = 0;
  for (const line of linesFromEnd(file, 64 * 1024)) {
    if (++scanned > TAIL_LINES) break;
    const s = tryJson(line);
    if (s && isTurn(s) && s.created_at) return Date.parse(s.created_at) || null;
  }
  return null;
}

/**
 * @param {import('../lib/project.js').Project} project
 * @param {import('./index.js').Context} ctx
 * @returns {Promise<import('./index.js').Candidate[]>}
 */
export async function findSessions(project, ctx) {
  const out = [];
  const seen = new Set();
  // Hundreds of conversations share a few dozen folders, and project.match touches the disk.
  const scores = new Map();
  const match = (dir) => scores.get(dir) ?? scores.set(dir, project.match(dir)).get(dir);
  for (const root of storeRoots(ctx)) {
    const index = (await readIndex(root)) ?? [];
    const known = new Set(index.map((e) => e.id));
    const synced = index.reduce((max, e) => Math.max(max, e.lastModified ?? 0), 0);
    for (const e of [...index, ...unindexed(root, known, synced)]) {
      // No step_count filter: stale index rows say 0 steps for conversations with real turns; the log decides.
      if (e.subagent || seen.has(e.id)) continue;
      const logs = logsDir(root, e.id);
      const where = e.uris.length ? matchUris(e.uris, match) : matchToolPaths(root, e.id, project, match);
      if (!where.score) continue;
      const lastActivity = lastTurnTime(logs);
      if (!lastActivity) continue;
      seen.add(e.id);
      const info = e.info();
      out.push({
        agent: name,
        id: e.id,
        lastActivity,
        score: where.score,
        cwd: where.cwd,
        title: info.title,
        ref: { root, branch: info.branch, startedAt: info.startedAt },
      });
    }
  }
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  const self = await currentId(out, ctx.env);
  return out.map((c) => ({ ...c, current: c.id === self }));
}

/**
 * The conversation copass runs inside. Hooks and sidecars get ANTIGRAVITY_CONVERSATION_ID; the commands the
 * agent runs get only ANTIGRAVITY_TRAJECTORY_ID, which conversations/<id>.db maps back (trajectory_meta).
 * The running conversation is among the most recent, so only the newest few are probed.
 */
async function currentId(candidates, env) {
  if (env.ANTIGRAVITY_CONVERSATION_ID) return env.ANTIGRAVITY_CONVERSATION_ID;
  const trajectory = env.ANTIGRAVITY_TRAJECTORY_ID;
  if (!trajectory) return undefined;
  for (const c of candidates.slice(0, MAX_CURRENT_PROBES)) {
    const db = join(c.ref.root, 'conversations', `${c.id}.db`);
    const rows = await queryAll(db, 'SELECT 1 FROM trajectory_meta WHERE trajectory_id = ? LIMIT 1', [trajectory]);
    if (rows?.length) return c.id;
  }
  return undefined;
}

// ── Steps → events ──────────────────────────────────────────────────────

/** Steps from every log layout, merged by step_index; _full wins over the lossy copies. */
function readSteps(logs) {
  const byIndex = new Map();
  for (const f of LOG_FILES) {
    for (const s of readJsonl(join(logs, f))) {
      if (Number.isInteger(s?.step_index) && !byIndex.has(s.step_index)) byIndex.set(s.step_index, s);
    }
  }
  return [...byIndex.values()].sort((a, b) => a.step_index - b.step_index);
}

/**
 * What the user typed: the inside of <USER_REQUEST>, plus any artifact review comments the IDE
 * puts in front of it ("Comments on artifact URI: …"), with the harness blocks removed.
 * Inputs cut short in the lossy transcript copy may lack closing tags.
 */
export function promptText(content, media) {
  let text = content.replace(WRAPPER, '');
  const start = content.indexOf(REQUEST_OPEN);
  if (start >= 0) {
    const rest = content.slice(start + REQUEST_OPEN.length);
    const close = rest.indexOf(REQUEST_CLOSE);
    const end = close >= 0 ? close : rest.search(WRAPPER_OPEN);
    const before = content.slice(0, start).replace(WRAPPER, '').trim();
    text = [before, (end >= 0 ? rest.slice(0, end) : rest).trim()].filter(Boolean).join('\n\n');
  }
  text = text.replace(TRUNCATED, '…').trim();
  const images = Array.isArray(media) ? media.length : 0;
  if (!images) return text;
  return [text, images === 1 ? '[image attached]' : `[${images} images attached]`].filter(Boolean).join('\n');
}

/** Exact model id of the conversation's last generation: conversations/<id>.db gen_metadata field 3.28. */
async function lastGenerationModel(root, id) {
  const rows = await queryAll(join(root, 'conversations', `${id}.db`), 'SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1');
  const data = rows?.[0]?.data;
  if (!data) return undefined;
  const request = pbGet(pbFields(Buffer.from(data)), 3);
  return Buffer.isBuffer(request) ? pbStr(pbGet(pbFields(request), 28)) || undefined : undefined;
}

/** The model picked in the input's settings-change block, if the user switched it. */
function modelSwitch(content) {
  let model;
  for (const block of content.matchAll(SETTINGS_BLOCK)) {
    for (const m of block[1].matchAll(MODEL_SWITCH)) model = m[1].trim();
  }
  return model;
}

const tail = (text) => {
  const t = String(text ?? '').trim();
  return t.length > ERROR_TAIL ? t.slice(-ERROR_TAIL) : t;
};

function toolEvent(call, ts, brain) {
  const a = call.args ?? {};
  const base = { kind: 'tool', tool: call.name, ts };
  if (EDIT_TOOLS.has(call.name)) {
    // Plans, task lists and walkthroughs live in the agent's own brain/ folder, not in the project.
    const own = typeof a.TargetFile === 'string' && isInside(a.TargetFile, brain);
    return { ...base, action: own ? 'other' : 'edit', target: a.TargetFile };
  }
  if (call.name === 'run_command') return { ...base, action: 'command', target: a.CommandLine };
  if (READ_ARG[call.name]) return { ...base, action: 'read', target: a[READ_ARG[call.name]] };
  if (SEARCH_ARG[call.name]) return { ...base, action: 'search', target: a[SEARCH_ARG[call.name]] };
  return { ...base, action: 'other', target: a.toolSummary ?? a.Url ?? a.query };
}

/** The agent's question as the user saw it: each question with its options. */
function questionText(args) {
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  return questions
    .map((q) => [q?.question, ...(Array.isArray(q?.options) ? q.options.map((o) => `- ${o}`) : [])].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
}

/** Fill ok/exit/error on a tool event from the step that carries its result. */
function settle(ev, step) {
  const content = typeof step.content === 'string' ? step.content.replace(RESULT_HEADER, '') : '';
  if (step.status === 'RUNNING') return; // still running, or moved to a background task
  if (step.error || step.status === 'ERROR' || step.status === 'INVALID') {
    ev.ok = false;
    ev.error = tail(step.error || content);
    return;
  }
  if (ev.action !== 'command') {
    ev.ok = true;
    return;
  }
  const header = content.split('\n', 6).join('\n');
  const m = EXIT_LINE.exec(header);
  const exit = Number.isInteger(step.exit_code) ? step.exit_code : m ? (m[3] ? 0 : Number(m[1] ?? m[2])) : undefined;
  if (exit === undefined) return; // a background task: the outcome is reported later, elsewhere
  ev.exit = exit;
  ev.ok = exit === 0;
  if (exit !== 0) {
    const out = OUTPUT_LINE.exec(content);
    ev.error = tail(out ? content.slice(out.index + out[0].length) : content);
  }
}

function stopEvent(step, message, ts) {
  let reason = 'error';
  if (/RESOURCE_EXHAUSTED|quota/i.test(message)) reason = 'quota';
  else if (/overloaded|UNAVAILABLE|No capacity/i.test(message)) reason = 'overloaded';
  else if (/stream was interrupted/i.test(message)) reason = 'interrupted';
  else if (step.error_code === 429) reason = 'rate_limit';
  const m = RESETS_IN.exec(message);
  const wait = m ? ((Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0)) * 1000 : 0;
  return { kind: 'stop', reason, message, ts, resetsAt: wait && ts ? ts + wait : undefined };
}

/** Antigravity retries after transient errors; only an error nothing answered afterwards stopped the session. */
function dropRecoveredStops(events) {
  let recovered = false;
  const kept = [];
  for (const e of events.toReversed()) {
    if (e.kind === 'prompt') recovered = false;
    else if (e.kind === 'reply' || e.kind === 'tool') recovered = true;
    else if (e.kind === 'stop' && recovered) continue;
    kept.push(e);
  }
  return kept.reverse();
}

/** brain/<id>/task.md, the checklist the agent keeps for the task. */
function planFromTaskFile(brain) {
  const file = join(brain, 'task.md');
  const items = (readText(file) ?? '')
    .split('\n')
    .map((line) => /^\s*[-*]\s+\[([ xX/])\]\s+(.+?)\s*$/.exec(line))
    .filter(Boolean)
    .map(([, mark, text]) => ({ text, status: PLAN_STATUS[mark] }));
  if (!items.length) return null;
  const updated = Date.parse(readJson(`${file}.metadata.json`)?.updatedAt ?? '');
  return { kind: 'plan', items, ts: Number.isNaN(updated) ? statSafe(file)?.mtimeMs : updated };
}

/**
 * @param {import('./index.js').Candidate} candidate
 * @param {import('./index.js').Context} ctx
 */
export async function loadSession(candidate, ctx) {
  const brain = join(candidate.ref.root, 'brain', candidate.id);
  const logs = logsDir(candidate.ref.root, candidate.id);
  const events = [];
  let pending = []; // tool calls of the last planner step, waiting for their result steps in order
  let model;

  for (const s of readSteps(logs)) {
    const ts = s.created_at ? Date.parse(s.created_at) || undefined : undefined;
    const content = typeof s.content === 'string' ? s.content : '';

    if (s.source === 'USER_EXPLICIT') {
      if (s.type !== 'USER_INPUT') continue; // user-side code actions and file views, not prompts
      pending = [];
      model = modelSwitch(content) ?? model;
      const text = promptText(content, s.media);
      if (text) events.push({ kind: 'prompt', text, ts });
    } else if (s.source === 'MODEL' && s.type === 'PLANNER_RESPONSE') {
      pending = [];
      const calls = Array.isArray(s.tool_calls) ? s.tool_calls : [];
      const text = content.replace(SYSTEM_NOTICE, '').replace(/\n{3,}/g, '\n\n').trim();
      if (text) {
        events.push({ kind: 'reply', text, ts, final: !calls.length && s.status === 'DONE', partial: s.status === 'RUNNING' });
      }
      for (const call of calls) {
        if (call?.name === 'ask_question') {
          const text = questionText(call.args);
          if (text) events.push({ kind: 'reply', text, ts, final: true });
          pending.push({ call, ev: null });
          continue;
        }
        const ev = toolEvent(call ?? {}, ts, brain);
        events.push(ev);
        pending.push({ call, ev });
      }
    } else if (s.source === 'SYSTEM' && s.type === 'CHECKPOINT') {
      // Antigravity's own context compaction. A '{{ CHECKPOINT 0 }}' with the '# USER Objective:' template
      // is the objective anchor written early in the first turn: nothing was dropped there. A CHECKPOINT 0
      // carrying a '# Previous Session Summary:' is a real overflow (a first turn that read huge files).
      if (CHECKPOINT_HEADER.exec(content)?.[1] === '0' && ANCHOR_TEMPLATE.test(content)) continue;
      events.push({ kind: 'compaction', summary: content.replace(CHECKPOINT_HEADER, '').trim() || undefined, ts });
    } else if (s.type === 'ERROR_MESSAGE') {
      const message = String(s.error || content).trim();
      const waiting = pending.shift();
      if (waiting?.ev) Object.assign(waiting.ev, { ok: false, error: tail(message) });
      events.push(stopEvent(s, message, ts));
    } else if (s.source === 'MODEL' && pending.length) {
      const { call, ev } = pending.shift();
      if (ev) settle(ev, s);
      else if (call?.name === 'ask_question' && s.status !== 'RUNNING') {
        // The user's answer to the agent's question ("A1: …") is something the user typed.
        const answer = content.replace(RESULT_HEADER, '').trim();
        if (answer) events.push({ kind: 'prompt', text: answer, ts });
      }
    }
  }

  const plan = planFromTaskFile(brain);
  if (plan) events.push(plan);

  return {
    meta: {
      agent: name,
      sessionId: candidate.id,
      title: candidate.title,
      cwd: candidate.cwd,
      logFile: mainLog(logs) ?? undefined,
      startedAt: candidate.ref.startedAt,
      lastActivity: candidate.lastActivity,
      model: model ?? (await lastGenerationModel(candidate.ref.root, candidate.id)),
      branch: candidate.ref.branch,
      resumeCommand: `agy --conversation ${candidate.id}`,
    },
    events: dropRecoveredStops(events),
  };
}

/** Start the agy CLI interactively with a first prompt (`-i` = --prompt-interactive). */
export function launch(prompt, ctx) {
  // The installer puts agy in ~/.gemini/bin, which is only on PATH after `agy install`.
  const local = ctx ? join(ctx.home, '.gemini', 'bin', 'agy') : null;
  const onPath = ctx?.env.PATH?.split(delimiter).some((dir) => dir && existsSync(join(dir, 'agy')));
  return [!onPath && local && existsSync(local) ? local : 'agy', ['-i', prompt]];
}
