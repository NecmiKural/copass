import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import * as goose from '../agents/goose.js';
import { assemble } from '../lib/assemble.js';
import { resolveProject } from '../lib/project.js';
import { openReadOnly } from '../lib/sqlite.js';
import { fixtureContext, tempDir, writeTree } from './helpers.js';

const MAIN = '20261025_1';
const MANUAL = '20261025_2';
const SCHEDULED = '20261025_3';
const STUB = '20261025_4';
const SUBAGENT = '20261025_5';
const ELSEWHERE = '20261025_6';
const ARCHIVED = '20261025_7';
const NAMED = '20261025_8';
const LEGACY = '20240101_120000';

// crates/goose/src/session/session_manager.rs, create_schema() at schema v17
const SCHEMA = `
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', user_set_name BOOLEAN DEFAULT FALSE,
  session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, extension_data TEXT DEFAULT '{}',
  total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER,
  accumulated_cache_read_tokens INTEGER, accumulated_cache_write_tokens INTEGER, accumulated_cost REAL,
  schedule_id TEXT, recipe_json TEXT, user_recipe_values_json TEXT, provider_name TEXT, model_config_json TEXT,
  goose_mode TEXT NOT NULL DEFAULT 'auto', archived_at TIMESTAMP, project_id TEXT, parent_session_id TEXT,
  system_prompt_override TEXT, system_prompt_extras_json TEXT, container_id TEXT);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL, content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, tokens INTEGER, metadata_json TEXT);
`;

const sec = (m) => Date.UTC(2026, 9, 25, 9, m) / 1000;
const stamp = (m) => new Date(sec(m) * 1000).toISOString().slice(0, 19).replace('T', ' ');

// content blocks as serde writes them (message.rs: tag = "type", camelCase)
const text = (t, extra = {}) => ({ type: 'text', text: t, ...extra });
const request = (id, name, args) => ({ type: 'toolRequest', id, toolCall: { status: 'success', value: { name, arguments: args } } });
const response = (id, value) => ({ type: 'toolResponse', id, toolResult: { status: 'success', value } });
const output = (t, extra = {}) => ({ content: [text(t)], isError: false, ...extra });

const VISIBLE = { userVisible: true, agentVisible: true };
const FOLDED = { userVisible: true, agentVisible: false };
const AGENT_ONLY = { userVisible: false, agentVisible: true };
const TURN_CONTEXT = { ...AGENT_ONLY, turnContext: true };

async function createDatabase(path) {
  await openReadOnly(path); // loads node:sqlite with its warning suppressed
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.prepare('INSERT INTO schema_version (version) VALUES (17)').run();
  return db;
}

function fixture(db, projectDir) {
  const addSession = db.prepare('INSERT INTO sessions (id, name, user_set_name, session_type, working_dir, created_at, updated_at, schedule_id, archived_at, model_config_json, extension_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const addMessage = db.prepare('INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, metadata_json) VALUES (?, ?, ?, ?, ?, ?)');
  let seq = 0;
  const say = (session, role, minute, content, metadata = VISIBLE) =>
    addMessage.run(`msg_${session}_${++seq}`, session, role, JSON.stringify(content), sec(minute), JSON.stringify(metadata));
  const config = JSON.stringify({ model_name: 'configured-model', temperature: null });
  // updated_at is bumped by every write, hidden or not: it must never decide lastActivity
  const session = (id, { name = 'CLI Session', named = 0, type = 'user', cwd = projectDir, schedule = null, archived = null, extension = '{}' } = {}) =>
    addSession.run(id, name, named, type, cwd, stamp(0), stamp(59), schedule, archived, config, extension);

  session(MAIN, { extension: JSON.stringify({ 'todo.v0': { content: '- [x] fix tokenizer\n- [~] fix tests\n- [ ] release' } }) });
  say(MAIN, 'assistant', 0, [], { userVisible: false, agentVisible: false, operations: { entry_hook: { session_start: true } } });
  say(MAIN, 'user', 1, [text('<system-reminder>moim</system-reminder>')], TURN_CONTEXT);
  say(MAIN, 'user', 1, [text("Fix the parser. Don't change the API.")]);
  say(MAIN, 'assistant', 2, [{ type: 'thinking', thinking: 'private chain of thought', signature: 's' }, text('Looking at the parser.'), request('call_1', 'edit', { path: 'src/parser.js', before: 'a', after: 'b' })], { ...VISIBLE, inference: { provider: 'anthropic', requestedModel: 'claude-x', resolvedModel: 'claude-x-20261001' } });
  say(MAIN, 'user', 2, [response('call_1', output('Edited src/parser.js'))]);
  say(MAIN, 'assistant', 3, [request('call_2', 'developer__shell', { command: 'npm test' }), request('call_3', 'tree', { path: 'src', depth: 2 })]);
  say(MAIN, 'user', 3, [
    response('call_2', output('boom', { isError: true, structuredContent: { stdout: '', stderr: '1 test failed: parser.spec.js', exit_code: 1 } })),
    response('call_3', [text('src/\n  parser.js')]), // older rows store the bare content list
  ]);
  say(MAIN, 'assistant', 4, [request('call_4', 'todo__todo_write', { content: '- [x] fix tokenizer\n- [ ] fix tests' }), request('call_5', 'developer__text_editor', { command: 'view', path: join(projectDir, 'README.md') }), request('call_6', 'summon__delegate', { instructions: 'look around' })]);
  say(MAIN, 'user', 4, [response('call_4', output('Updated (30 chars)'))]);
  say(MAIN, 'assistant', 5, [text('Tokenizer fixed; tests still fail.')]);
  // the user cuts a tool call short
  say(MAIN, 'user', 6, [text('Try the lexer too')]);
  say(MAIN, 'assistant', 6, [request('call_7', 'shell', { command: 'sleep 100' })]);
  say(MAIN, 'user', 7, [{ type: 'toolResponse', id: 'call_7', toolResult: { status: 'error', error: '-32603: Interrupted by the user to make a correction' } }]);
  say(MAIN, 'assistant', 7, [text('Yes — what would you like me to do?')]);
  // streamed fragments of one message arrive as separate rows with one message_id
  addMessage.run('stream-1', MAIN, 'assistant', JSON.stringify([text('Part one.')]), sec(8), JSON.stringify(VISIBLE));
  addMessage.run('stream-1', MAIN, 'assistant', JSON.stringify([text('Part two.')]), sec(8), JSON.stringify(VISIBLE));
  // a compaction: everything so far is folded, then summary (user), continuation (assistant), preserved prompt copy
  db.prepare("UPDATE messages SET metadata_json = json_set(metadata_json, '$.agentVisible', json('false')) WHERE session_id = ?").run(MAIN);
  say(MAIN, 'user', 9, [text('# Conversation Summary\n## User Intent\n- Fix the parser')], AGENT_ONLY);
  say(MAIN, 'assistant', 9, [text('Your context was compacted. The previous message contains a summary.')], AGENT_ONLY);
  say(MAIN, 'user', 9, [text('Try the lexer too')], AGENT_ONLY);
  say(MAIN, 'assistant', 10, [text('Trying the lexer.'), request('call_8', 'write', { path: join(projectDir, 'lexer.js'), content: 'x' })]);
  say(MAIN, 'user', 10, [response('call_8', output('Wrote lexer.js'))]);
  // a prompt that merely quotes the harness wording is still a prompt, not a compaction
  say(MAIN, 'user', 11, [text('What does "Your context was compacted" mean?'), text('--- Resource: file:///work/a.ts ---\nconst a = 1;\n---\n'), text('\n\n# /work/b.ts\n```\nlet b;\n```'), text('assistant-only hint', { annotations: { audience: ['assistant'] } }), { type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
  say(MAIN, 'assistant', 11, [{ type: 'error', kind: 'other', message: 'Ran into this error: Rate limit exceeded: slow down.\n\nPlease retry if you think this is a transient or recoverable error.' }], FOLDED);
  say(MAIN, 'user', 12, [text('Now also handle unicode identifiers')]);
  say(MAIN, 'assistant', 13, [{ type: 'systemNotification', notificationType: 'creditsExhausted', msg: 'Please add credits to your account, then resend your message to continue.', data: { top_up_url: null } }], FOLDED);
  say(MAIN, 'user', 14, [text('<system-reminder>later moim</system-reminder>')], TURN_CONTEXT); // harness rows after the last real message

  // /compact typed by the user, then the summary pair
  session(MANUAL, { name: 'Parser fixes', named: 1 });
  say(MANUAL, 'user', 20, [text('Add logging')]);
  say(MANUAL, 'assistant', 20, [text('Added.')]);
  say(MANUAL, 'user', 21, [text('/compact')], FOLDED);
  say(MANUAL, 'user', 22, [text('summary text')], AGENT_ONLY);
  say(MANUAL, 'assistant', 22, [text('continuing')], AGENT_ONLY);
  db.prepare("UPDATE messages SET metadata_json = json_set(metadata_json, '$.agentVisible', json('false')) WHERE session_id = ? AND role = 'user' AND created_timestamp < ?").run(MANUAL, sec(22));
  say(MANUAL, 'user', 23, [text('/myrecipe go')], FOLDED); // custom slash command: the typed line is the prompt…
  say(MANUAL, 'user', 23, [text('Expanded recipe prompt')], { userVisible: false, agentVisible: true }); // …its expansion is agent-only
  say(MANUAL, 'assistant', 24, [text('Recipe done.')]);

  session(SCHEDULED, { name: 'Scheduled job: nightly', type: 'scheduled', schedule: 'nightly' });
  say(SCHEDULED, 'user', 30, [text('Run the nightly checks')]);
  say(SCHEDULED, 'assistant', 31, [text('Done.')]);

  session(STUB);
  say(STUB, 'assistant', 40, [], { userVisible: false, agentVisible: false, operations: { entry_hook: { session_start: true } } });

  session(SUBAGENT, { type: 'sub_agent' });
  say(SUBAGENT, 'user', 41, [text('delegated work')]);

  session(ELSEWHERE, { cwd: join(projectDir, '..') });
  say(ELSEWHERE, 'user', 42, [text('somewhere else')]);

  session(ARCHIVED, { archived: stamp(50) });
  say(ARCHIVED, 'user', 43, [text('old news')]);

  session(NAMED, { name: 'Release plan', named: 0 }); // auto-generated names are real titles
  say(NAMED, 'user', 44, [text('Plan the release')]);
  addMessage.run('ms', NAMED, 'assistant', JSON.stringify([text('Plan ready.')]), sec(45) * 1000, JSON.stringify(VISIBLE)); // old rows hold milliseconds
}

async function setup() {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'my app');
  writeTree(projectDir, { 'README.md': 'x' });
  const dbPath = join(home, '.local/share/goose/sessions/sessions.db');
  const db = await createDatabase(dbPath);
  fixture(db, projectDir);
  db.close();
  return { home, projectDir, dbPath };
}

const idsOf = (found) => found.map((c) => c.id);

test('finds the project sessions newest first, skipping stubs, subagents, archives and other directories', async () => {
  const { home, projectDir, dbPath } = await setup();
  const before = readFileSync(dbPath);
  const found = await goose.findSessions(resolveProject(projectDir), fixtureContext(home));

  assert.deepEqual(idsOf(found), [NAMED, SCHEDULED, MANUAL, MAIN]);
  const main = found.find((c) => c.id === MAIN);
  assert.equal(main.score, 3);
  assert.equal(main.lastActivity, Date.UTC(2026, 9, 25, 9, 13), 'last visible message, not updated_at');
  assert.equal(main.title, undefined, 'the CLI placeholder name is not a title');
  assert.equal(main.preview, "Fix the parser. Don't change the API.");
  assert.equal(found.find((c) => c.id === MANUAL).title, 'Parser fixes');
  assert.equal(found.find((c) => c.id === NAMED).title, 'Release plan');
  assert.equal(found.find((c) => c.id === NAMED).lastActivity, Date.UTC(2026, 9, 25, 9, 45), 'millisecond timestamps are normalized');
  assert.equal(found.find((c) => c.id === SCHEDULED).background, true);
  assert.equal(main.background, false);
  assert.deepEqual(readFileSync(dbPath), before, 'database opened read-only');

  const self = await goose.findSessions(resolveProject(projectDir), fixtureContext(home, { AGENT_SESSION_ID: MAIN }));
  assert.deepEqual(self.filter((c) => c.current).map((c) => c.id), [MAIN]);
  rmSync(home, { recursive: true, force: true });
});

test('loads prompts, replies, tools, plan, compaction, interrupt and stop from the message rows', async () => {
  const { home, projectDir } = await setup();
  const ctx = fixtureContext(home);
  const candidate = (await goose.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === MAIN);
  const { meta, events } = await goose.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), [
    "Fix the parser. Don't change the API.",
    'Try the lexer too',
    'What does "Your context was compacted" mean?\n[image attached]',
    'Now also handle unicode identifiers',
  ]);
  assert.equal(s.latest.started, false, 'the last prompt was never answered');
  assert.equal(s.latest.answered, false);

  assert.equal(events.filter((e) => e.kind === 'compaction').length, 1, 'only the structural summary counts');
  assert.match(s.compaction.summary, /^# Conversation Summary/);
  assert.equal(s.compaction.trigger, 'auto');

  const replies = events.filter((e) => e.kind === 'reply');
  assert.deepEqual(replies.map((r) => r.text), ['Looking at the parser.', 'Tokenizer fixed; tests still fail.', 'Part one.\nPart two.', 'Trying the lexer.'], 'no thinking, no hook or continuation text, fragments merged');
  assert.deepEqual(replies.map((r) => r.final), [false, true, false, false], 'only the last reply of a turn, with no tool call after it, is the answer');

  const tools = events.filter((e) => e.kind === 'tool');
  assert.deepEqual(tools.map((t) => [t.action, t.target]), [
    ['edit', `${projectDir}/src/parser.js`],
    ['command', 'npm test'],
    ['search', `${projectDir}/src`],
    ['read', `${projectDir}/README.md`],
    ['other', undefined],
    ['command', 'sleep 100'],
    ['edit', `${projectDir}/lexer.js`],
  ]);
  assert.deepEqual(s.files.map((f) => f.path), [`${projectDir}/lexer.js`, `${projectDir}/src/parser.js`]);
  assert.equal(s.failures[0].error, '1 test failed: parser.spec.js');
  assert.equal(tools[1].exit, 1);
  assert.equal(tools[0].ok, true);
  assert.equal(tools[2].ok, true, 'bare content list results load');
  assert.equal(tools[5].ok, false);
  assert.ok(events.some((e) => e.kind === 'interrupt'));

  assert.deepEqual(s.plan.items, [
    { text: 'fix tokenizer', status: 'done' },
    { text: 'fix tests', status: 'active' },
    { text: 'release', status: 'pending' },
  ], 'the saved todo state wins over the last todo_write call');

  const stops = events.filter((e) => e.kind === 'stop');
  assert.deepEqual(stops.map((e) => e.reason), ['rate_limit', 'quota']);
  assert.equal(s.stop.reason, 'quota');
  assert.match(s.stop.message, /add credits/);

  assert.equal(meta.model, 'claude-x-20261001');
  assert.equal(meta.cwd, projectDir);
  assert.equal(meta.resumeCommand, `goose session --resume --session-id ${MAIN}`);
  assert.equal(meta.startedAt, Date.UTC(2026, 9, 25, 9, 0));
  rmSync(home, { recursive: true, force: true });
});

test('a recipe expansion is not a compaction, and /compact marks the next summary manual', async () => {
  const { home, projectDir } = await setup();
  const ctx = fixtureContext(home);
  const candidate = (await goose.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === MANUAL);
  const { meta, events } = await goose.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), ['Add logging', '/compact', '/myrecipe go']);
  assert.equal(events.filter((e) => e.kind === 'compaction').length, 1);
  assert.equal(s.compaction.trigger, 'manual');
  assert.equal(s.compaction.summary, 'summary text');
  assert.equal(s.latest.answered, true);
  assert.equal(meta.model, 'configured-model', 'falls back to the session model config');
  rmSync(home, { recursive: true, force: true });
});

test('reads legacy .jsonl sessions the database does not hold, and none it does', async () => {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'legacy');
  writeTree(projectDir, { 'README.md': 'x' });
  const dir = '.local/share/goose/sessions';
  const meta = { description: 'Legacy   parser fix', working_dir: projectDir, id: LEGACY, created_at: '2024-01-01T12:00:00Z', updated_at: '2024-01-01T12:05:00Z', extension_data: {}, message_count: 2 };
  writeTree(home, {
    [`${dir}/${LEGACY}.jsonl`]: [
      meta,
      { id: 'msg1', role: 'user', created: 1704110400, content: [text('Fix the parser')] },
      { id: 'msg2', role: 'assistant', created: 1704110401, content: [text('Looking.'), request('t1', 'developer__shell', { command: 'ls' })] },
      { id: 'msg3', role: 'user', created: 1704110402, content: [response('t1', [text('a.js')])] },
      { id: 'msg4', role: 'assistant', created: 1704110403, content: [text('Done.')], metadata: VISIBLE },
    ],
    [`${dir}/20240102_090000.jsonl`]: [{ ...meta, id: '20240102_090000' }],
    [`${dir}/${MAIN}.jsonl`]: [meta, { id: 'x', role: 'user', created: 1704110400, content: [text('imported already')] }],
  });
  const db = await createDatabase(join(home, dir, 'sessions.db'));
  db.prepare("INSERT INTO sessions (id, working_dir) VALUES (?, ?)").run(MAIN, projectDir); // a session the database imported: its .jsonl is stale
  db.close();

  const ctx = fixtureContext(home);
  const found = await goose.findSessions(resolveProject(projectDir), ctx);
  assert.deepEqual(idsOf(found), [LEGACY], 'stub and already-imported files are skipped');
  assert.equal(found[0].title, 'Legacy parser fix');
  assert.equal(found[0].lastActivity, 1704110403000);

  const { meta: loaded, events } = await goose.loadSession(found[0], ctx);
  const s = assemble(loaded, events);
  assert.deepEqual(s.prompts.map((p) => p.text), ['Fix the parser']);
  assert.equal(s.latest.answered, true);
  assert.deepEqual(s.commands.map((c) => c.target), ['ls']);
  assert.equal(events.find((e) => e.kind === 'reply' && e.text === 'Done.').final, true);
  rmSync(home, { recursive: true, force: true });
});

test('locates the data directory per platform and for GOOSE_PATH_ROOT', async () => {
  const root = tempDir('copass-root-');
  const projectDir = join(tempDir('copass-proj-'), 'app');
  writeTree(projectDir, { 'README.md': 'x' });
  const project = resolveProject(projectDir);
  const meta = { working_dir: projectDir, created_at: '2024-01-01T12:00:00Z' };
  const session = (id) => [meta, { role: 'user', created: 1704110400, content: [text('hello')] }, { role: 'assistant', created: 1704110401, content: [text('hi')] }].map((r, i) => (i ? r : { ...r, id }));

  writeTree(root, {
    'rooted/data/sessions/20240101_1.jsonl': session('20240101_1'),
    'xdg/goose/sessions/20240101_2.jsonl': session('20240101_2'),
    'win/Block/goose/data/sessions/20240101_3.jsonl': session('20240101_3'),
    'home/.local/share/goose/sessions/20240101_4.jsonl': session('20240101_4'),
    'home/Library/Application Support/Block/goose/data/sessions/20240101_5.jsonl': session('20240101_5'),
  });
  const ids = async (platform, env) => idsOf(await goose.findSessions(project, { env, home: join(root, 'home'), platform, now: Date.now() }));

  assert.deepEqual(await ids('linux', { GOOSE_PATH_ROOT: join(root, 'rooted') }), ['20240101_1']);
  assert.deepEqual(await ids('linux', { XDG_DATA_HOME: join(root, 'xdg') }), ['20240101_2']);
  assert.deepEqual(await ids('win32', { APPDATA: join(root, 'win') }), ['20240101_3']);
  assert.deepEqual(await ids('linux', {}), ['20240101_4']);
  assert.deepEqual((await ids('darwin', {})).sort(), ['20240101_4', '20240101_5']);
  assert.deepEqual(await ids('linux', { GOOSE_PATH_ROOT: 'relative/root' }), ['20240101_4'], 'a relative GOOSE_PATH_ROOT is ignored, as goose does');
  rmSync(root, { recursive: true, force: true });
});

test('launch starts an interactive run with the first prompt', () => {
  assert.deepEqual(goose.launch('--odd prompt'), ['goose', ['run', '-s', '--text=--odd prompt']]);
});
