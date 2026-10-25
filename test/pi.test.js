import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import * as pi from '../agents/pi.js';
import { assemble } from '../lib/assemble.js';
import { resolveProject } from '../lib/project.js';
import { fixtureContext, tempDir, writeTree } from './helpers.js';

const ID = '0199e0a1-5b2c-7d3e-8f40-123456789abc';
const SUB = '0199e0a1-5b2c-7d3e-8f40-aaaaaaaaaaaa';
const STUB = '0199e0a1-5b2c-7d3e-8f40-bbbbbbbbbbbb';
const OTHER = '0199e0a1-5b2c-7d3e-8f40-cccccccccccc';
const FLAT = '0199e0a1-5b2c-7d3e-8f40-dddddddddddd';
const V1 = 'ffae836b-9420-4060-ac13-7745215f90ff';

const t = (s) => new Date(Date.UTC(2026, 9, 25, 9, 0, s)).toISOString();
const ms = (s) => Date.parse(t(s));
const fileName = (id, s) => `${t(s).replace(/[:.]/g, '-')}_${id}.jsonl`;

const header = (id, cwd, s = 0) => ({ type: 'session', version: 3, id, timestamp: t(s), cwd });
const message = (id, s, m) => ({ type: 'message', id, timestamp: t(s), message: { ...m, timestamp: ms(s) } });
const user = (id, s, content) => message(id, s, { role: 'user', content });
const assistant = (id, s, content, extra = {}) =>
  message(id, s, {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    ...extra,
  });
const toolResult = (id, s, toolCallId, toolName, text, extra = {}) =>
  message(id, s, { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], isError: false, ...extra });
const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
const system = (id, s, cwd) =>
  message(id, s, { role: 'system', content: '', sections: { preamble: 'You are an expert coding assistant.', cwd }, toolsAdded: [{ name: 'read', description: 'Read a file', parameters: {} }] });

/** Entries point at the previous one unless they say otherwise (parentId given explicitly). */
function chain(entries) {
  return entries.map(({ type, id, timestamp, ...rest }, i) => ({
    type,
    id,
    parentId: 'parentId' in rest ? rest.parentId : (entries[i - 1]?.id ?? null),
    timestamp,
    ...rest,
  }));
}

function mainSession(projectDir) {
  const cwd = projectDir;
  const skill = '<skill name="review" location="/h/.pi/agent/skills/review/SKILL.md">\nReferences are relative to /h/.pi/agent/skills/review.\n\nReview the diff.\n</skill>\n\ncheck src/parser.js';
  const fileBlock = '<file name="/work/notes.md">\nINLINED FILE BODY\n</file>\nNow also handle unicode identifiers';
  return [
    header(ID, cwd),
    ...chain([
      system('e0000001', 1, cwd),
      { type: 'model_change', id: 'e0000002', timestamp: t(2), provider: 'openai', modelId: 'gpt-4o' },
      user('e0000003', 60, "Fix the parser. Don't change the API."),
      assistant('e0000004', 70, [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'Looking at the parser.' }, call('c1', 'edit', { path: 'src/parser.js', edits: [{ oldText: 'a', newText: 'b' }] })], { stopReason: 'toolUse' }),
      toolResult('e0000005', 71, 'c1', 'edit', 'Edited src/parser.js'),
      // an abandoned branch (/tree back to e0000005), kept in the file but not part of the conversation
      assistant('x0000001', 80, [{ type: 'text', text: 'abandoned approach' }, call('cx', 'write', { path: 'src/abandoned.js', content: 'x' })], { parentId: 'e0000005', stopReason: 'toolUse' }),
      user('x0000002', 85, 'abandoned follow-up'),
      { type: 'branch_summary', id: 'e0000006', parentId: 'e0000005', timestamp: t(90), fromId: 'x0000002', summary: 'Branch summary text' },
      assistant('e0000007', 100, [call('c2', 'bash', { command: 'npm test' })], { stopReason: 'toolUse' }),
      toolResult('e0000008', 101, 'c2', 'bash', '1 test failed: parser.spec.js\n\nCommand exited with code 1', { isError: true }),
      { type: 'custom', id: 'e0000009', timestamp: t(102), customType: 'plan-mode', data: { enabled: false, todos: [{ step: 1, text: 'older plan step', completed: false }], executing: true } },
      assistant('e0000010', 110, [call('c3', 'todo', { action: 'add', text: 'fix tests' })], { stopReason: 'toolUse' }),
      toolResult('e0000011', 111, 'c3', 'todo', 'Added todo #2: fix tests', { details: { action: 'add', todos: [{ id: 1, text: 'fix tokenizer', done: true }, { id: 2, text: 'fix tests', done: false }], nextId: 3 } }),
      assistant('e0000012', 120, [call('c4', 'codemode', { code: 'await tools.write(...)' })], { stopReason: 'toolUse' }),
      toolResult('e0000013', 121, 'c4', 'codemode', 'done', { nestedCalls: { complete: true, calls: [{ id: 'n1', name: 'write', arguments: { path: '/work/nested.js', content: 'x' }, status: 'ok' }, { id: 'n2', name: 'bash', arguments: { command: 'false' }, status: 'error', error: 'exit 1' }] } }),
      assistant('e0000014', 130, [{ type: 'text', text: 'Tokenizer fixed.' }, { type: 'text', text: 'Tests still red.' }]),
      { type: 'compaction', id: 'e0000015', timestamp: t(140), summary: '## Goal\nFix the parser\n\n## Next Steps\n1. fix tests', firstKeptEntryId: 'e0000007', tokensBefore: 50000 },
      user('e0000016', 150, skill),
      assistant('e0000017', 160, [{ type: 'text', text: 'Starting the review' }], { stopReason: 'aborted', errorMessage: 'Request was aborted' }),
      message('e0000018', 165, { role: 'bashExecution', command: 'git status', output: 'clean', exitCode: 0, cancelled: false, truncated: false }),
      message('e0000019', 166, { role: 'bashExecution', command: 'cat .secret-notes', output: 'hidden', exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true }),
      user('e0000020', 170, fileBlock),
      assistant('e0000021', 175, [], { stopReason: 'error', errorMessage: 'overloaded_error' }),
      { type: 'context_edit', id: 'e0000022', timestamp: t(176), targetId: 'e0000021', replacement: null },
      assistant('e0000023', 180, [{ type: 'text', text: 'Handled unicode identifiers.' }]),
      { type: 'custom_message', id: 'e0000024', timestamp: t(185), customType: 'plan-mode-context', content: '[PLAN MODE ACTIVE]', display: false },
      user('e0000025', 600, [{ type: 'text', text: 'ship it' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]),
      assistant('e0000026', 610, [], { stopReason: 'error', errorMessage: 'You have hit your ChatGPT usage limit (plus). Try again in ~42 min.' }),
      { type: 'session_info', id: 'e0000027', timestamp: t(615), name: 'Parser fixes' },
    ]),
  ];
}

function fixture() {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'my_app.v2'); // pi keeps '_' and '.' in directory names
  writeTree(projectDir, { 'README.md': 'x' });
  const dir = `.pi/agent/sessions/${pi.encodeCwd(projectDir)}`;
  const subDir = join(projectDir, 'packages', 'web');
  writeTree(home, {
    [`${dir}/${fileName(ID, 0)}`]: mainSession(projectDir),
    // a stub: the header and the system prompt only, nothing said yet
    [`${dir}/${fileName(STUB, 5)}`]: [header(STUB, projectDir, 5), ...chain([system('s0000001', 6, projectDir)])],
    // a session started in a subdirectory of the project
    [`.pi/agent/sessions/${pi.encodeCwd(subDir)}/${fileName(SUB, 20)}`]: [header(SUB, subDir, 20), ...chain([user('b0000001', 30, 'Style the nav'), assistant('b0000002', 40, [{ type: 'text', text: 'Done.' }])])],
    // "my_app.v2-backup" shares the directory-name prefix; the cwd in its header rules it out
    [`.pi/agent/sessions/${pi.encodeCwd(`${projectDir}-backup`)}/${fileName(OTHER, 10)}`]: [header(OTHER, `${projectDir}-backup`, 10), ...chain([user('c0000001', 20, 'hi')])],
  });
  return { home, projectDir, subDir };
}

test('encodeCwd matches pi: leading separator dropped, separators and drive colons become dashes', () => {
  assert.equal(pi.encodeCwd('/Users/me/my_app.v2'), '--Users-me-my_app.v2--');
  assert.equal(pi.encodeCwd('C:\\Users\\me\\proj'), '--C--Users-me-proj--');
});

test('finds the real sessions, skips stubs and lookalike dirs, flags the running one', async () => {
  const { home, projectDir } = fixture();
  const project = resolveProject(projectDir);
  const found = await pi.findSessions(project, fixtureContext(home));
  assert.deepEqual(found.map((c) => c.id), [ID, SUB]);
  const [main, sub] = found;
  assert.equal(main.title, 'Parser fixes');
  assert.equal(main.preview, "Fix the parser. Don't change the API.");
  assert.equal(main.score, 3);
  assert.equal(sub.score, 1);
  assert.equal(main.lastActivity, ms(600), 'activity = last user/assistant record, not the error or session_info after it');
  assert.equal(main.background, undefined);
  assert.equal(main.current, false);

  const byId = await pi.findSessions(project, fixtureContext(home, { PI_SESSION_ID: ID }));
  assert.deepEqual(byId.map((c) => c.current), [true, false]);
  const byFile = await pi.findSessions(project, fixtureContext(home, { PI_SESSION_FILE: main.ref.file }));
  assert.deepEqual(byFile.map((c) => c.current), [true, false]);
});

test('reads the conversation from the active branch: prompts, replies, tools, plan, compaction, stop', async () => {
  const { home, projectDir } = fixture();
  const ctx = fixtureContext(home);
  const [candidate] = await pi.findSessions(resolveProject(projectDir), ctx);
  const { meta, events } = await pi.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), [
    "Fix the parser. Don't change the API.",
    '/skill:review check src/parser.js',
    '@/work/notes.md\nNow also handle unicode identifiers',
    'ship it\n[image attached]',
  ]);
  assert.equal(s.latest.prompt.text, 'ship it\n[image attached]');
  assert.equal(s.latest.started, false);

  const replies = events.filter((e) => e.kind === 'reply');
  assert.deepEqual(replies.map((r) => r.text), ['Looking at the parser.', 'Tokenizer fixed.\nTests still red.', 'Starting the review', 'Handled unicode identifiers.']);
  assert.deepEqual(replies.map((r) => [r.final, r.partial]), [[undefined, undefined], [true, undefined], [undefined, true], [true, undefined]]);
  assert.equal(events.filter((e) => e.kind === 'interrupt').length, 1);
  assert.equal(s.latest.interrupted, false, 'the abort belongs to an earlier turn');

  const text = JSON.stringify(events);
  for (const absent of ['private reasoning', 'abandoned', 'Branch summary text', 'INLINED FILE BODY', 'PLAN MODE ACTIVE', '.secret-notes', 'expert coding assistant']) {
    assert.ok(!text.includes(absent), `${absent} must not reach the events`);
  }

  assert.deepEqual(s.files.map((f) => f.path).sort(), [`${projectDir}/src/parser.js`, '/work/nested.js'].sort());
  const failure = s.failures.find((f) => f.target === 'npm test');
  assert.equal(failure.exit, 1);
  assert.equal(failure.error, '1 test failed: parser.spec.js\n\nCommand exited with code 1');
  assert.ok(s.failures.some((f) => f.target === 'false' && f.error === 'exit 1'), 'a nested call that failed');
  assert.equal(events.find((e) => e.target === 'git status').exit, 0, 'a command the user ran with !');
  assert.deepEqual(s.plan.items, [{ text: 'fix tokenizer', status: 'done' }, { text: 'fix tests', status: 'pending' }]);
  assert.equal(events.filter((e) => e.kind === 'plan').length, 2, 'the plan-mode entry is a plan snapshot too');

  assert.match(s.compaction.summary, /^## Goal/);
  assert.equal(s.compaction.ts, ms(140));
  assert.equal(s.stop.reason, 'quota', 'the retried overloaded attempt was omitted by a context_edit and does not count');
  assert.equal(s.stop.resetsAt, ms(610) + 42 * 60_000);

  assert.equal(meta.title, 'Parser fixes');
  assert.equal(meta.model, 'claude-sonnet-4-5');
  assert.equal(meta.cwd, projectDir);
  assert.equal(meta.startedAt, ms(0));
  assert.equal(meta.logFile, candidate.ref.file);
  assert.equal(meta.resumeCommand, `pi --session ${ID}`);
});

test('a half-written last line (live session) changes nothing', async () => {
  const { home, projectDir } = fixture();
  const ctx = fixtureContext(home);
  const project = resolveProject(projectDir);
  const [{ ref }] = await pi.findSessions(project, ctx);
  appendFileSync(ref.file, '{"type":"message","id":"zz000001","parentId":"e0000027","timestamp":"2026-10-25T09:11:00.000Z","mess');
  const [candidate] = await pi.findSessions(project, ctx);
  assert.equal(candidate.lastActivity, ms(600));
  const { meta, events } = await pi.loadSession(candidate, ctx);
  assert.equal(meta.title, 'Parser fixes');
  assert.equal(assemble(meta, events).stop.reason, 'quota');
});

test('classifies pi error messages into stop reasons', async () => {
  const home = tempDir('copass-home-');
  const projectDir = tempDir('copass-proj-');
  const errors = ['overloaded_error', '429 Too Many Requests', 'insufficient_quota: add billing details', 'HTTP 503 Service Unavailable', 'Provider finish_reason: network_error'];
  const entries = chain([
    user('d0000001', 10, 'go'),
    ...errors.map((errorMessage, i) => assistant(`d000001${i}`, 20 + i, [], { stopReason: 'error', errorMessage })),
  ]);
  writeTree(home, { [`.pi/agent/sessions/${pi.encodeCwd(projectDir)}/${fileName(ID, 0)}`]: [header(ID, projectDir), ...entries] });
  const ctx = fixtureContext(home);
  const [candidate] = await pi.findSessions(resolveProject(projectDir), ctx);
  const { events } = await pi.loadSession(candidate, ctx);
  assert.deepEqual(events.filter((e) => e.kind === 'stop').map((e) => e.reason), ['overloaded', 'rate_limit', 'quota', 'overloaded', 'error']);
});

test('reads v1 sessions (no ids, linear, model in the header)', async () => {
  const home = tempDir('copass-home-');
  const projectDir = tempDir('copass-proj-');
  const at = (s) => t(s);
  const v1 = [
    { type: 'session', id: V1, timestamp: at(0), cwd: projectDir, provider: 'anthropic', modelId: 'claude-opus-4-5', thinkingLevel: 'off' },
    { type: 'message', timestamp: at(10), message: { role: 'user', content: [{ type: 'text', text: 'Refactor main' }], timestamp: ms(10) } },
    { type: 'message', timestamp: at(20), message: { role: 'assistant', content: [call('t1', 'read', { path: 'main.ts' })], stopReason: 'toolUse', timestamp: ms(20) } },
    { type: 'message', timestamp: at(21), message: { role: 'toolResult', toolCallId: 't1', toolName: 'read', content: [{ type: 'text', text: 'file body' }], isError: false, timestamp: ms(21) } },
    { type: 'thinking_level_change', timestamp: at(22), thinkingLevel: 'minimal' },
    { type: 'compaction', timestamp: at(30), summary: '# Context Checkpoint\nRefactoring main', firstKeptEntryIndex: 1, tokensBefore: 1000 },
    { type: 'message', timestamp: at(40), message: { role: 'bashExecution', command: 'npm test', output: 'FAIL', exitCode: 1, cancelled: false, truncated: false, timestamp: ms(40) } },
    { type: 'message', timestamp: at(50), message: { role: 'user', content: 'and the tests', timestamp: ms(50) } },
  ];
  writeTree(home, { [`.pi/agent/sessions/${pi.encodeCwd(projectDir)}/${fileName(V1, 0)}`]: v1 });
  const ctx = fixtureContext(home);
  const [candidate] = await pi.findSessions(resolveProject(projectDir), ctx);
  assert.equal(candidate.lastActivity, ms(50));
  const { meta, events } = await pi.loadSession(candidate, ctx);
  const s = assemble(meta, events);
  assert.deepEqual(s.prompts.map((p) => p.text), ['Refactor main', 'and the tests']);
  assert.equal(s.compaction.summary, '# Context Checkpoint\nRefactoring main');
  assert.equal(meta.model, 'claude-opus-4-5');
  assert.equal(s.failures[0].target, 'npm test');
  assert.equal(s.failures[0].exit, 1);
  assert.equal(events.find((e) => e.action === 'read').target, `${projectDir}/main.ts`, 'relative tool paths resolve against the session cwd');
});

test('honours PI_CODING_AGENT_DIR, PI_CODING_AGENT_SESSION_DIR and the sessionDir setting (flat directories)', async () => {
  const { home, projectDir } = fixture();
  const project = resolveProject(projectDir);
  const flatSession = (id, cwd) => [header(id, cwd), ...chain([user('f0000001', 30, 'from a flat dir'), assistant('f0000002', 40, [{ type: 'text', text: 'ok' }])])];
  writeTree(home, {
    'flat/a.jsonl': flatSession(FLAT, projectDir),
    'flat/b.jsonl': flatSession(OTHER, `${projectDir}-elsewhere`), // another project's session in the same directory
    'agentx/settings.json': { sessionDir: '~/from-settings' },
    'from-settings/c.jsonl': flatSession(SUB, projectDir),
  });

  const env = await pi.findSessions(project, fixtureContext(home, { PI_CODING_AGENT_SESSION_DIR: join(home, 'flat') }));
  assert.deepEqual(env.map((c) => c.id).sort(), [FLAT, ID, SUB].sort(), 'the default directory is still searched');

  const setting = await pi.findSessions(project, fixtureContext(home, { PI_CODING_AGENT_DIR: join(home, 'agentx') }));
  assert.deepEqual(setting.map((c) => c.id), [SUB], 'agent dir moved: no default sessions there, the setting points at from-settings');
});

test('launch passes the prompt as a positional argument', () => {
  assert.deepEqual(pi.launch('read the hand-over'), ['pi', ['read the hand-over']]);
  assert.deepEqual(pi.launch('-x'), ['pi', ['--', '-x']]);
});
