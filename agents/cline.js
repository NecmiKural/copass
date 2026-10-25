/**
 * Cline adapter.
 *
 * Cline keeps two stores and a machine can have both:
 *
 * SDK store (CLI 3.x, VS Code extension 4.x): $CLINE_SESSION_DATA_DIR or
 * <data>/sessions/<id>/{<id>.json manifest, <id>.messages.json, <id>.compaction.json},
 * where <data> is $CLINE_DATA_DIR or ($CLINE_DIR or ~/.cline)/data. <data>/db/sessions.db
 * indexes the same rows; the manifests are the fallback when it cannot be read.
 * Subagent transcripts live inside their root's directory under other stems, and
 * sub-session ids contain '__', so neither is ever listed as a session.
 *
 * Legacy task store (VS Code extension 3.x and the editors it runs in, CLI 2.x in
 * <data>): <base>/state/taskHistory.json (unsorted HistoryItem[] with the launch
 * cwd) and <base>/tasks/<id>/ui_messages.json, the rows the user saw. The
 * model-facing api_conversation_history.json is never read: it is mostly harness text.
 */

import { dirname, isAbsolute, join, resolve } from 'node:path';

import { linesFromEnd, listDir, readJson, readText, statSafe, tryJson } from '../lib/fsx.js';
import { queryAll } from '../lib/sqlite.js';
import { oneLine } from '../lib/text.js';

export const name = 'cline';
export const label = 'Cline';

const EXTENSION_ID = 'saoudrizwan.claude-dev';
// VS Code and the forks the 3.x extension runs in; each keeps its own globalStorage.
const EDITORS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf', 'Antigravity'];

const LEGACY_TOOLS = {
  editedExistingFile: 'edit',
  newFileCreated: 'edit',
  fileDeleted: 'edit',
  appliedDiff: 'edit',
  readFile: 'read',
  listFilesTopLevel: 'read',
  listFilesRecursive: 'read',
  listCodeDefinitionNames: 'read',
  searchFiles: 'search',
  codebaseSearch: 'search',
  webSearch: 'search',
};
// SDK tools, plus the 3.x names that legacy tasks resumed in VS Code 4.x carry over.
const SDK_TOOLS = {
  editor: 'edit',
  apply_patch: 'edit',
  write_to_file: 'edit',
  replace_in_file: 'edit',
  run_commands: 'command',
  execute_command: 'command',
  read_files: 'read',
  read_file: 'read',
  list_files: 'read',
  list_code_definition_names: 'read',
  search_codebase: 'search',
  search_files: 'search',
};
// Tools whose input is text shown to the user as the agent's message.
const REPLY_TOOLS = {
  attempt_completion: { field: 'result', final: true },
  submit_and_exit: { field: 'summary', final: true },
  plan_mode_respond: { field: 'response', final: true },
  act_mode_respond: { field: 'response' },
  ask_question: { field: 'question' },
  ask_followup_question: { field: 'question' },
};

// What hosts wrap around typed text: <user_input>/<user_command> (SDK), <task>/<feedback>/… (3.x).
const ENVELOPE = /<user_input\b|<user_command\b|<(?:task|feedback|answer|user_message)>/;
const HARNESS_BLOCK = /<(environment_details|mode_notice|explicit_instructions|file_content)\b[^>]*>[\s\S]*?<\/\1>/g;
const LEGACY_WRAPPER = /<(task|feedback|answer|user_message)>([\s\S]*?)<\/\1>/g;
const THINKING = /<thinking>[\s\S]*?<\/thinking>/g;
// A text that opens with tool-call syntax is a call the model wrote out instead of making
// (`<tool_name>list_files</tool_name>\n<path>…`, a lone `</tool_call>`), not something it said.
const TOOL_MARKUP = /^<\/?(?:tool_\w+|function_calls)>/;
const TS_KEY = /(?<!\\)"ts":\s*(\d{10,})/g;
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

function dataDir(ctx) {
  return ctx.env.CLINE_DATA_DIR ?? join(ctx.env.CLINE_DIR ?? join(ctx.home, '.cline'), 'data');
}

function sessionsDir(ctx) {
  return ctx.env.CLINE_SESSION_DATA_DIR ?? join(dataDir(ctx), 'sessions');
}

/** Every legacy store: the CLI 2.x one in <data>, then each editor's globalStorage. */
function legacyBases(ctx) {
  const appData =
    ctx.platform === 'darwin'
      ? join(ctx.home, 'Library', 'Application Support')
      : ctx.platform === 'win32'
        ? (ctx.env.APPDATA ?? join(ctx.home, 'AppData', 'Roaming'))
        : (ctx.env.XDG_CONFIG_HOME ?? join(ctx.home, '.config'));
  return [
    { dir: dataDir(ctx), cli: true },
    ...EDITORS.map((app) => ({ dir: join(appData, app, 'User', 'globalStorage', EXTENSION_ID) })),
    { dir: join(ctx.home, '.vscode-server', 'data', 'User', 'globalStorage', EXTENSION_ID) },
  ];
}

/** Root SDK sessions from the sessions.db index, or from the manifests when it cannot be read. */
async function sdkRows(ctx) {
  const db = join(ctx.env.CLINE_DB_DATA_DIR ?? join(dataDir(ctx), 'db'), 'sessions.db');
  const rows = await queryAll(
    db,
    `SELECT session_id, cwd, workspace_root, status, interactive, started_at, ended_at, model, prompt,
            messages_path, metadata_json FROM sessions WHERE is_subagent = 0 AND parent_session_id IS NULL`,
  );
  if (rows) return rows.map((r) => ({ ...r, metadata: tryJson(r.metadata_json ?? '') ?? {} }));
  const dir = sessionsDir(ctx);
  return listDir(dir)
    .filter((d) => d.isDirectory() && !d.name.includes('__'))
    .map((d) => readJson(join(dir, d.name, `${d.name}.json`)))
    .filter((m) => typeof m?.session_id === 'string');
}

/** ts of the last message in a messages.json, read from the end; null when it holds none. */
function lastMessageTs(file) {
  for (const line of linesFromEnd(file, 64 * 1024)) {
    const hits = [...line.matchAll(TS_KEY)];
    if (hits.length) return Number(hits.at(-1)[1]);
  }
  return null;
}

/**
 * @param {import('../lib/project.js').Project} project
 * @param {import('./index.js').Context} ctx
 * @returns {Promise<import('./index.js').Candidate[]>}
 */
export async function findSessions(project, ctx) {
  const memo = new Map();
  const score = (...dirs) =>
    Math.max(
      0,
      ...dirs.filter(Boolean).map((d) => {
        if (!memo.has(d)) memo.set(d, project.match(d));
        return memo.get(d);
      }),
    );

  const out = [];
  for (const row of await sdkRows(ctx)) {
    const s = score(row.cwd, row.workspace_root);
    if (!s) continue;
    const id = row.session_id;
    const file = row.messages_path || join(sessionsDir(ctx), id, `${id}.messages.json`);
    const lastActivity = lastMessageTs(file);
    if (!lastActivity) continue; // opened but never used
    out.push({
      agent: name,
      id,
      lastActivity,
      score: s,
      cwd: row.cwd || row.workspace_root,
      title: row.metadata?.title || undefined,
      preview: userText(row.prompt) || undefined,
      background: row.interactive === false || row.interactive === 0,
      ref: { kind: 'sdk', file, row },
    });
  }

  const seen = new Set(out.map((c) => c.id));
  for (const base of legacyBases(ctx)) {
    const history = readJson(join(base.dir, 'state', 'taskHistory.json'));
    for (const h of Array.isArray(history) ? history : []) {
      const id = String(h?.id ?? '');
      // A legacy task resumed in VS Code 4.x continues as the SDK session with the same id.
      if (!id || !h.task || !h.ts || seen.has(id)) continue;
      const s = score(h.cwdOnTaskInitialization);
      if (!s) continue;
      const dir = join(base.dir, 'tasks', id);
      const file = join(dir, 'ui_messages.json');
      if (!statSafe(file)) continue; // deleted task
      seen.add(id);
      out.push({
        agent: name,
        id,
        lastActivity: Number(h.ts), // last non-resume row; the file mtime moves when a task is merely reopened
        score: s,
        cwd: h.cwdOnTaskInitialization,
        preview: h.task,
        ref: { kind: 'legacy', file, dir, cli: Boolean(base.cli), model: h.modelId, startedAt: Number(id) || undefined },
      });
    }
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}

// ── Shared event helpers ────────────────────────────────────────────────

/**
 * Event collector. An error stays a stop only while no reply or tool call follows
 * it (auto-retries that succeeded are not why the session stopped), and only the
 * last error of a run of them is kept. Repeated identical plans are dropped.
 */
function eventLog() {
  const events = [];
  let anchor = -1; // index of the last prompt, reply or tool event
  let plan = '';
  const dropStops = () => {
    for (let k = events.length - 1; k > anchor; k--) if (events[k].kind === 'stop') events.splice(k, 1);
  };
  return {
    events,
    push(ev) {
      if (!ev) return ev;
      if (ev.kind === 'plan') {
        const key = JSON.stringify(ev.items);
        if (key === plan) return ev;
        plan = key;
      }
      if (ev.kind === 'reply' || ev.kind === 'tool' || ev.kind === 'stop') dropStops();
      events.push(ev);
      if (ev.kind === 'prompt' || ev.kind === 'reply' || ev.kind === 'tool') anchor = events.length - 1;
      return ev;
    },
  };
}

/** Cline's markdown checklist ('- [x] done', '- [ ] open') as a plan event. */
function planFromChecklist(text, ts) {
  const items = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*[-*]\s*\[([ xX])\]\s+(.+)$/.exec(line);
    if (m) items.push({ text: m[2].trim(), status: m[1] === ' ' ? 'pending' : 'done' });
  }
  return items.length ? { kind: 'plan', items, ts } : null;
}

function stopReason(text, status) {
  const code = status ?? Number(/\b([45]\d\d)\b/.exec(text)?.[1]);
  if (code === 402 || /quota|usage limit|insufficient[_ ](?:balance|funds|credits?|quota)|credits?\b|billing|payment required/i.test(text))
    return 'quota';
  if (code === 429 || /rate.?limit|too many requests/i.test(text)) return 'rate_limit';
  if (code >= 500 || /overloaded/i.test(text)) return 'overloaded';
  return 'error';
}

/** A stop from a provider error, which Cline stores as JSON nested in JSON strings. */
function apiStop(raw, ts) {
  const text = String(raw ?? '');
  let message = text;
  let status;
  for (let depth = 0; depth < 5; depth++) {
    const at = message.indexOf('{');
    const j = at < 0 ? null : tryJson(message.slice(at));
    if (!j || typeof j !== 'object') break;
    status ??= Number(j.status ?? j.error?.code) || undefined;
    const inner = j.error?.message ?? j.message ?? j.errorMessage;
    if (typeof inner !== 'string' || !inner.trim()) break;
    message = inner;
  }
  const delay = /retry(?:Delay\\*"?\s*:\s*\\*"?|\s+in\s+)(\d+(?:\.\d+)?)s/i.exec(text);
  return {
    kind: 'stop',
    reason: stopReason(text, status),
    message: oneLine(message, 500) || undefined,
    ts,
    resetsAt: delay && ts ? ts + Math.round(Number(delay[1]) * 1000) : undefined,
  };
}

/** File targets made absolute against the session cwd (3.x records them relative). */
function absolute(target, action, cwd) {
  const isPath = action === 'edit' || action === 'read';
  return isPath && typeof target === 'string' && cwd && !isAbsolute(target) ? resolve(cwd, target) : target;
}

const stripThinking = (s) => String(s ?? '').replace(THINKING, '').trim();
const visibleText = (s) => {
  const text = stripThinking(s);
  return TOOL_MARKUP.test(text) ? '' : text;
};

/** What the user typed, from a model-facing user text: envelopes unwrapped, harness blocks removed. */
function userText(raw) {
  const text = String(raw ?? '').replace(HARNESS_BLOCK, '');
  if (/^\s*\[[^\]\n]+\] Result:/.test(text)) return ''; // a 3.x tool result
  // A 4.x envelope wins: <task>/<feedback> inside it are words the user typed.
  const sdk = /<user_input\b|<user_command\b/.test(text);
  const wrapped = sdk ? [] : [...text.matchAll(LEGACY_WRAPPER)].map((m) => m[2].trim()).filter(Boolean);
  if (wrapped.length) return wrapped.join('\n');
  if (/^\s*\[TASK RESUMPTION\]/.test(text)) return '';
  const slash = /<user_command\b[^>]*\bslash="([^"]+)"/.exec(text)?.[1];
  const body = text.replace(/<\/?(?:user_input|user_command)\b[^>]*>/g, '').trim();
  return slash ? `/${slash}${body ? ` ${body}` : ''}` : body;
}

// ── Legacy task store ──────────────────────────────────────────────────

/** A partial text row is a stale stream snapshot when another text row follows in the same request. */
function staleSnapshot(rows, i) {
  for (let k = i + 1; k < rows.length; k++) {
    if (rows[k]?.say === 'api_req_started') return false;
    if (rows[k]?.say === 'text') return true;
  }
  return false;
}

function legacyPrompt(u) {
  const parts = [
    String(u.text ?? '').trim(),
    ...(Array.isArray(u.images) ? u.images : []).map(() => '[image attached]'),
    ...(Array.isArray(u.files) ? u.files : []).map((f) => `[file attached: ${f}]`),
  ];
  const text = parts.filter(Boolean).join('\n');
  return text ? { kind: 'prompt', text, ts: u.ts } : null;
}

function legacyText(u, i, rows) {
  const text = visibleText(u.text);
  if (!text || tryJson(text)?.tokensIn !== undefined) return null; // usage stats leaked into a text row
  if (u.partial && staleSnapshot(rows, i)) return null;
  return { kind: 'reply', text, ts: u.ts, ...(u.partial && { partial: true }) };
}

function legacyTool(j, ts, cwd) {
  if (j.tool === 'summarizeTask') return { kind: 'compaction', summary: stripThinking(j.content) || undefined, ts };
  const action = LEGACY_TOOLS[j.tool] ?? 'other';
  const target = action === 'search' ? (j.regex ?? j.query ?? j.path) : (j.path ?? j.url ?? j.query);
  return { kind: 'tool', tool: j.tool, action, target: absolute(target, action, cwd), ts };
}

// Partial rows that are final as they are: an interrupted text stream, a plan_mode_respond with
// needs_more_exploration (never completed, yet shown), a diff_error. Other kinds are updated in place.
const PARTIAL_KEPT = new Set(['text', 'ask:plan_mode_respond', 'diff_error']);

/** One ui_messages.json row as an event, or null for noise (reasoning, hooks, checkpoints…). */
function rowEvent(u, i, rows, cwd) {
  if (!u || typeof u !== 'object') return null;
  const kind = u.type === 'ask' ? `ask:${u.ask}` : u.say;
  if (u.partial && !PARTIAL_KEPT.has(kind)) return null; // a stream snapshot; the finished row follows
  const json = () => tryJson(u.text ?? '') ?? {};
  const reply = (raw, final) => {
    const text = String(raw ?? '').trim();
    return text ? { kind: 'reply', text, ts: u.ts, ...(final && { final }) } : null;
  };
  switch (kind) {
    case 'task':
    case 'user_feedback':
      return legacyPrompt(u);
    case 'text':
      return legacyText(u, i, rows);
    case 'completion_result':
      return reply(String(u.text ?? '').replace(/\s*HAS_CHANGES\s*$/, ''), true);
    case 'ask:followup':
      return reply(json().question ?? u.text);
    case 'ask:plan_mode_respond': // left partial when the model asked to explore more: shown, but not the answer
      return reply(json().response ?? u.text, !u.partial);
    case 'diff_error': {
      // A replace_in_file whose SEARCH block did not match: the edit was not applied.
      const target = absolute(String(u.text ?? '').trim(), 'edit', cwd) || undefined;
      return { kind: 'tool', tool: 'replace_in_file', action: 'edit', target, ok: false, ts: u.ts };
    }
    case 'tool':
    case 'ask:tool': {
      const j = json();
      return j.tool ? legacyTool(j, u.ts, cwd) : null;
    }
    case 'command':
    case 'ask:command': {
      const command = String(u.text ?? '').replace(/REQ_APP\s*$/, '').trim();
      return command ? { kind: 'tool', tool: 'execute_command', action: 'command', target: command, ts: u.ts } : null;
    }
    case 'ask:condense': // /smol: the user is shown the summary the context is condensed to
      return { kind: 'compaction', summary: stripThinking(u.text) || undefined, trigger: 'manual', ts: u.ts };
    case 'task_progress':
      return planFromChecklist(u.text, u.ts);
    case 'api_req_started': {
      const j = json();
      if (j.cancelReason === 'user_cancelled') return { kind: 'interrupt', ts: u.ts };
      return j.cancelReason ? apiStop(j.streamingFailedMessage || j.cancelReason, u.ts) : null;
    }
    case 'error_retry':
      return apiStop(json().errorMessage ?? u.text, u.ts);
    case 'ask:api_req_failed':
      return apiStop(u.text, u.ts);
    case 'ask:mistake_limit_reached':
    case 'error':
      return { kind: 'stop', reason: 'error', message: oneLine(u.text, 500) || undefined, ts: u.ts };
    default:
      return null;
  }
}

function loadLegacy(candidate) {
  const { file, dir } = candidate.ref;
  const parsed = readJson(file) ?? readJson(file); // retry once: the extension rewrites it while running
  const rows = Array.isArray(parsed) ? parsed : [];
  const log = eventLog();
  let model = candidate.ref.model;
  rows.forEach((u, i) => {
    if (u?.modelInfo?.modelId) model = u.modelInfo.modelId;
    log.push(rowEvent(u, i, rows, candidate.cwd));
  });
  // task_progress rows mirror the focus-chain file; read it only when they are missing.
  if (!log.events.some((e) => e.kind === 'plan')) {
    const path = join(dir, `focus_chain_taskid_${candidate.id}.md`);
    log.push(planFromChecklist(readText(path), statSafe(path)?.mtimeMs));
  }
  return {
    meta: {
      logFile: file,
      startedAt: rows[0]?.ts ?? candidate.ref.startedAt,
      model,
      resumeCommand: candidate.ref.cli ? `cline --taskId ${candidate.id}` : undefined,
    },
    events: log.events,
  };
}

// ── SDK session store ──────────────────────────────────────────────────

const blocksOf = (m) =>
  typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
const textsOf = (m) => blocksOf(m).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);

/** File, command or query targets of one tool call (some tools batch several). */
function targets(action, input) {
  const list = (v) => [v].flat();
  switch (action) {
    case 'edit': {
      const patch = typeof input === 'string' ? input : input?.input;
      const files = [...String(patch ?? '').matchAll(PATCH_FILE)].map((m) => m[1].trim());
      return files.length ? files : [input?.path ?? input?.absolutePath];
    }
    case 'command': // a string, {command, args}, or a list of either
      return list(input?.commands ?? (input?.args ? input : input?.command) ?? input?.cmd ?? input).map((c) =>
        typeof c === 'string' ? c : c?.command ? [c.command, ...(c.args ?? [])].join(' ') : undefined,
      );
    case 'read':
      return list(input?.files ?? input?.file_paths ?? input?.paths ?? input?.path ?? input).map((f) =>
        typeof f === 'string' ? f : (f?.path ?? f?.file_path ?? f?.filePath),
      );
    case 'search':
      return list(input?.queries ?? input?.regex ?? input).map((q) => (typeof q === 'string' ? q : undefined));
    default: // fetch_web_content batches {url, prompt} requests
      return list(input?.requests ?? input).map((r) => r?.url ?? r?.query ?? r?.skill ?? undefined);
  }
}

/** ok/exit/error from one tool_result; batched tools get one entry per call when the counts match. */
function applyResult(evs, block) {
  const content = block.content;
  const perCall = Array.isArray(content) && evs.length > 1 && content.length === evs.length;
  evs.forEach((ev, k) => {
    const items = perCall ? [content[k]] : [content].flat();
    if (!block.is_error && !items.some((x) => x?.success === false)) {
      ev.ok = true;
      return;
    }
    // The command output, then the error line ("Command exited with code 2"): the tail is what failed.
    const text = items
      .map((x) => (typeof x === 'string' ? x : [typeof x?.result === 'string' ? x.result : '', x?.error ?? x?.text ?? ''].filter(Boolean).join('\n')))
      .join('\n')
      .trim();
    const exit = /exit(?:ed with)? code:?\s*(-?\d+)/i.exec(text)?.[1];
    ev.ok = false;
    if (text) ev.error = text.slice(-1500);
    if (exit !== undefined) ev.exit = Number(exit);
  });
}

function sdkUser(m, enveloped, tools, log) {
  const blocks = blocksOf(m);
  for (const b of blocks) {
    if (b?.type === 'tool_result' && tools.has(b.tool_use_id)) applyResult(tools.get(b.tool_use_id), b);
  }
  const raw = textsOf(m);
  // Hosts wrap typed text; unwrapped user text in such a session is a runtime notice.
  if (enveloped && !raw.some((t) => ENVELOPE.test(t))) return;
  const parts = [
    ...raw.map(userText),
    ...blocks.filter((b) => b?.type === 'image').map(() => '[image attached]'),
    ...blocks.filter((b) => b?.type === 'file' && b.path).map((b) => `[file attached: ${b.path}]`),
  ];
  const text = parts.filter(Boolean).join('\n').trim();
  if (text) log.push({ kind: 'prompt', text, ts: m.ts });
}

function sdkAssistant(m, cwd, tools, log) {
  const blocks = blocksOf(m);
  const uses = blocks.filter((b) => b?.type === 'tool_use' && b.name);
  const text = textsOf(m).map(visibleText).filter(Boolean).join('\n');
  // A model turn that ends without a tool call is the turn's answer.
  if (text) log.push({ kind: 'reply', text, ts: m.ts, ...(!uses.length && { final: true }) });
  for (const b of uses) {
    const input = b.input ?? {};
    if (typeof input.task_progress === 'string') log.push(planFromChecklist(input.task_progress, m.ts));
    const say = REPLY_TOOLS[b.name];
    if (say) {
      const t = input[say.field];
      if (typeof t === 'string' && t.trim()) log.push({ kind: 'reply', text: t.trim(), ts: m.ts, ...(say.final && { final: true }) });
    } else if (b.name === 'summarize_task' || b.name === 'condense') {
      log.push({ kind: 'compaction', summary: stripThinking(input.context) || undefined, ts: m.ts });
    } else {
      const action = SDK_TOOLS[b.name] ?? 'other';
      const evs = targets(action, input).map((target) =>
        log.push({ kind: 'tool', tool: b.name, action, target: absolute(target, action, cwd), ts: m.ts }),
      );
      tools.set(b.id, evs);
    }
  }
}

/** The latest summary in <id>.compaction.json and how many messages.json messages it replaced. */
function sidecarCompaction(candidate) {
  const path = candidate.ref.row.compaction_path || join(dirname(candidate.ref.file), `${candidate.id}.compaction.json`);
  const state = readJson(path);
  const list = Array.isArray(state?.messages) ? state.messages : [];
  const md = list.findLast((m) => m?.metadata?.kind === 'compaction_summary')?.metadata;
  if (!md?.summary || !(state.source_message_count > 0)) return null;
  return { count: state.source_message_count, summary: String(md.summary), ts: md.generatedAt ?? Date.parse(state.updated_at) };
}

function loadSdk(candidate) {
  const { file, row } = candidate.ref;
  const doc = readJson(file) ?? readJson(file); // rewritten atomically while the session runs; retry once
  const messages = (Array.isArray(doc?.messages) ? doc.messages : []).filter((m) => m && typeof m === 'object');
  const enveloped = messages.some((m) => m.role === 'user' && textsOf(m).some((t) => ENVELOPE.test(t)));
  const sidecar = sidecarCompaction(candidate);
  const log = eventLog();
  const tools = new Map();
  let model = row.model;
  let canonical = 0;
  let sidecarDone = false;

  for (const m of messages) {
    const md = m.metadata ?? {};
    if (md.kind === 'compaction_summary') {
      log.push({ kind: 'compaction', summary: String(md.summary ?? '') || undefined, ts: md.generatedAt ?? m.ts });
      sidecarDone ||= md.summary === sidecar?.summary;
    } else if (md.displayRole === 'error') {
      log.push(apiStop(textsOf(m).join('\n'), m.ts)); // the run's terminal error, shown to the user
    } else if (m.role === 'user') {
      sdkUser(m, enveloped, tools, log);
    } else if (m.role === 'assistant') {
      if (m.modelInfo?.id) model = m.modelInfo.id;
      sdkAssistant(m, candidate.cwd, tools, log);
    }
    if (md.displayOnly !== true) canonical++;
    if (sidecar && !sidecarDone && canonical === sidecar.count) {
      log.push({ kind: 'compaction', summary: sidecar.summary, ts: sidecar.ts });
      sidecarDone = true;
    }
  }
  if (row.status === 'failed' && log.events.at(-1)?.kind !== 'stop') {
    // A dead process is marked failed with a terminal_marker; anything else is a run failure.
    const marker = row.metadata?.terminal_marker;
    const ts = Date.parse(row.ended_at) || undefined;
    log.push({ kind: 'stop', reason: marker ? 'aborted' : 'error', message: marker || undefined, ts });
  }

  return {
    meta: {
      logFile: file,
      startedAt: Date.parse(row.started_at) || undefined,
      model,
      branch: row.metadata?.git?.branch,
      resumeCommand: `cline --id ${candidate.id}`,
    },
    events: log.events,
  };
}

/**
 * @param {import('./index.js').Candidate} candidate
 * @param {import('./index.js').Context} ctx
 */
export async function loadSession(candidate, ctx) {
  const { meta, events } = candidate.ref.kind === 'sdk' ? loadSdk(candidate) : loadLegacy(candidate);
  return {
    meta: {
      agent: name,
      sessionId: candidate.id,
      title: candidate.title,
      cwd: candidate.cwd,
      lastActivity: candidate.lastActivity,
      ...meta,
    },
    events,
  };
}

/**
 * Start Cline's terminal UI with a first prompt. `--tui` keeps it interactive on
 * both CLI 2.x (where it skips the kanban launcher) and 3.x (where a bare prompt
 * would run headless and exit).
 */
export function launch(prompt) {
  return ['cline', ['--tui', prompt]];
}
