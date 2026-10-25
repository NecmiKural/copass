import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';

import * as gemini from '../agents/gemini-cli.js';
import { assemble } from '../lib/assemble.js';
import { resolveProject } from '../lib/project.js';
import { fixtureContext, tempDir, writeTree } from './helpers.js';

const ID = '11111111-2222-4333-8444-555555555555';
const LEGACY = '22222222-2222-4333-8444-555555555555';
const SUB = '44444444-2222-4333-8444-555555555555';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const t = (m) => new Date(Date.UTC(2026, 9, 25, 9, m)).toISOString();
const april = (m) => new Date(Date.UTC(2026, 3, 1, 8, m)).toISOString();

const msg = (id, type, ts, content, extra = {}) => ({ id, timestamp: ts, type, content, ...extra });
const call = (name, args) => ({ role: 'model', parts: [{ functionCall: { name, args } }] });
const answer = (name, response) => ({ role: 'user', parts: [{ functionResponse: { id: `r-${name}`, name, response } }] });

function mainSession(projectDir, H) {
  const header = { sessionId: ID, projectHash: H, startTime: t(0), lastUpdated: t(0), kind: 'main' };
  const tools = [
    { id: 'c1', name: 'replace', args: { file_path: `${projectDir}/parser.js` }, status: 'success', timestamp: t(2), result: [{ functionResponse: { id: 'c1', name: 'replace', response: { output: 'ok' } } }] },
    { id: 'c2', name: 'run_shell_command', args: { command: 'npm test' }, status: 'success', timestamp: t(2), result: [{ functionResponse: { id: 'c2', name: 'run_shell_command', response: { output: 'Output: 1 failing: parser.spec.js\nExit Code: 1\nProcess Group PGID: 7' } } }] },
    { id: 'c3', name: 'write_todos', args: { todos: [{ description: 'fix tokenizer', status: 'completed' }, { description: 'fix tests', status: 'in_progress' }, { description: 'dropped idea', status: 'cancelled' }] }, status: 'success', timestamp: t(2) },
  ];
  return [
    header,
    { $set: { messages: [msg('env', 'user', t(0), [{ text: '<session_context>\nThis is the Gemini CLI.\n</session_context>' }])] } },
    msg('u1', 'user', t(1), [
      { text: "Fix the parser. Don't change the API.\n\nCurrent File Path:\n```javascript\n/x/parser.js\n```\n\nUser Selected Files:\n- /x/a.js\n" },
      { text: '\n\n<hook_context>injected by a hook</hook_context>' },
    ]),
    msg('ide', 'user', t(1), [{ text: "Here is the user's editor context as a JSON object. This is for your information only.\n```json\n{}\n```" }]),
    msg('g1', 'gemini', t(2), '', { thoughts: [{ subject: 'Planning', description: 'private reasoning' }], model: 'gemini-3.1-pro-preview' }),
    msg('g1', 'gemini', t(2), [{ text: 'thinking aloud', thought: true }, { text: 'Looking at the parser.' }], { model: 'gemini-3.1-pro-preview', toolCalls: tools }),
    msg('u-rw', 'user', t(3), 'a request that was rewound'),
    msg('g-rw', 'gemini', t(3), 'rewound reply'),
    { $rewindTo: 'u-rw' },
    msg('cmd', 'user', t(4), '/model'),
    msg('snap', 'user', t(5), [{ text: '<state_snapshot>\n<overall_goal>fix the parser</overall_goal>\n</state_snapshot>' }]),
    msg('ack', 'gemini', t(5), 'Got it. Thanks for the additional context!'),
    msg('u2', 'user', t(6), 'Now also handle unicode identifiers'),
    msg('g2', 'gemini', t(7), 'Partial answer'),
    { $patch: { id: 'g2', content: 'Unicode handled.' } },
    msg('u3', 'user', t(8), 'And update the README'),
    msg('e1', 'error', t(9), 'You have exhausted your daily quota on this model.'),
    { $set: { lastUpdated: t(9), summary: 'Parser fixes' } },
    { ...header, lastUpdated: t(9) }, // re-appended on resume
  ];
}

function fixture() {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'my_app.v2');
  writeTree(projectDir, { 'README.md': 'x' });
  const H = sha256(projectDir);
  const legacyDir = `.gemini/tmp/${H}`;
  const legacy = {
    sessionId: LEGACY,
    projectHash: H,
    startTime: april(0),
    lastUpdated: april(30),
    messages: [msg('l1', 'user', april(1), [{ text: 'Add a login page' }]), msg('l2', 'gemini', april(2), ''), msg('l3', 'gemini', april(20), 'Login page added.')],
  };
  const history1 = [{ role: 'user', parts: [{ text: 'Add a login page' }] }, call('read_file', { file_path: `${projectDir}/app.js` }), answer('read_file', { output: 'code' }), call('write_file', { file_path: `${projectDir}/login.js` })];
  const history2 = [...history1, answer('write_file', { output: 'ok' }), call('run_shell_command', { command: 'npm run build' }), answer('run_shell_command', { output: 'Output: build failed\nExit Code: 2' }), call('replace', { file_path: `${projectDir}/login.js` })];

  writeTree(home, {
    // 'my-app-1': slugs collide and are never derived; the registry decides.
    '.gemini/projects.json': { projects: { [projectDir]: 'my-app-1', [home]: 'home', [`${projectDir}/api`]: 'api' } },
    '.gemini/tmp/my-app-1/.project_root': projectDir,
    [`.gemini/tmp/my-app-1/chats/session-2026-10-25T09-00-${ID.slice(0, 8)}.jsonl`]: `${mainSession(projectDir, H).map((r) => JSON.stringify(r)).join('\n')}\n{"id":"torn","type":"us`,
    // Gemini Code Assist agent-mode stub: only the harness environment dump.
    '.gemini/tmp/my-app-1/chats/session-2026-10-25T10-00-a2a-serv.jsonl': [
      { sessionId: 'a2a-server', projectHash: H, startTime: t(60), lastUpdated: t(60), kind: 'main' },
      { $set: { messages: [msg('a2a', 'user', t(60), [{ text: '<session_context>\nenv\n</session_context>' }])] } },
    ],
    '.gemini/tmp/my-app-1/chats/session-2026-10-25T11-00-99999999.jsonl': [{ sessionId: '99999999-0000-4000-8000-000000000000', projectHash: H, startTime: t(120), lastUpdated: t(120), kind: 'main' }],
    [`.gemini/tmp/my-app-1/chats/session-2026-10-25T12-00-77777777.jsonl`]: [
      { sessionId: '77777777-0000-4000-8000-000000000000', projectHash: sha256('/elsewhere'), startTime: t(180), lastUpdated: t(180) },
      msg('x', 'user', t(181), 'belongs to another project'),
    ],
    [`.gemini/tmp/my-app-1/chats/${ID}/sub1.jsonl`]: [{ sessionId: 'sub1', projectHash: H, kind: 'subagent' }, msg('s', 'user', t(200), 'subagent task')],
    // Legacy whole-file session in the pre-registry hash dir, with checkpoints instead of tool calls.
    [`${legacyDir}/chats/session-2026-04-01T08-00-${LEGACY.slice(0, 8)}.json`]: legacy,
    [`${legacyDir}/checkpoints/2026-04-01T08-05-00_000Z-login.js-write_file.json`]: { clientHistory: history1, toolCall: { name: 'write_file', args: { file_path: `${projectDir}/login.js` } }, commitHash: 'abc', messageId: `${LEGACY}########3` },
    [`${legacyDir}/checkpoints/2026-04-01T08-10-00_000Z-login.js-replace.json`]: { clientHistory: history2, toolCall: { name: 'replace', args: { file_path: `${projectDir}/login.js` } }, commitHash: 'def', messageId: `${LEGACY}########7` },
    [`${legacyDir}/checkpoints/2026-04-01T08-12-00_000Z-other.js-replace.json`]: { clientHistory: [call('replace', { file_path: `${projectDir}/other.js` })], toolCall: { name: 'replace', args: {} }, messageId: 'another-session########1' },
    // A migrated copy of the legacy session in the slug dir is the same session.
    [`.gemini/tmp/my-app-1/chats/session-2026-04-01T08-00-${LEGACY.slice(0, 8)}.json`]: legacy,
    // Launched in a subdirectory of the project.
    [`.gemini/tmp/api/chats/session-2026-10-20T09-00-${SUB.slice(0, 8)}.jsonl`]: [{ sessionId: SUB, projectHash: sha256(`${projectDir}/api`) }, msg('a', 'user', '2026-10-20T09:01:00.000Z', 'Add an endpoint')],
    // Launched in the home directory: an ancestor never matches.
    '.gemini/tmp/home/chats/session-2026-10-25T13-00-33333333.jsonl': [{ sessionId: '33333333-0000-4000-8000-000000000000', projectHash: sha256(home) }, msg('h', 'user', t(240), 'hi')],
  });
  return { home, projectDir };
}

test('replay applies upserts, $set, $rewindTo, $patch with orderIds and skips torn lines', () => {
  const dir = tempDir('copass-replay-');
  writeTree(dir, {
    'session-x.jsonl': `${[
      { sessionId: 's', projectHash: 'h' },
      msg('a', 'user', t(0), 'one'),
      msg('b', 'gemini', t(1), 'two'),
      msg('c', 'user', t(2), 'three'),
      { $rewindTo: 'c' },
      { $patch: { updates: [{ id: 'b', content: 'TWO' }], removeIds: [], orderIds: ['b', 'a'] } },
      { $set: { lastUpdated: t(3) } },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n')}\n{"$set":`,
  });
  const { meta, messages } = gemini.replay(join(dir, 'session-x.jsonl'));
  assert.deepEqual(messages.map((m) => `${m.id}:${m.content}`), ['b:TWO', 'a:one']);
  assert.equal(meta.lastUpdated, t(3));
});

test('finds real sessions through the registry and legacy hash dirs, skipping stubs and other projects', async () => {
  const { home, projectDir } = fixture();
  const project = resolveProject(projectDir);
  const found = await gemini.findSessions(project, fixtureContext(home));
  assert.deepEqual(found.map((c) => c.id), [ID, SUB, LEGACY]);
  assert.equal(found[0].title, 'Parser fixes');
  assert.equal(found[0].preview, "Fix the parser. Don't change the API.");
  assert.equal(found[0].lastActivity, Date.UTC(2026, 9, 25, 9, 8), 'activity = last user/gemini record, not the error');
  assert.equal(found[0].score, 3);
  assert.equal(found[1].score, 1);
  assert.equal(found[1].cwd, `${projectDir}/api`);
  assert.equal(found[2].ref.dirs.length, 2, 'migrated duplicate merged into one candidate');

  const self = await gemini.findSessions(project, fixtureContext(home, { GEMINI_SESSION_ID: ID }));
  assert.equal(self[0].current, true);
  const moved = await gemini.findSessions(project, fixtureContext(tempDir('copass-empty-'), { GEMINI_CLI_HOME: home }));
  assert.equal(moved.length, 3, 'GEMINI_CLI_HOME overrides the home directory');
});

test('loads clean prompts, replies, tool outcomes, plan, compaction and the quota stop', async () => {
  const { home, projectDir } = fixture();
  const ctx = fixtureContext(home);
  const [candidate] = await gemini.findSessions(resolveProject(projectDir), ctx);
  const { meta, events } = await gemini.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), ["Fix the parser. Don't change the API.", 'Now also handle unicode identifiers', 'And update the README']);
  assert.equal(s.latest.prompt.text, 'And update the README');
  assert.equal(s.latest.started, false);
  assert.deepEqual(events.filter((e) => e.kind === 'reply').map((e) => e.text), ['Looking at the parser.', 'Unicode handled.']);
  assert.match(s.compaction.summary, /^<state_snapshot>/);
  assert.deepEqual(s.files.map((f) => f.path), [`${projectDir}/parser.js`]);
  assert.equal(s.failures[0].target, 'npm test');
  assert.equal(s.failures[0].exit, 1);
  assert.match(s.failures[0].error, /1 failing/);
  assert.equal(s.testCommand.target, 'npm test');
  assert.deepEqual(s.plan.items.map((i) => i.status), ['done', 'active']);
  assert.equal(s.stop.reason, 'quota');
  assert.equal(meta.model, 'gemini-3.1-pro-preview');
  assert.equal(meta.resumeCommand, `gemini --resume ${ID}`);
  assert.equal(meta.startedAt, Date.UTC(2026, 9, 25, 9, 0));
  assert.ok(!JSON.stringify(events).includes('private reasoning') && !JSON.stringify(events).includes('thinking aloud'));
  assert.ok(!JSON.stringify(events).includes('rewound'));
});

test('recovers edits and failing commands of older sessions from linked checkpoints', async () => {
  const { home, projectDir } = fixture();
  const ctx = fixtureContext(home);
  const candidate = (await gemini.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === LEGACY);
  const { meta, events } = await gemini.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(events.map((e) => e.kind), ['prompt', 'tool', 'tool', 'tool', 'tool', 'reply']);
  assert.deepEqual(s.files.map((f) => [f.path, f.count]), [[`${projectDir}/login.js`, 2]]);
  assert.equal(s.failures.length, 1);
  assert.equal(s.failures[0].target, 'npm run build');
  assert.equal(s.failures[0].exit, 2);
  assert.equal(events[1].action, 'read');
  assert.equal(events[1].ok, true);
  assert.equal(events[2].ts, Date.UTC(2026, 3, 1, 8, 5), 'dated by the first checkpoint holding the call');
  assert.ok(!s.files.some((f) => f.path.endsWith('other.js')), 'checkpoints of other sessions are ignored');
});

test('launch starts Gemini CLI interactively with the prompt', () => {
  assert.deepEqual(gemini.launch('hello'), ['gemini', ['-i', 'hello']]);
});

test('places checkpoint-recovered tool calls in the turn that made them', async () => {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'app');
  writeTree(projectDir, { 'README.md': 'x' });
  const at = (m) => new Date(Date.UTC(2026, 3, 2, 10, m)).toISOString();
  const S = '55555555-2222-4333-8444-555555555555';
  const session = {
    sessionId: S,
    projectHash: sha256(projectDir),
    startTime: at(0),
    lastUpdated: at(20),
    messages: [
      msg('u1', 'user', at(0), [{ text: 'Why does the build fail?' }]),
      msg('g1', 'gemini', at(5), 'Because of a missing import.'),
      msg('u2', 'user', at(10), [{ text: 'Fix it' }]),
      msg('g2', 'gemini', at(20), 'Fixed.'),
    ],
  };
  // The only checkpoint (written before the edit in turn 2) also holds turn 1's command.
  const history = [
    { role: 'user', parts: [{ text: '<session_context>\nenv\n</session_context>' }] },
    { role: 'user', parts: [{ text: 'Why does the build fail?' }] },
    call('run_shell_command', { command: 'npm run build' }),
    answer('run_shell_command', { output: 'Output: missing import\nExit Code: 1' }),
    { role: 'model', parts: [{ text: 'Because of a missing import.' }] },
    { role: 'user', parts: [{ text: 'Fix it' }] },
    call('replace', { file_path: 'app.js' }),
  ];
  writeTree(home, {
    '.gemini/projects.json': { projects: { [projectDir]: 'app' } },
    [`.gemini/tmp/app/chats/session-2026-04-02T10-00-${S.slice(0, 8)}.json`]: session,
    '.gemini/tmp/app/checkpoints/2026-04-02T10-15-00_000Z-app.js-replace.json': { clientHistory: history, messageId: `${S}########6` },
  });
  const ctx = fixtureContext(home);
  const [candidate] = await gemini.findSessions(resolveProject(projectDir), ctx);
  const { meta, events } = await gemini.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(events.map((e) => e.kind), ['prompt', 'tool', 'reply', 'prompt', 'tool', 'reply']);
  assert.deepEqual(s.turns[0].tools.map((e) => e.target), ['npm run build']);
  assert.deepEqual(s.turns[1].tools.map((e) => e.target), [`${projectDir}/app.js`], 'relative paths resolve against the launch dir');
  assert.equal(s.turns[1].tools[0].ts, Date.UTC(2026, 3, 2, 10, 15), 'still dated by the checkpoint when that is earlier');
});

test('prompts drop JetBrains prior-chat history, unescape its brackets, keep the typed command line and unwrap shell mode', async () => {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'app');
  writeTree(projectDir, { 'README.md': 'x' });
  const S = '66666666-2222-4333-8444-555555555555';
  writeTree(home, {
    '.gemini/projects.json': { projects: { [projectDir]: 'app' } },
    [`.gemini/tmp/app/chats/session-2026-10-25T09-00-${S.slice(0, 8)}.jsonl`]: [
      { sessionId: S, projectHash: sha256(projectDir), startTime: t(0), lastUpdated: t(0), kind: 'main' },
      msg('u1', 'user', t(1), [{ text: 'Render &lt;List&gt; lazily\n\n\n\n\n PRIOR CHAT HISTORY: an older prompt\n \nanother one' }]),
      msg('g1', 'gemini', t(2), 'Done.'),
      msg('u2', 'user', t(3), [{ text: 'Keep a && b <= c as is' }]),
      msg('u3', 'user', t(4), [{ text: 'You are a test fixer. Expanded command template.' }], { displayContent: [{ text: '/fix-tests unit' }] }),
      msg('u4', 'user', t(5), [{ text: 'Explain this\n--- Content from referenced files ---\nfile body' }], { displayContent: [{ text: '@src/a.js Explain this' }] }),
      msg('sh', 'user', t(6), [{ text: 'I ran the following shell command:\n```sh\ngit log --format=\\`%h\\`\n```\n\nThis produced the following result:\n```\nabc123\n```' }]),
    ],
  });
  const ctx = fixtureContext(home);
  const [candidate] = await gemini.findSessions(resolveProject(projectDir), ctx);
  assert.equal(candidate.preview, 'Render <List> lazily');
  const { events } = await gemini.loadSession(candidate, ctx);
  assert.deepEqual(
    events.filter((e) => e.kind === 'prompt').map((e) => e.text),
    ['Render <List> lazily', 'Keep a && b <= c as is', '/fix-tests unit', '@src/a.js Explain this', '! git log --format=`%h`'],
  );
});

test('shell outcomes come from the exit code or a cancelled run, never from stdout lines; Esc is an interrupt', async () => {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'app');
  writeTree(projectDir, { 'README.md': 'x' });
  const S = '77777777-2222-4333-8444-555555555555';
  const wrap = (s) => `<untrusted_context source="run_shell_command">\n${s}\n</untrusted_context>`;
  const shell = (id, command, output) => ({
    id,
    name: 'run_shell_command',
    args: { command },
    status: 'success',
    timestamp: t(2),
    result: [{ functionResponse: { id, name: 'run_shell_command', response: { output: wrap(output) } } }],
  });
  writeTree(home, {
    '.gemini/projects.json': { projects: { [projectDir]: 'app' } },
    [`.gemini/tmp/app/chats/session-2026-10-25T09-00-${S.slice(0, 8)}.jsonl`]: [
      { sessionId: S, projectHash: sha256(projectDir), startTime: t(0), lastUpdated: t(0), kind: 'main' },
      msg('u1', 'user', t(1), 'Check the logs'),
      msg('g1', 'gemini', t(2), 'Checked.', {
        toolCalls: [
          shell('c1', 'cat app.log', 'Output: rotating logs\nError: disk full (yesterday)\nProcess Group PGID: 9'),
          shell('c2', 'make', 'Output: make: *** [all] Error 2\nExit Code: 2\nProcess Group PGID: 10'),
          shell('c3', 'sleep 900', 'Command was cancelled by user before it could complete. There was no output before it was cancelled.'),
        ],
      }),
      msg('i1', 'info', t(3), 'Request cancelled.'),
    ],
  });
  const ctx = fixtureContext(home);
  const [candidate] = await gemini.findSessions(resolveProject(projectDir), ctx);
  const { events } = await gemini.loadSession(candidate, ctx);
  const [log, make, sleep] = events.filter((e) => e.kind === 'tool');
  assert.equal(log.ok, true);
  assert.equal(make.ok, false);
  assert.equal(make.exit, 2);
  assert.ok(!make.error.includes('untrusted_context'));
  assert.equal(sleep.ok, false);
  assert.equal(assemble({}, events).latest.interrupted, true, 'Esc is recorded as a "Request cancelled." info record');
});
