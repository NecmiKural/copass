import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import * as copilot from '../agents/copilot-cli.js';
import { assemble } from '../lib/assemble.js';
import { resolveProject } from '../lib/project.js';
import { fixtureContext, tempDir, writeTree } from './helpers.js';

const ID = '11111111-2222-4333-8444-555555555555';
const OLD = '22222222-2222-4333-8444-555555555555';
const STUB = '99999999-2222-4333-8444-555555555555';
const EMPTY = '88888888-2222-4333-8444-555555555555';
const NESTED = '77777777-2222-4333-8444-555555555555';
const HOME = '66666666-2222-4333-8444-555555555555';

const t = (m) => new Date(Date.UTC(2026, 9, 25, 9, m)).toISOString();
let seq = 0;
const ev = (type, m, data, extra = {}) => ({ type, data, id: `e${++seq}`, parentId: null, timestamp: t(m), ...extra });
const start = (id, cwd, m, extra = {}) =>
  ev('session.start', m, { sessionId: id, copilotVersion: '1.0.56', startTime: t(m), selectedModel: 'auto', context: { cwd, gitRoot: cwd, branch: 'feature/x', headCommit: 'abc1234def5678' }, ...extra });
const toolStart = (m, id, toolName, args, extra = {}) => ev('tool.execution_start', m, { toolCallId: id, toolName, arguments: args, ...extra });
const toolDone = (m, id, data) => ev('tool.execution_complete', m, { toolCallId: id, model: 'gpt-5.4', success: true, ...data });

async function writeTodoDb(path) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  const add = db.prepare('INSERT INTO todos (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  add.run('a', 'fix tokenizer', 'done', '2026-10-25 09:01:00', '2026-10-25 09:20:00');
  add.run('b', 'fix tests', 'in_progress', '2026-10-25 09:02:00', '2026-10-25 09:20:00');
  add.run('c', 'release', 'blocked', '2026-10-25 09:03:00', '2026-10-25 09:20:00');
  db.close();
}

async function fixture() {
  const home = tempDir('copass-home-');
  const xdg = tempDir('copass-xdg-');
  const projectDir = join(tempDir('copass-proj-'), 'my app');
  writeTree(projectDir, { 'README.md': 'x', 'nested/.git/HEAD': 'ref: refs/heads/main\n', 'sub/a.txt': 'x' });
  const state = '.copilot/session-state';
  const vscodePrompt =
    "Fix the parser\n<reminder>Use the todo tool.</reminder><attachments><attachment id=\"a.ts\">const a = 1;</attachment></attachments><userRequest>Fix the parser. Don't change the API.</userRequest>\n";
  writeTree(home, {
    [`${state}/${ID}/events.jsonl`]: [
      start(ID, projectDir, 0),
      ev('system.message', 0, { role: 'system', content: '<custom_instruction>AGENTS.md dump</custom_instruction>' }),
      ev('user.message', 1, { content: vscodePrompt, transformedContent: `<current_datetime>now</current_datetime>${vscodePrompt}`, interactionId: 'i1', source: 'user' }),
      ev('assistant.message', 2, { messageId: 'm1', content: 'Looking at the parser.', phase: 'commentary', interactionId: 'i1', reasoningText: 'secret thinking', toolRequests: [{}] }),
      toolStart(2, 'tc1', 'report_intent', { intent: 'Fixing parser' }),
      toolStart(2, 'tc2', 'apply_patch', `*** Begin Patch\n*** Update File: ${projectDir}/parser.js\n@@\n-a\n+b\n*** Add File: src/lexer.js\n+x\n*** End Patch\n`),
      toolDone(2, 'tc2', { result: { content: 'Done' } }),
      toolStart(3, 'tc3', 'bash', { command: 'npm test', description: 'Run tests' }),
      toolDone(3, 'tc3', { result: { content: 'FAIL parser.spec.js\n<exited with exit code 1>' } }),
      toolStart(4, 'tc4', 'update_todo', { todos: '- [x] fix tokenizer\n- [ ] fix tests\n  - note without a box' }),
      toolStart(5, 'tc5', 'task', { agent_type: 'explore', description: 'Find usages', prompt: 'look around' }),
      ev('assistant.message', 5, { messageId: 'm2', content: 'subagent noise', interactionId: 'i1', parentToolCallId: 'tc5', toolRequests: [] }),
      toolStart(5, 'tc6', 'edit', { path: `${projectDir}/sub/a.txt`, old_str: 'x', new_str: 'y' }, { parentToolCallId: 'tc5' }),
      toolStart(5, 'tc7', 'view', { path: `${projectDir}/README.md` }, { parentToolCallId: 'tc5' }),
      toolStart(5, 'tc8', 'rg', { pattern: 'parse' }, {}),
      ev('tool.execution_start', 5, { toolCallId: 'tc9', toolName: 'view', arguments: { path: '/x' } }, { agentId: 'sub-1' }),
      ev('assistant.message', 6, { messageId: 'm3', content: 'Parser fixed; tests still fail.', phase: 'final_answer', interactionId: 'i1', toolRequests: [] }),
      ev('assistant.turn_end', 6, { turnId: '1' }),
      ev('user.message', 7, { content: '<system_notification>Shell 3 completed</system_notification>', source: 'system', interactionId: 'i9' }),
      ev('session.compaction_start', 8, { conversationTokens: 1000 }),
      ev('session.compaction_complete', 8, { success: true, summaryContent: '<overview>Fixing the parser</overview>\n<next_steps>tests</next_steps>', checkpointNumber: 1 }),
      ev('user.message', 9, { content: 'Now also handle unicode identifiers\n[Resource link: file:///tmp/lexer.js]', interactionId: 'i2', source: 'user', agentMode: 'interactive' }),
      ev('user.message', 9, { content: 'Continue working', interactionId: 'i3', isAutopilotContinuation: true }),
      ev('assistant.message', 10, { messageId: 'm4', content: 'Working on it', interactionId: 'i2', toolRequests: [{}] }),
      ev('abort', 11, { reason: 'user initiated' }),
      ev('user.message', 12, { content: 'and update the README', interactionId: 'i4', source: 'user' }),
      ev('session.error', 13, {
        errorType: 'rate_limit',
        errorCode: 'user_weekly_rate_limited',
        statusCode: 429,
        message: "You've reached your weekly rate limit. Please wait for your limit to reset on May 11, 2026 at 12:00 PM.",
      }),
    ],
    [`${state}/${ID}/workspace.yaml`]: `id: ${ID}\ncwd: ${projectDir}\nname: |-\n  Parser fixes\n  for unicode\n  [Resource link: file:///tmp/a.ts]\nuser_named: false\n`,
    [`${state}/${STUB}/workspace.yaml`]: `id: ${STUB}\n`,
    [`${state}/${EMPTY}/events.jsonl`]: [start(EMPTY, projectDir, 30)],
    // A separate repository inside the project, and the home directory above it: neither belongs to it.
    [`${state}/${NESTED}/events.jsonl`]: [start(NESTED, join(projectDir, 'nested'), 40), ev('user.message', 40, { content: 'other repo' })],
    [`${state}/${HOME}/events.jsonl`]: [start(HOME, join(projectDir, '..'), 40), ev('user.message', 40, { content: 'home' })],
    [`${state}/.session-operation-locks/x.lock`]: '',
  });
  // An older CLI (no source field) that only ever wrote under $XDG_STATE_HOME, run from a subdirectory.
  writeTree(xdg, {
    [`.copilot/session-state/${OLD}/events.jsonl`]: [
      start(OLD, join(projectDir, 'sub'), -30, { copilotVersion: '1.0.4' }),
      ev('user.message', -29, { content: 'Run the build', interactionId: 'o1' }),
      toolStart(-28, 'o2', 'powershell', { command: 'npm run build' }),
      toolDone(-28, 'o2', { result: { content: 'ok\n<exited with exit code 0>' } }),
      toolStart(-28, 'o3', 'view', { path: 'src/a.js' }),
      toolDone(-28, 'o3', { success: false, error: { code: 'ENOENT', message: 'Path does not exist' } }),
      ev('session.truncation', -27, { messagesRemovedDuringTruncation: 4 }),
      ev('assistant.message', -26, { messageId: 'o4', content: 'Build passes.', interactionId: 'o1', toolRequests: [] }),
      // A message steered in mid-turn: the reply still carries the first prompt's interactionId.
      ev('user.message', -26, { content: 'Also run the linter', interactionId: 'o5' }),
      ev('assistant.message', -26, { messageId: 'o6', content: 'Linter is clean.', interactionId: 'o1', toolRequests: [] }),
      ev('session.model_change', -26, { newModel: 'auto' }),
      ev('session.shutdown', -25, { shutdownType: 'routine', currentModel: 'claude-sonnet-4.5' }),
    ],
  });
  await writeTodoDb(join(home, state, ID, 'session.db'));
  return { home, xdg, projectDir };
}

test('finds real sessions in both roots, skips stubs, empty, nested-repo and parent-dir sessions', async () => {
  const { home, xdg, projectDir } = await fixture();
  const project = resolveProject(projectDir);
  const found = await copilot.findSessions(project, fixtureContext(home, { XDG_STATE_HOME: xdg }));
  assert.deepEqual(found.map((c) => [c.id, c.score]), [[ID, 3], [OLD, 1]]);
  assert.equal(found[0].title, 'Parser fixes\nfor unicode');
  assert.equal(found[0].lastActivity, Date.UTC(2026, 9, 25, 9, 12), 'activity = last real message, not the error');
  assert.equal(found[1].preview, 'Run the build', 'no workspace.yaml title: preview from the first prompt');
  assert.equal(found.some((c) => c.current), false);

  const self = await copilot.findSessions(project, fixtureContext(home, { COPILOT_AGENT_SESSION_ID: ID }));
  assert.deepEqual(self.map((c) => c.current), [true]);

  // Older builds only set COPILOT_CLI=1; the running session is the one whose lock owner is alive.
  writeTree(join(home, '.copilot/session-state', ID), { [`inuse.${process.pid}.lock`]: '' });
  writeTree(join(xdg, '.copilot/session-state', OLD), { 'inuse.999999999.lock': '' });
  const locked = await copilot.findSessions(project, fixtureContext(home, { COPILOT_CLI: '1', XDG_STATE_HOME: xdg }));
  assert.deepEqual(locked.map((c) => c.current), [true, false]);
});

test('loads clean prompts, merged replies, tools, plan, compaction and the quota stop', async () => {
  const { home, projectDir } = await fixture();
  const ctx = fixtureContext(home);
  const [candidate] = await copilot.findSessions(resolveProject(projectDir), ctx);
  const { meta, events } = await copilot.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), ["Fix the parser. Don't change the API.", 'Now also handle unicode identifiers', 'and update the README']);
  assert.equal(s.latest.started, false);
  assert.equal(s.turns[0].replies.length, 1);
  assert.deepEqual([s.turns[0].replies[0].text, s.turns[0].replies[0].final], ['Parser fixed; tests still fail.', true]);
  assert.deepEqual([s.turns[1].replies[0].final, s.turns[1].interrupted], [false, true]);
  assert.equal(s.stop.reason, 'quota');
  assert.equal(s.stop.resetsAt, new Date(2026, 4, 11, 12, 0).getTime());
  assert.match(s.compaction.summary, /^<overview>Fixing the parser/);
  assert.deepEqual(s.files.map((f) => f.path), [`${projectDir}/sub/a.txt`, 'src/lexer.js', `${projectDir}/parser.js`]);
  assert.deepEqual([s.failures[0].target, s.failures[0].exit, s.failures[0].error], ['npm test', 1, 'FAIL parser.spec.js']);
  assert.deepEqual(events.filter((e) => e.kind === 'plan').map((p) => p.items.map((i) => i.status)), [['done', 'pending'], ['done', 'active', 'blocked']]);
  assert.deepEqual(events.filter((e) => e.kind === 'tool').map((e) => e.action), ['edit', 'edit', 'command', 'other', 'edit', 'search']);
  assert.deepEqual(
    [meta.branch, meta.commit, meta.model, meta.cwd, meta.resumeCommand],
    ['feature/x', 'abc1234def5678', 'gpt-5.4', projectDir, `copilot --resume=${ID}`],
  );
  const text = JSON.stringify(events);
  for (const noise of ['subagent noise', 'secret thinking', 'system_notification', 'Continue working', 'AGENTS.md', 'current_datetime', '<reminder>', 'Resource link']) {
    assert.ok(!text.includes(noise), noise);
  }
});

test('older CLI: truncation, command exit codes and failed tools', async () => {
  const { home, xdg, projectDir } = await fixture();
  const ctx = fixtureContext(home, { XDG_STATE_HOME: xdg });
  const old = (await copilot.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === OLD);
  const { meta, events } = await copilot.loadSession(old, ctx);
  const s = assemble(meta, events);
  assert.deepEqual([s.compaction.trigger, s.compaction.summary], ['truncation', undefined]);
  assert.deepEqual([s.commands[0].target, s.commands[0].exit, s.commands[0].ok], ['npm run build', 0, true]);
  assert.deepEqual([s.failures[0].action, s.failures[0].error], ['read', 'Path does not exist']);
  assert.deepEqual(s.turns.map((turn) => turn.replies.map((r) => r.text)), [['Build passes.'], ['Linter is clean.']]);
  assert.equal(s.latest.answered, true);
  assert.equal(meta.model, 'claude-sonnet-4.5', "a later switch to 'auto' keeps the concrete model");
});

test('background shells, cut-off resource links in titles, detached runs and plan.md', async () => {
  const home = tempDir('copass-home-');
  const projectDir = tempDir('copass-proj-');
  const BG = '33333333-2222-4333-8444-555555555555';
  const DETACHED = '44444444-2222-4333-8444-555555555555';
  const running = (id) => `partial output\n<command with shellId: ${id} is still running after 30 seconds. Use read_bash to continue waiting, or stop_bash to stop it.>`;
  const dir = `.copilot/session-state/${BG}`;
  writeTree(home, {
    [`${dir}/events.jsonl`]: [
      start(BG, projectDir, 0),
      ev('user.message', 1, { content: 'Build and test it', interactionId: 'b1' }),
      toolStart(2, 'b2', 'bash', { command: 'make build' }),
      toolDone(2, 'b2', { result: { content: running('7') } }),
      toolStart(3, 'b3', 'read_bash', { shellId: '7', delay: 10 }),
      toolDone(3, 'b3', { result: { content: 'cc: error: missing header\n<command with id: 7 exited with exit code 2>' } }),
      ev('system.notification', 3, { content: 'Shell 7 completed', kind: { type: 'shell_completed', shellId: '7', exitCode: 2 } }),
      toolStart(4, 'b4', 'bash', { command: 'make test' }),
      toolDone(4, 'b4', { result: { content: running('8') } }),
      ev('system.notification', 5, { content: 'Shell 8 completed', kind: { type: 'shell_completed', shellId: '8', exitCode: 127 } }),
      toolStart(6, 'b5', 'bash', { command: 'make serve' }),
      toolDone(6, 'b5', { result: { content: '<command started in background with shellId: 9>' } }),
      toolStart(6, 'b6', 'stop_bash', { shellId: '9' }),
      toolDone(6, 'b6', { result: { content: '<command with id: 9 stopped>' } }),
      ev('assistant.message', 7, { messageId: 'b7', content: 'Build fails.', interactionId: 'b1', toolRequests: [] }),
    ],
    [`${dir}/workspace.yaml`]: `id: ${BG}\nsummary: |-\n  Build and test it\n  [Resource link: file:///Users/someone/proj/Make...\n`,
    [`${dir}/plan.md`]: '# Plan\n\n- [x] build\n- [ ] test\n',
    [`.copilot/session-state/${DETACHED}/events.jsonl`]: [
      start(DETACHED, projectDir, 10, { detachedFromSpawningParentSessionId: BG }),
      ev('user.message', 10, { content: 'wrap up' }),
    ],
  });
  const ctx = fixtureContext(home);
  const found = await copilot.findSessions(resolveProject(projectDir), ctx);
  assert.deepEqual(found.map((c) => [c.id, c.background]), [[DETACHED, true], [BG, undefined]]);
  const bg = found.find((c) => c.id === BG);
  assert.equal(bg.title, 'Build and test it', 'the link cut by the 100-char title limit is still removed');

  const { meta, events } = await copilot.loadSession(bg, ctx);
  const s = assemble(meta, events);
  assert.deepEqual(
    s.commands.map((c) => [c.target, c.ok, c.exit, c.error]),
    [
      ['make build', false, 2, 'cc: error: missing header'],
      ['make test', false, 127, undefined],
      ['make serve', undefined, undefined, undefined],
    ],
  );
  assert.deepEqual(events.filter((e) => e.kind === 'tool').map((e) => e.tool), ['bash', 'bash', 'bash'], 'shell helpers are not separate work');
  assert.deepEqual(s.plan.items, [{ text: 'build', status: 'done' }, { text: 'test', status: 'pending' }]);
});

test('launches interactively with the first prompt', () => {
  assert.deepEqual(copilot.launch('continue the work'), ['copilot', ['-i', 'continue the work']]);
});
