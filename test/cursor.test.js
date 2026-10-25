import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import * as cursor from '../agents/cursor.js';
import { assemble } from '../lib/assemble.js';
import { resolveProject } from '../lib/project.js';
import { fixtureContext, tempDir, writeTree } from './helpers.js';

// The fixture stores are written with node:sqlite directly; keep its ExperimentalWarning out of the output.
const emitWarning = process.emitWarning;
process.emitWarning = () => {};
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emitWarning;

const ID = '11111111-2222-4333-8444-555555555555';
const STORE_ONLY = '22222222-2222-4333-8444-555555555555';
const JSONL_ONLY = '33333333-2222-4333-8444-555555555555';
const SUBDIR = '44444444-2222-4333-8444-555555555555';
const CHILD = '55555555-2222-4333-8444-555555555555';
const STUB = '66666666-2222-4333-8444-555555555555';
const ACP = '77777777-2222-4333-8444-555555555555';
const OTHER = '88888888-2222-4333-8444-555555555555';

const md5 = (s) => createHash('md5').update(s).digest('hex');
const at = (h, m) => Date.UTC(2026, 9, 25, h, m);
const stamp = (h, m, ap = 'AM', zone = 'UTC+0') => `<timestamp>Sunday, Oct 25, 2026, ${h}:${String(m).padStart(2, '0')} ${ap} (${zone})</timestamp>`;
const query = (text) => `<user_query>\n${text}\n</user_query>`;
const pin = (path, ms) => utimesSync(path, ms / 1000, ms / 1000);

// ── Store messages, in the AI-SDK shape Cursor logs ─────────────────────────────

/** A typed prompt: <timestamp> and <system_reminder> parts beside the <user_query> part. */
const user = (n, text, h, m) => ({
  role: 'user',
  content: [
    { type: 'text', text: stamp(h, m) },
    { type: 'text', text: '<system_reminder>\nYou are in agent mode.\n</system_reminder>' },
    { type: 'text', text: query(text) },
  ],
  providerOptions: { cursor: { requestId: `req-${n}` } },
});
const call = (id, toolName, args, extra = []) => ({ role: 'assistant', id: `m-${id}`, content: [...extra, { type: 'tool-call', toolCallId: id, toolName, args }] });
const done = (id, toolName, result, hl) => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName, result }],
  ...(hl ? { providerOptions: { cursor: { highLevelToolCallResult: hl } } } : {}),
});
const say = (text) => ({ role: 'assistant', id: `m-${text.length}`, content: [{ type: 'text', text }] });

/** A SQLite store as the CLI writes it: JSON message blobs and a protobuf blob, hex-encoded meta key '0'. */
function writeStore(path, meta, blobs) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  const insert = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
  for (const b of blobs) {
    const data = Buffer.isBuffer(b) ? b : Buffer.from(JSON.stringify(b));
    insert.run(createHash('sha256').update(data).digest('hex'), data);
  }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', Buffer.from(JSON.stringify(meta)).toString('hex'));
  db.close();
}

const root = Buffer.concat([Buffer.from([0x0a, 0x20]), createHash('sha256').update('root').digest(), Buffer.from([0x28, 0x07])]);
const context = [root, { role: 'system', content: 'You are an AI coding assistant.' }, { role: 'user', content: '<user_info>\nOS: darwin\n</user_info>' }, { foo: 'not a message' }];

function mainMessages(dir) {
  return [
    ...context,
    user(1, "Fix the parser. Don't change the API.", 9, 1),
    call('tc1', 'StrReplace', { path: `${dir}/parser.js`, old_string: 'a', new_string: 'b' }, [
      { type: 'redacted-reasoning', data: 'AAAA' },
      { type: 'reasoning', text: 'SECRET THINKING', providerOptions: { cursor: { modelName: 'composer-2.5' } } },
      { type: 'text', text: 'Looking at the parser.' },
    ]),
    done('tc1', 'StrReplace', 'Saved', { output: { success: { path: `${dir}/parser.js` } } }),
    call('tc2', 'Shell', { command: 'npm test', description: 'Run tests' }),
    done('tc2', 'Shell', 'Exit code: 1\n\nCommand output:\n\n```\nFAIL parser.spec.js\n1 test failed\n```\n\nCommand completed in 2.1s', { output: { success: { stdout: 'FAIL parser.spec.js' } } }),
    call('tc3', 'CallDynamicTool', {
      namespace: 'cursor',
      toolName: 'TodoWrite',
      arguments: { merge: false, todos: [{ id: '1', content: 'fix tokenizer', status: 'completed' }, { id: '2', content: 'fix tests', status: 'in_progress' }, { id: '3', content: 'drop it', status: 'cancelled' }] },
    }),
    say('The tests still fail; two failures left.'),
    { role: 'user', content: '[Previous conversation summary]: Primary request: fix the parser.', providerOptions: { cursor: { isSummary: true } } },
    user(2, 'Now also handle unicode identifiers', 9, 5),
    call('tc4', 'Read', { path: `${dir}/missing.js` }),
    done('tc4', 'Read', 'File not found', { isError: true }),
    user(3, 'and update the README', 9, 8), // the request failed: no answer follows
  ];
}

/** The lossy transcript of the same chat: no results, null ids, redacted text, the failed turn's user line lost. */
function mainLog(dir) {
  const u = (h, m, text) => ({ role: 'user', message: { content: [{ type: 'text', text: `${stamp(h, m)}\n${query(text)}` }] } });
  const a = (...content) => ({ role: 'assistant', message: { content } });
  return [
    u(9, 1, "Fix the parser. Don't change the API."),
    a({ type: 'text', text: '[REDACTED]' }, { type: 'text', text: 'Looking at the parser.' }, { type: 'tool_use', name: 'StrReplace', input: { path: `${dir}/parser.js` }, id: null }),
    a({ type: 'tool_use', name: 'Shell', input: { command: 'npm test' }, id: null }),
    a({ type: 'text', text: 'The tests still fail; two failures left.' }),
    u(9, 5, 'Now also handle unicode identifiers'),
    { type: 'turn_ended', status: 'error', error: "You've hit your usage limit. Upgrade to Pro to continue." },
  ];
}

function fixture() {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'my_app.v2'); // '_' and '.' are lossy in Cursor's slug
  writeTree(projectDir, { 'README.md': 'x', 'sub/index.js': 'x' });
  const cfg = join(home, '.cursor');
  const slugDir = (p) => join(cfg, 'projects', cursor.slug(p), 'agent-transcripts');
  const bucket = join(cfg, 'chats', md5(projectDir));
  const files = {
    [`${slugDir(projectDir)}/${ID}/${ID}.jsonl`]: mainLog(projectDir),
    // a subagent transcript hangs below its parent and is never read
    [`${slugDir(projectDir)}/${ID}/subagents/${CHILD}.jsonl`]: [{ role: 'user', message: { content: [{ type: 'text', text: query('subagent noise') }] } }],
    [`${slugDir(projectDir)}/${STUB}/${STUB}.jsonl`]: '',
    // flat layout, a prompt-less catalog record, an image, the plan "Build" button, an abort
    [`${slugDir(projectDir)}/${JSONL_ONLY}.jsonl`]: [
      { role: 'user', message: { content: [{ type: 'text', text: `${stamp(2, 0, 'PM', 'UTC+4')}\n${query('Build me a cache')}` }] } },
      { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: { command: 'npm run build', description: 'Build' }, id: null }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'Build done.' }] } },
      { role: 'user', message: { content: [{ type: 'text', text: '<available_subagent_types>x</available_subagent_types>\n<available_subagent_models>y</available_subagent_models>\n<dynamic_tools>z</dynamic_tools>' }] } },
      { role: 'user', message: { content: [{ type: 'text', text: `${stamp(4, 35, 'AM', 'UTC-5:30')}\n<image_files>\n1. /tmp/a.png\n</image_files>\n${query('Look at this screenshot')}` }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: '[REDACTED]\nOn it.' }, { type: 'tool_use', name: 'Write', input: { path: `${projectDir}/cache.js`, contents: 'x' }, id: null }] } },
      { role: 'user', message: { content: [{ type: 'text', text: `${stamp(10, 9)}\n${query('Cache plan\n\nImplement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.')}` }] } },
      { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'CallDynamicTool', input: { namespace: 'cursor', toolName: 'TodoWrite', arguments: { merge: true, todos: [{ id: 'a', content: 'write cache', status: 'in_progress' }] } }, id: null }] } },
      { type: 'turn_ended', status: 'aborted' },
    ],
    [`${slugDir(join(projectDir, 'sub'))}/${SUBDIR}/${SUBDIR}.jsonl`]: [{ role: 'user', message: { content: [{ type: 'text', text: `${stamp(10, 0)}\n${query('look at sub')}` }] } }],
    // "my_app.v2-backup" shares the slug prefix; the disk has no such subdirectory
    [`${slugDir(`${projectDir}-backup`)}/${OTHER}/${OTHER}.jsonl`]: [{ role: 'user', message: { content: [{ type: 'text', text: query('not mine') }] } }],
    [`${bucket}/${STORE_ONLY}/meta.json`]: { cwd: projectDir, title: 'Sidecar title' },
    [`${cfg}/acp-sessions/${ACP}/meta.json`]: { cwd: projectDir, title: 'Via ACP' },
  };
  writeTree(home, Object.fromEntries(Object.entries(files).map(([p, v]) => [p.slice(home.length + 1), v])));

  writeStore(join(bucket, ID, 'store.db'), { agentId: ID, name: 'Parser fixes', mode: 'default', createdAt: at(9, 0), lastUsedModel: 'default', latestRootBlobId: 'abc' }, mainMessages(projectDir));
  writeStore(join(bucket, STORE_ONLY, 'store.db'), { agentId: STORE_ONLY, name: 'New Agent', createdAt: at(8, 0), latestRootBlobId: 'abc' }, [...context, user(1, 'store only prompt', 8, 30), say('store only answer')]);
  writeStore(join(bucket, CHILD, 'store.db'), { agentId: CHILD, name: 'sub', latestRootBlobId: 'abc', subagentInfo: { parentAgentId: ID, typeName: 'explore' } }, [...context, user(1, 'subagent noise', 9, 2)]);
  writeStore(join(bucket, STUB, 'store.db'), { agentId: STUB, name: 'New Agent', latestRootBlobId: '' }, context);
  writeStore(join(cfg, 'acp-sessions', ACP, 'store.db'), { agentId: ACP, name: 'New Agent', latestRootBlobId: 'abc' }, [...context, user(1, 'over acp', 7, 0), say('acp answer')]);

  pin(join(slugDir(projectDir), ID, `${ID}.jsonl`), at(11, 30));
  pin(join(bucket, STORE_ONLY, 'store.db'), at(11, 25));
  pin(join(slugDir(projectDir), `${JSONL_ONLY}.jsonl`), at(11, 20));
  pin(join(slugDir(join(projectDir, 'sub')), SUBDIR, `${SUBDIR}.jsonl`), at(11, 15));
  pin(join(cfg, 'acp-sessions', ACP, 'store.db'), at(11, 10));
  return { home, projectDir, cfg, bucket, slugDir };
}

test('slug matches Cursor: runs of non-alphanumerics become "-", "_" vanishes, no drive letter', () => {
  assert.equal(cursor.slug('/Users/me/my_app.v2/src'), 'Users-me-myapp-v2-src');
  assert.equal(cursor.slug('C:\\Users\\me\\proj'), 'Users-me-proj');
  assert.equal(cursor.slug('/a//b-c'), 'a-b-c');
});

test('finds stores, transcripts and ACP sessions; skips stubs, subagents and look-alike folders', async () => {
  const { home, projectDir } = fixture();
  const found = await cursor.findSessions(resolveProject(projectDir), fixtureContext(home));
  assert.deepEqual(found.map((c) => c.id), [ID, STORE_ONLY, JSONL_ONLY, SUBDIR, ACP], 'newest first; stub, subagent chat and "-backup" dropped');

  const by = Object.fromEntries(found.map((c) => [c.id, c]));
  assert.equal(by[ID].title, 'Parser fixes');
  assert.equal(by[ID].score, 3);
  assert.equal(by[ID].cwd, projectDir);
  assert.equal(by[ID].lastActivity, at(11, 30), 'the transcript is append-only: its mtime beats the minute stamps');
  assert.equal(by[ID].preview, "Fix the parser. Don't change the API.");
  assert.equal(by[ID].current, undefined, 'Cursor exposes no session id to child processes');
  assert.equal(by[STORE_ONLY].title, 'Sidecar title', 'the store says "New Agent"; the meta.json sidecar names it');
  assert.equal(by[STORE_ONLY].preview, 'store only prompt');
  assert.equal(by[JSONL_ONLY].title, undefined);
  assert.equal(by[JSONL_ONLY].preview, 'Build me a cache');
  assert.equal(by[SUBDIR].score, 1);
  assert.equal(by[SUBDIR].cwd, join(projectDir, 'sub'));
  assert.equal(by[ACP].title, 'Via ACP');
  assert.equal(by[ACP].score, 3);
  assert.equal(by[ID].ref.startedAt, at(9, 0));
});

test('honours CURSOR_CONFIG_DIR and XDG_CONFIG_HOME', async () => {
  const { home, projectDir } = fixture();
  const moved = join(home, 'elsewhere');
  const id = '99999999-2222-4333-8444-555555555555';
  writeTree(moved, { [`projects/${cursor.slug(projectDir)}/agent-transcripts/${id}/${id}.jsonl`]: [{ role: 'user', message: { content: [{ type: 'text', text: `${stamp(9, 0)}\n${query('moved')}` }] } }] });
  const project = resolveProject(projectDir);
  assert.ok((await cursor.findSessions(project, fixtureContext(home, { CURSOR_CONFIG_DIR: moved }))).some((c) => c.id === id));
  assert.ok((await cursor.findSessions(project, fixtureContext(home, { XDG_CONFIG_HOME: dirname(moved) }))).every((c) => c.id !== id), 'XDG uses <dir>/cursor');
  writeTree(join(home, 'xdg'), { [`cursor/projects/${cursor.slug(projectDir)}/agent-transcripts/${id}.jsonl`]: [{ role: 'user', message: { content: [{ type: 'text', text: query('xdg') }] } }] });
  assert.ok((await cursor.findSessions(project, fixtureContext(home, { XDG_CONFIG_HOME: join(home, 'xdg') }))).some((c) => c.id === id));
});

test('the store is the conversation: prompts, tools with outcomes, plan, summary and the unanswered last prompt', async () => {
  const { home, projectDir, bucket } = fixture();
  const ctx = fixtureContext(home);
  const before = readFileSync(join(bucket, ID, 'store.db'));
  const candidate = (await cursor.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === ID);
  const { meta, events } = await cursor.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), ["Fix the parser. Don't change the API.", 'Now also handle unicode identifiers', 'and update the README']);
  assert.deepEqual(s.prompts.map((p) => p.ts), [at(9, 1), at(9, 5), at(9, 8)]);
  assert.equal(s.latest.prompt.text, 'and update the README', 'the last prompt survives although its request failed');
  assert.equal(s.latest.started, false);

  assert.equal(s.compaction.summary, 'Primary request: fix the parser.');
  assert.ok(s.cut > 0, 'the summary is a structural boundary inside the history');
  assert.deepEqual(s.files.map((f) => f.path), [`${projectDir}/parser.js`]);
  assert.equal(s.commands[0].target, 'npm test');
  assert.deepEqual(s.failures.map((f) => [f.tool, f.exit, f.ok]), [['Shell', 1, false], ['Read', undefined, false]]);
  assert.match(s.failures[0].error, /FAIL parser\.spec\.js\n1 test failed/);
  assert.doesNotMatch(s.failures[0].error, /Command completed/);
  assert.equal(s.failures[1].error, 'File not found');
  assert.deepEqual(s.plan.items, [{ text: 'fix tokenizer', status: 'done' }, { text: 'fix tests', status: 'active' }], 'cancelled items are dropped');

  const replies = events.filter((e) => e.kind === 'reply');
  assert.deepEqual(replies.map((r) => [r.text, r.final]), [['Looking at the parser.', false], ['The tests still fail; two failures left.', true]]);
  assert.ok(!JSON.stringify(events).includes('SECRET THINKING'), 'reasoning is never read');
  assert.ok(!JSON.stringify(events).includes('REDACTED'));
  assert.ok(!JSON.stringify(events).includes('subagent noise'));
  assert.ok(!JSON.stringify(events).includes('<user_info>'));

  assert.equal(s.stop.reason, 'quota', 'how the last turn ended comes from the transcript');
  assert.match(s.stop.message, /usage limit/);
  assert.equal(meta.model, 'composer-2.5');
  assert.equal(meta.title, 'Parser fixes');
  assert.equal(meta.cwd, projectDir);
  assert.equal(meta.resumeCommand, `cursor-agent --resume ${ID}`);
  assert.match(meta.logFile, new RegExp(`${ID}\\.jsonl$`));
  assert.deepEqual(readFileSync(join(bucket, ID, 'store.db')), before, 'the store is never written');
});

test('without a store the transcript is read: wrappers unwrapped, redacted text dropped, order kept', async () => {
  const { home, projectDir } = fixture();
  const ctx = fixtureContext(home);
  const candidate = (await cursor.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === JSONL_ONLY);
  const { meta, events } = await cursor.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), ['Build me a cache', 'Look at this screenshot\n[image attached]', 'Implement the plan: Cache plan']);
  assert.deepEqual(s.prompts.map((p) => p.ts), [at(10, 0), at(10, 5), at(10, 9)], 'UTC+4 PM and UTC-5:30 stamps are converted to UTC');
  assert.deepEqual(events.filter((e) => e.kind === 'reply').map((r) => [r.text, r.final]), [['Build done.', true], ['On it.', false]]);
  assert.equal(s.commands[0].target, 'npm run build');
  assert.equal(s.commands[0].ok, undefined, 'the transcript has no tool results');
  assert.deepEqual(s.files.map((f) => f.path), [`${projectDir}/cache.js`]);
  assert.deepEqual(s.plan.items, [{ text: 'write cache', status: 'active' }]);
  assert.equal(s.latest.interrupted, true, 'turn_ended aborted = the user cut the turn short');
  assert.equal(meta.model, undefined);
  assert.equal(meta.logFile, candidate.ref.jsonl);
});

test('stop reasons come from the error of turn_ended; a store-less abort is an interrupt', async () => {
  const dir = tempDir('copass-log-');
  const cases = [
    ["You've hit your usage limit.", 'quota'],
    ['Too many requests (429), slow down', 'rate_limit'],
    ['The service is at capacity (503)', 'overloaded'],
    ['Connection lost', 'error'],
  ];
  for (const [i, [error, reason]] of cases.entries()) {
    const path = join(dir, `${i}.jsonl`);
    writeFileSync(path, [{ role: 'user', message: { content: [{ type: 'text', text: query('go') }] } }, { type: 'turn_ended', status: 'error', error }].map((r) => JSON.stringify(r)).join('\n'));
    const { events } = await cursor.loadSession({ id: `x${i}`, lastActivity: 1, ref: { jsonl: path } }, fixtureContext(dir));
    const stop = events.find((e) => e.kind === 'stop');
    assert.equal(stop.reason, reason, error);
    assert.equal(stop.message, error);
  }
  const resumed = join(dir, 'resumed.jsonl');
  writeFileSync(resumed, [
    { role: 'user', message: { content: [{ type: 'text', text: query('go') }] } },
    { type: 'turn_ended', status: 'error', error: 'Connection lost' },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'back' }] } },
    { type: 'turn_ended', status: 'success' },
  ].map((r) => JSON.stringify(r)).join('\n'));
  const { meta, events } = await cursor.loadSession({ id: 'r', lastActivity: 1, ref: { jsonl: resumed } }, fixtureContext(dir));
  assert.equal(assemble(meta, events).stop, null, 'a stop the session got past is not reported');
});

test('an unreadable store falls back to the transcript', async () => {
  const { home, projectDir, bucket } = fixture();
  const ctx = fixtureContext(home);
  const candidate = (await cursor.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === ID);
  writeFileSync(join(bucket, ID, 'store.db'), 'not a database');
  const { events } = await cursor.loadSession(candidate, ctx);
  assert.deepEqual(events.filter((e) => e.kind === 'prompt').map((e) => e.text), ["Fix the parser. Don't change the API.", 'Now also handle unicode identifiers']);
  assert.equal(events.at(-1).kind, 'stop');
});

test('tools: edit/command/read/search/other mapping, multi-file patches, MCP and merge-style todos', async () => {
  const dir = tempDir('copass-tools-');
  const path = join(dir, 'tools.jsonl');
  const calls = [
    ['Delete', { path: '/p/old.js' }],
    ['ApplyPatch', '*** Begin Patch\n*** Update File: /p/a.js\n@@\n-x\n+y\n*** Add File: /p/b.js\n+z\n*** End Patch'],
    ['EditNotebook', { target_notebook: '/p/n.ipynb' }],
    ['Glob', { glob_pattern: '**/*.ts', target_directory: '/p' }],
    ['Grep', { pattern: 'needle', path: '/p' }],
    ['ReadLints', { paths: ['/p/a.js'] }],
    ['WebSearch', { search_term: 'node sqlite' }],
    ['mcp_probe_echo', { text: 'hi' }],
    ['CallDynamicTool', { namespace: 'cursor', toolName: 'UpdateTodos', arguments: { merge: false, todos: [{ id: '1', content: 'a', status: 'pending' }, { id: '2', content: 'b', status: 'pending' }] } }],
    ['CallDynamicTool', { namespace: 'cursor', toolName: 'UpdateTodos', arguments: { merge: true, todos: [{ id: '2', status: 'completed' }] } }],
  ];
  writeFileSync(path, [
    { role: 'user', message: { content: [{ type: 'text', text: query('go') }] } },
    ...calls.map(([name, input]) => ({ role: 'assistant', message: { content: [{ type: 'tool_use', name, input, id: null }] } })),
  ].map((r) => JSON.stringify(r)).join('\n'));
  const { events } = await cursor.loadSession({ id: 't', lastActivity: 1, ref: { jsonl: path } }, fixtureContext(dir));
  const tools = events.filter((e) => e.kind === 'tool').map((e) => [e.tool, e.action, e.target]);
  assert.deepEqual(tools, [
    ['Delete', 'edit', '/p/old.js'],
    ['ApplyPatch', 'edit', '/p/a.js'],
    ['ApplyPatch', 'edit', '/p/b.js'],
    ['EditNotebook', 'edit', '/p/n.ipynb'],
    ['Glob', 'search', '**/*.ts'],
    ['Grep', 'search', 'needle'],
    ['ReadLints', 'read', '/p/a.js'],
    ['WebSearch', 'other', 'node sqlite'],
    ['mcp_probe_echo', 'other', undefined],
  ]);
  const plans = events.filter((e) => e.kind === 'plan');
  assert.deepEqual(plans.at(-1).items, [{ text: 'a', status: 'pending' }, { text: 'b', status: 'done' }], 'merge keeps the other items and the text of the one updated');
});

test('launch starts the CLI with the prompt', () => {
  assert.deepEqual(cursor.launch('continue the work'), ['cursor-agent', ['continue the work']]);
});
