/**
 * Codex adapter — OpenAI Codex CLI, the Codex VS Code extension and Codex Desktop.
 *
 * Sessions ("threads"): $CODEX_HOME|~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<uuid>.jsonl,
 * compressed to .jsonl.zst once older than 7 days. Each line is {timestamp, type, payload};
 * line 1 is session_meta (id, cwd, source, git and ~20 KB of base instructions). Two record
 * generations coexist: legacy files carry the user's prompts in event_msg.user_message,
 * paginated ones in event_msg.item_completed UserMessage. response_item records (assistant
 * messages, tool calls and their outputs) exist in both; the structured end events
 * (exec_command_end, patch_apply_end, CommandExecution, FileChange) only in some builds, so
 * they only enrich the tool calls.
 *
 * Discovery reads the thread index $CODEX_SQLITE_HOME|$CODEX_HOME/state_5.sqlite and falls back
 * to scanning the session folders when it is missing, locked or of another schema. Recency
 * always comes from the rollout's tail: migrations bump both file mtimes and the index's
 * updated_at. Threads Codex Desktop imported from Claude Code are skipped (copies of Claude
 * sessions that the claude-code adapter already offers).
 */

import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import * as zlib from 'node:zlib';

import { linesFromEnd, listDir, readFirstLine, readJson, readText, statSafe, tryJson } from '../lib/fsx.js';
import { queryAll } from '../lib/sqlite.js';

export const name = 'codex';
export const label = 'Codex';

const ROLLOUT_FILE = /^rollout-.+\.jsonl(?:\.zst)?$/;
const INTERACTIVE = new Set(['cli', 'vscode', 'atlas', 'chatgpt']); // codex-rs/rollout INTERACTIVE_SESSION_SOURCES
const MAX_SESSIONS = 40;
const TAIL_LINES = 2000;
const TAIL_CHUNK = 64 * 1024;
const HEAD_BYTES = 256 * 1024; // the first turn_context sits within ~150 KB of the file start
const MAX_ERROR = 1500;

const INDEX_SQL = `SELECT id, rollout_path, cwd, source, title, name, first_user_message FROM threads
  WHERE archived = 0 AND first_user_message <> '' AND model IS NOT NULL`;
const QUEUE_SQL = 'SELECT payload_json, created_at_ms FROM queued_items WHERE thread_id = ? ORDER BY queue_order';

const USER_MESSAGE_BEGIN = '## My request for Codex:'; // IDE wrapper marker (codex-rs/protocol)
const SUMMARY_PREFIX = 'Another language model started to solve this problem'; // one line, then the summary

// Harness text Codex injects as user input (codex-rs/core/src/context), plus the Claude Code
// wrappers found in sessions Codex Desktop imported from Claude Code.
const CONTEXTUAL = new RegExp(
  '^(?:# AGENTS\\.md instructions|Warning: apply_patch was requested via |<(?:' +
    [
      'user_instructions', 'environment_context', 'environments_instructions', 'apps_instructions',
      'skills_instructions', 'plugins_instructions', 'collaboration_mode', 'multi_agent_mode',
      'realtime_conversation', 'turn_aborted', 'subagent_notification', 'agent_message_board_notification',
      'skill', 'user_shell_command', 'recommended_plugins', 'codex_internal_context', 'goal_context',
      'model_switch', 'permissions', 'context_window', 'current_time_reminder', 'image_resize_notice',
      'user_verification_notice', 'observed_from_primary_session', 'local-command-(?:stdout|stderr|caveat)',
      'task-notification', 'user-prompt-submit-hook',
    ].join('|') +
    ')\\b)',
);
const CLAUDE_BLOCK = /<(ide_opened_file|ide_selection|system-reminder)>[\s\S]*?<\/\1>/g;
// Memory citations the UI strips from replies (codex-rs/utils/stream-parser assistant_text.rs).
const MEM_CITATION = /<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g;
const EXTERNAL_BLOCK = /^\[external unsupported block: ([\w-]+)\]$/gm;
const INTERRUPTED = /^\[Request interrupted by user/;

const COMMAND_TOOLS = new Set(['exec_command', 'shell', 'shell_command', 'local_shell']);
const PATCH_FILE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;
const EXIT_LINE = /^(?:Process exited with code|Exit code:) (-?\d+)$/m;
const RUNNING_LINE = /^Process running with session ID (\d+)$/m; // the exit code arrives in a later write_stdin output
const FAILED = /^[\w.]+ (?:verification )?failed\b/; // "exec_command failed: …", "apply_patch verification failed: …"
const PLAN_STATUS = { completed: 'done', in_progress: 'active', pending: 'pending' };

// codex_error_info kinds (codex-rs/protocol CodexErrorInfo); everything else is 'error'.
const STOP_REASON = {
  usage_limit_exceeded: 'quota',
  session_budget_exceeded: 'quota',
  rate_limit_exceeded: 'rate_limit',
  server_overloaded: 'overloaded',
  flex_unavailable: 'overloaded',
  internal_server_error: 'overloaded',
};
const NOT_FATAL = new Set(['thread_rollback_failed', 'active_turn_not_steerable']);

function codexHome(ctx) {
  return ctx.env.CODEX_HOME || join(ctx.home, '.codex');
}

function sqliteHome(ctx) {
  return ctx.env.CODEX_SQLITE_HOME || codexHome(ctx);
}

// ── Reading rollouts (.jsonl or .jsonl.zst) ─────────────────────────────

let zstMemo = { path: null, text: null };

/** Decompressed text of a .zst rollout; remembers the last file, which is read head then tail. */
function zstText(path) {
  if (zstMemo.path !== path) {
    let text = null;
    try {
      text = zlib.zstdDecompressSync(readFileSync(path)).toString('utf8'); // Node >= 22.15
    } catch {
      text = null;
    }
    zstMemo = { path, text };
  }
  return zstMemo.text;
}

function readRecords(path) {
  const text = path.endsWith('.zst') ? zstText(path) : readText(path);
  return (text ?? '').split('\n').map(tryJson).filter((r) => r && typeof r === 'object');
}

function firstLine(path) {
  if (!path.endsWith('.zst')) return readFirstLine(path);
  const text = zstText(path) ?? '';
  const nl = text.indexOf('\n');
  return nl < 0 ? text : text.slice(0, nl);
}

/** The first HEAD_BYTES of a rollout, and whether the file goes on past them. */
function headText(path) {
  if (path.endsWith('.zst')) {
    const text = zstText(path) ?? '';
    return { text: text.slice(0, HEAD_BYTES), full: text.length > HEAD_BYTES };
  }
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return { text: buf.toString('utf8', 0, n), full: n === HEAD_BYTES };
  } catch {
    return { text: '', full: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function* tailLines(path) {
  if (!path.endsWith('.zst')) {
    yield* linesFromEnd(path, TAIL_CHUNK);
    return;
  }
  const lines = (zstText(path) ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]) yield lines[i];
}

// ── Prompts ─────────────────────────────────────────────────────────────

/** The raw user input of a genuine prompt record (legacy or paginated), else null. */
function promptOf(record) {
  if (record?.type !== 'event_msg') return null;
  const p = record.payload ?? {};
  if (p.type === 'user_message') {
    if (p.kind && p.kind !== 'plain') return null; // early builds tagged injected instructions/context this way
    return { text: String(p.message ?? ''), images: (p.images?.length ?? 0) + (p.local_images?.length ?? 0) };
  }
  if (p.type === 'item_completed' && p.item?.type === 'UserMessage') {
    const blocks = Array.isArray(p.item.content) ? p.item.content : [];
    return {
      text: blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n'),
      images: blocks.filter((b) => b?.type === 'image' || b?.type === 'local_image').length,
    };
  }
  return null;
}

/** What the user typed: the request after the IDE context wrapper, without injected fragments. */
export function cleanPrompt(raw) {
  let text = String(raw ?? '');
  const at = text.indexOf(USER_MESSAGE_BEGIN);
  if (at >= 0) text = text.slice(at + USER_MESSAGE_BEGIN.length);
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    return `${command[1].trim()}${args ? ` ${args}` : ''}`;
  }
  text = text
    .replace(CLAUDE_BLOCK, '')
    .replace(EXTERNAL_BLOCK, (_, kind) => (kind === 'image' ? '[image attached]' : ''))
    .trim();
  return CONTEXTUAL.test(text) ? '' : text;
}

function promptText(prompt) {
  const text = cleanPrompt(prompt.text);
  return prompt.images ? [text, '[image attached]'].filter(Boolean).join('\n') : text;
}

// ── Discovery ───────────────────────────────────────────────────────────

/** 'interactive', 'background' (exec, mcp, unknown clients) or 'skip' (subagent and internal threads). */
function sourceKind(source) {
  const s = typeof source === 'string' && source.startsWith('{') ? tryJson(source) : source;
  if (s == null) return 'interactive'; // builds that predate the field default to VSCode
  if (typeof s === 'string') {
    if (/^(?:subagent|internal)/.test(s)) return 'skip';
    return INTERACTIVE.has(s) ? 'interactive' : 'background';
  }
  if (typeof s.custom === 'string') return INTERACTIVE.has(s.custom) ? 'interactive' : 'background';
  return 'skip';
}

function importedIds(ctx) {
  const records = readJson(join(codexHome(ctx), 'external_agent_session_imports.json'))?.records;
  return new Set(Array.isArray(records) ? records.map((r) => r?.imported_thread_id).filter(Boolean) : []);
}

function rolloutStat(path) {
  if (typeof path !== 'string') return null;
  for (const p of path.endsWith('.zst') ? [path] : [path, `${path}.zst`]) {
    const st = statSafe(p);
    if (st?.isFile()) return { file: p, mtime: st.mtimeMs };
  }
  return null;
}

/** Threads from the SQLite index (already non-empty and run by Codex), or null to fall back to scanning. */
async function indexEntries(ctx) {
  const rows = await queryAll(join(sqliteHome(ctx), 'state_5.sqlite'), INDEX_SQL);
  if (!rows) return null;
  return rows.flatMap((r) => {
    const found = rolloutStat(r.rollout_path);
    if (!found) return [];
    // `title` repeats the first message until Codex generates a real one.
    const title = r.name || (r.title !== r.first_user_message ? r.title : '') || undefined;
    const meta = { id: r.id, cwd: r.cwd, source: r.source, title, preview: cleanPrompt(r.first_user_message), ranTurn: true };
    return [{ ...found, meta }];
  });
}

function scanEntries(ctx) {
  const out = [];
  const walk = (dir, depth) => {
    for (const e of listDir(dir)) {
      const path = join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(path, depth + 1);
      else if (e.isFile() && ROLLOUT_FILE.test(e.name)) {
        const st = statSafe(path);
        if (st) out.push({ file: path, mtime: st.mtimeMs });
      }
    }
  };
  walk(join(codexHome(ctx), 'sessions'), 0);
  return out;
}

/** session_meta of a rollout found by scanning. */
function describeFile(file) {
  const r = tryJson(firstLine(file));
  const p = r?.type === 'session_meta' ? r.payload : null;
  return p?.id ? { id: p.id, cwd: p.cwd, source: p.source } : null;
}

/** Scan path only: did Codex ever run a turn here (imports and stubs have no turn_context), and the first prompt. */
function headInfo(file) {
  const { text, full } = headText(file);
  const lines = text.split('\n');
  if (full) lines.pop(); // possibly cut mid-line
  let preview;
  for (const line of lines) {
    if (!line.includes('"user_message"') && !line.includes('"UserMessage"')) continue;
    const prompt = promptOf(tryJson(line));
    preview = prompt ? cleanPrompt(prompt.text) : undefined;
    if (preview) break;
  }
  return { ranTurn: full || text.includes('"type":"turn_context"'), preview };
}

/** A record that shows the user or the agent doing something (not token counts or metadata). */
function isActivity(r) {
  if (r.type === 'response_item') return !(r.payload?.type === 'message' && r.payload.role !== 'assistant');
  return promptOf(r) !== null;
}

function lastActivityOf(file) {
  let scanned = 0;
  for (const line of tailLines(file)) {
    if (++scanned > TAIL_LINES) break;
    const r = tryJson(line);
    if (r?.timestamp && isActivity(r)) return Date.parse(r.timestamp);
  }
  return null;
}

/**
 * @param {import('../lib/project.js').Project} project
 * @param {import('./index.js').Context} ctx
 * @returns {Promise<import('./index.js').Candidate[]>}
 */
export async function findSessions(project, ctx) {
  const imported = importedIds(ctx);
  const entries = ((await indexEntries(ctx)) ?? scanEntries(ctx)).sort((a, b) => b.mtime - a.mtime);
  const out = [];
  const copies = new Map(); // cwd + last activity -> index in out
  let oldest = Infinity;
  for (const e of entries) {
    // lastActivity <= mtime, so once enough sessions are found no older file can outrank them.
    if (out.length >= MAX_SESSIONS && e.mtime < oldest) break;
    const s = e.meta ?? describeFile(e.file);
    if (!s || imported.has(s.id)) continue;
    const kind = sourceKind(s.source);
    const score = kind === 'skip' ? 0 : project.match(s.cwd);
    if (!score) continue;
    const info = e.meta ?? { ...s, ...headInfo(e.file) };
    if (!info.ranTurn) continue;
    const lastActivity = lastActivityOf(e.file);
    if (lastActivity === null || Number.isNaN(lastActivity)) continue;
    // Copies of a thread (an untouched fork, a restored clone) end on the same record. Keep the
    // oldest thread (UUIDv7 ids sort by creation): clones are lossy conversions of the original.
    const copyKey = `${s.cwd}\0${lastActivity}`;
    const copy = copies.get(copyKey);
    if (copy !== undefined && out[copy].id < s.id) continue;
    if (copy === undefined) copies.set(copyKey, out.length);
    oldest = Math.min(oldest, lastActivity);
    out[copy ?? out.length] = {
      agent: name,
      id: s.id,
      lastActivity,
      score,
      cwd: s.cwd,
      title: info.title || undefined,
      preview: info.preview || undefined,
      current: ctx.env.CODEX_THREAD_ID === s.id,
      background: kind === 'background',
      ref: { file: e.file },
    };
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity).slice(0, MAX_SESSIONS);
}

// ── Tool calls and their outcomes ───────────────────────────────────────

function outputText(output) {
  if (typeof output === 'string') return output;
  return Array.isArray(output) ? output.map((b) => b?.text ?? '').join('\n') : '';
}

function changedFiles(changes) {
  if (Array.isArray(changes)) return changes.map((c) => c?.path).filter(Boolean);
  return Object.entries(changes ?? {}).flatMap(([path, c]) => (c?.move_path ? [path, c.move_path] : [path]));
}

/** call_id -> {output, exit, ok, detail, files}, from outputs and the structured end events. */
function toolResults(records) {
  const out = new Map();
  const add = (id, data) => {
    if (!id) return;
    const known = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null));
    out.set(id, { ...out.get(id), ...known });
  };
  for (const { type, payload: p } of records) {
    if (!p) continue;
    if (type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
      add(p.call_id, { output: outputText(p.output) });
    }
    if (type !== 'event_msg') continue;
    const item = p.type === 'item_completed' ? p.item : null;
    if (p.type === 'exec_command_end') add(p.call_id, { exit: p.exit_code, detail: p.stderr || p.aggregated_output });
    else if (p.type === 'patch_apply_end') add(p.call_id, { ok: p.success, files: changedFiles(p.changes), detail: p.stderr });
    else if (item?.type === 'CommandExecution') {
      add(item.id, { exit: item.exit_code, ok: item.status === 'failed' ? false : undefined, detail: item.aggregated_output });
    } else if (item?.type === 'FileChange') {
      add(item.id, { ok: { completed: true, failed: false }[item.status], files: changedFiles(item.changes) });
    }
  }
  return out;
}

function tail(text) {
  const s = String(text ?? '').trim();
  return s.length > MAX_ERROR ? s.slice(-MAX_ERROR) : s;
}

/** The harness header of a unified-exec output (Chunk ID, Wall time, exit or session line), before 'Output:'. */
function outputHeader(out) {
  const marker = out.indexOf('\nOutput:\n');
  return marker >= 0 ? out.slice(0, marker) : out;
}

/** ok/exit/error of a call, from its structured end event or else the harness header of its output. */
function outcome(res) {
  if (!res) return {};
  const out = res.output ?? '';
  const json = out.startsWith('{') ? tryJson(out) : null; // {output, metadata: {exit_code}}
  const header = outputHeader(out);
  const exitMatch = EXIT_LINE.exec(header);
  const exit = res.exit ?? json?.metadata?.exit_code ?? (exitMatch ? Number(exitMatch[1]) : undefined);
  const hasExit = typeof exit === 'number';
  const ok = res.ok ?? (hasExit ? exit === 0 : FAILED.test(out) ? false : undefined);
  if (ok === undefined) return {};
  const result = hasExit ? { ok, exit } : { ok };
  if (ok) return result;
  // Without an 'Output:' marker ("apply_patch verification failed: …") the whole output is the error.
  const body = header === out ? out : out.slice(header.length).replace(/^\nOutput:\n/, '');
  const error = tail(res.detail || (json ? json.output : body));
  return error ? { ...result, error } : result;
}

function commandEvent(tool, command, res, ts) {
  // ['bash', '-lc', 'npm test'] -> 'npm test'
  const line = Array.isArray(command) ? (command.length === 3 && /^-\w*c$/.test(command[1]) ? command[2] : command.join(' ')) : command;
  return { kind: 'tool', tool, action: 'command', target: typeof line === 'string' ? line : undefined, ts, ...outcome(res) };
}

/** One edit event per file a patch touched: the structured change list, else the patch headers. */
function patchEvents(patch, res, cwd, ts) {
  const fromHeaders = [...String(patch ?? '').matchAll(PATCH_FILE)].map((m) => {
    const p = m[1].trim();
    return isAbsolute(p) || !cwd ? p : resolve(cwd, p);
  });
  const files = [...new Set(res?.files?.length ? res.files : fromHeaders)];
  const result = outcome(res);
  const base = { kind: 'tool', tool: 'apply_patch', action: 'edit', ts, ...result };
  return files.length ? files.map((target) => ({ ...base, target })) : [base];
}

function planEvent(plan, ts) {
  return { kind: 'plan', ts, items: plan.map((s) => ({ text: String(s?.step ?? ''), status: PLAN_STATUS[s?.status] ?? 'pending' })) };
}

function toolEvents(p, ts, res, s) {
  const raw = p.type === 'custom_tool_call' ? { input: p.input } : p.arguments;
  const args = (typeof raw === 'string' ? tryJson(raw) : raw) ?? {};
  const tool = p.name;
  if (tool === 'update_plan') return Array.isArray(args.plan) ? [planEvent(args.plan, ts)] : [];
  if (tool === 'apply_patch') return patchEvents(args.input ?? args.patch, res, s.cwd, ts);
  if (COMMAND_TOOLS.has(tool)) {
    const ev = commandEvent(tool, args.cmd ?? args.command, res, ts);
    const session = RUNNING_LINE.exec(outputHeader(res?.output ?? ''))?.[1];
    if (session) s.running.set(session, ev);
    return [ev];
  }
  if (tool === 'write_stdin') {
    // Input to (or a poll of) a command that is already listed: complete its outcome once it exits.
    const ev = s.running.get(String(args.session_id));
    const result = outcome(res);
    if (ev && result.ok !== undefined) {
      Object.assign(ev, result);
      s.running.delete(String(args.session_id));
    }
    return [];
  }
  if (tool === 'view_image') return [{ kind: 'tool', tool, action: 'read', target: args.path, ts }];
  return [{ kind: 'tool', tool, action: 'other', ts }];
}

function responseEvents(p, ts, results, s) {
  if (p.type === 'message') {
    if (p.role !== 'assistant') return []; // user-role items are injected context; prompts come from event_msg
    const text = (Array.isArray(p.content) ? p.content : [])
      .filter((b) => typeof b?.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .replace(MEM_CITATION, '')
      .trim();
    // phase: 'final_answer' is the turn's answer, 'commentary' progress; old builds record no phase.
    return text ? [{ kind: 'reply', text, ts, final: p.phase ? p.phase === 'final_answer' : undefined }] : [];
  }
  if (p.type === 'web_search_call') {
    const a = p.action ?? {};
    return [{ kind: 'tool', tool: 'web_search', action: 'search', target: a.query ?? a.queries?.[0] ?? a.url ?? a.pattern, ts }];
  }
  if (p.type === 'local_shell_call') return [commandEvent('local_shell', p.action?.command, results.get(p.call_id), ts)];
  if (p.type === 'function_call' || p.type === 'custom_tool_call') return toolEvents(p, ts, results.get(p.call_id), s);
  return [];
}

// ── Compaction, stops, turn bookkeeping ─────────────────────────────────

function compactionEvent(p, ts) {
  const message = typeof p.message === 'string' ? p.message.trim() : '';
  if (message) {
    // Local compaction stores SUMMARY_PREFIX + '\n' + summary (codex-rs/core/src/compact.rs).
    const summary = message.startsWith(SUMMARY_PREFIX) ? message.slice(message.indexOf('\n') + 1).trim() : message;
    return { kind: 'compaction', summary, ts };
  }
  // Remote compaction keeps only an encrypted {type: 'compaction'} item in the replacement history.
  const history = Array.isArray(p.replacement_history) ? p.replacement_history : [];
  return { kind: 'compaction', encrypted: history.some((i) => String(i?.type).startsWith('compaction')), ts };
}

/**
 * When the exhausted rate-limit windows reset (resets_at is unix seconds). token_count records
 * alternate between limits ('codex', 'premium'…), so each limit's latest snapshot is kept.
 */
function resetTime(rateLimits, ts) {
  const resets = Object.values(rateLimits)
    .flatMap((r) => [r?.primary, r?.secondary])
    .filter((w) => w?.used_percent >= 100 && Number.isFinite(w.resets_at))
    .map((w) => w.resets_at * 1000)
    .filter((at) => !(at <= ts)); // a window that already reset did not stop this turn
  return resets.length ? Math.max(...resets) : undefined;
}

function stopEvent(err, ts, rateLimits) {
  const info = err?.codex_error_info;
  const kind = info && typeof info === 'object' ? Object.keys(info)[0] : info;
  if (NOT_FATAL.has(kind)) return null;
  const reason = STOP_REASON[kind] ?? 'error';
  const resetsAt = reason === 'quota' || reason === 'rate_limit' ? resetTime(rateLimits, ts) : undefined;
  return { kind: 'stop', reason, message: err?.message, ts, ...(resetsAt && { resetsAt }) };
}

/** Old builds record no phase: the reply right before task_complete is the turn's answer. */
function markFinal(events) {
  for (let i = events.length - 1; i >= 0 && events[i].kind !== 'prompt'; i--) {
    if (events[i].kind !== 'reply') continue;
    if (events[i].final === undefined) events[i].final = true;
    return;
  }
}

/** thread_rolled_back: the user undid the last n turns. */
function rollBack(s, n) {
  const count = Number(n) || 0;
  if (count <= 0 || !s.turnStarts.length) return;
  const keep = Math.max(0, s.turnStarts.length - count);
  s.events.length = s.turnStarts[keep];
  s.turnStarts.length = keep;
}

function onEventMsg(record, ts, s) {
  const p = record.payload;
  const prompt = promptOf(record);
  if (prompt) {
    if (INTERRUPTED.test(prompt.text.trim())) {
      s.events.push({ kind: 'interrupt', ts });
      return;
    }
    const text = promptText(prompt);
    if (!text) return;
    s.turnStarts.push(s.events.length);
    s.events.push({ kind: 'prompt', text, ts });
    return;
  }
  if (p.type === 'token_count' && p.rate_limits) s.rateLimits = { ...s.rateLimits, [p.rate_limits.limit_id ?? '']: p.rate_limits };
  else if (p.type === 'thread_name_updated' && p.thread_name) s.title = p.thread_name;
  else if (p.type === 'task_complete') markFinal(s.events);
  else if (p.type === 'thread_rolled_back') rollBack(s, p.num_turns);
  else if (p.type === 'error') {
    const stop = stopEvent(p, ts, s.rateLimits);
    if (stop) s.events.push(stop);
  } else if (p.type === 'turn_aborted') {
    if (p.reason === 'interrupted') s.events.push({ kind: 'interrupt', ts });
    else if (p.reason === 'budget_limited') s.events.push({ kind: 'stop', reason: 'quota', message: 'token budget reached', ts });
    const stop = p.error ? stopEvent(p.error, ts, s.rateLimits) : null;
    if (stop) s.events.push(stop);
  }
}

/** Messages queued for the thread (`codex queue`, the Desktop queue) and not sent yet. */
async function queuedPrompts(id, ctx) {
  const rows = await queryAll(join(sqliteHome(ctx), 'queue_1.sqlite'), QUEUE_SQL, [id]);
  return (rows ?? []).flatMap((r) => {
    const content = tryJson(r.payload_json)?.UserInput?.content; // serde TurnInput::UserInput
    const text = Array.isArray(content) ? cleanPrompt(content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')) : '';
    return text ? [{ kind: 'prompt', source: 'queued', text, ts: r.created_at_ms }] : [];
  });
}

/**
 * @param {import('./index.js').Candidate} candidate
 * @param {import('./index.js').Context} ctx
 */
export async function loadSession(candidate, ctx) {
  const records = readRecords(candidate.ref.file);
  const results = toolResults(records);
  const s = { events: [], turnStarts: [], running: new Map(), cwd: candidate.cwd, session: null, model: undefined, title: undefined, rateLimits: {} };

  for (const r of records) {
    const ts = r.timestamp ? Date.parse(r.timestamp) : undefined;
    const p = r.payload ?? {};
    if (r.type === 'session_meta') s.session ??= p; // forks embed their parent's meta on later lines
    else if (r.type === 'turn_context') {
      s.model = p.model ?? s.model;
      s.cwd = p.cwd ?? s.cwd;
    } else if (r.type === 'compacted') s.events.push(compactionEvent(p, ts));
    else if (r.type === 'response_item') s.events.push(...responseEvents(p, ts, results, s));
    else if (r.type === 'event_msg') onEventMsg({ ...r, payload: p }, ts, s);
  }
  s.events.push(...(await queuedPrompts(candidate.id, ctx)));

  const started = s.session?.timestamp ? Date.parse(s.session.timestamp) : NaN;
  return {
    meta: {
      agent: name,
      sessionId: candidate.id,
      title: s.title ?? candidate.title,
      cwd: candidate.cwd,
      logFile: candidate.ref.file,
      startedAt: Number.isNaN(started) ? undefined : started,
      lastActivity: candidate.lastActivity,
      model: s.model,
      branch: s.session?.git?.branch ?? undefined,
      commit: s.session?.git?.commit_hash ?? undefined,
      resumeCommand: `codex resume ${candidate.id}`,
    },
    events: s.events,
  };
}

/** Start Codex interactively with a first prompt (`codex [PROMPT]`, codex-cli 0.149). */
export function launch(prompt) {
  return ['codex', [prompt]];
}
