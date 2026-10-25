/**
 * Gemini CLI adapter.
 *
 * Sessions: <GEMINI_CLI_HOME|~>/.gemini/tmp/<project>/chats/session-<UTC minute>-<id8>.jsonl
 * (also under ~/.cache/.gemini when the CLI ran in the macOS seatbelt sandbox).
 * <project> is the slug that ~/.gemini/projects.json maps the launch directory to,
 * or sha256(launch dir) for pre-registry sessions. Slugs are lossy and collide
 * ('-1' suffixes), so they are never derived here: the registry, the
 * .project_root marker and the header's projectHash decide ownership.
 *
 * A .jsonl file is a log to replay, not a transcript: a metadata header
 * (repeated on resume), message records upserted by id, {$set} metadata
 * updates (whose `messages` replaces the list), {$rewindTo} and {$patch}
 * edits. Older CLIs wrote one whole ConversationRecord as session-*.json.
 * Subagent transcripts live in chats/<parentId>/ and are never read.
 * Gemini Code Assist's agent mode writes stubs with sessionId 'a2a-server'
 * into the same tree; they are labelled when they ever carry a conversation.
 *
 * Older CLIs recorded no tool calls in the chat file; the edits, commands
 * and results are recovered from tmp/<project>/checkpoints/*.json, whose
 * messageId starts with the session id.
 */

import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

import { listDir, readJson, readText, statSafe, tryJson } from '../lib/fsx.js';
import { samePath } from '../lib/project.js';

export const name = 'gemini-cli';
export const label = 'Gemini CLI';

const SESSION_FILE = /^session-.+\.jsonl?$/;
const CHECKPOINT_FILE = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)_(\d{3})Z-.+\.json$/;
const A2A_SESSION = 'a2a-server';
const CHECKPOINT_SLACK = 10 * 60 * 1000;
const MAX_ERROR = 1500;

const EDIT_TOOLS = new Set(['write_file', 'replace', 'edit', 'smart_edit']);
const READ_TOOLS = new Set(['read_file', 'read_many_files', 'list_directory']);
const SEARCH_TOOLS = new Set(['grep_search', 'search_file_content', 'glob', 'google_web_search']);
const TODO_STATUS = { completed: 'done', in_progress: 'active', pending: 'pending', blocked: 'blocked' };
const TRACKER_STATUS = { closed: 'done', in_progress: 'active', open: 'pending', blocked: 'blocked' };

// Gemini's own isIgnoredUserContent(): slash commands, help and harness context records.
const IGNORED_PROMPT = /^(?:\/|\?|<session_context>|<hook_context>)/;
// Harness text the CLI records as separate user messages (IDE context, /dir add, old env setup).
const INJECTED_PROMPT =
  /^(?:Here is (?:the user's editor context as a JSON object|a summary of changes in the user's editor context, in JSON format)\. This is for your information only\.|- \*\*Workspace Directories:\*\*|This is the Gemini CLI\. We are setting up the context for our chat\.)/;
const CONTINUE_PROMPT = 'Please continue.';
// Shell mode (!cmd): newer CLIs record the command and its output as a synthetic user turn, backticks escaped.
const SHELL_MODE = /^I ran the following shell command:\n```sh\n([\s\S]*?)\n```\n\nThis produced the following result:\n```/;
const HOOK_CONTEXT = /\s*<hook_context>[\s\S]*?<\/hook_context>/g;
// IDE context blocks that JetBrains' ACP client adds to the typed text.
const IDE_BLOCK =
  /(?:^|\n)(?:Current File Path:\n```[^\n]*\n[^\n]*\n```|Current Selection:\n```[^\n]*\n[\s\S]*?\n```|User Selected Files:\n(?:- [^\n]*(?:\n|$))+)/g;
// JetBrains' ACP client appends the earlier chat's prompts when a new session continues it.
const PRIOR_HISTORY = /(?:^|\n)[ \t]*PRIOR CHAT HISTORY:[\s\S]*$/;
const REFERENCED_FILES = '\n--- Content from referenced files ---';
const INTERRUPTED = '[The previous response was interrupted before it completed.]';
// The info record the CLI writes when the user presses Esc mid-turn.
const CANCELLED = 'Request cancelled.';
const SNAPSHOT = '<state_snapshot>';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function bases(ctx) {
  const home = ctx.env.GEMINI_CLI_HOME || ctx.home;
  return [join(home, '.gemini'), join(home, '.cache', '.gemini')];
}

/** Project temp dirs whose launch directory belongs to the project, with that directory. */
function projectDirs(project, ctx) {
  const out = [];
  for (const base of bases(ctx)) {
    const tmp = join(base, 'tmp');
    const entries = listDir(tmp).filter((e) => e.isDirectory());
    if (!entries.length) continue;
    const registry = readJson(join(base, 'projects.json'))?.projects ?? {};
    const owners = new Map();
    for (const [path, slug] of Object.entries(registry)) {
      if (typeof slug === 'string') owners.set(slug, path);
      owners.set(sha256(path), path); // legacy pre-registry dir of a registered path
    }
    for (const root of project.roots) if (!owners.has(sha256(root))) owners.set(sha256(root), root);
    for (const e of entries) {
      const owner = owners.get(e.name) ?? readText(join(tmp, e.name, '.project_root'))?.trim();
      const score = owner ? project.match(owner) : 0;
      // Registered dirs before legacy hash dirs, so a migrated duplicate keeps the slug copy.
      if (score) out.push({ dir: join(tmp, e.name), owner, score, legacy: /^[0-9a-f]{64}$/.test(e.name) });
    }
  }
  return out.sort((a, b) => Number(a.legacy) - Number(b.legacy));
}

/**
 * Replay a session file the way the CLI's createJsonlRecordAccumulator() does.
 * Torn lines (a live session's last line) are skipped.
 *
 * @param {string} file
 * @returns {{ meta: Record<string, any>, messages: any[] }}
 */
export function replay(file) {
  const raw = readText(file) ?? '';
  if (file.endsWith('.json')) {
    const { messages, ...meta } = tryJson(raw) ?? {};
    return { meta, messages: Array.isArray(messages) ? messages.filter((m) => typeof m?.id === 'string') : [] };
  }
  let meta = {};
  let map = new Map();
  const load = (list) => {
    for (const m of Array.isArray(list) ? list : []) if (typeof m?.id === 'string') map.set(m.id, m);
  };
  for (const line of raw.split('\n')) {
    const r = line.trim() ? tryJson(line) : null;
    if (!r || typeof r !== 'object') continue;
    if (typeof r.$rewindTo === 'string') {
      const ids = [...map.keys()];
      const at = ids.indexOf(r.$rewindTo);
      map = new Map(at < 0 ? [] : ids.slice(0, at).map((id) => [id, map.get(id)]));
    } else if (r.$patch && typeof r.$patch === 'object') {
      map = applyPatch(map, r.$patch);
    } else if (typeof r.id === 'string') {
      map.set(r.id, r); // same id again = upsert in place
    } else if (r.$set && typeof r.$set === 'object') {
      const { messages, ...rest } = r.$set;
      if (Array.isArray(messages)) {
        map = new Map();
        load(messages);
      }
      meta = { ...meta, ...rest };
    } else if (typeof r.sessionId === 'string' && typeof r.projectHash === 'string') {
      const { messages, ...rest } = r;
      meta = { ...meta, ...rest };
      load(messages);
    }
  }
  return { meta, messages: [...map.values()] };
}

function applyPatch(map, p) {
  const next = new Map(map);
  for (const u of [...(typeof p.id === 'string' ? [p] : []), ...(Array.isArray(p.updates) ? p.updates : [])]) {
    const m = typeof u?.id === 'string' ? next.get(u.id) : null;
    if (!m) continue;
    const toolCalls =
      Array.isArray(u.toolCalls) && m.type === 'gemini' && Array.isArray(m.toolCalls)
        ? m.toolCalls.map((tc) => {
            const tp = u.toolCalls.find((x) => x?.id === tc.id);
            return tp && 'result' in tp ? { ...tc, result: tp.result } : tc;
          })
        : m.toolCalls;
    next.set(u.id, { ...m, ...(u.content !== undefined ? { content: u.content } : {}), toolCalls });
  }
  for (const id of Array.isArray(p.removeIds) ? p.removeIds : []) next.delete(id);
  if (!Array.isArray(p.orderIds)) return next;
  const ordered = p.orderIds.filter((id) => next.has(id));
  const listed = new Set(ordered);
  return new Map([...[...next.keys()].filter((id) => !listed.has(id)), ...ordered].map((id) => [id, next.get(id)]));
}

/** Visible text of a PartListUnion: text parts only, never thoughts, calls or inline data. */
function visibleText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(visibleText).join('');
  return content && typeof content.text === 'string' && !content.thought ? content.text : '';
}

/** What the user typed in a user record, or '' for harness, tool-response and command records. */
function promptOf(m) {
  const raw = visibleText(m.content).trim();
  if (!raw || IGNORED_PROMPT.test(raw) || INJECTED_PROMPT.test(raw) || raw === CONTINUE_PROMPT) return '';
  const shell = SHELL_MODE.exec(raw);
  if (shell) return `! ${shell[1].replace(/\\([\\`])/g, '$1')}`;
  // displayContent is the input line the user typed ('@file …', '/custom-command args') when the sent content was expanded.
  const display = visibleText(m.displayContent).trim();
  const text = (display || raw).split(REFERENCED_FILES)[0].replace(HOOK_CONTEXT, '').replace(PRIOR_HISTORY, '');
  const stripped = text.replace(IDE_BLOCK, '\n');
  const out = (stripped === text ? text : stripped.replace(/\n{3,}/g, '\n\n')).trim();
  // JetBrains' ACP client HTML-escapes < and > in typed text; a raw bracket means the text was not escaped.
  return /[<>]/.test(out) ? out : out.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

const isSnapshot = (m) => m.type === 'user' && visibleText(m.content).trimStart().startsWith(SNAPSHOT);
const timeOf = (s) => (typeof s === 'string' && Date.parse(s)) || undefined;

/** Cheap facts for ranking a replayed session. Returns null for stubs without a real prompt. */
function probe(messages) {
  let preview = '';
  let lastActivity = 0;
  let snapshot = false;
  for (const m of messages) {
    if (m.type !== 'user' && m.type !== 'gemini') continue;
    const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    lastActivity = Math.max(lastActivity, timeOf(m.timestamp) ?? 0, ...calls.map((tc) => timeOf(tc?.timestamp) ?? 0));
    if (m.type !== 'user') continue;
    if (isSnapshot(m)) snapshot = true;
    else if (!preview) preview = promptOf(m);
  }
  return (preview || snapshot) && lastActivity ? { preview, lastActivity } : null;
}

/**
 * @param {import('../lib/project.js').Project} project
 * @param {import('./index.js').Context} ctx
 * @returns {Promise<import('./index.js').Candidate[]>}
 */
export async function findSessions(project, ctx) {
  const byId = new Map();
  for (const pd of projectDirs(project, ctx)) {
    // On Windows the registry key is lowercased but the hash is of the original spelling.
    const hashes = new Set([pd.owner, ...project.roots.filter((r) => samePath(r, pd.owner))].map(sha256));
    for (const e of listDir(join(pd.dir, 'chats'))) {
      if (!e.isFile() || !SESSION_FILE.test(e.name)) continue;
      const file = join(pd.dir, 'chats', e.name);
      const { meta, messages } = replay(file);
      if (meta.kind === 'subagent' || !hashes.has(meta.projectHash) || typeof meta.sessionId !== 'string') continue;
      const p = probe(messages);
      if (!p) continue;
      const a2a = meta.sessionId === A2A_SESSION;
      const id = a2a ? basename(e.name).replace(/\.jsonl?$/, '') : meta.sessionId;
      // A migrated session has a copy in the legacy hash dir; its checkpoints may sit in either.
      const prev = byId.get(id);
      const dirs = [...(prev?.ref.dirs ?? []), pd.dir];
      if (prev && prev.lastActivity >= p.lastActivity) {
        byId.set(id, { ...prev, ref: { ...prev.ref, dirs } });
        continue;
      }
      const summary = typeof meta.summary === 'string' ? meta.summary.trim() : '';
      byId.set(id, {
        agent: name,
        id,
        lastActivity: p.lastActivity,
        score: pd.score,
        cwd: pd.owner,
        title: a2a ? `Gemini Code Assist agent mode${summary ? `: ${summary}` : ''}` : summary || undefined,
        preview: p.preview || undefined,
        current: Boolean(ctx.env.GEMINI_SESSION_ID) && ctx.env.GEMINI_SESSION_ID === meta.sessionId,
        ref: { file, dirs, sessionId: meta.sessionId, a2a, startedAt: timeOf(meta.startTime) },
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.lastActivity - a.lastActivity);
}

const tail = (s) => {
  const text = String(s ?? '').trim();
  return text.length > MAX_ERROR ? text.slice(-MAX_ERROR) : text;
};

/** Tools resolve relative paths against the launch directory; absolute targets keep one key per file. */
function toolEvent(toolName, args, ts, cwd) {
  const a = args && typeof args === 'object' ? args : {};
  const base = { kind: 'tool', tool: toolName, ts };
  const raw = a.file_path ?? a.absolute_path ?? a.path;
  const path = typeof raw === 'string' && raw && cwd ? resolve(cwd, raw) : raw;
  if (EDIT_TOOLS.has(toolName)) return { ...base, action: 'edit', target: path };
  if (toolName === 'run_shell_command') return { ...base, action: 'command', target: a.command };
  if (READ_TOOLS.has(toolName)) return { ...base, action: 'read', target: path ?? a.dir_path ?? ([a.include ?? []].flat().join(' ') || undefined) };
  if (SEARCH_TOOLS.has(toolName)) return { ...base, action: 'search', target: a.pattern ?? a.query };
  return { ...base, action: 'other', target: a.description ?? a.url ?? a.query ?? undefined };
}

// Newer CLIs wrap tool output in <untrusted_context> tags.
const UNTRUSTED = /^\s*<untrusted_context[^>]*>\n?|\n?<\/untrusted_context>\s*$/g;

/**
 * ok/exit/error from a functionResponse.response. A shell run fails with a non-zero
 * 'Exit Code:' line (exit 0 is not written) or when it was cancelled or timed out;
 * spawn errors arrive as response.error. Stdout lines are never taken as errors.
 */
function outcome(toolName, response) {
  if (!response || typeof response !== 'object') return {};
  if (response.error !== undefined) return { ok: false, error: tail(typeof response.error === 'string' ? response.error : JSON.stringify(response.error)) };
  if (toolName !== 'run_shell_command') return { ok: true };
  const output = typeof response.output === 'string' ? response.output.replace(UNTRUSTED, '') : '';
  const exit = /^Exit Code: (-?\d+)/m.exec(output);
  const failed = (exit && exit[1] !== '0') || /^Command was (?:automatically )?cancelled/m.test(output);
  return failed ? { ok: false, ...(exit ? { exit: Number(exit[1]) } : {}), error: tail(output) } : { ok: true, ...(exit ? { exit: 0 } : {}) };
}

function planFromTodos(todos, ts) {
  const items = todos
    .filter((t) => t && t.status !== 'cancelled')
    .map((t) => ({ text: String(t.description ?? ''), status: TODO_STATUS[t.status] ?? 'pending' }));
  return { kind: 'plan', ts, items };
}

/** Events for one recorded tool call (newer CLIs record calls with status and result in the chat file). */
function toolCallEvent(tc, fallbackTs, cwd) {
  const ts = timeOf(tc.timestamp) ?? fallbackTs;
  if (tc.name === 'write_todos' && Array.isArray(tc.args?.todos)) return planFromTodos(tc.args.todos, ts);
  const ev = toolEvent(tc.name, tc.args, ts, cwd);
  if (tc.status === 'cancelled') return { ...ev, ok: false, error: 'cancelled by the user' };
  const response = [tc.result].flat().find((p) => p?.functionResponse)?.functionResponse?.response;
  if (tc.status === 'error') {
    const display = typeof tc.resultDisplay === 'string' ? tc.resultDisplay : '';
    return { ...ev, ok: false, error: outcome(tc.name, response).error || tail(display) || undefined };
  }
  return tc.status === 'success' ? { ...ev, ok: true, ...outcome(tc.name, response) } : ev;
}

function stopEvent(text, ts) {
  let reason = 'error';
  if (/exhausted|daily|usage limit|quota/i.test(text) && !/retry in|per.?minute/i.test(text)) reason = 'quota';
  else if (/rate.?limit|too many requests|\b429\b|retry in|per.?minute|quota/i.test(text)) reason = 'rate_limit';
  else if (/overloaded|unavailable|high demand|\b50[03]\b/i.test(text)) reason = 'overloaded';
  else if (/cancel|abort/i.test(text)) reason = 'aborted';
  const retry = /Please retry in ([\d.]+)(ms|s)\b/.exec(text);
  const resetsAt = retry && ts ? Math.round(ts + Number(retry[1]) * (retry[2] === 'ms' ? 1 : 1000)) : undefined;
  return { kind: 'stop', reason, message: text, ts, ...(resetsAt ? { resetsAt } : {}) };
}

/** Checkpoints written for this session (before each file edit), oldest first. */
function linkedCheckpoints(dirs, sessionId, from, to) {
  const found = new Map();
  for (const dir of dirs) {
    for (const e of listDir(join(dir, 'checkpoints'))) {
      const m = e.isFile() && !found.has(e.name) ? CHECKPOINT_FILE.exec(e.name) : null;
      if (!m) continue;
      const ts = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
      if (!(ts >= from && ts <= to)) continue;
      const ck = readJson(join(dir, 'checkpoints', e.name));
      if (!String(ck?.messageId ?? '').startsWith(`${sessionId}########`)) continue;
      found.set(e.name, { ts, history: Array.isArray(ck.clientHistory) ? ck.clientHistory : [] });
    }
  }
  return [...found.values()].sort((a, b) => a.ts - b.ts);
}

const partsOf = (history) => history.flatMap((turn) => (Array.isArray(turn?.parts) ? turn.parts : []));

/**
 * Tool events rebuilt from the newest checkpoint's API history. Calls carry no
 * time: each belongs after the message that precedes it in that history
 * (matched by text against the replayed records, in order) and is dated by
 * the first checkpoint that holds it, capped before the next replayed message.
 *
 * @param {{ts: number, history: any[]}[]} cks
 * @param {{text: string, ts?: number}[]} said  replayed user/gemini records with visible text
 * @param {string} [cwd]  launch directory, for relative file paths
 */
function checkpointTools(cks, said, cwd) {
  if (!cks.length) return [];
  const counts = cks.map((ck) => partsOf(ck.history).filter((p) => p?.functionCall).length);
  const calls = [];
  const responses = [];
  let anchor = -1;
  for (const turn of cks.at(-1).history) {
    const parts = Array.isArray(turn?.parts) ? turn.parts : [];
    const text = visibleText(parts).trim();
    const at = text ? said.findIndex((u, i) => i > anchor && u.text === text) : -1;
    if (at >= 0) anchor = at;
    for (const p of parts) {
      if (p?.functionCall) calls.push({ call: p.functionCall, anchor });
      else if (p?.functionResponse) responses.push(p.functionResponse);
    }
  }
  return calls.map(({ call, anchor: a }, j) => {
    const first = cks[counts.findIndex((n) => n > j)]?.ts ?? cks.at(-1).ts;
    const from = said[a]?.ts;
    const next = said[a + 1]?.ts;
    const ts = from === undefined ? first : Math.max(from, next === undefined ? first : Math.min(first, next - 1));
    if (call.name === 'write_todos' && Array.isArray(call.args?.todos)) return planFromTodos(call.args.todos, ts);
    const response = call.id ? responses.find((r) => r.id === call.id) : responses[j];
    return { ...toolEvent(call.name, call.args, ts, cwd), ...outcome(call.name, response?.response) };
  });
}

/** The latest <state_snapshot> found in checkpoint histories, dated by the first one holding it. */
function checkpointSnapshot(cks) {
  let found = null;
  for (const ck of cks) {
    const text = ck.history
      .filter((turn) => turn?.role === 'user')
      .map((turn) => visibleText(turn.parts).trim())
      .findLast((t) => t.startsWith(SNAPSHOT));
    if (text && text !== found?.summary) found = { kind: 'compaction', summary: text, ts: ck.ts };
  }
  return found;
}

/** Insert timed events into the replayed order without reordering the replayed events. */
function mergeByTime(events, extra) {
  const out = [];
  let j = 0;
  for (const e of events) {
    while (j < extra.length && e.ts !== undefined && extra[j].ts < e.ts) out.push(extra[j++]);
    out.push(e);
  }
  return [...out, ...extra.slice(j)];
}

/** The task tracker of newer CLIs: tmp/<project>/<sessionId>/tracker/<id>.json. */
function trackerPlan(dir) {
  const files = listDir(dir).filter((e) => e.isFile() && e.name.endsWith('.json'));
  const tasks = files.map((e) => readJson(join(dir, e.name))).filter((t) => t && typeof t.title === 'string');
  if (!tasks.length) return null;
  const ts = Math.max(...files.map((e) => statSafe(join(dir, e.name))?.mtimeMs ?? 0));
  return { kind: 'plan', ts, items: tasks.map((t) => ({ text: t.title, status: TRACKER_STATUS[t.status] ?? 'pending' })) };
}

/**
 * @param {import('./index.js').Candidate} candidate
 * @param {import('./index.js').Context} ctx
 */
export async function loadSession(candidate, ctx) {
  const { file, dirs, sessionId, a2a, startedAt } = candidate.ref;
  const { meta, messages } = replay(file);
  let events = [];
  let model;
  let afterSnapshot = false;
  let chatTools = false;

  for (const m of messages) {
    const ts = timeOf(m.timestamp);
    if (m.type === 'user') {
      if (isSnapshot(m)) {
        events.push({ kind: 'compaction', summary: visibleText(m.content).trim(), ts });
        afterSnapshot = true;
        continue;
      }
      afterSnapshot = false;
      const text = promptOf(m);
      if (text) events.push({ kind: 'prompt', text, ts });
    } else if (m.type === 'gemini') {
      if (m.model) model = m.model;
      const text = visibleText(m.content).trim();
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls.filter((tc) => tc && typeof tc.name === 'string') : [];
      if (text === INTERRUPTED) events.push({ kind: 'interrupt', ts });
      else if (text && !(afterSnapshot && !calls.length)) events.push({ kind: 'reply', text, ts }); // skip the snapshot's ack
      afterSnapshot = false;
      for (const tc of calls) events.push(toolCallEvent(tc, ts, candidate.cwd));
      chatTools ||= calls.length > 0;
    } else if (m.type === 'error') {
      const text = visibleText(m.content).trim();
      if (text) events.push(stopEvent(text, ts));
    } else if (m.type === 'info' && visibleText(m.content).trim() === CANCELLED) {
      events.push({ kind: 'interrupt', ts });
    }
  }

  const to = Math.max(timeOf(meta.lastUpdated) ?? 0, candidate.lastActivity) + CHECKPOINT_SLACK;
  const cks = linkedCheckpoints(dirs, sessionId, startedAt ?? 0, to);
  const snapshot = events.some((e) => e.kind === 'compaction') ? null : checkpointSnapshot(cks);
  const said = messages
    .filter((m) => m.type === 'user' || m.type === 'gemini')
    .map((m) => ({ text: visibleText(m.content).trim(), ts: timeOf(m.timestamp) }))
    .filter((u) => u.text);
  const extra = [...(chatTools ? [] : checkpointTools(cks, said, candidate.cwd)), ...(snapshot ? [snapshot] : [])].sort((a, b) => a.ts - b.ts);
  if (extra.length) events = mergeByTime(events, extra);
  const plan = trackerPlan(join(dirname(dirname(file)), sessionId, 'tracker'));
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
      model,
      resumeCommand: a2a ? undefined : `gemini --resume ${sessionId}`,
    },
    events,
  };
}

/** Start Gemini CLI interactively with a first prompt (-i / --prompt-interactive). */
export function launch(prompt) {
  return ['gemini', ['-i', prompt]];
}
