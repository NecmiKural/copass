import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import * as opencode from '../agents/opencode.js';
import { assemble } from '../lib/assemble.js';
import { resolveProject } from '../lib/project.js';
import { fixtureContext, tempDir, writeTree } from './helpers.js';

// The fixture databases are written with node:sqlite directly; keep its ExperimentalWarning out of the output.
const emitWarning = process.emitWarning;
process.emitWarning = () => {};
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emitWarning;

const t = (m) => Date.UTC(2026, 9, 25, 9, m);

// Table definitions as upstream's migrations create them (foreign keys left out).
// V2: packages/core/src/database/migration/20260804233008_*.ts, 20260812181746_session_inbox.ts.
// V1: packages/core/src/database/migration/20260127222353_*.ts.
const SCHEMA = `
CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, fork_session_id text,
  fork_boundary text, slug text NOT NULL, directory text NOT NULL, path text, title text, version text NOT NULL, share_url text,
  metadata text, cost real DEFAULT 0 NOT NULL, agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL,
  time_compacting integer, time_archived integer, time_suspended integer);
CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq);
CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id);
CREATE TABLE session_inbox (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, payload text NOT NULL,
  delivery text NOT NULL, enqueued_seq integer NOT NULL, time_created integer NOT NULL);
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL,
  title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer, summary_deletions integer, summary_files integer,
  summary_diffs text, revert text, permission text, time_created integer NOT NULL, time_updated integer NOT NULL,
  time_compacting integer, time_archived integer);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL,
  time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE todo (session_id text NOT NULL, content text NOT NULL, status text NOT NULL, priority text NOT NULL, position integer NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, PRIMARY KEY (session_id, position));
`;

/** A fixture database with every table, and small writers for both eras. */
function createStore(home) {
  const file = join(home, '.local', 'share', 'opencode', 'opencode.db');
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const seqs = new Map();
  let n = 0;
  return {
    file,
    db,
    session2(id, directory, m, extra = {}) {
      db.prepare(
        'INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, 'global', extra.parent ?? null, id, directory, extra.title ?? null, '2.1.4', t(m), t(m), extra.archived ?? null);
    },
    message2(session, type, m, data) {
      const seq = seqs.get(session) ?? 0;
      seqs.set(session, seq + 1);
      const row = JSON.stringify({ ...data, time: { created: t(m), ...data.time } });
      db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run(`msg_${String(++n).padStart(6, '0')}`, session, type, seq, t(m), t(m), row);
    },
    inbox(session, text, m, delivery = 'queue') {
      db.prepare('INSERT INTO session_inbox VALUES (?, ?, ?, ?, ?, ?, ?)').run(`msg_${String(++n).padStart(6, '0')}`, session, 'user', JSON.stringify({ text }), delivery, 0, t(m));
    },
    session1(id, directory, m, title = 'New session - 2026-10-25T09:00:00.000Z') {
      db.prepare('INSERT INTO session VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)').run(id, 'global', id, directory, title, '1.19.4', t(m), t(m));
    },
    message1(session, m, data, parts = []) {
      const id = `msg_${String(++n).padStart(6, '0')}`;
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(id, session, t(m), t(m), JSON.stringify({ time: { created: t(m) }, ...data }));
      for (const p of parts) {
        db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(`prt_${String(++n).padStart(6, '0')}`, id, session, t(m), t(m), JSON.stringify(p));
      }
      return id;
    },
    todo(session, position, content, status) {
      db.prepare('INSERT INTO todo VALUES (?, ?, ?, ?, ?, ?, ?)').run(session, content, status, 'medium', position, t(30), t(30));
    },
    close: () => db.close(),
  };
}

const model = { providerID: 'anthropic', id: 'claude-sonnet-4-5', variant: 'default' };
const toolPart = (id, name, input, state) => ({
  type: 'tool',
  id,
  name,
  state: { status: 'completed', input, content: [{ type: 'text', text: 'ok' }], ...state },
  time: { created: t(3), ran: t(3), completed: t(3) },
});

function projectFixture() {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'my app');
  writeTree(projectDir, { 'README.md': 'x' });
  return { home, projectDir, project: resolveProject(projectDir) };
}

/** The upgraded-install shape: V2 sessions, plus the V1 rows 2.x leaves in place. */
function v2Store({ home, projectDir }) {
  const s = createStore(home);
  s.session2('ses_main', projectDir, 1, { title: 'Parser fixes' });
  s.session2('ses_child', projectDir, 2, { parent: 'ses_main' });
  s.session2('ses_archived', projectDir, 3, { archived: t(4) });
  s.session2('ses_stub', projectDir, 4);
  s.session2('ses_other', `${projectDir}-backup`, 5);
  for (const id of ['ses_child', 'ses_archived', 'ses_other']) s.message2(id, 'user', 6, { text: 'elsewhere' });

  s.message2('ses_main', 'agent-switched', 1, { agent: 'build' });
  s.message2('ses_main', 'model-switched', 1, { model });
  s.message2('ses_main', 'user', 2, { text: "<system-reminder>be terse</system-reminder>\nFix the parser. Don't change the API." });
  s.message2('ses_main', 'synthetic', 2, { text: 'Background job finished' });
  s.message2('ses_main', 'assistant', 3, {
    agent: 'build',
    model,
    finish: 'tool-calls',
    content: [
      { type: 'reasoning', text: 'secret chain of thought' },
      { type: 'text', text: 'Looking at the parser.' },
      { type: 'text', text: 'Patching it now.' },
      toolPart('c1', 'edit', { path: 'parser.js', oldString: 'a', newString: 'b' }),
      toolPart('c2', 'shell', { command: 'npm test' }, { content: [{ type: 'text', text: '1 test failed: parser.spec.js' }, { type: 'text', text: 'Exited with code 1' }], metadata: { truncated: false, exit: 1 } }),
      toolPart('c3', 'todowrite', { todos: [{ content: 'fix tokenizer', status: 'completed' }, { content: 'fix tests', status: 'in_progress' }, { content: 'drop idea', status: 'cancelled' }] }),
      toolPart('c4', 'read', { path: join(projectDir, 'missing.txt') }, { status: 'error', error: { type: 'tool.execution', message: 'File not found' }, content: undefined }),
    ],
    time: { completed: t(4) },
  });
  s.message2('ses_main', 'assistant', 5, { agent: 'build', model, finish: 'stop', content: [{ type: 'text', text: 'Tests pass now.' }], time: { completed: t(5) } });
  s.message2('ses_main', 'compaction', 6, { status: 'running', reason: 'auto', summary: '' });
  s.message2('ses_main', 'compaction', 6, { status: 'completed', reason: 'auto', summary: '## Goal\nfix the parser', model });
  s.message2('ses_main', 'user', 8, { text: 'Now also handle unicode identifiers' });
  const error = { type: 'provider.rate-limit', message: 'Rate limit exceeded', status: 429, retryAfterMs: 3_600_000 };
  s.message2('ses_main', 'assistant', 9, { agent: 'build', model, finish: 'error', content: [], error, time: { completed: t(9) } });
  s.message2('ses_main', 'idle', 9, { outcome: 'failed', error });
  s.inbox('ses_main', 'and update the README', 10);
  // The migrated copy of a session 2.x already imported, and a V1 session it has not.
  s.session1('ses_main', projectDir, 1, 'Parser fixes');
  s.message1('ses_main', 1, { role: 'user', agent: 'build' }, [{ type: 'text', text: 'stale V1 copy' }]);
  s.session1('ses_v1only', projectDir, 20);
  s.message1('ses_v1only', 20, { role: 'user', agent: 'build' }, [{ type: 'text', text: 'Add a changelog' }]);
  s.close();
  return s.file;
}

test('finds V2 sessions, skips child, archived, stub and foreign ones, and flags the running one', async () => {
  const fx = projectFixture();
  v2Store(fx);
  const found = await opencode.findSessions(fx.project, fixtureContext(fx.home));
  assert.deepEqual(found.map((c) => c.id), ['ses_v1only', 'ses_main'], 'the migrated V1 copy of ses_main is not listed twice');
  const main = found.find((c) => c.id === 'ses_main');
  assert.equal(main.title, 'Parser fixes');
  assert.equal(main.score, 3);
  assert.equal(main.cwd, fx.projectDir);
  assert.equal(main.preview, "Fix the parser. Don't change the API.", 'preview is the typed text, not the harness wrapper');
  assert.equal(main.lastActivity, t(9), 'activity = last user/assistant message, not the idle marker or the inbox');
  assert.equal(main.ref.kind, 'v2');

  const old = found.find((c) => c.id === 'ses_v1only');
  assert.equal(old.ref.kind, 'v1');
  assert.equal(old.title, undefined, 'the placeholder title is dropped');
  assert.equal(old.preview, 'Add a changelog');

  const self = await opencode.findSessions(fx.project, fixtureContext(fx.home, { OPENCODE_SESSION_ID: 'ses_main' }));
  assert.deepEqual(self.map((c) => c.current), [false, true]);
});

test('loads V2 prompts, replies, tools, plan, compaction, stop and queued prompts', async () => {
  const fx = projectFixture();
  v2Store(fx);
  const ctx = fixtureContext(fx.home);
  const candidate = (await opencode.findSessions(fx.project, ctx)).find((c) => c.id === 'ses_main');
  const { meta, events } = await opencode.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), ["Fix the parser. Don't change the API.", 'Now also handle unicode identifiers']);
  assert.equal(s.latest.started, false, 'the last prompt hit the rate limit before any work');
  assert.deepEqual(s.latest.queued.map((q) => q.text), ['and update the README']);
  assert.equal(s.stop.reason, 'rate_limit');
  assert.equal(s.stop.message, 'Rate limit exceeded');
  assert.equal(s.stop.resetsAt, t(9) + 3_600_000);
  assert.equal(events.filter((e) => e.kind === 'stop').length, 1, 'the idle marker repeats the assistant error');
  assert.equal(s.compaction.summary, '## Goal\nfix the parser');
  assert.equal(s.compaction.trigger, 'auto');
  assert.equal(events.filter((e) => e.kind === 'compaction').length, 1, 'a running compaction is no boundary yet');
  assert.deepEqual(s.files.map((f) => f.path), [join(fx.projectDir, 'parser.js')], 'relative paths resolve against the session cwd');
  assert.equal(s.failures[0].target, 'npm test');
  assert.equal(s.failures[0].exit, 1);
  assert.equal(s.failures[0].error, '1 test failed: parser.spec.js\nExited with code 1');
  assert.deepEqual(s.plan.items, [{ text: 'fix tokenizer', status: 'done' }, { text: 'fix tests', status: 'active' }]);
  assert.equal(events.find((e) => e.tool === 'read').error, 'File not found');

  const replies = events.filter((e) => e.kind === 'reply');
  assert.deepEqual(replies.map((r) => r.text), ['Looking at the parser.\nPatching it now.', 'Tests pass now.'], 'fragments merge, reasoning never appears');
  assert.deepEqual(replies.map((r) => r.final), [false, true]);
  assert.equal(meta.model, 'anthropic/claude-sonnet-4-5');
  assert.equal(meta.resumeCommand, 'opencode --session ses_main');
  assert.equal(meta.logFile, candidate.ref.file);
  assert.ok(!JSON.stringify(events).includes('secret chain of thought'));
});

test('V2 edge records: native compaction, patch files, user shell, interrupt, failed compaction', async () => {
  const fx = projectFixture();
  const s = createStore(fx.home);
  s.session2('ses_edge', fx.projectDir, 1);
  s.message2('ses_edge', 'user', 1, { text: 'Refactor the loader', files: [{ mime: 'image/png', data: 'AAAA', source: { type: 'inline' } }] });
  s.message2('ses_edge', 'assistant', 2, {
    agent: 'build',
    model,
    finish: 'tool-calls',
    content: [
      toolPart('p1', 'patch', { patchText: '*** Begin Patch\n*** Add File: a.txt\n+x\n*** Update File: src/b.js\n*** Move to: src/c.js\n@@\n-1\n+2\n*** Delete File: old.txt\n*** End Patch' }),
      toolPart('p2', 'shell', { command: 'sleep 99' }, { metadata: { exit: 124, timeout: true, truncated: false }, content: [{ type: 'text', text: 'Timed out before completion' }] }),
      toolPart('p3', 'subagent', { description: 'explore the repo', prompt: 'look' }),
      toolPart('p4', 'webfetch', { url: 'https://example.com' }),
      toolPart('p5', 'grep', { pattern: 'TODO' }),
    ],
  });
  s.message2('ses_edge', 'shell', 3, { shellID: 'sh_1', command: 'git status', status: 'exited', exit: 128, output: { output: 'fatal: not a git repository', cursor: 0, size: 0, truncated: false } });
  s.message2('ses_edge', 'compaction', 4, { status: 'completed', reason: 'manual', summary: '', native: { messages: [{ role: 'assistant', content: 'opaque' }] } });
  s.message2('ses_edge', 'compaction', 5, { status: 'failed', reason: 'auto', error: { type: 'provider.invalid-request', message: 'prompt is too long' } });
  const wrapped = '# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>\n<environment_context>cwd</environment_context>\n## My request for Codex:\ncontinue please';
  s.message2('ses_edge', 'user', 6, { text: wrapped });
  s.message2('ses_edge', 'assistant', 7, { agent: 'build', model, finish: 'length', content: [{ type: 'text', text: 'Half an ans' }] });
  s.message2('ses_edge', 'idle', 7, { outcome: 'interrupted' });
  s.close();

  const ctx = fixtureContext(fx.home);
  const [candidate] = await opencode.findSessions(fx.project, ctx);
  const { events } = await opencode.loadSession(candidate, ctx);

  assert.deepEqual(events.filter((e) => e.kind === 'prompt').map((e) => e.text), ['Refactor the loader\n[image attached]', 'continue please'], 'instruction dumps, environment blocks and IDE envelopes are not typed text');
  const edits = events.filter((e) => e.action === 'edit').map((e) => e.target);
  assert.deepEqual(edits, [join(fx.projectDir, 'a.txt'), join(fx.projectDir, 'src/b.js'), join(fx.projectDir, 'src/c.js'), join(fx.projectDir, 'old.txt')]);
  assert.deepEqual(events.find((e) => e.target === 'sleep 99'), { kind: 'tool', tool: 'shell', action: 'command', target: 'sleep 99', ts: t(3), ok: false, exit: 124, error: 'Timed out before completion' });
  assert.equal(events.find((e) => e.tool === 'subagent').action, 'other');
  assert.equal(events.find((e) => e.tool === 'subagent').target, 'explore the repo');
  assert.equal(events.find((e) => e.tool === 'webfetch').target, 'https://example.com');
  assert.deepEqual(events.find((e) => e.tool === 'grep').action, 'search');
  assert.deepEqual(events.find((e) => e.target === 'git status'), { kind: 'tool', tool: 'shell', action: 'command', target: 'git status', ts: t(3), ok: false, exit: 128, error: 'fatal: not a git repository' });
  const compactions = events.filter((e) => e.kind === 'compaction');
  assert.deepEqual(compactions.map((c) => [c.trigger, c.encrypted, c.summary]), [['manual', true, undefined]]);
  assert.equal(events.find((e) => e.kind === 'stop' && e.message === 'prompt is too long').reason, 'error');
  const last = events.findLast((e) => e.kind === 'reply');
  assert.deepEqual([last.text, last.final, last.partial], ['Half an ans', false, true]);
  assert.equal(events.at(-1).kind, 'interrupt');
});

test('loads a V1 store: typed prompts, compaction pair, bash exit codes, todo table, errors', async () => {
  const fx = projectFixture();
  const s = createStore(fx.home);
  const { projectDir } = fx;
  s.session1('ses_one', projectDir, 1, 'Fix the parser');
  s.session1('ses_sub', projectDir, 2);
  s.db.prepare("UPDATE session SET parent_id = 'ses_one' WHERE id = 'ses_sub'").run();
  s.message1('ses_sub', 2, { role: 'user', agent: 'general' }, [{ type: 'text', text: 'subagent prompt' }]);
  s.session1('ses_stub', projectDir, 3);

  const user = { role: 'user', agent: 'build', model: { providerID: 'openai', modelID: 'gpt-5' } };
  const asst = (parentID, extra = {}) => ({ role: 'assistant', parentID, providerID: 'openai', modelID: 'gpt-5', mode: 'build', agent: 'build', path: { cwd: projectDir, root: projectDir }, time: { created: t(3), completed: t(4) }, ...extra });
  const tool = (name, input, state) => ({ type: 'tool', callID: `call_${name}`, tool: name, state: { status: 'completed', input, title: name, metadata: {}, time: { start: t(3), end: t(3) }, output: 'ok', ...state } });

  const u1 = s.message1('ses_one', 1, user, [
    { type: 'text', text: 'Fix the parser.' },
    { type: 'text', text: 'Called the Read tool with the following input: {}', synthetic: true },
  ]);
  s.message1('ses_one', 3, asst(u1, { finish: 'tool-calls' }), [
    { type: 'step-start' },
    { type: 'reasoning', text: 'secret chain of thought', time: { start: t(3) } },
    { type: 'text', text: 'Looking at the parser.' },
    tool('edit', { filePath: `${projectDir}/parser.js`, oldString: 'a', newString: 'b' }),
    tool('bash', { command: 'npm test', description: 'run tests' }, { output: '2 failed', metadata: { output: '2 failed', exit: 1, truncated: false } }),
    tool('bash', { command: 'ls' }, { output: 'parser.js', metadata: { output: 'parser.js', exit: 0, truncated: false } }),
    tool('apply_patch', { patchText: '*** Begin Patch\n*** Update File: lib/x.js\n@@\n-1\n+2\n*** End Patch' }),
    tool('todowrite', { todos: [{ content: 'old plan', status: 'pending', priority: 'high' }] }),
    tool('write', { filePath: `${projectDir}/new.js`, content: 'x' }, { status: 'error', error: 'The user rejected permission to use this specific tool call.', output: undefined }),
    { type: 'step-finish', reason: 'tool-calls', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
  ]);
  const u2 = s.message1('ses_one', 5, user, [{ type: 'compaction', auto: true }]);
  s.message1('ses_one', 6, asst(u2, { summary: true, mode: 'compaction', agent: 'compaction', finish: 'stop', time: { created: t(5), completed: t(6) } }), [{ type: 'text', text: '## Goal\nfix the parser' }]);
  s.message1('ses_one', 6, user, [{ type: 'text', text: 'Continue if you have next steps, or stop and ask for clarification.', synthetic: true, metadata: { compaction_continue: true } }]);
  const u3 = s.message1('ses_one', 8, user, [{ type: 'text', text: 'Now handle unicode identifiers' }]);
  s.message1('ses_one', 9, asst(u3, { time: { created: t(9), completed: t(9) }, error: { name: 'APIError', data: { message: 'You exceeded your current quota', statusCode: 429, isRetryable: true, responseHeaders: { 'retry-after': '120' } } } }));
  const u4 = s.message1('ses_one', 11, user, [{ type: 'text', text: 'try again' }]);
  s.message1('ses_one', 12, asst(u4, { time: { created: t(12) }, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }), [{ type: 'text', text: 'Working on' }]);
  s.message1('ses_one', 14, user, [{ type: 'text', text: 'final prompt, never answered' }]);
  s.todo('ses_one', 0, 'fix tokenizer', 'completed');
  s.todo('ses_one', 1, 'fix tests', 'in_progress');
  // A 1.x database has no session_v2 or session_inbox, but session_message exists and may hold projected rows.
  s.db.exec('DROP TABLE session_v2; DROP TABLE session_inbox;');
  s.message2('ses_one', 'user', 1, { text: 'projected copy, never read for a V1 session' });
  s.close();

  const ctx = fixtureContext(fx.home);
  const found = await opencode.findSessions(fx.project, ctx);
  assert.deepEqual(found.map((c) => c.id), ['ses_one'], 'subagent and never-used sessions are skipped');
  assert.equal(found[0].lastActivity, t(14));
  assert.equal(found[0].preview, 'Fix the parser.');

  const { meta, events } = await opencode.loadSession(found[0], ctx);
  const session = assemble(meta, events);
  assert.deepEqual(session.prompts.map((p) => p.text), ['Fix the parser.', 'Now handle unicode identifiers', 'try again', 'final prompt, never answered']);
  assert.equal(session.latest.started, false);
  assert.match(session.compaction.summary, /^## Goal/);
  assert.equal(session.compaction.trigger, 'auto');
  assert.ok(!events.some((e) => e.kind === 'reply' && e.text.startsWith('## Goal')), 'the summary message is not a reply');
  assert.deepEqual(session.files.map((f) => f.path), [join(projectDir, 'lib/x.js'), `${projectDir}/parser.js`], 'newest edit first; the rejected write is no edit');
  assert.equal(session.failures.length, 2);
  const failed = session.failures.find((f) => f.target === 'npm test');
  assert.deepEqual([failed.exit, failed.error], [1, '2 failed']);
  assert.equal(session.failures.find((f) => f.tool === 'write').error, 'The user rejected permission to use this specific tool call.');
  assert.deepEqual(session.plan.items, [{ text: 'fix tokenizer', status: 'done' }, { text: 'fix tests', status: 'active' }], 'the todo table wins over older todowrite calls');
  const stop = events.find((e) => e.kind === 'stop');
  assert.deepEqual([stop.reason, stop.resetsAt], ['quota', t(9) + 120_000]);
  assert.ok(events.some((e) => e.kind === 'interrupt'));
  assert.ok(!JSON.stringify(events).includes('secret chain of thought'));
  assert.equal(meta.model, 'openai/gpt-5');
  assert.equal(meta.resumeCommand, 'opencode --session ses_one');
});

test('honours XDG_DATA_HOME and OPENCODE_DB, never writes to the store, tolerates a bad database', async () => {
  const fx = projectFixture();
  const xdg = tempDir('copass-xdg-');
  const s = createStore(xdg); // <xdg>/.local/share/opencode/opencode.db
  s.session2('ses_x', fx.projectDir, 1);
  s.message2('ses_x', 'user', 1, { text: 'hello from xdg' });
  s.close();
  const data = join(xdg, '.local', 'share');
  const before = readFileSync(s.file);

  const ctx = fixtureContext(fx.home, { XDG_DATA_HOME: data });
  const [found] = await opencode.findSessions(fx.project, ctx);
  assert.equal(found.id, 'ses_x');
  await opencode.loadSession(found, ctx);
  assert.deepEqual(readFileSync(s.file), before, 'the database is opened read-only');
  assert.ok(!existsSync(`${s.file}-wal`) && !existsSync(`${s.file}-shm`));

  const renamed = join(data, 'opencode', 'work.db');
  writeFileSync(renamed, readFileSync(s.file));
  const viaEnv = await opencode.findSessions(fx.project, fixtureContext(fx.home, { XDG_DATA_HOME: data, OPENCODE_DB: 'work.db' }));
  assert.equal(viaEnv[0].ref.file, renamed);

  assert.deepEqual(await opencode.findSessions(fx.project, fixtureContext(tempDir('copass-empty-'))), [], 'no database');
  const junk = tempDir('copass-junk-');
  writeTree(junk, { '.local/share/opencode/opencode.db': 'this is not sqlite' });
  assert.deepEqual(await opencode.findSessions(fx.project, fixtureContext(junk)), []);
  const missing = await opencode.loadSession({ id: 'ses_gone', agent: 'opencode', lastActivity: 1, ref: { file: join(junk, 'nope.db'), kind: 'v2' } }, ctx);
  assert.deepEqual(missing.events, []);
});

test('launch starts the TUI with a first prompt', () => {
  assert.deepEqual(opencode.launch('continue the work'), ['opencode', ['--prompt', 'continue the work']]);
});
