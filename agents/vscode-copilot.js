/**
 * VS Code Copilot Chat adapter (local agent-mode chats).
 *
 * Sessions: <User>/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl (legacy: flat .json),
 * where <User> is <base>/{Code, Code - Insiders, VSCodium}/User. The hash is opaque: only its
 * workspace.json names the window's folder (or a JSONC .code-workspace file), so every hash dir
 * is checked and all matching ones are used. Folder-less windows (the empty window's
 * globalStorage/emptyWindowChatSessions, the Agents window) count only through a session's own
 * workingDirectory.
 *
 * A .jsonl file is VS Code's object mutation log (objectMutationLog.ts): line 1 is the full state
 * (kind 0), then Set (1), Push (2, optionally truncating to `i` first) and Delete (3) entries.
 * It is replayed exactly, because truncations rewind edited, retried and restored requests.
 *
 * The per-window index in state.vscdb ('chat.ChatSessionStore.index') gives activity, emptiness
 * and titles without parsing logs. VS Code flushes it lazily, so an entry is trusted only for a
 * file not modified after the database, and only once its last request had ended; other files are
 * replayed, newest first, within a budget, and the rest are dated from the tail of their log.
 * Requests run by the Copilot CLI agent ('copilotcli') live in ~/.copilot and are left to the
 * copilot-cli adapter.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, resolve } from 'node:path';

import { listDir, readJson, readText, statSafe, tryJson } from '../lib/fsx.js';
import { queryAll } from '../lib/sqlite.js';

export const name = 'vscode-copilot';
export const label = 'VS Code Copilot Chat';

const PRODUCTS = ['Code', 'Code - Insiders', 'VSCodium'];
const INDEX_KEY = 'chat.ChatSessionStore.index';
const SESSION_FILE = /\.jsonl?$/;
const REPLAY_BUDGET = 8 * 1024 * 1024; // bytes of unindexed logs replayed per search
const TAIL_BYTES = 64 * 1024;
const TIME_KEY = /"(?:completedAt|timestamp)":(\d{13})\b/g;
const ERROR_TAIL = 1500;

// ResponseModelState and ToolConfirmKind (chatService.ts).
const COMPLETE = 1;
const CANCELLED = 2;
const FAILED = 3;
const DENIED = 0;
const SKIPPED = 5;

const CLI_AGENT = 'copilotcli';
const EDIT_TOOLS = new Set([
  'copilot_applyPatch', 'copilot_replaceString', 'copilot_multiReplaceString', 'copilot_createFile',
  'copilot_insertEdit', 'copilot_editNotebook', 'copilot_editFiles',
]);
const COMMAND_TOOLS = new Set(['run_in_terminal', 'run_task', 'copilot_runTests', 'runTests']);
const READ_TOOLS = new Set(['copilot_readFile', 'copilot_listDirectory', 'copilot_getErrors', 'copilot_readNotebookCellOutput', 'get_terminal_output']);
const SEARCH_TOOLS = new Set([
  'copilot_findTextInFiles', 'copilot_findFiles', 'copilot_searchCodebase', 'copilot_searchWorkspaceSymbols',
  'copilot_listCodeUsages', 'search_subagent',
]);
const PLAN_STATUS = { completed: 'done', 'in-progress': 'active', 'not-started': 'pending', blocked: 'blocked' };

/** Every existing VS Code-family User directory (userDataPath.ts: VSCODE_PORTABLE, VSCODE_APPDATA, then the OS default). */
export function userDirs(ctx) {
  const { env, home, platform } = ctx;
  const base =
    env.VSCODE_APPDATA ??
    (platform === 'win32'
      ? env.APPDATA ?? join(home, 'AppData', 'Roaming')
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : env.XDG_CONFIG_HOME ?? join(home, '.config'));
  const dirs = PRODUCTS.map((p) => join(base, p, 'User'));
  if (env.VSCODE_PORTABLE) dirs.unshift(join(env.VSCODE_PORTABLE, 'user-data', 'User'));
  return dirs.filter((d) => statSafe(d)?.isDirectory());
}

/** Local path of a VS Code URI (a 'file:' string or a serialized {scheme, path, fsPath}); null for remote ones. */
export function uriPath(u) {
  try {
    if (typeof u === 'string') return u.startsWith('file:') ? fileURLToPath(u) : null;
    if (!u || (u.scheme && u.scheme !== 'file')) return null;
    if (u.fsPath) return u.fsPath;
    if (!u.path) return null;
    const url = new URL('file://');
    url.pathname = u.path;
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/** Parse JSONC (comments, trailing commas) as VS Code writes .code-workspace files. */
function parseJsonc(text) {
  const STRING = '"(?:[^"\\\\]|\\\\.)*"';
  const noComments = text.replace(new RegExp(`(${STRING})|//[^\\n]*|/\\*[\\s\\S]*?\\*/`, 'g'), (_, s) => s ?? '');
  return tryJson(noComments.replace(new RegExp(`(${STRING})|,(\\s*[}\\]])`, 'g'), (_, s, close) => s ?? close));
}

/** The local folders a workspaceStorage dir belongs to: [] for folder-less windows, null for remote ones. */
function workspaceFolders(dir) {
  const ws = readJson(join(dir, 'workspace.json'));
  if (ws?.folder) {
    const folder = uriPath(ws.folder);
    return folder ? [folder] : null;
  }
  if (ws?.workspace && !uriPath(ws.workspace)) return null;
  const file = uriPath(ws?.workspace);
  const config = file ? parseJsonc(readText(file) ?? '') : null;
  return (config?.folders ?? [])
    .map((f) => (f?.uri ? uriPath(f.uri) : typeof f?.path === 'string' ? resolve(dirname(file), f.path) : null))
    .filter(Boolean);
}

/** Session stores that can hold the project's chats: matching windows plus folder-less ones. */
function stores(project, ctx) {
  const out = [];
  for (const user of userDirs(ctx)) {
    const root = join(user, 'workspaceStorage');
    for (const e of listDir(root)) {
      if (!e.isDirectory()) continue;
      const dir = join(root, e.name);
      const folders = workspaceFolders(dir);
      if (!folders) continue;
      const scored = folders.map((f) => ({ f, s: project.match(f) })).sort((a, b) => b.s - a.s)[0];
      if (folders.length && !scored.s) continue;
      out.push({ chatDir: join(dir, 'chatSessions'), db: join(dir, 'state.vscdb'), cwd: scored?.f ?? null, score: scored?.s ?? 0 });
    }
    const global = join(user, 'globalStorage');
    out.push({ chatDir: join(global, 'emptyWindowChatSessions'), db: join(global, 'state.vscdb'), cwd: null, score: 0 });
  }
  return out;
}

async function readIndex(db) {
  const rows = await queryAll(db, 'SELECT value FROM ItemTable WHERE key = ?', [INDEX_KEY]);
  const value = rows?.[0]?.value;
  if (value == null) return null;
  return tryJson(typeof value === 'string' ? value : Buffer.from(value).toString('utf8'))?.entries ?? null;
}

function applyEntry(state, e) {
  if (!Array.isArray(e.k) || !e.k.length) return;
  let parent = state;
  for (const key of e.k.slice(0, -1)) parent = parent?.[key];
  if (!parent || typeof parent !== 'object') return;
  const key = e.k.at(-1);
  if (e.kind === 1) parent[key] = e.v;
  else if (e.kind === 3) parent[key] = undefined;
  else if (e.kind === 2) {
    const arr = Array.isArray(parent[key]) ? parent[key] : [];
    if (typeof e.i === 'number') arr.length = e.i;
    for (const v of Array.isArray(e.v) ? e.v : []) arr.push(v);
    parent[key] = arr;
  }
}

/** Replay a session file into its current state, as VS Code would load it (null when unreadable). */
export function readSession(path) {
  const text = readText(path);
  if (!text) return null;
  if (path.endsWith('.json')) return tryJson(text);
  let state = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const e = tryJson(line); // a torn last line from a live write is skipped
    if (!e) continue;
    if (e.kind === 0) state = e.v;
    else if (state) applyEntry(state, e);
  }
  return state && typeof state === 'object' ? state : null;
}

/** The requests copass reads: everything except the ones the Copilot CLI agent ran. */
const ownRequests = (state) => (Array.isArray(state?.requests) ? state.requests : []).filter((r) => r && r.agent?.id !== CLI_AGENT);

/** Epoch ms of the last request's last activity (the response end, else its start plus elapsed time). */
function activityOf(requests) {
  let last = 0;
  for (const r of requests) {
    const t = r.modelState?.completedAt ?? (r.timestamp ?? 0) + (r.result?.timings?.totalElapsed ?? 0);
    if (t > last) last = t;
  }
  return last || null;
}

/**
 * Last activity of a log from its final 64 KB: the newest request start or response end written
 * there. ponytail: an estimate for logs past the replay budget (it matched a full replay on every
 * real log checked); a log whose tail holds no such time is left out. Replay more if it drifts.
 */
function tailActivity(path, size) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const len = Math.min(TAIL_BYTES, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    let last = 0;
    for (const m of buf.toString('utf8').matchAll(TIME_KEY)) last = Math.max(last, Number(m[1]));
    return last || null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** What the user typed in a request; attached instruction files and IDE context are separate variables. */
function promptText(r) {
  const text = (typeof r.message === 'string' ? r.message : r.message?.text ?? '').trim();
  const image = (r.variableData?.variables ?? []).some((v) => v?.kind === 'image') ? '[image attached]' : '';
  return [text, image].filter(Boolean).join('\n');
}

/**
 * True for a request the user typed. System-initiated requests report a finished background
 * terminal, and a request with `confirmation` was sent by clicking a button ("Try Again",
 * "Continue") under the previous response: neither carries user words.
 */
const isPrompt = (r) => !r.isSystemInitiated && !r.hiddenFromTranscript && r.confirmation === undefined;

/**
 * @param {import('../lib/project.js').Project} project
 * @param {import('./index.js').Context} ctx
 * @returns {Promise<import('./index.js').Candidate[]>}
 */
export async function findSessions(project, ctx) {
  const out = [];
  const pending = [];
  const add = (store, file, id, info) => {
    const cwd = info.cwd ?? store.cwd;
    const score = cwd === store.cwd ? store.score : project.match(cwd);
    if (!score || !info.lastActivity) return;
    out.push({ agent: name, id, lastActivity: info.lastActivity, score, cwd, title: info.title || undefined, preview: info.preview || undefined, current: false, background: false, ref: { file } });
  };

  for (const store of stores(project, ctx)) {
    const names = listDir(store.chatDir).filter((e) => e.isFile() && SESSION_FILE.test(e.name)).map((e) => e.name);
    if (!names.length) continue;
    const index = await readIndex(store.db);
    const indexTime = statSafe(store.db)?.mtimeMs ?? 0;
    for (const file of names) {
      if (file.endsWith('.json') && names.includes(`${file}l`)) continue; // the .jsonl log supersedes it
      const id = file.replace(SESSION_FILE, '');
      const path = join(store.chatDir, file);
      const st = statSafe(path);
      const entry = index?.[id];
      if (!st || entry?.isExternal) continue;
      // An entry flushed while a request was still running has no end time yet (ended == started).
      const settled = entry?.isEmpty || entry?.timing?.lastRequestEnded > entry?.timing?.lastRequestStarted;
      if (entry && settled && st.mtimeMs <= indexTime) {
        if (entry.isEmpty) continue;
        const lastActivity = entry.timing?.lastRequestEnded ?? entry.lastMessageDate;
        add(store, path, id, { lastActivity, cwd: uriPath(entry.workingDirectory), title: entry.title });
      } else {
        pending.push({ store, path, id, mtime: st.mtimeMs, size: st.size });
      }
    }
  }

  // Logs the index does not cover (new, unsettled, or never indexed). A file's mtime bounds its
  // activity from above, so a log that does not fit the budget is replayed only when it could
  // still be newer than every session found so far; otherwise it is dated from its tail.
  let spent = 0;
  let best = Math.max(0, ...out.map((c) => c.lastActivity));
  for (const p of pending.sort((a, b) => b.mtime - a.mtime)) {
    if (spent + p.size > REPLAY_BUDGET && p.mtime <= best) {
      // Too much to replay: list it from its tail when its window already ties it to the project.
      if (p.store.score) add(p.store, p.path, p.id, { lastActivity: tailActivity(p.path, p.size) });
      continue;
    }
    spent += p.size;
    const state = readSession(p.path);
    const requests = ownRequests(state);
    if (!requests.length) continue;
    const first = requests.find(isPrompt);
    add(p.store, p.path, p.id, {
      lastActivity: activityOf(requests),
      cwd: uriPath(state.workingDirectory),
      title: state.customTitle,
      preview: first ? promptText(first) : null,
    });
    best = Math.max(best, out.at(-1)?.lastActivity ?? 0); // only sessions that belong to the project count
  }
  return out;
}

/** Markdown of a tool message (string or {value}), with links reduced to their label or path. */
function messageText(m) {
  const raw = typeof m === 'string' ? m : typeof m?.value === 'string' ? m.value : '';
  return raw.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, text, uri) => text || uriPath(uri) || uri).trim();
}

const messageUris = (m) => (m && typeof m === 'object' ? Object.values(m.uris ?? {}).map(uriPath).filter(Boolean) : []);

function refName(p) {
  const ref = p.inlineReference ?? {};
  return p.name || ref.name || posix.basename(ref.uri?.path ?? ref.location?.uri?.path ?? ref.path ?? '');
}

// Terminal output keeps ANSI control sequences (colors, bracketed-paste toggles).
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

function tail(s) {
  const text = String(s ?? '').replace(ANSI, '').trim();
  return text ? text.slice(-ERROR_TAIL) : undefined;
}

function outputText(details) {
  if (!Array.isArray(details?.output)) return '';
  return details.output.filter((o) => typeof o?.value === 'string' && o.isText !== false).map((o) => o.value).join('\n');
}

/** ok/exit/error of a tool call, from the user's confirmation, the terminal state or the tool result. */
function outcome(p) {
  const confirm = p.isConfirmed?.type;
  if (confirm === DENIED) return { ok: false, error: 'denied by the user' };
  if (confirm === SKIPPED) return { ok: false, error: 'skipped by the user' };
  const tsd = p.toolSpecificData ?? {};
  const output = () => tail(tsd.terminalCommandOutput?.text ?? outputText(p.resultDetails));
  const exit = tsd.terminalCommandState?.exitCode;
  if (typeof exit === 'number') return exit === 0 ? { ok: true, exit } : { ok: false, exit, error: output() };
  if (p.resultDetails?.isError) return { ok: false, error: output() };
  return {};
}

function toolEvent(p, ts) {
  const id = p.toolId ?? 'tool';
  const text = messageText(p.invocationMessage) || messageText(p.pastTenseMessage);
  const uri = messageUris(p.invocationMessage)[0] ?? messageUris(p.pastTenseMessage)[0];
  const quoted = /`([^`]+)`/.exec(text)?.[1] ?? /"([^"]+)"/.exec(text)?.[1];
  const base = { kind: 'tool', tool: id, ts, ...outcome(p) };
  if (id === 'run_in_terminal') {
    // What ran (VS Code executes userEdited ?? toolEdited ?? original): the tool drops a redundant
    // `cd <cwd> &&` and prefixes a space to keep the command out of the shell history.
    const cmd = p.toolSpecificData?.commandLine;
    const line = (cmd?.userEdited ?? cmd?.toolEdited ?? cmd?.original)?.trim();
    return { ...base, action: 'command', target: line || p.toolSpecificData?.confirmation?.commandLine || text };
  }
  if (COMMAND_TOOLS.has(id)) return { ...base, action: 'command', target: quoted ?? text };
  if (READ_TOOLS.has(id)) return { ...base, action: 'read', target: uri ?? text };
  if (SEARCH_TOOLS.has(id)) return { ...base, action: 'search', target: quoted ?? text };
  return { ...base, action: 'other', target: uri ?? (text || undefined) };
}

/**
 * Events of one response, in order. Prose between tool calls becomes one reply each; thinking,
 * progress and other UI parts only break paragraphs. An edit shows up as the tool call plus a
 * codeblockUri/textEditGroup pair for the same file, which are folded into one edit event.
 */
function responseEvents(r, ts) {
  const events = [];
  let prose = [];
  let gap = false;
  const claimed = new Set(); // files whose edit event was already emitted for the current edit
  let open = null; // an edit event still waiting for its file

  const flush = () => {
    const text = prose.join('').replace(/\n{3,}/g, '\n\n').trim();
    if (text) events.push({ kind: 'reply', text, ts });
    prose = [];
    gap = false;
  };
  const write = (s) => {
    if (gap && prose.length) prose.push('\n\n');
    prose.push(s);
    gap = false;
  };
  const edit = (tool, target) => events.push({ kind: 'tool', tool, action: 'edit', target, ts });
  const editedFile = (p, target) => {
    if (claimed.has(target)) {
      if (p.kind === 'textEditGroup') claimed.delete(target);
      return;
    }
    if (open) {
      open.target = target;
      open = null;
    } else {
      edit(p.kind, target);
    }
    if (p.kind === 'codeblockUri') claimed.add(target);
  };

  for (const p of Array.isArray(r.response) ? r.response : []) {
    if (!p || typeof p !== 'object') continue;
    if (p.kind === undefined || p.kind === 'markdownContent') {
      const v = typeof p.value === 'string' ? p.value : p.content?.value;
      // Bare code fences only frame an edit's code block; they are not prose.
      if (typeof v === 'string' && !/^[\s`]*$/.test(v)) write(v);
      else gap = true;
    } else if (p.kind === 'inlineReference') {
      const ref = refName(p);
      if (ref) write(`\`${ref}\``);
    } else if (p.kind === 'toolInvocationSerialized') {
      flush();
      open = null; // an edit's file parts follow its own tool call directly
      if (p.toolId === 'manage_todo_list') {
        const list = p.toolSpecificData?.todoList;
        if (Array.isArray(list) && list.length) {
          events.push({ kind: 'plan', ts, items: list.map((t) => ({ text: t?.title ?? '', status: PLAN_STATUS[t?.status] ?? 'pending' })) });
        }
      } else if (EDIT_TOOLS.has(p.toolId)) {
        const files = [...new Set([...messageUris(p.invocationMessage), ...messageUris(p.pastTenseMessage)])];
        const base = { kind: 'tool', tool: p.toolId, action: 'edit', ts, ...outcome(p) };
        if (!files.length) events.push((open = { ...base, target: undefined }));
        for (const target of files) {
          events.push({ ...base, target });
          claimed.add(target);
        }
      } else {
        events.push(toolEvent(p, ts));
      }
    } else if ((p.kind === 'codeblockUri' && p.isEdit) || p.kind === 'textEditGroup') {
      flush();
      const target = uriPath(p.uri);
      if (target) editedFile(p, target);
    } else if (p.kind === 'workspaceEdit') {
      flush();
      for (const e of Array.isArray(p.edits) ? p.edits : []) {
        const target = uriPath(e?.newResource ?? e?.oldResource);
        if (target) edit('workspaceEdit', target);
      }
    } else {
      gap = true; // thinking (never shown), undoStop, progress, confirmations…
    }
  }
  flush();

  const state = r.modelState?.value;
  const replies = events.filter((e) => e.kind === 'reply');
  const last = replies.at(-1);
  if (last && (state === CANCELLED || state === FAILED || r.result?.errorDetails?.responseIsIncomplete)) last.partial = true;
  else if (last && state === COMPLETE) last.final = true;
  return events;
}

/** Why a request stopped, from the agent's own error record. */
function stopEvent(r) {
  const err = r.result?.errorDetails;
  const state = r.modelState?.value;
  // A cancelled request (errorDetails 'Canceled', with or without a code) is the user's interrupt.
  if (state === CANCELLED || err?.code === 'canceled' || (!err && state !== FAILED)) return null;
  const code = String(err?.code ?? '');
  let reason = 'error';
  if (err?.isQuotaExceeded || /quota/i.test(code)) reason = 'quota';
  else if (err?.isRateLimited || /ratelimit/i.test(code)) reason = 'rate_limit';
  else if (/overload|unavailable|capacity/i.test(code)) reason = 'overloaded';
  return { kind: 'stop', reason, message: err?.message || undefined, ts: r.modelState?.completedAt ?? r.timestamp };
}

/**
 * Conversation summaries, each placed before the request that owns its tool-call round: the
 * summary replaces every turn up to that round. Foreground summaries are stored twice and the
 * same summary can be repeated in later requests, so they are keyed by round id.
 */
function compactions(requests) {
  const rounds = new Map();
  requests.forEach((r, at) => {
    for (const round of r.result?.metadata?.toolCallRounds ?? []) if (round?.id) rounds.set(round.id, { at, ts: round.timestamp });
  });
  const found = new Map();
  requests.forEach((r, at) => {
    const md = r.result?.metadata ?? {};
    const legacy = (md.toolCallRounds ?? []).map((round) => round?.summary && { toolCallRoundId: round.id, text: round.summary.text ?? round.summary });
    for (const s of [...(Array.isArray(md.summaries) ? md.summaries : []), md.summary, ...legacy]) {
      if (typeof s?.text !== 'string' || !s.text.trim()) continue;
      const key = s.toolCallRoundId ?? `${at}:${s.text.length}`;
      if (found.has(key)) continue;
      const round = rounds.get(s.toolCallRoundId);
      found.set(key, { at: round?.at ?? at, event: { kind: 'compaction', summary: s.text.trim(), ts: round?.ts ?? r.timestamp } });
    }
  });
  return [...found.values()];
}

/**
 * @param {import('./index.js').Candidate} candidate
 * @param {import('./index.js').Context} _ctx
 */
export async function loadSession(candidate, _ctx) {
  const state = readSession(candidate.ref.file);
  const requests = ownRequests(state);
  const summaries = compactions(requests);
  const events = [];
  let model;

  requests.forEach((r, i) => {
    const ts = r.timestamp;
    for (const s of summaries) if (s.at === i) events.push(s.event);
    if (isPrompt(r)) {
      const text = promptText(r);
      if (text) events.push({ kind: 'prompt', text, ts });
    }
    // The agent's work in a request without user words continues the user's last request.
    events.push(...responseEvents(r, ts));
    if (r.modelState?.value === CANCELLED) events.push({ kind: 'interrupt', ts: r.modelState.completedAt ?? ts });
    // An error only explains the stop when nothing ran after it (a retry may have succeeded).
    const stop = i === requests.length - 1 ? stopEvent(r) : null;
    if (stop) events.push(stop);
    model = r.result?.metadata?.resolvedModel ?? r.modelId ?? model;
  });

  for (const q of state?.pendingRequests ?? []) {
    // Background-terminal notifications and button clicks wait in the same queue as typed prompts.
    const o = q?.sendOptions ?? {};
    const typed = q?.request && isPrompt(q.request) && !o.isSystemInitiated && !o.hideFromTranscript && o.confirmation === undefined;
    const text = typed ? promptText(q.request) : '';
    if (text) events.push({ kind: 'prompt', source: 'queued', text, ts: q.request.timestamp });
  }
  const draft = state?.inputState?.inputText?.trim();
  if (draft) events.push({ kind: 'prompt', source: 'draft', text: draft });

  return {
    meta: {
      agent: name,
      sessionId: candidate.id,
      title: state?.customTitle ?? candidate.title,
      cwd: candidate.cwd,
      logFile: candidate.ref.file,
      startedAt: state?.creationDate,
      lastActivity: activityOf(requests) ?? candidate.lastActivity,
      model,
      branch: state?.repoData?.localBranch,
      commit: state?.repoData?.localHeadCommit,
      // VS Code has no command that reopens a given chat; it is in the Chat view's history.
    },
    events,
  };
}

/** Open Copilot Chat in agent mode with a first prompt; `code chat` opens the current directory's window. */
export function launch(prompt) {
  return ['code', ['chat', '--mode', 'agent', prompt]];
}
