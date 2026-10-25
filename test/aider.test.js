import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import * as aider from '../agents/aider.js';
import { assemble } from '../lib/assemble.js';
import { resolveProject } from '../lib/project.js';
import { fixtureContext, tempDir, writeTree } from './helpers.js';

// Records exactly as aider/io.py writes them (append_chat_history).
const header = (dt) => `\n# aider chat started at ${dt}\n\n`;
const user = (text) => `\n${text.split('\n').map((l) => `#### ${l}`).join('  \n')}  \n`;
const tool = (text) => `${text.split('\n').map((l) => (l ? `> ${l}  ` : '>  ')).join('\n')}\n`;
const toolMulti = (text) => `> ${text}  \n`; // tool_output with embedded newlines: only the first line is prefixed
const ai = (text) => `\n${text.trim()}\n\n`;
const input = (dt, text) => `\n# ${dt}\n${text.split('\n').map((l) => `+${l}`).join('\n')}\n`;

const EDIT_REPLY = ai(
  [
    'I will make the tokenizer handle unicode identifiers.',
    '',
    '#### Why this works',
    '',
    'src/parser.js',
    '```js',
    '<<<<<<< SEARCH',
    'const ID = /[a-z]+/;',
    '=======',
    'const ID = /\\p{L}+/u;',
    '>>>>>>> REPLACE',
    '```',
  ].join('\n'),
);

const FAILED_EDIT_BODY =
  '# 1 SEARCH/REPLACE block failed to match!\n\n## SearchReplaceNoExactMatch: This SEARCH block failed to exactly match lines in src/lexer.js\n<<<<<<< SEARCH\nconst X = 1;\n=======\nconst X = 2;\n>>>>>>> REPLACE\n\nThe SEARCH section must exactly match an existing block of lines including all white space, comments, indentation, docstrings, etc';

function banner({ cwd, root } = {}) {
  return [
    tool('Aider v0.86.1'),
    tool('Main model: anthropic/claude-sonnet-4-5 with diff edit format, prompt cache, infinite output'),
    tool('Weak model: anthropic/claude-3-5-haiku-20241022'),
    tool('Git repo: .git with 42 files'),
    tool('Repo-map: using 4096 tokens, auto refresh'),
    cwd ? tool('Note: in-chat filenames are always relative to the git working dir, not the current working dir.') + tool(`Cur working dir: ${cwd}`) + tool(`Git working dir: ${root}`) : '',
    tool('Added src/parser.js to the chat.'),
  ].join('');
}

function history(root) {
  const web = join(root, 'packages', 'web');
  return [
    // A stub: started, one command, quit.
    header('2026-10-24 18:00:00'),
    banner(),
    user('/exit'),

    // The real session.
    header('2026-10-25 09:00:00'),
    banner(),
    user('/add src/parser.js'),
    tool('Added src/parser.js to the chat.'),
    user("Fix the parser.\nDon't change the public API."),
    EDIT_REPLY,
    // With prompt caching the usage report spans two lines and only the first is prefixed.
    '> Tokens: 3.2k sent, 1.1k cache write, 2.0k cache hit, 410 received.\nCost: $0.02 message, $0.02 session.  \n',
    tool('Applied edit to src/parser.js'),
    tool('Commit a1b2c3d fix: accept unicode identifiers'),
    tool('You can use /undo to undo and discard each aider commit.'),
    user('/test npm test'),
    tool('Added 12 lines of output to the chat.'),
    user('/ask why does the lexer still fail?'),
    ai('<thinking-content-7bbeb8e1441453ad999a0bbba8a46d4b>\n\nthe regex needs the u flag\n\n</think>\n\nBecause lexer.js still uses an ASCII class.'),
    tool('Tokens: 3.9k sent, 120 received. Cost: $0.02 message, $0.04 session.'),
    user('!git status'),
    user('Now fix the lexer too'),
    ai('Updating src/lexer.js.\n\nsrc/lexer.js\n```js\n<<<<<<< SEARCH\nconst X = 1;\n=======\nconst X = 2;\n>>>>>>> REPLACE\n```'),
    tool('Tokens: 4.0k sent, 90 received.'),
    tool('The LLM did not conform to the edit format.'),
    tool('https://aider.chat/docs/troubleshooting/edit-errors.html'),
    toolMulti(FAILED_EDIT_BODY),
    ai('Sorry, retrying with the exact lines.'),
    tool('Tokens: 5.0k sent, 40 received.'),
    tool('Running npm test'),
    user('Also handle emoji identifiers'),
    // ^C mid-turn: the interrupt line precedes the partial reply.
    tool('\n\n^C again to exit'),
    ai('Let me look at how emoji are tok'),
    user('go on'),
    tool('litellm.RateLimitError: RateLimitError: AnthropicException - {"error":{"message":"rate limit"}}'),
    tool('The API provider has rate limited you. Try again later or check your quotas.'),
    tool('Retrying in 0.2 seconds...'),
    tool('litellm.RateLimitError: RateLimitError: AnthropicException - {"error":{"message":"rate limit"}}'),
    tool('The API provider has rate limited you. Try again later or check your quotas.'),
    tool('Retrying in 0.5 seconds...'),
    tool('litellm.RateLimitError: RateLimitError: OpenAIException - You exceeded your current quota, please check your plan and billing details.'),
    tool('The API provider has rate limited you. Try again later or check your quotas.'),

    // A later session started in a subdirectory, still unanswered.
    header('2026-10-25 11:30:00'),
    banner({ cwd: web, root }),
    user('Wire the parser into the web package'),
  ].join('');
}

function inputHistory() {
  return [
    input('2026-10-24 18:00:05.100000', '/exit'),
    input('2026-10-25 09:00:10.000000', '/add src/parser.js'),
    input('2026-10-25 09:01:30.250000', "Fix the parser.\nDon't change the public API."),
    input('2026-10-25 09:05:00.000000', '/test npm test'),
    input('2026-10-25 09:06:00.000000', '/ask why does the lexer still fail?'),
    input('2026-10-25 09:08:00.000000', '!git status'),
    input('2026-10-25 09:09:00.500000', 'Now fix the lexer too'),
    input('2026-10-25 09:12:00.000000', 'y'),
    input('2026-10-25 09:20:00.000000', 'Also handle emoji identifiers'),
    input('2026-10-25 09:30:00.000000', 'go on'),
    input('2026-10-25 11:30:15.000000', 'Wire the parser into the web package'),
  ].join('');
}

function fixture(extra = {}) {
  const root = join(tempDir('copass-proj-'), 'my app');
  const home = tempDir('copass-home-');
  writeTree(root, {
    'README.md': 'x',
    '.aider.chat.history.md': history(root),
    '.aider.input.history': inputHistory(),
    ...extra,
  });
  return { root, home };
}

const at = (h, m, s = 0, ms = 0) => new Date(2026, 9, 25, h, m, s, ms).getTime();

test('finds every substantive session of the repo, newest first, and skips the stub', async () => {
  const { root, home } = fixture();
  const found = await aider.findSessions(resolveProject(root), fixtureContext(home));

  assert.deepEqual(found.map((c) => c.ref.header), ['2026-10-25 11:30:00', '2026-10-25 09:00:00']);
  assert.equal(new Set(found.map((c) => c.id.slice(0, 8))).size, 2, 'ids differ within the 8 characters copass lists');
  const [sub, main] = found;
  assert.equal(sub.cwd, join(root, 'packages', 'web'));
  assert.equal(sub.score, 1, 'a session started in a subdirectory');
  assert.equal(sub.preview, 'Wire the parser into the web package');
  assert.equal(sub.lastActivity, at(11, 30, 15), 'last typed input of that session');
  assert.equal(main.cwd, root);
  assert.equal(main.score, 3);
  assert.equal(main.preview, "Fix the parser.\nDon't change the public API.");
  assert.equal(main.lastActivity, at(9, 30), 'the last input typed before the next session started, not the mtime');
  assert.ok(!found.some((c) => c.current || c.background));
});

test('a repo without aider history yields nothing', async () => {
  const root = join(tempDir('copass-proj-'), 'plain');
  writeTree(root, { 'README.md': 'x' });
  assert.deepEqual(await aider.findSessions(resolveProject(root), fixtureContext(tempDir('copass-home-'))), []);
});

test('loads prompts, replies, edits, failures, interrupt and stop from one session', async () => {
  const { root, home } = fixture();
  const ctx = fixtureContext(home);
  const found = await aider.findSessions(resolveProject(root), ctx);
  const { meta, events } = await aider.loadSession(found.find((c) => c.ref.header === '2026-10-25 09:00:00'), ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), [
    "Fix the parser.\nDon't change the public API.",
    'why does the lexer still fail?',
    'Now fix the lexer too',
    'Also handle emoji identifiers',
    'go on',
  ]);
  assert.equal(s.prompts[0].ts, at(9, 1, 30, 250), 'typing time comes from .aider.input.history');
  assert.equal(s.prompts[2].ts, at(9, 9, 0, 500));
  assert.equal(s.latest.prompt.text, 'go on');
  assert.equal(s.latest.started, false, 'the last prompt was never answered');

  const replies = events.filter((e) => e.kind === 'reply');
  assert.equal(replies.length, 5, 'tool output (cost line, edit error body) never turns into replies');
  assert.ok(replies[0].text.includes('#### Why this works'), 'a markdown heading in a reply is not a prompt');
  assert.ok(replies[0].text.includes('<<<<<<< SEARCH'));
  assert.equal(replies[0].final, true);
  assert.equal(replies[1].text, 'Because lexer.js still uses an ASCII class.', 'reasoning is not part of the reply');
  assert.ok(!replies.some((r) => r.text.includes('SearchReplaceNoExactMatch')), 'the edit error body is not a reply');
  assert.equal(replies.find((r) => r.text.startsWith('Sorry')).final, true);
  const cut = replies.find((r) => r.text.startsWith('Let me look'));
  assert.equal(cut.partial, true);
  assert.equal(cut.final, undefined);
  assert.ok(events.some((e) => e.kind === 'interrupt'));

  assert.deepEqual(s.files.map((f) => f.path), [join(root, 'src', 'parser.js')]);
  assert.deepEqual(
    s.commands.map((c) => [c.tool, c.target, c.ok]),
    [['test', 'npm test', false], ['run', 'git status', undefined], ['shell', 'npm test', undefined]],
  );
  const failure = events.find((e) => e.tool === 'edit' && e.ok === false);
  assert.equal(failure.target, join(root, 'src', 'lexer.js'));
  assert.match(failure.error, /SEARCH section must exactly match/);
  assert.ok(failure.error.length <= 1500);
  assert.ok(events.some((e) => e.tool === 'commit' && e.target === 'a1b2c3d fix: accept unicode identifiers'));

  assert.equal(s.stop.reason, 'quota', 'the last error mentions the exhausted quota');
  assert.equal(events.filter((e) => e.kind === 'stop').length, 2, 'retries of the same error are not repeated');
  assert.equal(s.plan, null);
  assert.equal(s.compaction, null);

  assert.equal(meta.model, 'anthropic/claude-sonnet-4-5');
  assert.equal(meta.commit, 'a1b2c3d');
  assert.equal(meta.cwd, root);
  assert.equal(meta.logFile, join(root, '.aider.chat.history.md'));
  assert.equal(meta.startedAt, at(9, 0));
  assert.equal(meta.resumeCommand, 'aider --restore-chat-history');
});

test('commands: plumbing is dropped, state changes stay, /ok becomes a request', async () => {
  const root = join(tempDir('copass-proj-'), 'cmds');
  const text = [
    header('2026-10-25 09:00:00'),
    banner(),
    user('/add a.js'),
    tool('Added a.js to the chat.'),
    user('/undo'),
    tool('Removed: abc1234 fix'),
    user('/model sonnet'),
    user('/ok'),
    ai('Okay, making the changes.'),
  ].join('');
  writeTree(root, { '.aider.chat.history.md': text });
  const ctx = fixtureContext(tempDir('copass-home-'));
  const [candidate] = await aider.findSessions(resolveProject(root), ctx);
  const { events } = await aider.loadSession(candidate, ctx);
  assert.deepEqual(
    events.filter((e) => e.kind === 'prompt').map((e) => e.text),
    ['/undo', '/model sonnet', 'Ok, please go ahead and make those changes.'],
  );
});

test('reads files with CRLF line endings and trimmed trailing spaces', async () => {
  const root = join(tempDir('copass-proj-'), 'trimmed');
  const text = [header('2026-10-25 09:00:00'), banner(), user('Add a --verbose flag'), ai('Done: added the flag.\n\nRun with --verbose.'), tool('Tokens: 1k sent, 10 received.')].join('');
  writeTree(root, { '.aider.chat.history.md': text.replace(/ +$/gm, '').replaceAll('\n', '\r\n') });
  const ctx = fixtureContext(tempDir('copass-home-'));
  const [candidate] = await aider.findSessions(resolveProject(root), ctx);
  const { events } = await aider.loadSession(candidate, ctx);
  assert.equal(events.find((e) => e.kind === 'prompt').text, 'Add a --verbose flag');
  assert.equal(events.find((e) => e.kind === 'reply').text.startsWith('Done: added the flag.'), true);
  assert.equal(candidate.lastActivity > 0, true, 'falls back to the file mtime without an input history');
});

test('strips reasoning blocks and drops replies that are only reasoning', async () => {
  const root = join(tempDir('copass-proj-'), 'think');
  const tag = 'thinking-content-7bbeb8e1441453ad999a0bbba8a46d4b';
  const text = [
    header('2026-10-25 09:00:00'),
    user('one'),
    ai('<think>\nplanning\n</think>\nAnswer A'),
    user('two'),
    ai(`<${tag}>\n\nhmm\n\n</${tag}>\n\nAnswer B`),
    user('three'),
    ai(`<${tag}>\n\nstill thinking when the user pressed ctrl-c`),
    user('four'),
    ai('Use the <think> tag carefully.'),
  ].join('');
  writeTree(root, { '.aider.chat.history.md': text });
  const ctx = fixtureContext(tempDir('copass-home-'));
  const [candidate] = await aider.findSessions(resolveProject(root), ctx);
  const { events } = await aider.loadSession(candidate, ctx);
  assert.deepEqual(events.filter((e) => e.kind === 'reply').map((e) => e.text), ['Answer A', 'Answer B', 'Use the <think> tag carefully.']);
});

test('keeps a request that was never answered and flags provider overload', async () => {
  const root = join(tempDir('copass-proj-'), 'quota');
  const text = [
    header('2026-10-25 09:00:00'),
    banner(),
    user('Refactor the router'),
    tool('litellm.InternalServerError: AnthropicException - Overloaded'),
    tool("The API provider's servers are down or overloaded."),
  ].join('');
  writeTree(root, { '.aider.chat.history.md': text });
  const ctx = fixtureContext(tempDir('copass-home-'));
  const [candidate] = await aider.findSessions(resolveProject(root), ctx);
  const { meta, events } = await aider.loadSession(candidate, ctx);
  const s = assemble(meta, events);
  assert.equal(s.latest.prompt.text, 'Refactor the router');
  assert.equal(s.stop.reason, 'overloaded');
});

test('reaches a session that is older than the first read window', async () => {
  const root = join(tempDir('copass-proj-'), 'big');
  const filler = ai('word '.repeat(700 * 1024)); // ~3.5 MB reply in the middle session
  const text = [
    header('2026-10-20 08:00:00'),
    user('Old request'),
    ai('Old answer'),
    header('2026-10-21 08:00:00'),
    user('Huge request'),
    filler,
    header('2026-10-22 08:00:00'),
    user('Newest request'),
    ai('Newest answer'),
  ].join('');
  writeTree(root, { '.aider.chat.history.md': text });
  const ctx = fixtureContext(tempDir('copass-home-'));
  const found = await aider.findSessions(resolveProject(root), ctx);
  assert.deepEqual(found.map((c) => c.preview), ['Newest request']);
  assert.ok(text.length > 2 * 1024 * 1024);

  // The full list needs the older sessions: ask for one directly through a candidate.
  const old = { ...found[0], ref: { ...found[0].ref, header: '2026-10-20 08:00:00' } };
  const { events } = await aider.loadSession(old, ctx);
  assert.deepEqual(events.map((e) => e.text), ['Old request', 'Old answer']);
});

test('launches aider with the hand-over as read-only context', () => {
  assert.deepEqual(aider.launch('ignored'), ['aider', ['--read', '.copass/latest.md']]);
});
