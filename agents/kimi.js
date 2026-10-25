/**
 * Built from upstream source; not verified against local data. The only local Kimi data is one
 * legacy session that holds a system prompt and no conversation: it confirmed the md5 bucket
 * layout and that such stubs are skipped, but no conversation record has been parsed from it.
 *
 * Kimi CLI adapter. Two storage generations share the `kimi` binary:
 *
 * Kimi Code CLI (current, TypeScript; github.com/MoonshotAI/kimi-code @ 7ccac2b, 2026-10-23)
 *   $KIMI_CODE_HOME|~/.kimi-code/sessions/wd_<slug>_<sha256(workDir)[:12]>/<sessionId>/
 *     state.json              title, cwd, archived, custom (child sessions), createdAt/updatedAt
 *     agents/main/wire.jsonl  journal, one {type, ...payload, time(ms)} per line
 *   plus a global session_index.jsonl of {sessionId, sessionDir, workDir}. Subagents
 *   live in agents/<id>/wire.jsonl and are never read.
 *   Upstream: packages/agent-core-v2/src/_base/utils/workdir-slug.ts (bucket key),
 *   workspace/sessionLifecycle/sessionLifecycleService.ts (index lines),
 *   session/sessionMetadata/{sessionMetadata,sessionMetadataService}.ts (state.json),
 *   docs/wire-manifest.d.ts + agent/contextMemory/{loopEventFold,contextEvents,conversationTime}.ts
 *   (records, loop events, undo anchors), agent/loop/{turnOps,turnEvents}.ts (turn.prompt,
 *   turn.steer, turn.ended, which origins are typed by the user), llm-adapter/contract/errors.ts
 *   (error names and codes), features/todo/todoOps.ts, apps/kimi-code/src/cli/commands.ts and
 *   docs/en/{reference/kimi-command,configuration/data-locations}.md.
 *   `kimi migrate` copies a Python session in as ses_<uuid> (packages/migration-legacy/src/sessions/
 *   {wire-writer,turn-structure,translator}.ts): protocol 1.0, one turn.prompt per Python user message,
 *   the whole conversation as context.append_message with nested function calls, no loop events,
 *   and state.json custom.kimi_cli_session_id. Both shapes are read.
 *
 * Python Kimi CLI (legacy, archived; github.com/MoonshotAI/kimi-cli @ 9ab1286, 2026-09-22)
 *   $KIMI_SHARE_DIR|~/.kimi/kimi.json         work_dirs[{path, kaos, last_session_id}]
 *   ~/.kimi/sessions/<md5(workDir)>/<uuid>/   context.jsonl (model history, no timestamps),
 *                                             wire.jsonl (timestamped UI journal), state.json
 *   Upstream: src/kimi_cli/{session,metadata,session_state,share}.py, soul/{context,compaction}.py,
 *   wire/{file,types}.py, cli/__init__.py. The wire journal is the richer source and is used when
 *   present; context.jsonl (roles starting with "_" are bookkeeping) is the fallback.
 *
 * Neither generation exports its session id to child processes, so `current` is never set.
 * Neither CLI can start interactively with a first prompt (`-p` runs one prompt and exits).
 */

import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { linesFromEnd, listDir, readJson, readJsonl, readText, statSafe, tryJson } from '../lib/fsx.js';

export const name = 'kimi';
export const label = 'Kimi CLI';

const MAX_PROBES = 40;
const TAIL_LINES = 3000;
const HEAD_BYTES = 256 * 1024;
const MAX_ERROR = 1500;
const RESUME = (id) => `kimi --session ${id}`;

const EDIT_TOOLS = new Set(['Write', 'Edit', 'WriteFile', 'StrReplaceFile']);
const READ_TOOLS = new Set(['Read', 'ReadFile', 'ReadMediaFile']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'SearchWeb']);
const SHELL_TOOLS = new Set(['Bash', 'Shell']);
const TODO_TOOLS = new Set(['TodoList', 'SetTodoList']);
const PLAN_STATUS = { done: 'done', in_progress: 'active', pending: 'pending' };

// Parts of a user message that the user never typed.
const HIDDEN_PART_SOURCES = new Set(['user prompt submit hook', 'skill activation']);
const HARNESS_TEXT = /^\s*<(system|system-reminder)>[\s\S]*<\/\1>\s*$/;
const MEDIA_TAG = /^\s*<(image|video|audio|file)\b[^>]*\bpath="[^"]*"[^>]*>(?:<\/\1>)?\s*$/;
const INLINE_NOISE = /<system-reminder>[\s\S]*?<\/system-reminder>|<system>Image compressed to fit model limits:[\s\S]*?<\/system>/g;
const EXIT_CODE = /exit(?:ed)?(?: with)? code:? (-?\d+)/i;
const PARTIAL_STEP_END = new Set(['max_tokens', 'interrupted', 'error', 'filtered']);

const COMPACTED = '<system>Previous context has been compacted. Here is the compaction output:</system>';
const LEGACY_BACKGROUND = /You are running in (?:non-interactive|afk) mode/;

// ── shared helpers ──────────────────────────────────────────────────────────

const toMs = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' ? Date.parse(v) || 0 : 0);

/** Content as a part list: Kimi stores either a bare string or [{type, ...}]. */
const partsOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);

const textOf = (content) =>
  partsOf(content)
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');

/** What the user actually typed, without hook output, skill bodies, media tags or reminders. */
function promptText(content, origin) {
  const shown = origin?.clientMetadata; // IDE clients record the text the user typed as display_text
  if (Array.isArray(shown) && shown.length && shown.every((m) => typeof m?.display_text === 'string')) {
    const typed = shown.map((m) => m.display_text).join('\n').trim();
    if (typed) return typed;
  }
  const out = [];
  for (const p of partsOf(content)) {
    if (p?.type === 'image_url' || p?.type === 'video_url' || p?.type === 'audio_url') out.push(`[${p.type.slice(0, 5)} attached]`);
    else if (p?.type === 'text' && typeof p.text === 'string') {
      if (HIDDEN_PART_SOURCES.has(p.meta?.source) || MEDIA_TAG.test(p.text) || HARNESS_TEXT.test(p.text)) continue;
      out.push(p.text.replace(INLINE_NOISE, ''));
    }
  }
  return out.join('\n').trim();
}

const tail = (text) => (text.length > MAX_ERROR ? text.slice(-MAX_ERROR) : text);

/** Output of a tool result: a string or a list of content parts. */
const outputText = (output) => (typeof output === 'string' ? output : textOf(output)).trim();

const absolute = (p, cwd) => (typeof p === 'string' && p && cwd && !isAbsolute(p) ? resolve(cwd, p) : p);

function toolEvent(tool, args, ts, id, cwd) {
  const a = args && typeof args === 'object' ? args : {};
  const base = { kind: 'tool', tool, ts, id };
  if (EDIT_TOOLS.has(tool)) return { ...base, action: 'edit', target: absolute(a.path ?? a.file_path, cwd) };
  if (SHELL_TOOLS.has(tool)) return { ...base, action: 'command', target: a.command };
  if (READ_TOOLS.has(tool)) return { ...base, action: 'read', target: absolute(a.path ?? a.file_path, cwd) };
  if (SEARCH_TOOLS.has(tool)) return { ...base, action: 'search', target: a.pattern ?? a.query };
  return { ...base, action: 'other', target: a.description ?? a.url ?? a.query ?? a.skill ?? undefined };
}

/** Record the outcome of a tool result on its event. */
function settle(ev, isError, text) {
  ev.ok = !isError;
  if (isError) ev.error = tail(text.replace(/<\/?system>/g, '')); // drop Kimi's <system>ERROR: …</system> markup
  if (ev.action !== 'command') return;
  // Kimi reports failures as "Command failed with exit code: N."; a success carries no code.
  const m = isError ? EXIT_CODE.exec(text) : null;
  if (m) ev.exit = Number(m[1]);
  else if (!isError) ev.exit = 0;
}

const pushIf = (events, ev) => ev && events.push(ev);
const promptEvent = (text, ts) => (text ? { kind: 'prompt', text, ts } : null);

/** Summary text when `content` is Python Kimi's compaction output message (first part is a fixed marker), else null. */
function compactionSummary(content) {
  const parts = partsOf(content);
  return parts[0]?.type === 'text' && parts[0].text?.trim() === COMPACTED ? textOf(parts.slice(1)).trim() : null;
}

function planEvent(todos, ts) {
  if (!Array.isArray(todos)) return null;
  return { kind: 'plan', ts, items: todos.map((t) => ({ text: t?.title ?? '', status: PLAN_STATUS[t?.status] ?? 'pending' })) };
}

/** The first `bytes` of a file as lines (the last may be cut mid-line and is dropped). */
function headLines(path, bytes = HEAD_BYTES) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    const lines = buf.toString('utf8', 0, n).split('\n');
    if (n === bytes) lines.pop();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** First record of a file's head for which `pick` returns something. */
function firstInHead(path, pick) {
  for (const line of headLines(path)) {
    const r = tryJson(line);
    const hit = r && pick(r);
    if (hit) return hit;
  }
  return null;
}

// ── Kimi Code CLI (current) ─────────────────────────────────────────────────

const codeHome = (ctx) => ctx.env.KIMI_CODE_HOME || join(ctx.home, '.kimi-code');

/** Bucket directory name upstream derives from a work directory (workdir-slug.ts). */
export function workDirKey(workDir) {
  const normalized = workDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const slug = basename(normalized)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  const safe = slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
  return `wd_${safe}_${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

// A user message the user typed (not an injection, notification or steer): what `context.undo` can remove.
const isAnchor = (o) => !o?.inTurn && (!o?.kind || o.kind === 'user' || ((o.kind === 'skill_activation' || o.kind === 'plugin_command') && o.trigger === 'user-slash'));

/** What the user typed in a prompt's origin and content; empty for injections, cron jobs, task notices and hook results. */
function typed(origin, content) {
  const o = origin ?? { kind: 'user' };
  if (o.kind === 'user') return promptText(content, o);
  if (isAnchor(o)) {
    const args = o.skillArgs ?? o.commandArgs;
    return `/${o.skillName ?? o.commandName}${args ? ` ${args}` : ''}`;
  }
  return '';
}

const turnText = (r) => typed(r.origin, r.input);
const bareUser = (r) => r.type === 'context.append_message' && r.message?.role === 'user' && isAnchor(r.message.origin);

const isCodeActivity = (r) =>
  r.type === 'turn.prompt' ||
  r.type === 'turn.steer' ||
  bareUser(r) ||
  (r.type === 'context.append_loop_event' && (r.event?.type === 'content.part' || r.event?.type === 'tool.call'));

/** Rank one session: last activity, title, first prompt, recorded cwd. Null for stubs and non-sessions. */
function probeCode(dir, wire) {
  const state = readJson(join(dir, 'state.json')) ?? readJson(join(dir, 'session-meta', 'state.json')) ?? {};
  if (state.archived === true || state.custom?.child_session_kind === 'child') return null;
  let lastActivity = 0;
  let scanned = 0;
  for (const line of linesFromEnd(wire, 256 * 1024)) {
    if (++scanned > TAIL_LINES) break;
    const r = tryJson(line);
    if (r && isCodeActivity(r)) {
      lastActivity = toMs(r.time) || toMs(state.updatedAt);
      break;
    }
  }
  if (!lastActivity) return null;
  const title = typeof state.title === 'string' && state.title.trim() && state.title !== 'New Session' ? state.title : undefined;
  // Journals older than turn.prompt only have the bare user message.
  const preview =
    firstInHead(wire, (r) => r.type === 'turn.prompt' && turnText(r)) ||
    firstInHead(wire, (r) => bareUser(r) && typed(r.message.origin, r.message.content));
  return {
    lastActivity,
    title,
    preview: preview || undefined,
    cwd: state.cwd ?? state.workDir,
    startedAt: toMs(state.createdAt) || undefined,
    importedFrom: state.custom?.kimi_cli_session_id, // set by `kimi migrate` on a copied Python session
  };
}

function codeSessions(project, ctx) {
  const sessionsDir = join(codeHome(ctx), 'sessions');
  const dirs = new Map(); // session dir -> work directory the index (or bucket) recorded for it
  const scores = new Map();
  const matches = (wd) => {
    if (!scores.has(wd)) scores.set(wd, project.match(wd));
    return scores.get(wd);
  };

  // The index also finds sessions started in a subdirectory of the project.
  for (const line of (readText(join(codeHome(ctx), 'session_index.jsonl')) ?? '').split('\n')) {
    const e = line.trim() ? tryJson(line) : null;
    if (typeof e?.sessionId !== 'string' || typeof e.workDir !== 'string' || typeof e.sessionDir !== 'string') continue;
    const bucket = e.sessionDir.split(/[\\/]/).at(-2);
    if (bucket && matches(e.workDir)) dirs.set(join(sessionsDir, bucket, e.sessionId), e.workDir);
  }
  // Without an index the picker's own lookup still works: one bucket per project root.
  for (const root of project.roots) {
    const bucket = join(sessionsDir, workDirKey(root));
    for (const d of listDir(bucket)) {
      if (d.isDirectory() && !dirs.has(join(bucket, d.name))) dirs.set(join(bucket, d.name), root);
    }
  }

  const files = [];
  for (const [dir, workDir] of dirs) {
    const wire = join(dir, 'agents', 'main', 'wire.jsonl');
    const st = statSafe(wire);
    if (st && st.size > 0) files.push({ dir, wire, workDir, mtime: st.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const out = [];
  for (const f of files.slice(0, MAX_PROBES)) {
    const p = probeCode(f.dir, f.wire);
    if (!p) continue;
    const cwd = p.cwd ?? f.workDir;
    const score = project.match(cwd);
    if (!score) continue;
    out.push({
      agent: name,
      id: basename(f.dir),
      lastActivity: p.lastActivity,
      score,
      cwd,
      title: p.title,
      preview: p.preview || undefined,
      ref: { era: 'code', file: f.wire, startedAt: p.startedAt, importedFrom: p.importedFrom },
    });
  }
  return out;
}

/** Stop event from a turn.ended error payload, whose `cause` chain ends at the provider error. */
function stopEvent(error, ts) {
  const chain = [];
  for (let e = error; e && chain.length < 9; e = e.cause) chain.push(e);
  const reason = chain.some((e) => e.name === 'APIProviderQuotaExhaustedError')
    ? 'quota'
    : chain.some((e) => e.code === 'provider.rate_limit')
      ? 'rate_limit'
      : chain.some((e) => e.code === 'provider.overloaded')
        ? 'overloaded'
        : 'error';
  const source = chain.find((e) => /^provider\./.test(e.code)) ?? chain[0];
  return { kind: 'stop', reason, message: source?.message, ts };
}

function loadCode(candidate) {
  const events = [];
  const tools = new Map();
  const anchors = []; // indices into events of the prompts `context.undo` can remove
  const cwd = candidate.cwd;
  const records = readJsonl(candidate.ref.file);
  const journaled = records.some((r) => r.type === 'turn.prompt');
  let model;
  let bound;
  let trigger;
  let reply = null; // visible text of the step being streamed
  let lastReply = null; // last assistant message of the turn, for journals without step.end

  const addCall = (name, args, ts, id) => {
    if (TODO_TOOLS.has(name)) return; // the plan comes from tools.update_store
    const call = toolEvent(name, typeof args === 'string' ? tryJson(args) : args, ts, id, cwd);
    tools.set(id, call);
    events.push(call);
  };

  for (const r of records) {
    const ts = toMs(r.time) || undefined;
    switch (r.type) {
      case 'turn.prompt':
      case 'turn.steer': {
        if (!r.origin?.inTurn) anchors.push(events.length);
        lastReply = null;
        // A session copied from Python Kimi carries its compaction message as a prompt.
        const summary = r.type === 'turn.prompt' ? compactionSummary(r.input) : null;
        if (summary !== null) events.push({ kind: 'compaction', ts, ...(summary ? { summary } : {}) });
        else pushIf(events, promptEvent(turnText(r), ts));
        break;
      }
      case 'context.append_message': {
        // Native journals only append user messages here (their prompt is the turn.prompt record);
        // sessions copied from Python Kimi keep the whole conversation as messages.
        const m = r.message ?? {};
        if (m.role === 'user') {
          if (journaled) break;
          if (isAnchor(m.origin)) anchors.push(events.length);
          pushIf(events, promptEvent(typed(m.origin, m.content), ts));
        } else if (m.role === 'assistant') {
          const text = textOf(m.content).trim();
          if (text) events.push((lastReply = { kind: 'reply', text, ts }));
          for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) addCall(c.name ?? c.function?.name, c.arguments ?? c.function?.arguments, ts, c.id);
        } else if (m.role === 'tool') {
          const call = tools.get(m.toolCallId);
          const text = textOf(m.content);
          if (call) settle(call, m.isError === true || text.trimStart().startsWith('<system>ERROR:'), text);
        }
        break;
      }
      case 'context.append_loop_event': {
        const ev = r.event ?? {};
        if (ev.type === 'step.begin') reply = null;
        else if (ev.type === 'content.part') {
          const text = ev.part?.type === 'text' ? ev.part.text : '';
          if (!text?.trim()) break;
          if (reply) reply.text += `\n${text}`;
          else events.push((reply = { kind: 'reply', text, ts, final: false, partial: true }));
        } else if (ev.type === 'step.end') {
          if (reply) Object.assign(reply, { final: ev.finishReason === 'end_turn', partial: PARTIAL_STEP_END.has(ev.finishReason) });
          reply = null;
        } else if (ev.type === 'tool.call') addCall(ev.name, ev.args, ts, ev.toolCallId);
        else if (ev.type === 'tool.result') {
          const call = tools.get(ev.toolCallId);
          if (call) settle(call, ev.result?.isError === true, outputText(ev.result?.output) || ev.result?.note || '');
        }
        break;
      }
      case 'tools.update_store':
        if (r.key === 'todo') pushIf(events, planEvent(r.value, ts));
        break;
      case 'full_compaction.begin':
        trigger = r.source;
        break;
      case 'full_compaction.cancel':
        trigger = undefined;
        break;
      case 'context.apply_compaction': {
        // The summary is a string (current) or a context message (older records).
        const summary = (typeof r.summary === 'string' ? r.summary : textOf(r.summary?.content) || r.contextSummary || '').trim();
        events.push({ kind: 'compaction', trigger, ts, ...(summary ? { summary } : {}) });
        trigger = undefined;
        anchors.length = 0;
        break;
      }
      case 'context.undo': {
        const n = Math.min(Number(r.count) || 0, anchors.length);
        if (n > 0) events.length = anchors[anchors.length - n];
        anchors.length -= Math.max(n, 0);
        break;
      }
      case 'context.clear':
        events.length = 0;
        anchors.length = 0;
        break;
      case 'turn.ended':
        if (r.reason === 'cancelled') events.push({ kind: 'interrupt', ts });
        else if (r.reason === 'failed') events.push(stopEvent(r.error, ts));
        else if (lastReply) lastReply.final = true;
        break;
      case 'llm.request':
        model = r.model ?? model;
        break;
      case 'profile.bind':
        bound = r.modelAlias ?? bound;
        break;
    }
  }

  return { events, model: model ?? bound };
}

// ── Python Kimi CLI (legacy) ────────────────────────────────────────────────

const legacyHome = (ctx) => ctx.env.KIMI_SHARE_DIR || join(ctx.home, '.kimi');
const LEGACY_ACTIVITY = new Set(['TurnBegin', 'SteerInput', 'ContentPart', 'ToolCall']);

/** Events from context.jsonl, the model-facing history. It carries no timestamps. */
function legacyContextEvents(records, cwd) {
  const events = [];
  const calls = new Map();
  for (const r of records) {
    if (typeof r?.role !== 'string' || r.role.startsWith('_')) continue;
    const parts = partsOf(r.content);
    if (r.role === 'user') {
      const summary = compactionSummary(parts);
      if (summary !== null) events.push({ kind: 'compaction', ...(summary ? { summary } : {}) });
      else pushIf(events, promptEvent(promptText(parts)));
    } else if (r.role === 'assistant') {
      const text = textOf(parts).trim();
      if (text) events.push({ kind: 'reply', text });
      for (const c of Array.isArray(r.tool_calls) ? r.tool_calls : []) {
        const args = tryJson(c.function?.arguments);
        const call = { name: c.function?.name, args };
        if (!TODO_TOOLS.has(call.name)) events.push((call.ev = toolEvent(call.name, args, undefined, c.id, cwd)));
        calls.set(c.id, call);
      }
    } else if (r.role === 'tool') {
      const call = calls.get(r.tool_call_id);
      if (!call) continue;
      const text = textOf(parts);
      const failed = text.trimStart().startsWith('<system>ERROR:');
      if (call.ev) settle(call.ev, failed, text);
      else if (!failed) pushIf(events, planEvent(call.args?.todos));
    }
  }
  return events;
}

/** Events from wire.jsonl, the timestamped journal the UI is fed from. */
function legacyWireEvents(records, cwd) {
  const events = [];
  const calls = new Map();
  let lastCall = null;
  let step = null; // the reply being streamed in the current step
  let lastReply = null;
  for (const rec of records) {
    const m = rec?.message;
    if (typeof m?.type !== 'string') continue; // header line, or not a wire record
    const p = m.payload ?? {};
    const ts = toMs(rec.timestamp * 1000) || undefined;
    switch (m.type) {
      case 'TurnBegin':
      case 'SteerInput': {
        const text = promptText(p.user_input);
        if (text) events.push({ kind: 'prompt', text, ts });
        step = lastReply = null;
        break;
      }
      case 'StepBegin':
        step = null;
        break;
      case 'ContentPart': {
        if (p.type !== 'text' || !p.text?.trim()) break;
        if (step) step.text += `\n${p.text}`;
        else events.push((lastReply = step = { kind: 'reply', text: p.text, ts }));
        break;
      }
      case 'ToolCall': {
        // Streamed arguments can arrive later as ToolCallPart records.
        const call = { name: p.function?.name, args: p.function?.arguments ?? '', id: p.id };
        if (!TODO_TOOLS.has(call.name)) events.push((call.ev = toolEvent(call.name, tryJson(call.args), ts, p.id, cwd)));
        calls.set(p.id, call);
        lastCall = call;
        break;
      }
      case 'ToolCallPart': {
        if (!lastCall) break;
        lastCall.args += p.arguments_part ?? '';
        if (lastCall.ev) Object.assign(lastCall.ev, toolEvent(lastCall.name, tryJson(lastCall.args), lastCall.ev.ts, lastCall.id, cwd));
        break;
      }
      case 'ToolResult': {
        const call = calls.get(p.tool_call_id);
        const rv = p.return_value ?? {};
        if (!call) break;
        const text = [rv.message, outputText(rv.output ?? '')].filter(Boolean).join('\n');
        if (call.ev) settle(call.ev, rv.is_error === true, text);
        else if (rv.is_error !== true) pushIf(events, planEvent(tryJson(call.args)?.todos, ts));
        break;
      }
      case 'StepInterrupted':
        events.push({ kind: 'interrupt', ts });
        step = null;
        break;
      case 'CompactionEnd':
        events.push({ kind: 'compaction', ts });
        break;
      case 'TurnEnd':
        if (lastReply) lastReply.final = true;
        break;
    }
  }
  return events;
}

/** True for a print-mode run: the harness tells the model no user is present. */
function legacyBackground(dir) {
  return headLines(join(dir, 'context.jsonl'), 128 * 1024)
    .slice(0, 8)
    .some((line) => {
      const text = textOf(tryJson(line)?.content).trim();
      return HARNESS_TEXT.test(text) && LEGACY_BACKGROUND.test(text);
    });
}

function probeLegacy(dir, cwd) {
  const state = readJson(join(dir, 'state.json')) ?? {};
  if (state.archived === true) return null;
  const wire = join(dir, 'wire.jsonl');
  let lastActivity = 0;
  let scanned = 0;
  for (const line of linesFromEnd(wire, 256 * 1024)) {
    if (++scanned > TAIL_LINES) break;
    const rec = tryJson(line);
    if (LEGACY_ACTIVITY.has(rec?.message?.type)) {
      lastActivity = toMs(rec.timestamp * 1000);
      break;
    }
  }
  const first = lastActivity ? firstInHead(wire, (r) => r.message?.type === 'TurnBegin' && r) : null;
  let preview = first ? promptText(first.message.payload?.user_input) : '';
  let startedAt = first ? toMs(first.timestamp * 1000) || undefined : undefined;
  if (!lastActivity) {
    // No wire journal: fall back to the model history, whose only clock is the file mtime.
    const context = join(dir, 'context.jsonl');
    preview = legacyContextEvents(readJsonl(context), cwd).find((e) => e.kind === 'prompt')?.text ?? '';
    if (!preview) return null;
    lastActivity = statSafe(context)?.mtimeMs ?? 0;
    startedAt = undefined;
  }
  return { lastActivity, preview, startedAt, title: state.custom_title || undefined, background: legacyBackground(dir) };
}

function legacySessions(project, ctx) {
  const home = legacyHome(ctx);
  const meta = readJson(join(home, 'kimi.json'));
  const workDirs = new Set(project.roots);
  for (const wd of Array.isArray(meta?.work_dirs) ? meta.work_dirs : []) {
    if (typeof wd?.path === 'string' && (!wd.kaos || wd.kaos === 'local') && project.match(wd.path)) workDirs.add(wd.path);
  }

  const files = [];
  for (const cwd of workDirs) {
    const bucket = join(home, 'sessions', createHash('md5').update(cwd).digest('hex'));
    for (const d of listDir(bucket)) {
      if (!d.isDirectory()) continue;
      const dir = join(bucket, d.name);
      const st = statSafe(join(dir, 'wire.jsonl')) ?? statSafe(join(dir, 'context.jsonl'));
      if (st) files.push({ dir, cwd, mtime: st.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const out = [];
  for (const f of files.slice(0, MAX_PROBES)) {
    const p = probeLegacy(f.dir, f.cwd);
    const score = p && project.match(f.cwd);
    if (!score) continue;
    out.push({
      agent: name,
      id: basename(f.dir),
      lastActivity: p.lastActivity,
      score,
      cwd: f.cwd,
      title: p.title,
      preview: p.preview || undefined,
      background: p.background,
      ref: { era: 'legacy', dir: f.dir, startedAt: p.startedAt },
    });
  }
  return out;
}

function loadLegacy(candidate) {
  const dir = candidate.ref.dir;
  const wire = readJsonl(join(dir, 'wire.jsonl'));
  const journaled = wire.some((r) => r?.message?.type === 'TurnBegin');
  const events = journaled
    ? legacyWireEvents(wire, candidate.cwd)
    : legacyContextEvents(readJsonl(join(dir, 'context.jsonl')), candidate.cwd);

  if (journaled) {
    // The journal marks where a compaction happened; only context.jsonl holds the summary,
    // and compaction rotates the older history away, so it belongs to the last compaction.
    const last = events.findLast((e) => e.kind === 'compaction');
    const summary = last && legacyContextEvents(readJsonl(join(dir, 'context.jsonl'))).findLast((e) => e.kind === 'compaction')?.summary;
    if (summary) last.summary = summary;
  }
  return { events, model: undefined, logFile: join(dir, journaled ? 'wire.jsonl' : 'context.jsonl') };
}

// ── adapter contract ────────────────────────────────────────────────────────

/**
 * @param {import('../lib/project.js').Project} project
 * @param {import('./index.js').Context} ctx
 * @returns {Promise<import('./index.js').Candidate[]>}
 */
export async function findSessions(project, ctx) {
  const found = codeSessions(project, ctx);
  // `kimi migrate` copies a Python session into the current store as ses_<uuid> and records the origin.
  const migrated = new Set(found.flatMap((c) => [c.ref.importedFrom, c.id.replace(/^ses_/, '')]));
  for (const c of legacySessions(project, ctx)) if (!migrated.has(c.id)) found.push(c);
  return found.sort((a, b) => b.lastActivity - a.lastActivity);
}

/**
 * @param {import('./index.js').Candidate} candidate
 * @param {import('./index.js').Context} ctx
 */
export async function loadSession(candidate, ctx) {
  const legacy = candidate.ref.era === 'legacy';
  const { events, model, logFile } = legacy ? loadLegacy(candidate) : { ...loadCode(candidate), logFile: candidate.ref.file };
  return {
    meta: {
      agent: name,
      sessionId: candidate.id,
      title: candidate.title,
      cwd: candidate.cwd,
      logFile,
      startedAt: candidate.ref.startedAt,
      lastActivity: candidate.lastActivity,
      model,
      resumeCommand: RESUME(candidate.id),
    },
    events,
  };
}

/** Neither Kimi CLI generation can open the interactive UI with a first prompt: -p runs it and exits. */
export function launch() {
  return null;
}
