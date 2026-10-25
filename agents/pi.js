/**
 * pi adapter (https://pi.dev, github.com/earendil-works/pi, formerly badlogic/pi-mono).
 *
 * Built from upstream source; not verified against local data (pi is not
 * installed on the machine this was written on). Sources, repository main at
 * 38ff991 (2026-10-24), packages/coding-agent:
 *   docs/session-format.md, message-types.md, sessions.md, cli.md, compaction.md,
 *     environment-variables.md, settings.md
 *   src/core/session-manager.ts (8ddc44e, 2026-10-23): header, entry types, leaf = last entry
 *     of the file, activity time, default session directory name
 *   src/core/tools/{bash,edit,write,read,grep,find,ls}.ts: tool argument names, exit-code suffix
 *   src/core/agent-session.ts: /skill expansion, retry omission through context_edit
 *   src/cli/{args,file-processor}.ts: positional prompt, @file expansion
 *   ../ai/src/utils/retry.ts: provider error wording; ../ai/src/api/openai-codex-responses.ts
 *   examples/extensions/{todo.ts,plan-mode/index.ts}: the only todo/plan state pi persists
 *   test/fixtures/before-compaction.jsonl: a real session in the older v1 shape
 *
 * Sessions: $PI_CODING_AGENT_DIR|~/.pi/agent/sessions/--<cwd>--/<timestamp>_<id>.jsonl, where
 * <cwd> has its leading separator dropped and every '/', '\' and ':' replaced by '-' — lossy, so
 * every match is confirmed against the cwd in the file's header. A session directory set with
 * PI_CODING_AGENT_SESSION_DIR or the `sessionDir` setting is flat (all projects in one directory).
 *
 * The file is a tree: every entry points at its parent and pi resumes at the LAST entry of the
 * file, so only the path from that leaf to the root is the conversation; abandoned branches
 * (/tree) are ignored, and so are branch summaries (they do not cut the active context). v1
 * files have no ids and are read in file order. pi persists no queued-but-undelivered prompts or
 * input drafts, has no subagents, and its header does not say whether a run was interactive, so
 * background is never set. Without PI_SESSION_ID in the environment (set only for commands that
 * pi's own bash tool runs) no session is flagged current.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { linesFromEnd, listDir, readFirstLine, readJson, readJsonl, statSafe, tryJson } from '../lib/fsx.js';

export const name = 'pi';
export const label = 'pi';

const MAX_PROBES = 40;
const MAX_FLAT_PROBES = 200;
const TAIL_LINES = 3000;
const HEAD_BYTES = 256 * 1024;
const MAX_ERROR = 1500;

const FILE_ARG = (a) => a.path ?? a.file_path;
// tool name -> [action, target taken from the call's arguments]
const TOOLS = {
  edit: ['edit', FILE_ARG],
  write: ['edit', FILE_ARG],
  read: ['read', FILE_ARG],
  bash: ['command', (a) => a.command],
  powershell: ['command', (a) => a.command],
  grep: ['search', (a) => a.pattern],
  find: ['search', (a) => a.pattern],
  ls: ['search', (a) => FILE_ARG(a) ?? '.'],
};

// `/skill:name args` is stored expanded, and the files of `pi @file "msg"` are inlined in the prompt.
const SKILL_BLOCK = /^<skill name="([^"]+)" location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;
const FILE_BLOCKS = /^(?:<file name="[^"]*">[\s\S]*?<\/file>\n?)+/;
const FILE_NAME = /<file name="([^"]*)">/g;
const EXIT_SUFFIX = /Command exited with code (\d+)\s*$/;

// Pi's errorMessage is the provider's own text; these follow its retry classifier (ai/src/utils/retry.ts).
const QUOTA = /insufficient_quota|quota exceeded|out of budget|billing|credit balance|available balance|usage.?limit|hit your .{0,40}limit|subscription_sharing_\w*limit/i;
const RATE_LIMIT = /rate.?limit|too many requests|resource.?exhausted|(?<![a-z0-9])429(?![a-z0-9])/i;
const OVERLOADED = /overloaded|server_busy|servers are currently busy|high demand|at capacity|service.?(?:is.?)?(?:temporarily.?)?unavailable|server.?error|internal.?error|(?<![a-z0-9])(?:500|502|503|504|520|524|529)(?![a-z0-9])/i;
// "You have hit your ChatGPT usage limit (plus). Try again in ~42 min." (Codex login) and similar.
const RETRY_IN = /(?:try again|retry)(?: again)? in ~?\s*(\d+(?:\.\d+)?)\s*(ms|s|sec\w*|m|min\w*|h|hr\w*|hours?)\b/i;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 };

function expandHome(p, home) {
  if (p === '~') return home;
  return p.startsWith('~/') || p.startsWith('~\\') ? join(home, p.slice(2)) : p;
}

function agentDir(ctx) {
  const dir = ctx.env.PI_CODING_AGENT_DIR;
  return dir ? expandHome(dir, ctx.home) : join(ctx.home, '.pi', 'agent');
}

/** The flat session directory the user configured (env beats the setting), or null for the default layout. */
function customSessionDir(project, ctx) {
  const dir = ctx.env.PI_CODING_AGENT_SESSION_DIR || readJson(join(agentDir(ctx), 'settings.json'))?.sessionDir;
  return typeof dir === 'string' && dir ? resolve(project.dir, expandHome(dir, ctx.home)) : null;
}

/** Pi's session directory name for a working directory. */
export function encodeCwd(cwd) {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/**
 * Session directories whose name could belong to one of the project's roots. Exact names come
 * first; prefix matches (subdirectories, but also siblings such as "app-api" for "app") are
 * confirmed later against the cwd in the header.
 */
function candidateDirs(sessionsRoot, project, ctx) {
  const fold = ctx.platform === 'darwin' || ctx.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const keys = new Set();
  for (const root of project.roots) {
    keys.add(fold(encodeCwd(root)));
    if (/[^\x00-\x7f]/.test(root)) keys.add(fold(encodeCwd(root.normalize('NFD'))));
  }
  const exact = [];
  const prefixed = [];
  for (const d of listDir(sessionsRoot)) {
    if (!d.isDirectory()) continue;
    const f = fold(d.name);
    for (const k of keys) {
      if (f === k) exact.push(join(sessionsRoot, d.name));
      else if (f.startsWith(k.slice(0, -1))) prefixed.push(join(sessionsRoot, d.name)); // '--root-' + more
      else continue;
      break;
    }
  }
  return { exact, prefixed };
}

/** Time an entry was written (message_end for a reply), falling back to the message's own stamp. */
function entryTime(e) {
  const t = Date.parse(e.timestamp);
  return Number.isFinite(t) ? t : typeof e.message?.timestamp === 'number' ? e.message.timestamp : undefined;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

const tail = (text) => (text.length > MAX_ERROR ? text.slice(-MAX_ERROR) : text);

/** Resolve a tool path the way pi does: optional leading '@', '~', relative to the session cwd. */
function absPath(p, cwd, home) {
  if (typeof p !== 'string' || !p) return undefined;
  const s = expandHome(p.startsWith('@') ? p.slice(1) : p, home);
  return isAbsolute(s) || !cwd ? s : resolve(cwd, s);
}

/** What the user typed in a user message, with expanded skills and inlined @files folded back. */
function promptText(content) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const parts = [];
  for (const b of blocks) {
    if (b?.type === 'image') {
      parts.push('[image attached]');
      continue;
    }
    if (b?.type !== 'text' || typeof b.text !== 'string') continue;
    const skill = SKILL_BLOCK.exec(b.text);
    const files = skill ? null : FILE_BLOCKS.exec(b.text);
    if (skill) parts.push(`/skill:${skill[1]}${skill[2] ? ` ${skill[2].trim()}` : ''}`);
    else if (files) parts.push(`${[...files[0].matchAll(FILE_NAME)].map((m) => `@${m[1]}`).join(' ')}\n${b.text.slice(files[0].length)}`);
    else parts.push(b.text);
  }
  return parts.join('\n').trim();
}

const hasVisible = (m) =>
  Array.isArray(m.content) && m.content.some((b) => (b?.type === 'text' && b.text?.trim()) || b?.type === 'toolCall');

/** A user message, or an assistant message that said or did something (not an empty error or abort). */
const isConversation = (r) =>
  r.type === 'message' && (r.message?.role === 'user' || (r.message?.role === 'assistant' && hasVisible(r.message)));

/** The session header (first line); null when the file is not a pi session. */
function readHeader(file) {
  const header = tryJson(readFirstLine(file) ?? '');
  return header?.type === 'session' && typeof header.id === 'string' ? header : null;
}

/**
 * First prompt and an early /name from the start of a file. The second line is the system prompt
 * (tens of KB), which is skipped unparsed; later lines are only parsed when they might matter.
 */
function probeHead(file) {
  let fd;
  let lines;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    lines = buf.toString('utf8', 0, n).split('\n');
    if (n === HEAD_BYTES) lines.pop(); // possibly cut mid-line
  } catch {
    return { preview: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  let preview = null;
  let title;
  for (const line of lines.slice(1)) {
    if (line.includes('"type":"session_info"')) {
      const r = tryJson(line);
      if (r?.type === 'session_info') title = r.name?.trim() || undefined;
    } else if (preview === null && line.includes('"role":"user"') && !line.slice(0, 300).includes('"role":"system"')) {
      const r = tryJson(line);
      if (r?.message?.role === 'user') preview = promptText(r.message.content) || null;
    }
  }
  return { preview, title };
}

/** Last user/assistant time from the end of the file; null for a session with no conversation yet. */
function lastActivity(file) {
  let scanned = 0;
  for (const line of linesFromEnd(file, 256 * 1024)) {
    if (++scanned > TAIL_LINES) break;
    const r = tryJson(line);
    if (r && isConversation(r)) return entryTime(r) ?? null;
  }
  return null;
}

/**
 * @param {import('../lib/project.js').Project} project
 * @param {import('./index.js').Context} ctx
 * @returns {Promise<import('./index.js').Candidate[]>}
 */
export async function findSessions(project, ctx) {
  const sessionFiles = (dirs, cap) => {
    const files = [];
    for (const dir of dirs) {
      for (const entry of listDir(dir)) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const path = join(dir, entry.name);
        const st = statSafe(path);
        if (st && st.size > 0) files.push({ path, mtime: st.mtimeMs });
      }
    }
    return files.sort((a, b) => b.mtime - a.mtime).slice(0, cap);
  };
  // Separate probe budgets, so busy sibling projects cannot crowd out the project's own sessions.
  const { exact, prefixed } = candidateDirs(join(agentDir(ctx), 'sessions'), project, ctx);
  const flat = customSessionDir(project, ctx);
  const files = [...sessionFiles(exact, MAX_PROBES), ...sessionFiles(prefixed, MAX_PROBES), ...(flat ? sessionFiles([flat], MAX_FLAT_PROBES) : [])];

  const out = [];
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    const header = readHeader(f.path);
    const score = header ? project.match(header.cwd) : 0;
    if (!score) continue;
    const activity = lastActivity(f.path);
    if (activity === null) continue;
    const head = probeHead(f.path);
    out.push({
      agent: name,
      id: header.id,
      lastActivity: activity,
      score,
      cwd: header.cwd,
      title: head.title,
      preview: head.preview || undefined,
      current: ctx.env.PI_SESSION_ID === header.id || ctx.env.PI_SESSION_FILE === f.path,
      ref: { file: f.path, startedAt: Date.parse(header.timestamp) || undefined, model: header.modelId },
    });
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}

/**
 * The conversation: the path from the file's last entry up through parentId (how pi itself
 * resumes), or the entries in file order for v1 files, which have no ids.
 */
function activeBranch(records) {
  const entries = records.filter((r) => r.type !== 'session');
  if (!entries.some((e) => typeof e.id === 'string')) return entries;
  const byId = new Map(entries.filter((e) => typeof e.id === 'string').map((e) => [e.id, e]));
  const path = [];
  const seen = new Set();
  for (let e = entries.at(-1); e && !seen.has(e); e = byId.get(e.parentId)) {
    seen.add(e);
    path.push(e);
  }
  return path.reverse();
}

function toolEvent(tool, args, ts, st) {
  const a = args && typeof args === 'object' ? args : {};
  const [action, pick] = (Object.hasOwn(TOOLS, tool) && TOOLS[tool]) || ['other', (x) => x.description ?? x.url ?? x.query];
  const target = pick(a);
  return { kind: 'tool', tool, action, target: action === 'edit' || action === 'read' ? absPath(target, st.cwd, st.home) : target ?? undefined, ts };
}

function stopEvent(m, ts) {
  const message = m.errorMessage ?? '';
  const reason = QUOTA.test(message) ? 'quota' : RATE_LIMIT.test(message) ? 'rate_limit' : OVERLOADED.test(message) ? 'overloaded' : 'error';
  const wait = reason === 'quota' || reason === 'rate_limit' ? RETRY_IN.exec(message) : null;
  const unitMs = wait ? (wait[2].toLowerCase() === 'ms' ? 1 : UNIT_MS[wait[2][0].toLowerCase()]) : 0;
  return { kind: 'stop', reason, message: message || undefined, resetsAt: wait && ts ? Math.round(ts + Number(wait[1]) * unitMs) : undefined, ts };
}

function onAssistant(st, e, ts) {
  const m = e.message;
  if (m.model) st.model = m.model;
  let reply = null;
  for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b?.type === 'text' && b.text?.trim()) {
      if (reply && st.events.at(-1) === reply) reply.text += `\n${b.text}`;
      else st.events.push((reply = { kind: 'reply', text: b.text, ts }));
    } else if (b?.type === 'toolCall' && b.name !== 'todo') {
      const ev = toolEvent(b.name, b.arguments, ts, st);
      st.tools.set(b.id, ev);
      st.events.push(ev);
    }
  }
  if (reply && m.stopReason === 'stop') reply.final = true;
  else if (reply && ['length', 'aborted', 'error'].includes(m.stopReason)) reply.partial = true;
  if (m.stopReason === 'aborted') st.events.push({ kind: 'interrupt', ts });
  // A failed attempt that pi retried is kept in the file but omitted from context by a context_edit.
  else if (m.stopReason === 'error' && !st.omitted.has(e.id)) st.events.push(stopEvent(m, ts));
}

function onToolResult(st, r, ts) {
  const text = textOf(r.content);
  const ev = st.tools.get(r.toolCallId);
  if (ev) {
    ev.ok = !r.isError;
    if (r.isError) ev.error = tail(text);
    const exit = EXIT_SUFFIX.exec(text);
    if (ev.action === 'command' && (exit || !r.isError)) ev.exit = exit ? Number(exit[1]) : 0;
  }
  if (r.toolName === 'todo' && Array.isArray(r.details?.todos)) {
    st.events.push({ kind: 'plan', ts, items: r.details.todos.map((t) => ({ text: t.text, status: t.done ? 'done' : 'pending' })) });
  }
  // Calls a tool (codemode) made to other tools are recorded on its result; they still touched files.
  for (const c of r.nestedCalls?.calls ?? []) {
    const nested = toolEvent(c.name, c.arguments, ts, st);
    if (c.status !== 'unfinished') nested.ok = c.status === 'ok';
    if (c.error) nested.error = tail(String(c.error));
    st.events.push(nested);
  }
}

/** A command the user ran themselves with `!cmd` (`!!cmd` is deliberately kept from the model, so it is skipped). */
function onUserBash(st, m, ts) {
  if (m.excludeFromContext || !m.command) return;
  const done = typeof m.exitCode === 'number';
  const ok = done ? m.exitCode === 0 : m.cancelled ? false : undefined;
  const ev = { kind: 'tool', tool: 'bash', action: 'command', target: m.command, ts, ok };
  if (done) ev.exit = m.exitCode;
  if (ok === false) ev.error = tail(String(m.output ?? '')) || 'cancelled';
  st.events.push(ev);
}

function onMessage(st, e, ts) {
  const m = e.message;
  if (m?.role === 'user') {
    const text = promptText(m.content);
    if (text) st.events.push({ kind: 'prompt', text, ts });
  } else if (m?.role === 'assistant') onAssistant(st, e, ts);
  else if (m?.role === 'toolResult') onToolResult(st, m, ts);
  else if (m?.role === 'bashExecution') onUserBash(st, m, ts);
  // system prompts, extension-injected custom messages: not the user's words, not the agent's work
}

/**
 * @param {import('./index.js').Candidate} candidate
 * @param {import('./index.js').Context} ctx
 */
export async function loadSession(candidate, ctx) {
  const records = readJsonl(candidate.ref.file);
  const path = activeBranch(records);
  const st = {
    events: [],
    tools: new Map(),
    model: candidate.ref.model,
    cwd: candidate.cwd,
    home: ctx.home,
    omitted: new Set(path.filter((e) => e.type === 'context_edit' && e.replacement === null).map((e) => e.targetId)),
  };

  for (const e of path) {
    const ts = entryTime(e);
    if (e.type === 'message') onMessage(st, e, ts);
    else if (e.type === 'model_change' && e.modelId) st.model = e.modelId;
    else if (e.type === 'compaction') st.events.push({ kind: 'compaction', summary: String(e.summary ?? '').trim() || undefined, ts });
    else if (e.type === 'custom' && e.customType === 'plan-mode' && Array.isArray(e.data?.todos)) {
      st.events.push({ kind: 'plan', ts, items: e.data.todos.map((t) => ({ text: t.text, status: t.completed ? 'done' : 'pending' })) });
    }
  }

  // /name applies to the whole file, whichever branch it was typed on; the latest one wins, an empty one clears.
  const names = records.filter((r) => r.type === 'session_info');
  const title = names.length ? names.at(-1).name?.trim() || undefined : candidate.title;

  return {
    meta: {
      agent: name,
      sessionId: candidate.id,
      title,
      cwd: candidate.cwd,
      logFile: candidate.ref.file,
      startedAt: candidate.ref.startedAt,
      lastActivity: candidate.lastActivity,
      model: st.model,
      resumeCommand: `pi --session ${candidate.id}`,
    },
    events: st.events,
  };
}

/** Start pi interactively with a first prompt (a positional argument; `--` keeps a leading '-' from being read as a flag). */
export function launch(prompt) {
  return ['pi', prompt.startsWith('-') ? ['--', prompt] : [prompt]];
}
