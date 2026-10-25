/**
 * GitHub Copilot CLI adapter.
 *
 * Sessions: ($COPILOT_HOME | ~/.copilot)/session-state/<uuid>/events.jsonl on every OS;
 * machines that have not run a recent build may still keep them under
 * $XDG_STATE_HOME/.copilot/session-state. Append-only JSONL of {type, data, id, parentId,
 * timestamp, agentId?} (a rewind rewrites it shorter). Line 1 is always session.start with
 * the launch context {cwd, gitRoot, branch, headCommit}. Sessions started from VS Code
 * (Copilot Chat's CLI agent) live here too and wrap the prompt in <userRequest>. Sub-agent
 * events are inline, marked by agentId or data.parentToolCallId. A session directory
 * without events.jsonl was created but never used.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

import { linesFromEnd, listDir, readFirstLine, readJsonl, readText, statSafe, tryJson } from '../lib/fsx.js';
import { realpathOr } from '../lib/project.js';
import { queryAll } from '../lib/sqlite.js';

export const name = 'copilot-cli';
export const label = 'GitHub Copilot CLI';

const HEAD_BYTES = 512 * 1024; // the first prompt can sit ~110 KB in, after the system prompt
const MAX_ERROR = 1500;

const EDIT_TOOLS = new Set(['edit', 'create']);
const COMMAND_TOOLS = new Set(['bash', 'powershell']);
const SEARCH_TOOLS = new Set(['rg', 'grep', 'glob']);
// Bookkeeping, not work: the agent's status line and autopilot's end marker (its summary
// arrives as session.task_complete). update_todo becomes a plan event instead. The shell
// helpers only poll or feed a background command; their results complete that command.
const SKIP_TOOLS = new Set(['report_intent', 'task_complete']);
for (const verb of ['read', 'write', 'stop', 'list']) for (const shell of COMMAND_TOOLS) SKIP_TOOLS.add(`${verb}_${shell}`);
// session.error types that end the turn; the others are internal and the agent carries on.
const STOP_ERRORS = new Set(['rate_limit', 'quota', 'query', 'context_limit', 'authentication', 'authorization']);
const PLAN_STATUS = { done: 'done', in_progress: 'active', pending: 'pending', blocked: 'blocked' };
const CHECKBOX = { x: 'done', X: 'done', ' ': 'pending', '~': 'active', '-': 'active', '>': 'active', '!': 'blocked' };

const USER_REQUEST = /<userRequest>([\s\S]*?)<\/userRequest>/;
const WRAPPER_BLOCK = /<(reminder|attachments|system_notification)>[\s\S]*?<\/\1>/g;
// ACP clients (JetBrains) attach the open editor file as a resource_link, rendered as its own
// line. Titles copy the prompt cut at 100 chars, which can leave the link without its `]`.
const RESOURCE_LINK = /^\[Resource link: [^\]\n]*\]?$/gm;
const PATCH_FILE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;
const EXIT_MARKER = /<exited with exit code (-?\d+)>\s*$/;
// A command still running when the tool returned; read_bash or a shell_completed notification
// reports its exit later.
const BACKGROUND_SHELL = /<command (?:with shellId: |started in (?:detached )?background with shellId: )([^\s>]+)/;
const SHELL_EXIT = /<command with id: ([^\s>]+) exited with exit code (-?\d+)>\s*$/;
const CHECKLIST_ITEM = /^\s*[-*]\s*\[(.)\]\s*(.+)$/gm;

/** Session roots, deduplicated: the XDG migration leaves a symlink at the old path. */
function stateDirs(ctx) {
  const dirs = [join(ctx.env.COPILOT_HOME || join(ctx.home, '.copilot'), 'session-state')];
  if (ctx.env.XDG_STATE_HOME) dirs.push(join(ctx.env.XDG_STATE_HOME, '.copilot', 'session-state'));
  return [...new Map(dirs.map((d) => [realpathOr(d), d])).values()];
}

const isSub = (e) => Boolean(e.agentId || e.data?.parentToolCallId);

/** A user.message the user sent: not a system notification, skill injection or autopilot nudge. */
const isTyped = (d) => (!d.source || d.source === 'user') && !d.isAutopilotContinuation;

/** What the user typed. Never transformedContent, which adds datetime, todo and SQL context. */
function promptText(content) {
  const raw = String(content ?? '');
  const wrapped = USER_REQUEST.exec(raw);
  return (wrapped ? wrapped[1] : raw.replace(WRAPPER_BLOCK, '')).replace(RESOURCE_LINK, '').trim();
}

/** Time of the last main-agent user/assistant record, or null for a session without any. */
function lastActivityOf(file) {
  for (const line of linesFromEnd(file, 256 * 1024)) {
    if (!line.includes('"user.message"') && !line.includes('"assistant.message"')) continue;
    const e = tryJson(line);
    if (!e || isSub(e)) continue;
    if (e.type === 'assistant.message' || (e.type === 'user.message' && isTyped(e.data ?? {}))) return Date.parse(e.timestamp);
  }
  return null;
}

/** First genuine prompt within the head of the file, for `copass list` when there is no title. */
function firstPrompt(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (!line.includes('"user.message"')) continue;
      const e = tryJson(line);
      if (e?.type === 'user.message' && !isSub(e) && isTyped(e.data ?? {})) return promptText(e.data.content) || undefined;
    }
  } catch {
    // unreadable: no preview
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}

/** A top-level scalar of workspace.yaml: plain, quoted or a block scalar (`|-`, `>`). */
function yamlField(text, key) {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (i < 0) return null;
  const value = lines[i].slice(key.length + 1).trim();
  if (/^[|>][-+]?$/.test(value)) {
    const body = [];
    for (let j = i + 1; j < lines.length && (/^\s/.test(lines[j]) || !lines[j]); j++) body.push(lines[j].trim());
    return body.join(value[0] === '|' ? '\n' : ' ').trim() || null;
  }
  if (value.startsWith('"')) return tryJson(value) ?? value.slice(1, -1);
  if (value.startsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value || null;
}

/** The session's name (set by the user or generated), else its summary. */
function titleOf(dir) {
  const yaml = readText(join(dir, 'workspace.yaml'));
  const title = yaml && (yamlField(yaml, 'name') ?? yamlField(yaml, 'summary'));
  return title ? title.replace(RESOURCE_LINK, '').trim() || null : null; // generated names copy the first prompt
}

/** inuse.<pid>.lock whose process still runs (EPERM = alive, owned by someone else). */
function hasLiveLock(dir) {
  return listDir(dir).some((entry) => {
    const m = /^inuse\.(\d+)\.lock$/.exec(entry.name);
    if (!m) return false;
    try {
      process.kill(Number(m[1]), 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  });
}

/** Shell commands get COPILOT_AGENT_SESSION_ID; older builds (1.0.4) strip it but set COPILOT_CLI=1. */
function isCurrent(id, dir, ctx) {
  if (ctx.env.COPILOT_AGENT_SESSION_ID) return ctx.env.COPILOT_AGENT_SESSION_ID === id;
  return ctx.env.COPILOT_CLI === '1' && hasLiveLock(dir);
}

/**
 * @param {import('../lib/project.js').Project} project
 * @param {import('./index.js').Context} ctx
 * @returns {Promise<import('./index.js').Candidate[]>}
 */
export async function findSessions(project, ctx) {
  const seen = new Set();
  const out = [];
  for (const root of stateDirs(ctx)) {
    for (const entry of listDir(root)) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || seen.has(entry.name)) continue;
      seen.add(entry.name);
      const dir = join(root, entry.name);
      const file = join(dir, 'events.jsonl');
      if (!statSafe(file)?.size) continue;
      const start = tryJson(readFirstLine(file) ?? '');
      if (start?.type !== 'session.start') continue;
      // ponytail: matched on the launch cwd only; a later session.resume/context_changed into
      // another directory needs a full scan to see, so loadSession reports it as meta.cwd.
      const cwd = start.data?.context?.cwd;
      const score = project.match(cwd);
      if (!score) continue;
      const lastActivity = lastActivityOf(file);
      if (lastActivity === null) continue;
      const title = titleOf(dir);
      out.push({
        agent: name,
        id: entry.name,
        lastActivity,
        score,
        cwd,
        title: title ?? undefined,
        preview: title ? undefined : firstPrompt(file),
        current: isCurrent(entry.name, dir, ctx),
        // A headless run the CLI detaches when an interactive session shuts down.
        background: start.data?.detachedFromSpawningParentSessionId ? true : undefined,
        ref: { file, dir, startedAt: Date.parse(start.data?.startTime ?? start.timestamp) || undefined },
      });
    }
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}

const tail = (text) => String(text ?? '').trim().slice(-MAX_ERROR);

/** Tool events for one call; apply_patch yields one edit per file it touches. */
function toolEvents(d, ts) {
  const a = d.arguments ?? {};
  const base = { kind: 'tool', tool: d.toolName, ts };
  if (d.toolName === 'apply_patch') {
    const patch = typeof a === 'string' ? a : String(a.input ?? a.patch ?? '');
    const paths = [...patch.matchAll(PATCH_FILE)].map((m) => m[1].trim());
    return paths.length ? paths.map((target) => ({ ...base, action: 'edit', target })) : [{ ...base, action: 'edit' }];
  }
  if (EDIT_TOOLS.has(d.toolName)) return [{ ...base, action: 'edit', target: a.path }];
  if (COMMAND_TOOLS.has(d.toolName)) return [{ ...base, action: 'command', target: a.command }];
  if (d.toolName === 'view') return [{ ...base, action: 'read', target: a.path }];
  if (SEARCH_TOOLS.has(d.toolName)) return [{ ...base, action: 'search', target: a.pattern }];
  return [{ ...base, action: 'other', target: a.description ?? a.url ?? a.query ?? a.question ?? undefined }];
}

/** Outcome from tool.execution_complete; shells report their exit code as a trailing marker. */
function applyResult(ev, d, shells) {
  const output = String(d.result?.content ?? '');
  const exit = ev.action === 'command' ? EXIT_MARKER.exec(output) : null;
  const background = ev.action === 'command' && !exit && d.success !== false ? BACKGROUND_SHELL.exec(output) : null;
  if (background) return void shells.set(background[1], ev); // outcome unknown until the shell finishes
  if (exit) ev.exit = Number(exit[1]);
  ev.ok = exit ? ev.exit === 0 : d.success !== false;
  if (!ev.ok) ev.error = tail(exit ? output.slice(0, exit.index) : (d.error?.message ?? d.error?.code ?? output));
}

/** A background command finished; whichever of read_bash and the notification comes first sets the exit. */
function finishShell(ev, exit, output) {
  if (!ev) return;
  if (ev.exit === undefined) Object.assign(ev, { exit, ok: exit === 0 });
  if (ev.ok === false && !ev.error && output.trim()) ev.error = tail(output);
}

/** update_todo (CLI <= 1.0.4) keeps the list as a markdown checklist. */
function planFromChecklist(markdown, ts) {
  const items = [...String(markdown ?? '').matchAll(CHECKLIST_ITEM)].map((m) => ({ text: m[2].trim(), status: CHECKBOX[m[1]] ?? 'pending' }));
  return items.length ? { kind: 'plan', ts, items } : null;
}

/** Newer builds keep todos in the session's own SQLite file (written through the `sql` tool). */
async function planFromDb(dir) {
  const rows = await queryAll(join(dir, 'session.db'), 'SELECT title, status, updated_at FROM todos ORDER BY created_at, rowid');
  if (!rows?.length) return null;
  const ts = Math.max(...rows.map((r) => Date.parse(`${String(r.updated_at).replace(' ', 'T')}Z`) || 0));
  return { kind: 'plan', ts, items: rows.map((r) => ({ text: String(r.title), status: PLAN_STATUS[r.status] ?? 'pending' })) };
}

/** Reset time as the CLI prints it: "on May 11, 2026 at 12:00 PM" (local) or "in 2 hours 5 minutes". */
function resetTime(message, ts) {
  const on = /on (\w+ \d{1,2}, \d{4}) at (\d{1,2}:\d{2}\s*[AP]M)/i.exec(message);
  if (on) return Date.parse(`${on[1]} ${on[2]}`) || undefined;
  if (!ts) return undefined;
  if (/\bin under a minute\b/.test(message)) return ts + 60_000;
  const hours = /\bin (\d+) hours?\b/.exec(message);
  const minutes = /\b(?:in|hours?) (\d+) minutes?\b/.exec(message);
  if (!hours && !minutes) return undefined;
  return ts + (Number(hours?.[1] ?? 0) * 60 + Number(minutes?.[1] ?? 0)) * 60_000;
}

function stopEvent(d, ts) {
  let reason = 'error';
  if (d.errorType === 'quota' || /weekly|global|quota/.test(String(d.errorCode ?? ''))) reason = 'quota';
  else if (d.errorType === 'rate_limit') reason = 'rate_limit';
  else if (d.statusCode >= 500) reason = 'overloaded';
  const message = d.message ? String(d.message) : undefined;
  return { kind: 'stop', reason, message, resetsAt: message ? resetTime(message, ts) : undefined, ts };
}

/**
 * GPT models split a turn into 'commentary' notes and a 'final_answer'; one reply per
 * interaction keeps the final answer, else the joined notes. Models without phases end
 * the agent loop with a message that requests no tools, which is the turn's answer.
 * `replies` is cleared at every user.message: a reply can carry the previous prompt's
 * interactionId (a message steered in from VS Code mid-turn).
 */
function addReply(events, replies, d, ts) {
  const text = String(d.content ?? '').trim();
  if (!text) return;
  const final = d.phase ? d.phase === 'final_answer' : !d.toolRequests?.length;
  let r = d.interactionId ? replies.get(d.interactionId) : null;
  if (!r) {
    r = { event: { kind: 'reply', text, ts, final }, finals: [], notes: [] };
    events.push(r.event);
    if (d.interactionId) replies.set(d.interactionId, r);
  }
  (final ? r.finals : r.notes).push(text);
  r.event.text = (r.finals.length ? r.finals : r.notes).join('\n\n');
  r.event.final = r.finals.length > 0;
  r.event.ts = ts;
}

/** 'auto' lets the service choose per request; the concrete model recorded on replies and tool results says more. */
const pickModel = (next, current) => (next && (next !== 'auto' || !current) ? next : current);

/**
 * @param {import('./index.js').Candidate} candidate
 * @param {import('./index.js').Context} ctx
 */
export async function loadSession(candidate, ctx) {
  const events = [];
  const tools = new Map();
  const shells = new Map(); // shellId -> command event still running in the background
  const replies = new Map();
  let context = {};
  let model;

  for (const e of readJsonl(candidate.ref.file)) {
    const d = e.data ?? {};
    const ts = Date.parse(e.timestamp) || undefined;
    const sub = isSub(e);
    // A sub-agent's file edits are real changes; the rest of its side chain is noise.
    if (sub && e.type !== 'tool.execution_start' && e.type !== 'tool.execution_complete') continue;

    switch (e.type) {
      case 'session.start':
      case 'session.resume':
        context = d.context ?? context;
        model = pickModel(d.selectedModel, model);
        break;
      case 'session.context_changed':
        context = d;
        break;
      case 'session.model_change':
        model = pickModel(d.newModel, model);
        break;
      case 'user.message': {
        replies.clear();
        const text = isTyped(d) ? promptText(d.content) : '';
        if (text) events.push({ kind: 'prompt', text, ts });
        break;
      }
      case 'assistant.message':
        model = pickModel(d.model, model);
        addReply(events, replies, d, ts);
        break;
      case 'session.task_complete':
        if (d.summary) events.push({ kind: 'reply', text: String(d.summary), final: true, ts });
        break;
      case 'tool.execution_start': {
        if (d.toolName === 'update_todo') {
          const plan = sub ? null : planFromChecklist(d.arguments?.todos, ts);
          if (plan) events.push(plan);
          break;
        }
        if (SKIP_TOOLS.has(d.toolName)) break;
        const evs = toolEvents(d, ts).filter((t) => !sub || t.action === 'edit');
        tools.set(d.toolCallId, evs);
        events.push(...evs);
        break;
      }
      case 'tool.execution_complete': {
        if (!sub) model = pickModel(d.model, model);
        for (const ev of tools.get(d.toolCallId) ?? []) applyResult(ev, d, shells);
        const output = String(d.result?.content ?? '');
        const done = sub ? null : SHELL_EXIT.exec(output);
        if (done) finishShell(shells.get(done[1]), Number(done[2]), output.slice(0, done.index));
        break;
      }
      case 'system.notification':
        if (d.kind?.type === 'shell_completed' && Number.isInteger(d.kind.exitCode)) finishShell(shells.get(d.kind.shellId), d.kind.exitCode, '');
        break;
      case 'session.compaction_complete':
        if (d.success === false) break;
        events.push({ kind: 'compaction', summary: d.summaryContent?.trim() || undefined, trigger: d.customInstructions ? 'manual' : undefined, ts });
        break;
      case 'session.truncation':
        events.push({ kind: 'compaction', trigger: 'truncation', ts });
        break;
      case 'session.error':
        if (STOP_ERRORS.has(d.errorType)) events.push(stopEvent(d, ts));
        break;
      case 'session.shutdown':
        model = pickModel(d.currentModel, model);
        if (d.shutdownType === 'error') events.push({ kind: 'stop', reason: 'error', message: d.errorReason, ts });
        break;
      case 'abort':
        events.push({ kind: 'interrupt', ts });
        break;
    }
  }

  const dbPlan = await planFromDb(candidate.ref.dir);
  const lastPlan = events.findLast((ev) => ev.kind === 'plan');
  if (dbPlan && !(lastPlan?.ts > dbPlan.ts)) events.push(dbPlan);
  // Without todo state, the checklist the agent keeps in its own plan.md is the plan.
  if (!lastPlan && !dbPlan) {
    const planFile = join(candidate.ref.dir, 'plan.md');
    const plan = planFromChecklist(readText(planFile), statSafe(planFile)?.mtimeMs);
    if (plan) events.push(plan);
  }

  return {
    meta: {
      agent: name,
      sessionId: candidate.id,
      title: candidate.title,
      cwd: context.cwd ?? candidate.cwd,
      logFile: candidate.ref.file,
      startedAt: candidate.ref.startedAt,
      lastActivity: candidate.lastActivity,
      model,
      branch: context.branch,
      commit: context.headCommit,
      resumeCommand: `copilot --resume=${candidate.id}`,
    },
    events,
  };
}

/** Start Copilot CLI interactively with a first prompt (`-i, --interactive <prompt>`). */
export function launch(prompt) {
  return ['copilot', ['-i', prompt]];
}
