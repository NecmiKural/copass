/**
 * Claude Code adapter.
 *
 * Sessions: $CLAUDE_CONFIG_DIR|~/.claude/projects/<sanitized launch cwd>/<uuid>.jsonl,
 * append-only JSONL written by the CLI, the VS Code extension and the desktop app.
 * The directory name replaces every non-alphanumeric character with '-' and is
 * cut at 200 chars plus a base36 hash, so it is lossy: every match is confirmed
 * against the cwd recorded inside the file. Subagent transcripts live in
 * <uuid>/subagents/ and are never read.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

import { linesFromEnd, listDir, readJson, readJsonl, statSafe, tryJson } from '../lib/fsx.js';

export const name = 'claude-code';
export const label = 'Claude Code';

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const MAX_DIR_NAME = 200;
const MAX_PROBES = 40;
const ENOUGH_CANDIDATES = 20;
const TITLE_WINDOW_CHARS = 512 * 1024;
const TAIL_LINES = 3000;
const HEAD_BYTES = 128 * 1024;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PLAN_STATUS = { completed: 'done', in_progress: 'active', pending: 'pending', blocked: 'blocked' };

// Harness text that arrives inside user records but was never typed by the user.
const NOISE_BLOCK =
  /^\s*<(?:system-reminder|ide_opened_file|ide_selection|task-notification|agent-message|local-command-(?:stdout|stderr|caveat)|command-message|bash-(?:stdout|stderr)|observed_from_primary_session|user-prompt-submit-hook)\b/;
const INLINE_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const INTERRUPTED = /^\[Request interrupted by user/;
const SUMMARY_PREAMBLE = /^This session is being continued from a previous conversation[^\n]*\n+/;
// Claude's summary ends by telling the previous model to resume without asking — not meant for the next agent.
const SUMMARY_DIRECTIVE = /\n+[^\n]*(?:Please )?continue the conversation from where (?:it|we|you) left off[\s\S]*$/i;

function configDir(ctx) {
  return (ctx.env.CLAUDE_CONFIG_DIR ?? join(ctx.home, '.claude')).normalize('NFC');
}

function javaHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/** Claude Code's project directory name for an absolute path. */
export function sanitize(p) {
  const e = p.replace(/[^a-zA-Z0-9]/g, '-');
  return e.length <= MAX_DIR_NAME ? e : `${e.slice(0, MAX_DIR_NAME)}-${Math.abs(javaHash(p)).toString(36)}`;
}

/**
 * Project directories whose name could belong to one of the project's roots.
 * Exact names come first; prefix matches (subdirectories, but also siblings
 * such as "app-api" for "app") are confirmed later against the recorded cwd.
 */
function candidateDirs(projectsDir, project, ctx) {
  const fold = ctx.platform === 'darwin' || ctx.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const keys = new Set();
  for (const root of project.roots) {
    keys.add(fold(sanitize(root)));
    if (/[^\x00-\x7f]/.test(root)) keys.add(fold(sanitize(root.normalize('NFD'))));
  }
  const exact = [];
  const prefixed = [];
  for (const d of listDir(projectsDir)) {
    if (!d.isDirectory()) continue;
    const f = fold(d.name);
    for (const k of keys) {
      const long = k.length > MAX_DIR_NAME && f.startsWith(k.slice(0, MAX_DIR_NAME));
      if (f === k || long) exact.push(join(projectsDir, d.name));
      else if (f.startsWith(`${k}-`)) prefixed.push(join(projectsDir, d.name));
      else continue;
      break;
    }
  }
  return { exact, prefixed };
}

/** First records of a file, enough to find the launch cwd and start time. */
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

const isMessage = (r) =>
  (r.type === 'user' || r.type === 'assistant') && !r.isSidechain && !r.isMeta && r.message?.model !== '<synthetic>';

/** Read just enough of a session to rank it: last activity, title, cwd. Returns null for stubs. */
function probe(file) {
  let lastActivity = null;
  let title = null;
  let aiTitle = null;
  let relocated = null;
  let entrypoint = null;
  let tailCwd = null;
  let scanned = 0;
  let chars = 0;
  for (const line of linesFromEnd(file, 256 * 1024)) {
    if (++scanned > TAIL_LINES) break;
    // Tail records can be megabytes (API request blobs); once the last message is known,
    // look for the title only within a small window.
    chars += line.length;
    if (lastActivity !== null && chars > TITLE_WINDOW_CHARS) break;
    const r = tryJson(line);
    if (!r) continue;
    if (r.type === 'custom-title' && title === null) title = r.customTitle ?? null;
    else if (r.type === 'ai-title' && aiTitle === null) aiTitle = r.aiTitle ?? null;
    else if (r.type === 'relocated' && relocated === null) relocated = r.relocatedCwd ?? null;
    else if (lastActivity === null && isMessage(r) && r.timestamp) {
      lastActivity = Date.parse(r.timestamp);
      entrypoint = r.entrypoint ?? null;
      tailCwd = r.cwd ?? null;
    }
    // Titles are re-appended near the tail; stop once the essentials are found.
    if (lastActivity !== null && (title !== null || scanned > 400)) break;
  }
  if (lastActivity === null) return null;
  // The launch cwd is in the first records; a huge first record (an image) can push it
  // past the head window, so the cwd of the last message is the fallback.
  const head = headRecords(file);
  const startedAt = head.find((r) => r.timestamp)?.timestamp;
  const firstUser = head.find((r) => isMessage(r) && r.type === 'user' && r.toolUseResult === undefined && !r.isCompactSummary);
  return {
    lastActivity,
    title: title ?? aiTitle,
    preview: firstUser ? promptText(firstUser.message?.content) : null,
    cwd: relocated ?? head.find((r) => r.cwd)?.cwd ?? tailCwd,
    entrypoint,
    startedAt: startedAt ? Date.parse(startedAt) : undefined,
  };
}

/**
 * @param {import('../lib/project.js').Project} project
 * @param {import('./index.js').Context} ctx
 * @returns {Promise<import('./index.js').Candidate[]>}
 */
export async function findSessions(project, ctx) {
  const sessionFiles = (dirs) => {
    const files = [];
    for (const dir of dirs) {
      for (const entry of listDir(dir)) {
        if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue;
        const path = join(dir, entry.name);
        const st = statSafe(path);
        if (st && st.size > 0) files.push({ path, id: entry.name.slice(0, -'.jsonl'.length), mtime: st.mtimeMs });
      }
    }
    return files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_PROBES);
  };
  // Separate probe budgets, so busy sibling projects cannot crowd out the project's own sessions.
  const { exact, prefixed } = candidateDirs(join(configDir(ctx), 'projects'), project, ctx);
  const files = [...sessionFiles(exact), ...sessionFiles(prefixed)].sort((a, b) => b.mtime - a.mtime);

  const out = [];
  for (const f of files) {
    // lastActivity <= mtime, so once enough sessions are found an older file cannot outrank them.
    if (out.length >= ENOUGH_CANDIDATES && f.mtime < out[ENOUGH_CANDIDATES - 1].lastActivity) break;
    const p = probe(f.path);
    if (!p) continue;
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
      current: ctx.env.CLAUDE_CODE_SESSION_ID === f.id,
      background: p.entrypoint === 'sdk-cli',
      ref: { file: f.path, startedAt: p.startedAt },
    });
    out.sort((a, b) => b.lastActivity - a.lastActivity);
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** What the user actually typed in a user record, without harness wrappers. */
function promptText(content) {
  const raw = textOf(content);
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(raw);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim();
    return `${command[1].trim()}${args ? ` ${args}` : ''}`;
  }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(raw);
  if (bash) return `! ${bash[1].trim()}`;

  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const parts = [];
  for (const b of blocks) {
    if (b?.type === 'image') parts.push('[image attached]');
    else if (b?.type === 'text' && typeof b.text === 'string' && !NOISE_BLOCK.test(b.text)) {
      parts.push(b.text.replace(INLINE_REMINDER, ''));
    }
  }
  return parts.join('\n').trim();
}

function resultText(content) {
  const text = typeof content === 'string' ? content : textOf(content);
  return text.length > 1500 ? text.slice(-1500) : text;
}

function toolEvent(block, ts) {
  const input = block.input ?? {};
  const base = { kind: 'tool', tool: block.name, ts, id: block.id };
  if (EDIT_TOOLS.has(block.name)) return { ...base, action: 'edit', target: input.file_path ?? input.notebook_path };
  if (block.name === 'Bash') return { ...base, action: 'command', target: input.command };
  if (block.name === 'Read') return { ...base, action: 'read', target: input.file_path };
  if (block.name === 'Grep' || block.name === 'Glob') return { ...base, action: 'search', target: input.pattern };
  return { ...base, action: 'other', target: input.description ?? input.url ?? input.query ?? undefined };
}

function planFromTodos(todos, ts) {
  return {
    kind: 'plan',
    ts,
    items: todos.map((t) => ({ text: t.content ?? t.subject ?? '', status: PLAN_STATUS[t.status] ?? 'pending' })),
  };
}

/** The newer Task* tools keep their list in ~/.claude/tasks/<sessionId>/<n>.json. */
function planFromTaskDir(dir) {
  const files = listDir(dir).filter((e) => e.isFile() && e.name.endsWith('.json'));
  if (!files.length) return null;
  const tasks = files.map((e) => readJson(join(dir, e.name))).filter((t) => t && (t.subject || t.content));
  if (!tasks.length) return null;
  const ts = Math.max(...files.map((e) => statSafe(join(dir, e.name))?.mtimeMs ?? 0));
  return planFromTodos(tasks.sort((a, b) => Number(a.id) - Number(b.id)), ts);
}

function stopEvent(record, ts) {
  const text = textOf(record.message?.content);
  let reason = 'error';
  if (record.error === 'rate_limit') {
    // "You've hit your session limit · resets 2pm" is a usage quota; a plain 429 is a rate limit.
    reason = /(?:usage|session|weekly|daily|monthly|5-hour)\s+limit|hit your limit|resets\s/i.test(text) ? 'quota' : 'rate_limit';
  } else if (/oauth|token|auth/i.test(text) || record.error === 'authentication_failed') {
    reason = 'error';
  } else if (record.error === 'server_error' || record.apiErrorStatus >= 500 || /overloaded/i.test(text)) {
    reason = 'overloaded';
  }
  return { kind: 'stop', reason, message: text, ts };
}

/**
 * @param {import('./index.js').Candidate} candidate
 * @param {import('./index.js').Context} ctx
 */
export async function loadSession(candidate, ctx) {
  const records = readJsonl(candidate.ref.file);
  const events = [];
  const tools = new Map();
  const queue = [];
  let model;
  let branch;
  let lastCompaction = null;

  for (const r of records) {
    const ts = r.timestamp ? Date.parse(r.timestamp) : undefined;
    if (r.isSidechain) continue;
    if (r.gitBranch) branch = r.gitBranch;

    if (r.type === 'system' && r.subtype === 'compact_boundary') {
      lastCompaction = { kind: 'compaction', trigger: r.compactMetadata?.trigger, ts };
      events.push(lastCompaction);
    } else if (r.type === 'queue-operation') {
      // Harness items (task notifications, agent messages) are queued too; keep the FIFO
      // aligned with a placeholder and drop them at the end.
      if (r.operation === 'enqueue') queue.push({ text: r.content ? promptText(String(r.content)) : '', ts });
      else if (r.operation === 'dequeue' || r.operation === 'remove') queue.shift();
    } else if (r.type === 'attachment' && r.attachment?.type === 'queued_command') {
      // A prompt typed while the agent was busy and delivered mid-turn.
      const a = r.attachment;
      if (!a.isMeta && a.origin?.kind !== 'peer') {
        const text = promptText(a.prompt);
        if (text) events.push({ kind: 'prompt', text, ts });
      }
    } else if (r.type === 'user') {
      const content = r.message?.content;
      if (r.isCompactSummary) {
        const summary = textOf(content).replace(SUMMARY_PREAMBLE, '').replace(SUMMARY_DIRECTIVE, '').trim();
        if (lastCompaction && !lastCompaction.summary) lastCompaction.summary = summary;
        else events.push((lastCompaction = { kind: 'compaction', summary, ts }));
        continue;
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== 'tool_result') continue;
          const ev = tools.get(b.tool_use_id);
          if (!ev) continue;
          ev.ok = !b.is_error;
          if (b.is_error) ev.error = resultText(b.content);
        }
      }
      if (r.isMeta || r.toolUseResult !== undefined || r.sourceToolAssistantUUID) continue;
      if (r.origin?.kind === 'task-notification' || r.origin?.kind === 'peer') continue;
      if (INTERRUPTED.test(textOf(content).trim())) {
        events.push({ kind: 'interrupt', ts });
        continue;
      }
      const text = promptText(content);
      if (text) events.push({ kind: 'prompt', text, ts });
    } else if (r.type === 'assistant') {
      const m = r.message ?? {};
      if (r.isApiErrorMessage || r.error) {
        events.push(stopEvent(r, ts));
        continue;
      }
      if (m.model === '<synthetic>') continue;
      if (m.model) model = m.model;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === 'text' && b.text?.trim()) {
          const last = events.at(-1);
          const partial = m.stop_reason === 'max_tokens' || Boolean(r.isAbortedMidStream);
          if (last?.kind === 'reply' && last.msgId && last.msgId === m.id) {
            last.text += `\n${b.text}`;
            last.final = m.stop_reason === 'end_turn';
          } else {
            events.push({ kind: 'reply', text: b.text, ts, msgId: m.id, final: m.stop_reason === 'end_turn', partial });
          }
        } else if (b?.type === 'tool_use') {
          if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
            events.push(planFromTodos(b.input.todos, ts));
            continue;
          }
          const ev = toolEvent(b, ts);
          tools.set(b.id, ev);
          events.push(ev);
        }
      }
    }
  }

  for (const q of queue) if (q.text) events.push({ kind: 'prompt', source: 'queued', text: q.text, ts: q.ts });
  const taskPlan = planFromTaskDir(join(configDir(ctx), 'tasks', candidate.id));
  if (taskPlan) events.push(taskPlan);

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
      resumeCommand: `claude --resume ${candidate.id}`,
    },
    events,
  };
}

/** Start Claude Code interactively with a first prompt. */
export function launch(prompt) {
  return ['claude', [prompt]];
}
