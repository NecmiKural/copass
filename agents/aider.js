/**
 * Built from upstream source; not verified against local data (Aider is not
 * installed on this machine, so there was no real history file to check).
 *
 * Aider adapter.
 *
 * Upstream: github.com/Aider-AI/aider @ 5dc9490 (2026-05-22) and
 * prompt-toolkit @ 6c7fbc1 (2026-10-20):
 *   aider/args.py L270-288       the chat and input history files default to
 *                                <git root>/.aider.chat.history.md and
 *                                .aider.input.history (the cwd outside a repo)
 *   aider/io.py L336             every aider process appends
 *                                "\n# aider chat started at YYYY-MM-DD HH:MM:SS\n\n" (naive local time)
 *   aider/io.py L775-795         user_input writes "#### <line>" per line joined by "  \n";
 *                                ai_output writes "\n<reply>\n\n" verbatim (reasoning included)
 *   aider/io.py L966-1010,L1117  tool_output/_error/_warning write "> <text>  \n"; a multi-line
 *                                tool_output prefixes only its FIRST line
 *   aider/coders/base_coder.py   L207 banner (model), L986 ^C, L1449-1510 litellm errors and
 *                                retries, L1829 ai_output in send()'s finally, L2102 "Tokens:",
 *                                L2296-2334 edit errors and "Applied edit to <file>"
 *   aider/repo.py L313           "Commit <sha> <message>"
 *   aider/main.py L1117          "Cur working dir:" / "Git working dir:" when aider ran in a subdirectory
 *   aider/commands.py            /run /test !cmd /git run commands; /ask /code /architect /context /ok carry a request
 *   aider/reasoning_tags.py      reasoning is logged as <thinking-content-…> or <think> blocks
 *   prompt_toolkit/history.py L262-307  .aider.input.history: "\n# <datetime.now()>\n" + "+<line>\n" per input
 *
 * Sessions: one markdown file per repository holds EVERY aider process of that
 * repo, one "# aider chat started at" block each, so a session is identified by
 * its start time (the id is a hash of file and start time). Records carry no timestamps; the input-history file supplies them for
 * typed prompts. Command output, todo lists and the summaries of chat-history
 * compaction are never logged, so there are no plan or compaction events.
 * Aider exposes no session id to child processes, so `current` is never set.
 * `aider --restore-chat-history` reloads the file (all sessions), which is the
 * only native way back in.
 */

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { readText, statSafe } from '../lib/fsx.js';
import { realpathOr } from '../lib/project.js';
import { isCommand } from '../lib/text.js';

export const name = 'aider';
export const label = 'Aider';

const CHAT_FILE = '.aider.chat.history.md';
const INPUT_FILE = '.aider.input.history';
const MB = 1024 * 1024;
const WINDOWS = [2 * MB, 8 * MB, 32 * MB, Infinity]; // tail sizes tried until the wanted session is inside
const MAX_PER_FILE = 25;
const MAX_ERROR = 1500;

const HEADER = /^# aider chat started at (\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\s*$/;
const INPUT_STAMP = /^# (\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d+))?$/;

// What the user types: a request, or a command (aider treats any input starting with / or ! as one).
const RUN = /^(?:\/(run|test)(?:\s|$)|!)\s*([\s\S]*)$/;
const GIT = /^\/git\s+(\S[\s\S]*)$/;
const MODE = /^\/(?:ask|code|architect|context)\s+(\S[\s\S]*)$/;
const OK = /^\/ok(?:\s+([\s\S]*))?$/;
const KEPT = /^\/(?:undo|clear|reset|model|web)(?:\s|$)/; // plumbing worth showing the next agent

// Messages aider itself writes on the "> " channel.
const EDIT_FORMAT_ERROR = 'The LLM did not conform to the edit format.';
const APPLIED = /^Applied edit to (.+)$/;
const RUNNING = /^Running (.+)$/;
const COMMIT = /^Commit ([0-9a-f]{6,40}) (.+)$/;
const MODEL = /^(?:Main model|Model): (.+?) with \S+ edit format/;
const WORKDIR = /^(Cur|Git) working dir: (.+)$/;
const TOKENS = /^Tokens: /;
const OUTPUT_ADDED = /^Added \d+ lines? of output to the chat\.$/;
const INTERRUPT = /^\^C (?:again to exit|KeyboardInterrupt)$/;
const LITELLM = /^litellm\.(\w+)/;
const HARD_STOP = /^(?:Empty response received from LLM\.|Model .+ has hit a token limit!)/;
const STOP_REASON = {
  RateLimitError: 'rate_limit',
  RouterRateLimitError: 'rate_limit',
  BudgetExceededError: 'quota',
  InternalServerError: 'overloaded',
  ServiceUnavailableError: 'overloaded',
  BadGatewayError: 'overloaded',
  Timeout: 'overloaded',
};
const OUT_OF_CREDIT = /insufficient[_ ](?:quota|credits|funds)|exceeded your current quota|credit balance is too low|out of credits|usage limit|billing/i;

const THINK_ID = 'thinking-content-[0-9a-f]{32}';
const THINK_BLOCK = new RegExp(`<${THINK_ID}>[\\s\\S]*?(?:</(?:${THINK_ID}|think|thinking)>|$)`, 'g');
const THINK_LEAD = /^\s*<(think|thinking)>[\s\S]*?(?:<\/\1>|$)/;
const THINK_DANGLING = /^[\s\S]*?<\/(?:think|thinking)>/;

const abs = (root, p) => (isAbsolute(p) ? p : join(root, p));
const tail = (s) => (s.length > MAX_ERROR ? s.slice(-MAX_ERROR) : s);

/** Epoch ms of a "YYYY-MM-DD HH:MM:SS[.ffffff]" match; aider writes naive local time. */
function localMs(m) {
  const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms).getTime();
}

/** The reply as shown to the user: reasoning blocks removed. */
function stripReasoning(text) {
  let t = text.replace(THINK_BLOCK, '').replace(THINK_LEAD, '');
  if (!/<(?:think|thinking)>/.test(t)) t = t.replace(THINK_DANGLING, '');
  return t.trim();
}

function newSession(m, dir) {
  return {
    header: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`,
    startedAt: localMs(m),
    cwd: dir,
    root: dir, // edit paths are relative to the git working dir
    model: undefined,
    commit: undefined,
    events: [],
    prompts: [], // { event, raw }: prompt events with the text as typed, matched against the input history
    open: false, // a request was sent and its answer has not completed
    interrupted: false,
    lastReply: null,
    lastTest: null,
    failure: null,
  };
}

/** A user message: a request, or a command that is either a tool call, plumbing or dropped. */
function onPrompt(s, text) {
  const raw = text.trim();
  if (!raw || raw === '<blank>') return;
  s.lastTest = null;
  let m = RUN.exec(raw);
  if (m) {
    const target = m[2].trim();
    if (!target) return;
    const event = { kind: 'tool', tool: m[1] ?? 'run', action: 'command', target };
    s.events.push(event);
    s.lastTest = m[1] === 'test' ? event : null;
    return;
  }
  if ((m = GIT.exec(raw))) {
    s.events.push({ kind: 'tool', tool: 'git', action: 'command', target: `git ${m[1].trim()}` });
    return;
  }
  let body = raw;
  if ((m = MODE.exec(raw))) body = m[1].trim();
  else if ((m = OK.exec(raw))) body = `Ok, please go ahead and make those changes.${m[1]?.trim() ? ` ${m[1].trim()}` : ''}`;
  else if (/^[/!]/.test(raw) && !KEPT.test(raw)) return;
  const event = { kind: 'prompt', text: body };
  s.events.push(event);
  s.prompts.push({ event, raw });
  if (!isCommand(body)) {
    s.open = true;
    s.interrupted = false;
    s.lastReply = null;
  }
}

/** An assistant message (one per LLM call). */
function onReply(s, text) {
  const clean = stripReasoning(text);
  if (!clean) return;
  if (s.lastReply) s.lastReply.final = false; // only the turn's last reply can be its answer
  s.lastReply = { kind: 'reply', text: clean, partial: s.interrupted };
  s.interrupted = false;
  s.events.push(s.lastReply);
}

function stop(s, reason, message) {
  if (s.lastReply && !s.lastReply.final) s.lastReply.partial = true; // the error cut the reply short
  s.open = false;
  const last = s.events.at(-1);
  if (last?.kind === 'stop' && last.reason === reason) return; // retries repeat the same error
  s.events.push({ kind: 'stop', reason, message: message.slice(0, 500) });
}

/** One "> " message. Returns true when it announces an edit-format error whose body follows. */
function onTool(s, msg) {
  const text = msg.trim();
  const first = text.split('\n', 1)[0];
  let m;
  if (text === EDIT_FORMAT_ERROR) {
    s.failure = { kind: 'tool', tool: 'edit', action: 'edit', ok: false, error: text };
    s.events.push(s.failure);
    return true;
  }
  if ((m = APPLIED.exec(first))) {
    s.events.push({ kind: 'tool', tool: 'edit', action: 'edit', target: abs(s.root, m[1].trim()), ok: true });
  } else if ((m = RUNNING.exec(first))) {
    s.events.push({ kind: 'tool', tool: 'shell', action: 'command', target: m[1].trim() });
  } else if ((m = COMMIT.exec(first))) {
    s.commit = m[1];
    s.events.push({ kind: 'tool', tool: 'commit', action: 'other', target: `${m[1]} ${m[2]}` });
  } else if ((m = MODEL.exec(first))) {
    s.model = m[1];
  } else if ((m = WORKDIR.exec(first))) {
    s[m[1] === 'Cur' ? 'cwd' : 'root'] = m[2].trim();
  } else if (TOKENS.test(first)) {
    if (s.lastReply && !s.lastReply.partial) s.lastReply.final = true;
    s.open = false;
  } else if (OUTPUT_ADDED.test(first) && s.lastTest) {
    // /test adds its output to the chat only on a non-zero exit, but never logs the output itself.
    Object.assign(s.lastTest, { ok: false, error: 'exited non-zero (aider does not log command output)' });
    s.lastTest = null;
  } else if (INTERRUPT.test(first) && s.open) {
    s.open = false;
    s.interrupted = true; // the partial reply is logged right after this line
    s.events.push({ kind: 'interrupt' });
  } else if ((m = LITELLM.exec(first))) {
    stop(s, OUT_OF_CREDIT.test(text) ? 'quota' : (STOP_REASON[m[1]] ?? 'error'), first);
  } else if (HARD_STOP.test(first)) {
    stop(s, 'error', first);
  }
  return false;
}

/** The body of an edit-format error: which file failed and why. */
function onEditError(s, text) {
  const f = s.failure;
  if (!f) return;
  const body = text.replace(/^> ?/, '');
  const file = /failed to exactly match lines in (.+)/.exec(body)?.[1]?.trim();
  f.error = tail(body.trim()) || f.error;
  if (file) f.target = abs(s.root, file);
  s.failure = null;
}

/**
 * Split history text into sessions of normalized events.
 *
 * Plain lines are assistant text (ai_output is the only writer of them), "#### "
 * lines are the user, "> " lines are tool output. aider ends every line it writes
 * itself with two spaces; an assistant reply with markdown headings ("#### Why")
 * is told apart from a prompt by that. Files whose trailing spaces were trimmed
 * are read leniently.
 */
function parse(text, dir) {
  const strict = /^#### .*  \r?$/m.test(text);
  const sessions = [];
  let s = null;
  let user = null; // lines of the user message being read
  let reply = null; // lines of the assistant message being read
  let tool = null; // the tool message being read; a plain line right after it continues it
  let body = null; // an edit-format error body: has blank lines and would read as replies
  let prev = '';

  const endUser = () => {
    if (user) onPrompt(s, user.join('\n'));
    user = null;
  };
  const endReply = () => {
    if (reply) onReply(s, reply.join('\n'));
    reply = null;
  };
  const endTool = (mayStartBody) => {
    if (tool !== null && onTool(s, tool) && mayStartBody && strict) body = [];
    tool = null;
  };
  const endBody = () => {
    if (body) onEditError(s, body.join('\n'));
    body = null;
  };
  const endAll = () => {
    endUser();
    endReply();
    endTool(false);
    endBody();
  };

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const head = HEADER.exec(line);
    if (head) {
      endAll();
      s = newSession(head, dir);
      sessions.push(s);
    } else if (!s) {
      continue; // before the first header: the end of a session cut by the read window
    } else if (body) {
      // The body ends at the first blank line that follows a line aider closed with two spaces.
      if (line === '' && prev.endsWith('  ')) endBody();
      else body.push(line);
    } else if (line.startsWith('#### ') && (!strict || line.endsWith('  '))) {
      endReply();
      endTool(false);
      const content = line.slice(5).replace(/ {2}$/, '');
      if (user) user.push(content);
      else user = [content];
    } else if (line === '>' || line.startsWith('> ')) {
      endUser();
      endReply();
      endTool(true);
      if (!body) tool = line.slice(2).replace(/ {2}$/, '');
    } else if (line.trim() === '') {
      endUser();
      endTool(false);
      if (reply) reply.push('');
    } else if (tool !== null) {
      tool += `\n${line}`;
    } else {
      endUser();
      (reply ??= []).push(line);
    }
    prev = line;
  }
  endAll();
  return sessions;
}

/** The last `bytes` of a file as text, starting on a line boundary. */
function readTail(file, bytes) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const cut = len < size;
    const buf = Buffer.alloc(len + (cut ? 1 : 0));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    let text = buf.toString('utf8');
    if (cut) text = buf[0] === 10 ? text.slice(1) : text.slice(text.indexOf('\n') + 1);
    return { text, whole: !cut };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Sessions of a history file, reading a growing tail until `done(sessions)` holds. */
function readSessions(file, dir, done) {
  for (const bytes of WINDOWS) {
    const read = readTail(file, bytes);
    if (!read) return [];
    const sessions = parse(read.text, dir);
    if (read.whole || done(sessions)) return sessions;
  }
  return [];
}

/** .aider.input.history entries: when each input was typed, and what. */
function readInputs(path) {
  const entries = [];
  for (const raw of (readText(path) ?? '').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = INPUT_STAMP.exec(line);
    if (m) entries.push({ ts: localMs(m), lines: [] });
    else if (line.startsWith('+') && entries.length) entries.at(-1).lines.push(line.slice(1));
  }
  return entries.map((e) => ({ ts: e.ts, text: e.lines.join('\n').trim() }));
}

/**
 * Give prompts their typing time and each session its last activity: the last
 * input typed during it; for the file's newest session without an input
 * history, the file's mtime (aider only ever appends).
 */
function stamp(sessions, inputs, mtime) {
  sessions.forEach((s, i) => {
    const until = sessions[i + 1]?.startedAt ?? Infinity;
    const mine = inputs.filter((e) => e.ts >= s.startedAt && e.ts < until);
    let from = 0;
    for (const p of s.prompts) {
      const at = mine.findIndex((e, k) => k >= from && e.text === p.raw);
      if (at < 0) continue;
      p.event.ts = mine[at].ts;
      from = at + 1;
    }
    const fallback = i === sessions.length - 1 ? mtime : s.startedAt;
    s.lastActivity = Math.max(s.startedAt, mine.at(-1)?.ts ?? fallback);
  });
}

/** History files of the project as [file, dir]; dir is the git root the file belongs to (edit paths are relative to it). */
function historyFiles(project, ctx) {
  const files = new Map();
  for (const root of project.roots) {
    for (const n of [CHAT_FILE, ctx.env.AIDER_CHAT_HISTORY_FILE]) {
      if (!n) continue;
      const file = realpathOr(resolve(root, n));
      files.set(file, isAbsolute(n) ? dirname(file) : root);
    }
  }
  return [...files];
}

function inputPath(dir, ctx) {
  const custom = ctx.env.AIDER_INPUT_HISTORY_FILE;
  return custom ? resolve(dir, custom) : join(dir, INPUT_FILE);
}

const isSubstantive = (e) => (e.kind === 'prompt' && !isCommand(e.text)) || e.kind === 'reply';

/**
 * @param {import('../lib/project.js').Project} project
 * @param {import('./index.js').Context} ctx
 * @returns {Promise<import('./index.js').Candidate[]>}
 */
export async function findSessions(project, ctx) {
  const out = [];
  for (const [file, dir] of historyFiles(project, ctx)) {
    const st = statSafe(file);
    if (!st?.isFile() || st.size === 0) continue;
    const sessions = readSessions(file, dir, (all) => all.length > 0);
    stamp(sessions, readInputs(inputPath(dir, ctx)), st.mtimeMs);
    for (const s of sessions.slice(-MAX_PER_FILE)) {
      if (!s.events.some(isSubstantive)) continue; // started and quit, or only commands
      const score = project.match(s.cwd);
      if (!score) continue;
      out.push({
        agent: name,
        id: createHash('sha1').update(`${file}\n${s.header}`).digest('hex').slice(0, 12), // aider has no session ids; copass lists the first 8 chars
        lastActivity: s.lastActivity,
        score,
        cwd: s.cwd,
        preview: s.events.find((e) => e.kind === 'prompt' && !isCommand(e.text))?.text,
        ref: { file, dir, header: s.header },
      });
    }
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}

/**
 * @param {import('./index.js').Candidate} candidate
 * @param {import('./index.js').Context} ctx
 */
export async function loadSession(candidate, ctx) {
  const { file, dir, header } = candidate.ref;
  const sessions = readSessions(file, dir, (all) => all.some((s) => s.header === header));
  stamp(sessions, readInputs(inputPath(dir, ctx)), statSafe(file)?.mtimeMs ?? 0);
  const s = sessions.findLast((x) => x.header === header);
  return {
    meta: {
      agent: name,
      sessionId: candidate.id,
      cwd: s?.cwd ?? candidate.cwd,
      logFile: file,
      startedAt: s?.startedAt,
      lastActivity: s?.lastActivity ?? candidate.lastActivity,
      model: s?.model,
      commit: s?.commit,
      resumeCommand: 'aider --restore-chat-history',
    },
    events: s?.events ?? [],
  };
}

/**
 * Aider cannot take a first prompt and stay interactive (--message answers once
 * and exits), so start it with the hand-over loaded as read-only context; the
 * user's first message then continues from it.
 */
export function launch() {
  return ['aider', ['--read', '.copass/latest.md']];
}

/** Shown when copass starts Aider: it cannot send a first message, only load the hand-over. */
export const launchNote = 'The hand-over is loaded as read-only context; type a message (e.g. "continue") to start.';
