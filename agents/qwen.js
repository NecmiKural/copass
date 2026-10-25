/**
 * Qwen Code adapter.
 *
 * Built from upstream source; not verified against local data (this machine only
 * has Qwen debug logs, no chat transcripts). Upstream: github.com/QwenLM/qwen-code,
 * main @ b44e033315 (2026-10-24, release v0.26.1), files:
 *   packages/core/src/services/chatRecordingService.ts @ 3b9b35e30d  ChatRecord, subtypes, payloads
 *   packages/core/src/services/sessionService.ts @ f1645116b0         listing, first record = cwd, archive/
 *   packages/core/src/config/storage.ts @ 51fdd6c449                   <runtime>/projects/<sanitizeCwd>/chats
 *   packages/core/src/utils/paths.ts                                   sanitizeCwd
 *   packages/core/src/utils/transcript-records.ts                      active chain, fragments, displayText
 *   packages/core/src/services/{chatCompressionService,postCompactAttachments}.ts  compaction summary
 *   packages/core/src/services/shellContextEnv.ts                      QWEN_CODE_SESSION_ID for shell children
 *   packages/cli/src/config/{config,top-level-options}.ts              -i, --resume (a bare prompt is one-shot)
 *   docs/users/features/worktree.md                                    `--resume <id> --worktree=<slug>`
 *
 * Sessions: $QWEN_RUNTIME_DIR | $QWEN_HOME | ~/.qwen, then
 * projects/<launch cwd with every non-alphanumeric replaced by '-'>/chats/<uuid>.jsonl.
 * One JSON object per line: {uuid, parentUuid, sessionId, timestamp, type, subtype?, cwd,
 * gitBranch, message?: {role, parts}, systemPayload?, toolCallResult?}. type is user |
 * assistant | tool_result | system. Records form a tree (rewinds leave dead branches), so
 * the conversation is the parentUuid chain walked back from the last record, and records
 * sharing a uuid are fragments of one message. Archived sessions (chats/archive/), subagent
 * records (isSidechain / agentId) and agent-owned sessions are skipped. Managed-engine
 * transcripts hold no chat records and are ignored. The directory name is lossy, so every
 * match is confirmed against the cwd recorded in the file.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { linesFromEnd, listDir, readJsonl, statSafe, tryJson } from '../lib/fsx.js';

export const name = 'qwen';
export const label = 'Qwen Code';

const SESSION_FILE = /^[0-9a-fA-F-]{32,36}\.jsonl$/;
const MAX_PROBES = 40;
const TAIL_LINES = 3000;
const TAIL_AFTER_ACTIVITY = 96 * 1024; // titles are re-appended every 32 KB, so they sit near the end
const HEAD_BYTES = 128 * 1024;
const ERROR_TAIL = 1500;
const SLASH_WINDOW_MS = 5000; // a /command expands into its model prompt right away

const NON_CONVERSATION = new Set([
  'session_artifact_event',
  'session_artifact_snapshot',
  'session_sources_snapshot',
  'managed_session_header_v1',
  'managed_session_event_v1',
  'managed_session_commit_v1',
]);
const HIDDEN_SOURCES = new Set(['agent', 'agent-host']); // machine-owned sessions
const PLAN_STATUS = { completed: 'done', in_progress: 'active', pending: 'pending' };
const RESUME_TRAILER = 'Resume the prior task';

// Harness text inside user records: reminders, notification envelopes, hook context.
const NOISE = /<(system-reminder|task-notification|qwen:user-prompt-submit-context)>[\s\S]*?(?:<\/\1>|$)/g;
const ATTACHMENT_TOKEN = /@attachment:\/\/\/\S+/g;
const MESSAGE_PREFIX = /"type":\s*"(?:user|assistant)"/;

/** Qwen's project directory name for an absolute path (utils/paths.ts sanitizeCwd). */
export function sanitize(cwd, platform = process.platform) {
  return (platform === 'win32' ? cwd.toLowerCase() : cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

function runtimeDirs(ctx) {
  const dirs = [];
  for (const d of [ctx.env.QWEN_RUNTIME_DIR, ctx.env.QWEN_HOME]) {
    if (!d) continue;
    const p = d === '~' ? ctx.home : /^~[\\/]/.test(d) ? join(ctx.home, d.slice(2)) : d;
    if (isAbsolute(p)) dirs.push(p);
  }
  dirs.push(join(ctx.home, '.qwen'));
  return [...new Set(dirs)];
}

/** chats/ directories whose name could belong to one of the project's roots (or a subdirectory). */
function candidateDirs(projectsDir, project, ctx) {
  const fold = ctx.platform === 'darwin' || ctx.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const keys = new Set();
  for (const root of project.roots) {
    keys.add(fold(sanitize(root, ctx.platform)));
    if (/[^\x00-\x7f]/.test(root)) keys.add(fold(sanitize(root.normalize('NFD'), ctx.platform)));
  }
  return listDir(projectsDir)
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => {
      const f = fold(n);
      for (const k of keys) if (f === k || f.startsWith(`${k}-`)) return true;
      return false;
    })
    .map((n) => join(projectsDir, n, 'chats'));
}

/** First records of a file, enough to find the launch cwd, the source and the first prompt. */
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

const strip = (s) => s.replace(NOISE, '').replace(ATTACHMENT_TOKEN, '').trim();
const visibleText = (p) => (typeof p?.text === 'string' && !p.thought ? p.text : '');

/**
 * What the user actually typed in a user record. systemPayload.displayText is the composer
 * text; older records only have the model-facing parts (reminders and file dumps removed here).
 */
function promptText(r, firstPartOnly = false) {
  const payload = r.systemPayload;
  const parts = Array.isArray(r.message?.parts) ? r.message.parts : [];
  let text;
  if (typeof payload?.displayText === 'string') text = payload.displayText;
  else {
    const texts = parts.map((p) => strip(visibleText(p))).filter(Boolean);
    text = (firstPartOnly ? texts.slice(0, 1) : texts).join('\n');
  }
  text = strip(text);
  const attached = payload?.attachmentReferences?.length || parts.some((p) => p?.inlineData || p?.fileData);
  return text || (attached ? '[attachment]' : '');
}

/** Typed by a person: no subtype (or a steering message delivered mid-turn) and real_user provenance. */
const isUserRecord = (r) =>
  r.type === 'user' && (!r.subtype || r.subtype === 'mid_turn_user_message') && (!r.provenance || r.provenance === 'real_user');
const isMainline = (r) => !r.isSidechain && !r.agentId;
const isMessage = (r) => isMainline(r) && (r.type === 'assistant' || (isUserRecord(r) && promptText(r) !== ''));

/** Read just enough of a session to rank it: last activity, title, cwd, source. Returns null for stubs. */
function probe(file) {
  let lastActivity = null;
  let title = null;
  let source = null;
  let read = 0;
  let scanned = 0;
  for (const line of linesFromEnd(file, 128 * 1024)) {
    if (++scanned > TAIL_LINES) break;
    read += line.length;
    if (title === null && line.includes('"custom_title"')) {
      const r = tryJson(line);
      if (r?.subtype === 'custom_title' && typeof r.systemPayload?.customTitle === 'string') title = r.systemPayload.customTitle;
    } else if (source === null && line.includes('"session_source"')) {
      const r = tryJson(line);
      if (r?.subtype === 'session_source') source = r.systemPayload?.sourceType ?? null;
    } else if (lastActivity === null && MESSAGE_PREFIX.test(line.slice(0, 1200))) {
      const r = tryJson(line);
      if (r && r.timestamp && isMessage(r)) lastActivity = Date.parse(r.timestamp);
    }
    if (lastActivity !== null && (title !== null || read > TAIL_AFTER_ACTIVITY)) break;
  }
  if (lastActivity === null || Number.isNaN(lastActivity)) return null;

  const head = headRecords(file);
  const first = head.find((r) => typeof r.cwd === 'string');
  const firstUser = head.find((r) => isMainline(r) && isUserRecord(r) && promptText(r) !== '');
  return {
    lastActivity,
    title: title || null,
    preview: firstUser ? promptText(firstUser) : null,
    cwd: first?.cwd ?? null,
    startedAt: first?.timestamp ? Date.parse(first.timestamp) : undefined,
    source: source ?? head.find((r) => r.subtype === 'session_source')?.systemPayload?.sourceType ?? null,
  };
}

/**
 * @param {import('../lib/project.js').Project} project
 * @param {import('./index.js').Context} ctx
 * @returns {Promise<import('./index.js').Candidate[]>}
 */
export async function findSessions(project, ctx) {
  const files = [];
  for (const base of runtimeDirs(ctx)) {
    for (const dir of candidateDirs(join(base, 'projects'), project, ctx)) {
      for (const entry of listDir(dir)) {
        if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue;
        const path = join(dir, entry.name);
        const st = statSafe(path);
        if (st && st.size > 0) files.push({ path, id: entry.name.slice(0, -'.jsonl'.length), mtime: st.mtimeMs });
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const live = String(ctx.env.QWEN_CODE_SESSION_ID ?? '').toLowerCase();
  const out = [];
  for (const f of files.slice(0, MAX_PROBES)) {
    const p = probe(f.path);
    if (!p || HIDDEN_SOURCES.has(p.source)) continue;
    const score = project.match(p.cwd);
    if (!score) continue;
    out.push({
      agent: name,
      id: f.id,
      lastActivity: p.lastActivity,
      score,
      cwd: p.cwd,
      title: p.title ?? undefined,
      preview: p.preview || undefined,
      current: live !== '' && live === f.id.toLowerCase(),
      background: p.source !== null && p.source !== 'default', // scheduled_task, channel, …
      ref: { file: f.path, startedAt: p.startedAt },
    });
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}

/** Conversation records in order: the parentUuid chain from the last record, fragments merged. */
function activeChain(records) {
  if (!records.some((r) => r.uuid)) return records;
  const byUuid = new Map();
  let leaf = null;
  for (const r of records) {
    if (!r.uuid || NON_CONVERSATION.has(r.subtype)) continue;
    const list = byUuid.get(r.uuid);
    if (list) list.push(r);
    else byUuid.set(r.uuid, [r]);
    leaf = r.uuid;
  }
  const chain = [];
  const seen = new Set();
  for (let u = leaf; u && byUuid.has(u) && !seen.has(u); ) {
    seen.add(u);
    const frags = byUuid.get(u);
    chain.push(merge(frags));
    u = frags[0].parentUuid;
  }
  return chain.reverse();
}

/** Streamed fragments of one message share a uuid: concatenate their parts (transcript-records.ts). */
function merge(frags) {
  const [first, ...more] = frags;
  if (!more.length) return first;
  return {
    ...first,
    message: { ...first.message, parts: frags.flatMap((f) => (Array.isArray(f.message?.parts) ? f.message.parts : [])) },
    model: first.model ?? more.find((f) => f.model)?.model,
    toolCallResult: first.toolCallResult ?? more.find((f) => f.toolCallResult)?.toolCallResult,
    timestamp: frags.map((f) => f.timestamp).filter(Boolean).sort().at(-1),
  };
}

const tail = (s) => (s.length > ERROR_TAIL ? s.slice(-ERROR_TAIL) : s);

function toolEvent(fc, ts) {
  const a = fc.args ?? {};
  const base = { kind: 'tool', tool: fc.name, ts, id: fc.id };
  switch (fc.name) {
    case 'edit':
    case 'write_file':
      return { ...base, action: 'edit', target: a.file_path };
    case 'notebook_edit':
      return { ...base, action: 'edit', target: a.notebook_path };
    case 'run_shell_command':
      return { ...base, action: 'command', target: a.command };
    case 'read_file':
    case 'list_directory':
      return { ...base, action: 'read', target: a.file_path ?? a.path };
    case 'grep_search':
    case 'glob':
      return { ...base, action: 'search', target: a.pattern };
    default:
      return { ...base, action: 'other', target: a.description ?? a.url ?? a.query ?? a.skill ?? undefined };
  }
}

function planEvent(todos, ts) {
  const open = new Set(todos.filter((t) => t.status !== 'completed').map((t) => t.id));
  const items = todos.map((t) => {
    const blocked = t.status === 'pending' && Array.isArray(t.blockedBy) && t.blockedBy.some((id) => open.has(id));
    return { text: t.content ?? '', status: blocked ? 'blocked' : (PLAN_STATUS[t.status] ?? 'pending') };
  });
  return { kind: 'plan', ts, items };
}

/** Outcome of one tool call, from the agent's own status plus the shell result when present. */
function applyResult(ev, response, own) {
  const display = own?.resultDisplay;
  const shell = display && typeof display === 'object' && display.type === 'shell_result' ? display : null;
  const failed = own?.status ? own.status !== 'success' : response?.error !== undefined;
  ev.ok = !failed;
  const exit = shell?.exitCode ?? /^Exit Code: (-?\d+)$/m.exec(String(response?.output ?? ''))?.[1];
  if (exit !== undefined && exit !== null && ev.action === 'command') ev.exit = Number(exit);
  if (!failed) return;
  const text = shell?.output || shell?.error || (typeof response?.error === 'string' ? response.error : '') || (typeof display === 'string' ? display : '');
  ev.error = tail(text || own?.status || 'failed');
}

/** Why an API call failed, from the status code and the provider's own words. */
function stopEvent(message, code, status, ts) {
  const words = `${code ?? ''} ${message ?? ''}`;
  const http = Number(status);
  let reason = 'error';
  if (/quota|billing|credit|balance/i.test(words)) reason = 'quota';
  else if (http === 429 || /rate.?limit|too many requests|throttl|resource.?exhausted/i.test(words)) reason = 'rate_limit';
  else if (http >= 500 || /overload|unavailable/i.test(words)) reason = 'overloaded';
  return { kind: 'stop', reason, message: String(message ?? ''), ts };
}

/** The summary the compaction left in the model-facing history, without the resume trailer. */
function compactionSummary(history) {
  for (const entry of Array.isArray(history) ? history.slice(0, 4) : []) {
    if (entry?.role !== 'user') continue;
    for (const p of entry.parts ?? []) {
      const text = visibleText(p);
      if (!text.includes(RESUME_TRAILER) && !text.includes('<state_snapshot>')) continue;
      const cut = text.lastIndexOf(RESUME_TRAILER);
      const body = (cut > 0 ? text.slice(0, cut) : text).trim();
      return body.replace(/^<state_snapshot>\s*|\s*<\/state_snapshot>$/g, '').trim();
    }
  }
  return '';
}

/**
 * @param {import('./index.js').Candidate} candidate
 * @param {import('./index.js').Context} ctx
 */
export async function loadSession(candidate, ctx) {
  const events = [];
  const calls = new Map();
  const atCommands = [];
  let slashTs = null;
  let pendingStop = null;
  let model;
  let branch;
  const flushStop = () => {
    if (pendingStop) events.push(pendingStop);
    pendingStop = null;
  };
  const prompt = (text, ts) => {
    flushStop();
    if (text) events.push({ kind: 'prompt', text, ts });
  };

  for (const r of activeChain(readJsonl(candidate.ref.file))) {
    if (!isMainline(r)) continue;
    const ts = r.timestamp ? Date.parse(r.timestamp) : undefined;
    if (r.gitBranch) branch = r.gitBranch;
    const p = r.systemPayload;

    if (r.type === 'system') {
      if (r.subtype === 'chat_compression') {
        const summary = compactionSummary(p?.compressedHistory);
        events.push({ kind: 'compaction', ts, trigger: p?.info?.triggerReason === 'manual' ? 'manual' : 'auto', ...(summary && { summary }) });
      } else if (r.subtype === 'slash_command') {
        // Only commands that became a model prompt are requests; /model, /about… are plumbing.
        if (p?.phase === 'invocation' && p.sentToModel === true && p.rawCommand) {
          if (!p.hiddenInvocation) prompt(String(p.rawCommand).trim(), ts);
          slashTs = ts ?? null;
        }
      } else if (r.subtype === 'at_command') {
        atCommands.push(p ?? {});
      } else if (r.subtype === 'session_model') {
        model ??= p?.modelId;
      } else if (r.subtype === 'ui_telemetry') {
        const e = p?.uiEvent;
        if (e?.['event.name'] === 'api_error') pendingStop = stopEvent(e.error_message, e.error_type, e.status_code, ts);
        else if (e?.['event.name'] === 'request_lifecycle' && e.phase === 'ended' && e.outcome === 'cancelled' && !e.subagentId) {
          if (events.at(-1)?.kind !== 'interrupt') events.push({ kind: 'interrupt', ts });
        }
      } else if (r.subtype === 'turn_result') {
        if (p?.state === 'cancelled' && events.at(-1)?.kind !== 'interrupt') events.push({ kind: 'interrupt', ts });
        else if (p?.state === 'error' && p.error) pendingStop = stopEvent(p.error.message, p.error.code, undefined, ts);
      }
    } else if (r.type === 'user') {
      if (r.subtype === 'mid_turn_user_message') prompt(promptText(r), ts);
      else if (isUserRecord(r)) {
        const fromSlash = slashTs !== null && ts !== undefined && ts - slashTs <= SLASH_WINDOW_MS;
        slashTs = null;
        const at = atCommands.shift();
        if (!fromSlash) prompt(at ? String(at.userText ?? '').trim() || promptText(r, true) : promptText(r), ts);
      }
    } else if (r.type === 'assistant') {
      pendingStop = null; // the request that failed was retried successfully
      atCommands.length = 0;
      if (r.model) model = r.model;
      const parts = Array.isArray(r.message?.parts) ? r.message.parts : [];
      const text = parts.map(visibleText).filter((t) => t.trim()).join('\n');
      const hasCalls = parts.some((x) => x?.functionCall);
      if (text) {
        const last = events.at(-1);
        if (last?.kind === 'reply') {
          last.text += `\n${text}`;
          last.final = !hasCalls;
        } else events.push({ kind: 'reply', text, ts, final: !hasCalls });
      }
      for (const { functionCall: fc } of parts.filter((x) => x?.functionCall)) {
        const ev = fc.name === 'todo_write' && Array.isArray(fc.args?.todos) ? planEvent(fc.args.todos, ts) : toolEvent(fc, ts);
        if (fc.id) calls.set(fc.id, ev);
        events.push(ev);
      }
    } else if (r.type === 'tool_result') {
      pendingStop = null;
      const own = r.toolCallResult;
      for (const { functionResponse: fr } of (Array.isArray(r.message?.parts) ? r.message.parts : []).filter((x) => x?.functionResponse)) {
        const ev = calls.get(fr.id ?? own?.callId);
        if (!ev) continue;
        const mine = own && (!own.callId || own.callId === (fr.id ?? own.callId)) ? own : undefined;
        if (ev.kind === 'plan') {
          if (mine?.status ? mine.status !== 'success' : fr.response?.error !== undefined) events.splice(events.indexOf(ev), 1);
        } else applyResult(ev, fr.response, mine);
      }
    }
  }
  flushStop();

  // Sessions started with `--worktree foo` live in that worktree's own store and need the flag again.
  const worktree = /[\\/]\.qwen[\\/]worktrees[\\/]([^\\/]+)$/.exec(candidate.cwd ?? '')?.[1];

  return {
    meta: {
      agent: name,
      sessionId: candidate.id,
      title: candidate.title,
      cwd: candidate.cwd,
      logFile: candidate.ref.file,
      startedAt: candidate.ref.startedAt,
      lastActivity: candidate.lastActivity,
      model,
      branch,
      resumeCommand: `qwen --resume ${candidate.id}${worktree ? ` --worktree=${worktree}` : ''}`,
    },
    events,
  };
}

/** Start Qwen Code interactively with a first prompt: a bare positional prompt runs one-shot, -i keeps the TUI open. */
export function launch(prompt) {
  return ['qwen', ['-i', prompt]];
}
