import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';

import * as kimi from '../agents/kimi.js';
import { assemble } from '../lib/assemble.js';
import { resolveProject } from '../lib/project.js';
import { fixtureContext, tempDir, writeTree } from './helpers.js';

const md5 = (s) => createHash('md5').update(s).digest('hex');
const T0 = Date.UTC(2026, 9, 25, 9);
const ms = (m) => T0 + m * 60_000; // wire.jsonl (current) stamps epoch milliseconds
const sec = (m) => ms(m) / 1000; // the legacy wire stamps epoch seconds

const MAIN = 'session_11111111-2222-4333-8444-555555555555';
const SUB = 'session_22222222-2222-4333-8444-555555555555';
const STUB = 'session_33333333-2222-4333-8444-555555555555';
const CHILD = 'session_44444444-2222-4333-8444-555555555555';
const ARCHIVED = 'session_55555555-2222-4333-8444-555555555555';
const OTHER = 'session_66666666-2222-4333-8444-555555555555';
const UNDO = 'session_77777777-2222-4333-8444-555555555555';
const MIGRATED = 'aaaaaaaa-2222-4333-8444-555555555555';

// ── Kimi Code CLI (current): wire protocol 1.5 records, shapes from upstream tests ──

const rec = (type, payload, m) => ({ type, agentId: 'main', ...payload, time: ms(m) });
const loop = (event, m) => rec('context.append_loop_event', { event }, m);
const text = (t) => ({ type: 'text', text: t });
const state = (extra) => ({ id: 'x', version: 2, title: 'Fix parser', titleKind: 'replaceable', createdAt: ms(0), updatedAt: ms(30), archived: false, ...extra });
const header = { type: 'metadata', protocol_version: '1.5', created_at: ms(0) };
const bind = (cwd) => rec('profile.bind', { modelAlias: 'kimi-k2', thinkingEffort: 'off', systemPrompt: 'You are Kimi.', environmentDisclosure: { cwd }, disallowedTools: [] }, 0);

const quota = {
  code: 'turn.failed',
  name: 'Error',
  message: 'step failed',
  retryable: false,
  cause: { code: 'provider.api_error', name: 'APIProviderQuotaExhaustedError', message: 'You exceeded your current quota', retryable: false, details: { statusCode: 429 } },
};

function mainWire(cwd) {
  return [
    header,
    bind(cwd),
    rec('permission.set_mode', { mode: 'manual' }, 0),
    // turn 0: an IDE client wraps the request; the typed words travel as display_text
    rec('context.append_message', { message: { role: 'user', content: [text('<ide_opened_file>parser.js</ide_opened_file>\nFix the parser. Do not change the API.')], toolCalls: [], origin: { kind: 'user' } } }, 1),
    rec('turn.prompt', { input: [text('<ide_opened_file>parser.js</ide_opened_file>\nFix the parser. Do not change the API.')], origin: { kind: 'user', clientMetadata: [{ display_text: 'Fix the parser. Do not change the API.' }] }, promptId: 'p0', turnId: 0 }, 1),
    rec('context.append_message', { message: { role: 'user', content: [text('<system-reminder>Today is Sunday</system-reminder>')], toolCalls: [], origin: { kind: 'injection', variant: 'date' } } }, 1),
    loop({ type: 'step.begin', uuid: 's0', turnId: '0', step: 1 }, 2),
    loop({ type: 'content.part', uuid: 'c0', turnId: '0', step: 1, stepUuid: 's0', part: { type: 'think', think: 'private reasoning', encrypted: null } }, 2),
    loop({ type: 'content.part', uuid: 'c1', turnId: '0', step: 1, stepUuid: 's0', part: text('Looking at the parser.') }, 2),
    loop({ type: 'tool.call', uuid: 't0', turnId: '0', step: 1, stepUuid: 's0', toolCallId: 'call_read', name: 'Read', args: { path: 'src/parser.js' } }, 2),
    loop({ type: 'tool.result', parentUuid: 't0', toolCallId: 'call_read', result: { output: 'file body' } }, 2),
    loop({ type: 'tool.call', uuid: 't1', turnId: '0', step: 1, stepUuid: 's0', toolCallId: 'call_edit', name: 'Edit', args: { path: 'src/parser.js', old_string: 'a', new_string: 'b' } }, 3),
    loop({ type: 'tool.result', parentUuid: 't1', toolCallId: 'call_edit', result: { output: 'edited' } }, 3),
    loop({ type: 'tool.call', uuid: 't2', turnId: '0', step: 1, stepUuid: 's0', toolCallId: 'call_test', name: 'Bash', args: { command: 'npm test', timeout: 60 } }, 3),
    loop({ type: 'tool.result', parentUuid: 't2', toolCallId: 'call_test', result: { isError: true, output: '<system>ERROR: Command failed with exit code: 1.</system>\n1 test failed: parser.spec.js' } }, 3),
    loop({ type: 'tool.call', uuid: 't3', turnId: '0', step: 1, stepUuid: 's0', toolCallId: 'call_todo', name: 'TodoList', args: { todos: [] } }, 3),
    rec('tools.update_store', { key: 'todo', value: [{ title: 'fix tokenizer', status: 'done' }, { title: 'fix tests', status: 'in_progress' }, { title: 'update docs', status: 'pending' }] }, 3),
    loop({ type: 'step.end', uuid: 's0', turnId: '0', step: 1, finishReason: 'tool_use', usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 } }, 3),
    loop({ type: 'step.begin', uuid: 's1', turnId: '0', step: 2 }, 4),
    loop({ type: 'content.part', uuid: 'c2', turnId: '0', step: 2, stepUuid: 's1', part: text('One test still fails.') }, 4),
    loop({ type: 'content.part', uuid: 'c3', turnId: '0', step: 2, stepUuid: 's1', part: text('I will look at it next.') }, 4),
    loop({ type: 'step.end', uuid: 's1', turnId: '0', step: 2, finishReason: 'end_turn' }, 4),
    rec('llm.request', { kind: 'loop', provider: 'kimi', model: 'kimi-k2-0905', toolSelect: false, systemPromptHash: 'h', toolsHash: 'h', messageCount: 3 }, 4),
    rec('turn.ended', { turnId: 0, reason: 'completed' }, 4),
    // compaction, then a turn that dies on quota while the user keeps typing
    rec('full_compaction.begin', { source: 'auto' }, 5),
    rec('context.apply_compaction', { summary: 'Summary: fixing the parser', compactedCount: 6, tokensBefore: 900, tokensAfter: 90, keptUserMessageCount: 1 }, 5),
    rec('turn.prompt', { input: [text('Now also handle unicode identifiers'), { type: 'text', text: '<hook-output>lint ok</hook-output>', meta: { source: 'user prompt submit hook', contentType: 'text/xml' } }], origin: { kind: 'user' }, promptId: 'p1', turnId: 1 }, 6),
    rec('turn.prompt', { input: [text('cron says hello')], origin: { kind: 'cron_job', jobId: 'j', cron: '* * * * *', recurring: true, coalescedCount: 1, stale: false }, promptId: 'pc', turnId: 2 }, 6),
    loop({ type: 'step.begin', uuid: 's2', turnId: '1', step: 1 }, 7),
    loop({ type: 'content.part', uuid: 'c4', turnId: '1', step: 1, stepUuid: 's2', part: text('Working on it') }, 7),
    rec('turn.steer', { input: [text('and keep the tests green')], origin: { kind: 'user', inTurn: true }, promptIds: ['p2'], turnId: 1 }, 8),
    rec('turn.ended', { turnId: 1, reason: 'failed', error: quota }, 9),
    rec('usage.record', { model: 'kimi-k2-0905', usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } }, 9),
  ];
}

function undoWire(cwd) {
  const prompt = (t, id, m) => rec('turn.prompt', { input: [text(t)], origin: { kind: 'user' }, promptId: id }, m);
  return [
    header,
    bind(cwd),
    prompt('first request', 'p0', 1),
    loop({ type: 'step.begin', uuid: 's0', step: 1 }, 2),
    loop({ type: 'content.part', uuid: 'c0', stepUuid: 's0', part: text('first answer') }, 2),
    loop({ type: 'step.end', uuid: 's0', step: 1, finishReason: 'end_turn' }, 2),
    rec('turn.ended', { turnId: 0, reason: 'completed' }, 2),
    prompt('second request', 'p1', 3),
    loop({ type: 'step.begin', uuid: 's1', step: 1 }, 4),
    loop({ type: 'content.part', uuid: 'c1', stepUuid: 's1', part: text('second answer, cut off') }, 4),
    loop({ type: 'step.end', uuid: 's1', step: 1, finishReason: 'interrupted' }, 4),
    rec('turn.ended', { turnId: 1, reason: 'cancelled' }, 4),
    prompt('third request', 'p2', 5),
    rec('context.undo', { count: 1 }, 6),
  ];
}

function codeFixture() {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'My App.v2');
  const subDir = join(projectDir, 'packages', 'api');
  writeTree(projectDir, { 'README.md': 'x' });
  writeTree(subDir, { 'index.js': 'x' });
  const other = tempDir('copass-other-');

  const dirOf = (cwd, id) => join(home, '.kimi-code', 'sessions', kimi.workDirKey(cwd), id);
  const index = (cwd, id) => ({ sessionId: id, sessionDir: dirOf(cwd, id), workDir: cwd });
  const at = (cwd, id, files) => Object.fromEntries(Object.entries(files).map(([f, c]) => [join('.kimi-code', 'sessions', kimi.workDirKey(cwd), id, f), c]));
  const wireAt = 'agents/main/wire.jsonl';

  writeTree(home, {
    '.kimi-code/session_index.jsonl': [
      index(projectDir, MAIN),
      index(subDir, SUB),
      index(projectDir, STUB),
      index(projectDir, CHILD),
      index(projectDir, ARCHIVED),
      index(other, OTHER),
      { sessionId: 'session_gone', deleted: true },
    ],
    ...at(projectDir, MAIN, { 'state.json': state({ cwd: projectDir }), [wireAt]: mainWire(projectDir) }),
    ...at(subDir, SUB, { 'state.json': state({ cwd: subDir, title: 'API work' }), [wireAt]: undoWire(subDir).slice(0, 4) }),
    ...at(projectDir, STUB, { 'state.json': state({ cwd: projectDir }), [wireAt]: [header, bind(projectDir)] }),
    ...at(projectDir, CHILD, { 'state.json': state({ cwd: projectDir, custom: { parent_session_id: MAIN, child_session_kind: 'child' } }), [wireAt]: undoWire(projectDir) }),
    ...at(projectDir, ARCHIVED, { 'state.json': state({ cwd: projectDir, archived: true }), [wireAt]: undoWire(projectDir) }),
    ...at(other, OTHER, { 'state.json': state({ cwd: other }), [wireAt]: undoWire(other) }),
    // Not in the index: still found through the project's own bucket, like Kimi's session picker does.
    ...at(projectDir, UNDO, { 'state.json': state({ cwd: projectDir, title: undefined }), [wireAt]: undoWire(projectDir) }),
    // A subagent transcript next to the main one is never read.
    ...at(projectDir, MAIN, { 'agents/agent-0/wire.jsonl': [header, rec('turn.prompt', { input: [text('subagent noise')], origin: { kind: 'system_trigger', name: 'subagent' } }, 2)] }),
  });
  return { home, projectDir, subDir };
}

test('workDirKey matches upstream: slug of the last segment plus sha256 of the normalized path', () => {
  const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
  assert.equal(kimi.workDirKey('/Users/me/My App.v2/'), `wd_my-app.v2_${sha('/Users/me/My App.v2')}`);
  assert.equal(kimi.workDirKey('C:\\Work\\Proj'), `wd_proj_${sha('C:/Work/Proj')}`);
  assert.equal(kimi.workDirKey('/'), `wd_workspace_${sha('')}`);
  assert.equal(kimi.workDirKey(`/x/${'é'.repeat(5)}${'a'.repeat(60)}`).split('_')[1], 'a'.repeat(40));
});

test('finds current sessions through the index and the project bucket; skips stubs, children, archived and foreign ones', async () => {
  const { home, projectDir, subDir } = codeFixture();
  const project = resolveProject(projectDir);
  const found = await kimi.findSessions(project, fixtureContext(home));

  assert.deepEqual(found.map((c) => c.id), [MAIN, UNDO, SUB], 'newest first; subagent wire, stub, child, archived and foreign dirs are skipped');
  const main = found[0];
  assert.equal(main.title, 'Fix parser');
  assert.equal(main.score, 3);
  assert.equal(main.cwd, projectDir);
  assert.equal(main.preview, 'Fix the parser. Do not change the API.', 'preview is what the user typed, not the IDE wrapper');
  assert.equal(main.lastActivity, ms(8), 'activity = last prompt/assistant record; usage and turn.ended do not count');
  assert.equal(main.current, undefined);
  assert.equal(found.find((c) => c.id === SUB).score, 1);
  assert.equal(found.find((c) => c.id === SUB).cwd, subDir);
  assert.equal(found.find((c) => c.id === UNDO).title, undefined);
});

test('KIMI_CODE_HOME relocates the data root', async () => {
  const { home, projectDir } = codeFixture();
  const moved = tempDir('copass-moved-');
  const empty = await kimi.findSessions(resolveProject(projectDir), fixtureContext(moved));
  assert.deepEqual(empty, []);
  const found = await kimi.findSessions(resolveProject(projectDir), fixtureContext(moved, { KIMI_CODE_HOME: join(home, '.kimi-code') }));
  assert.equal(found.length, 3);
});

test('loads a current session: prompts, tools, plan, compaction, quota stop', async () => {
  const { home, projectDir } = codeFixture();
  const ctx = fixtureContext(home);
  const candidate = (await kimi.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === MAIN);
  const { meta, events } = await kimi.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(
    s.prompts.map((p) => p.text),
    ['Fix the parser. Do not change the API.', 'Now also handle unicode identifiers', 'and keep the tests green'],
    'IDE wrapper unwrapped, hook output, injections and cron prompts dropped, steered prompt kept',
  );
  assert.equal(s.latest.prompt.text, 'and keep the tests green');
  assert.equal(s.latest.answered, false);
  assert.equal(s.stop.reason, 'quota');
  assert.equal(s.stop.message, 'You exceeded your current quota');
  assert.equal(s.compaction.summary, 'Summary: fixing the parser');
  assert.equal(s.compaction.trigger, 'auto');

  const replies = events.filter((e) => e.kind === 'reply');
  assert.deepEqual(replies.map((r) => r.text), ['Looking at the parser.', 'One test still fails.\nI will look at it next.', 'Working on it']);
  assert.deepEqual(replies.map((r) => [r.final, r.partial]), [[false, false], [true, false], [false, true]], 'a step that never ended is partial');
  assert.ok(!events.some((e) => /private reasoning|subagent noise|cron says|Today is/.test(e.text ?? '')));

  assert.deepEqual(s.files.map((f) => f.path), [`${projectDir}/src/parser.js`], 'relative tool paths resolve against the session cwd');
  const bash = events.find((e) => e.tool === 'Bash');
  assert.deepEqual([bash.action, bash.target, bash.ok, bash.exit], ['command', 'npm test', false, 1]);
  assert.equal(bash.error, 'ERROR: Command failed with exit code: 1.\n1 test failed: parser.spec.js');
  assert.equal(events.find((e) => e.tool === 'Read').ok, true);
  assert.ok(!events.some((e) => e.tool === 'TodoList'), 'todo calls become plan events, not tool events');
  assert.deepEqual(s.plan.items.map((i) => [i.text, i.status]), [['fix tokenizer', 'done'], ['fix tests', 'active'], ['update docs', 'pending']]);

  assert.equal(meta.model, 'kimi-k2-0905');
  assert.equal(meta.cwd, projectDir);
  assert.equal(meta.startedAt, ms(0));
  assert.equal(meta.resumeCommand, `kimi --session ${MAIN}`);
  assert.equal(meta.logFile, join(home, '.kimi-code', 'sessions', kimi.workDirKey(projectDir), MAIN, 'agents', 'main', 'wire.jsonl'));
});

test('context.undo removes the undone prompt, and a cancelled turn is an interrupt', async () => {
  const { home, projectDir } = codeFixture();
  const ctx = fixtureContext(home);
  const candidate = (await kimi.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === UNDO);
  const { events } = await kimi.loadSession(candidate, ctx);

  assert.deepEqual(events.filter((e) => e.kind === 'prompt').map((e) => e.text), ['first request', 'second request']);
  assert.equal(events.at(-1).kind, 'interrupt');
  const cut = events.find((e) => e.text?.startsWith('second answer'));
  assert.deepEqual([cut.partial, cut.final], [true, false]);
});

test('context.apply_compaction accepts the older context-message summary and context.clear resets history', async () => {
  const home = tempDir('copass-home-');
  const projectDir = tempDir('copass-proj-');
  const wire = [
    header,
    rec('turn.prompt', { input: [text('before clear')], origin: { kind: 'user' } }, 1),
    rec('context.clear', {}, 2),
    rec('turn.prompt', { input: [text('after clear')], origin: { kind: 'user' } }, 3),
    rec('context.apply_compaction', { summary: { role: 'user', content: [text('older summary')], toolCalls: [] }, count: 2 }, 4),
    rec('turn.prompt', { input: [text('/review src')], origin: { kind: 'skill_activation', trigger: 'user-slash', skillName: 'review', skillArgs: 'src', activationId: 'a' } }, 5),
  ];
  const bucket = join('.kimi-code', 'sessions', kimi.workDirKey(projectDir), 'session_x');
  writeTree(home, { [join(bucket, 'agents/main/wire.jsonl')]: wire });
  const ctx = fixtureContext(home);
  const [candidate] = await kimi.findSessions(resolveProject(projectDir), ctx);
  const { events } = await kimi.loadSession(candidate, ctx);
  assert.deepEqual(events.map((e) => e.kind), ['prompt', 'compaction', 'prompt']);
  assert.deepEqual([events[0].text, events[1].summary, events[2].text], ['after clear', 'older summary', '/review src']);
});

// ── Python Kimi CLI (legacy): context.jsonl + wire.jsonl, shapes from upstream fixtures ──

const LEG = '19e4fe92-fc86-4d17-b60c-94337670efd6';
const LEG_BG = 'bbbbbbbb-2222-4333-8444-555555555555';
const LEG_STUB = 'cccccccc-2222-4333-8444-555555555555';
const LEG_CTX = 'dddddddd-2222-4333-8444-555555555555';
const COMPACTED_MARK = '<system>Previous context has been compacted. Here is the compaction output:</system>';
const REMINDER = '<system-reminder>\nYou are running in non-interactive mode. The user cannot answer questions or provide feedback during execution.\n</system-reminder>';

const w = (m, type, payload) => ({ timestamp: sec(m), message: { type, payload } });
const legacyState = (extra) => ({ version: 1, approval: { yolo: false, auto_approve_actions: [] }, additional_dirs: [], custom_title: null, title_generated: false, plan_mode: false, archived: false, todos: [], ...extra });
const sysPrompt = { role: '_system_prompt', content: 'You are an AI agent. (elided)' };

function legacyWire() {
  return [
    { type: 'metadata', protocol_version: '1.9' },
    w(1, 'TurnBegin', { user_input: [text('Run the failing tests')] }),
    w(1, 'StepBegin', { n: 1 }),
    w(1, 'ContentPart', { type: 'think', think: 'private reasoning', encrypted: null }),
    w(1, 'ContentPart', text('Running them.')),
    w(2, 'ToolCall', { type: 'function', id: 'tc1', function: { name: 'Shell', arguments: '{"command": "npm test"}' }, extras: null }),
    w(2, 'StatusUpdate', { context_usage: 0.1, context_tokens: 10, max_context_tokens: 100, token_usage: null, message_id: 'm1', plan_mode: false, mcp_status: null }),
    w(2, 'ToolResult', { tool_call_id: 'tc1', return_value: { is_error: true, output: 'FAIL parser.spec.js', message: 'Command failed with exit code: 1.', display: [], extras: null } }),
    w(2, 'ToolCall', { type: 'function', id: 'tc2', function: { name: 'SetTodoList', arguments: '{"todos": [{"title": "fix tests", "status": "in_progress"}, {"title": "ship", "status": "pending"}]}' }, extras: null }),
    w(2, 'ToolResult', { tool_call_id: 'tc2', return_value: { is_error: false, output: 'Todo list updated', message: 'Todo list updated', display: [], extras: null } }),
    w(2, 'ToolCall', { type: 'function', id: 'tc3', function: { name: 'WriteFile', arguments: '{"path": "src/a.js", "content": "x"}' }, extras: null }),
    w(2, 'ToolResult', { tool_call_id: 'tc3', return_value: { is_error: false, output: '', message: 'File written', display: [], extras: null } }),
    w(3, 'SubagentEvent', { parent_tool_call_id: 'tc3', agent_id: 'a1', subagent_type: 'coder', event: { type: 'ContentPart', payload: text('subagent noise') } }),
    w(3, 'StepBegin', { n: 2 }),
    w(3, 'ContentPart', text('One test fails.')),
    w(3, 'ContentPart', text('Next I fix it.')),
    w(3, 'TurnEnd', {}),
    w(4, 'CompactionBegin', {}),
    w(4, 'CompactionEnd', {}),
    w(5, 'TurnBegin', { user_input: 'also fix lint' }),
    w(5, 'StepBegin', { n: 1 }),
    w(6, 'ToolCall', { type: 'function', id: 'tc4', function: { name: 'Shell', arguments: '{"command": "npm ' }, extras: null }),
    w(6, 'ToolCallPart', { arguments_part: 'run lint"}' }),
    w(6, 'StepInterrupted', {}),
  ];
}

// What `kimi migrate` writes (migration-legacy wire-writer): protocol 1.0, one turn.prompt per Python
// user message, every message as context.append_message with nested function calls, no loop events.
function migratedWire() {
  const at = (m) => ({ time: ms(m) });
  const user = (t) => ({ type: 'context.append_message', message: { role: 'user', content: [text(t)], toolCalls: [] } });
  return [
    { type: 'metadata', protocol_version: '1.0', created_at: ms(20) },
    { type: 'turn.prompt', agentId: 'main', input: [text('migrate me')], origin: { kind: 'user' }, ...at(20) },
    user('migrate me'),
    { type: 'turn.prompt', agentId: 'main', input: [text(REMINDER)], origin: { kind: 'user' }, ...at(20) },
    user(REMINDER),
    { type: 'context.append_message', message: { role: 'assistant', content: [{ type: 'think', think: 'private', encrypted: null }, text('Running it.')], toolCalls: [{ type: 'function', id: 'tc1', function: { name: 'Shell', arguments: '{"command": "npm test"}' } }] } },
    { type: 'context.append_message', message: { role: 'tool', content: [text('<system>ERROR: Command failed with exit code: 3.</system>'), text('boom')], toolCalls: [], toolCallId: 'tc1' } },
    { type: 'context.append_message', message: { role: 'assistant', content: [text('It failed with code 3.')], toolCalls: [] } },
    { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed', ...at(20) },
    { type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: COMPACTED_MARK }, text('Summary: ran the tests')], origin: { kind: 'user' }, ...at(20) },
    { type: 'turn.prompt', agentId: 'main', input: [text('now fix it')], origin: { kind: 'user' }, ...at(20) },
    { type: 'tools.update_store', agentId: 'main', key: 'todo', value: [{ title: 'fix it', status: 'pending' }], ...at(20) },
  ];
}

function legacyFixture() {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'PMS-Backend');
  writeTree(projectDir, { 'README.md': 'x' });
  const bucket = `.kimi/sessions/${md5(projectDir)}`;
  const migratedBucket = join('.kimi-code', 'sessions', kimi.workDirKey(projectDir), `ses_${MIGRATED}`);
  writeTree(home, {
    '.kimi/kimi.json': { work_dirs: [{ path: projectDir, kaos: 'local', last_session_id: LEG }, { path: '/elsewhere', kaos: 'local', last_session_id: null }] },
    [`${bucket}/${LEG}/state.json`]: legacyState({ custom_title: 'Run the failing tests' }),
    [`${bucket}/${LEG}/wire.jsonl`]: legacyWire(),
    [`${bucket}/${LEG}/context.jsonl`]: [
      sysPrompt,
      { role: '_checkpoint', id: 0 },
      { role: 'user', content: [{ type: 'text', text: COMPACTED_MARK }, text('Summary: tests were failing on the parser.')] },
      { role: '_usage', token_count: 40 },
      { role: 'user', content: 'also fix lint' },
    ],
    // print mode: the harness tells the model no user is present
    [`${bucket}/${LEG_BG}/wire.jsonl`]: [{ type: 'metadata', protocol_version: '1.9' }, w(10, 'TurnBegin', { user_input: 'summarize the repo' }), w(10, 'ContentPart', text('Done.')), w(10, 'TurnEnd', {})],
    [`${bucket}/${LEG_BG}/context.jsonl`]: [sysPrompt, { role: '_checkpoint', id: 0 }, { role: 'user', content: 'summarize the repo' }, { role: 'user', content: [text(REMINDER)] }],
    // the real-world stub: a system prompt and nothing else
    [`${bucket}/${LEG_STUB}/context.jsonl`]: [sysPrompt],
    // no wire journal: the model history is all there is
    [`${bucket}/${LEG_CTX}/context.jsonl`]: [
      sysPrompt,
      { role: '_checkpoint', id: 0 },
      { role: 'user', content: 'list the files' },
      { role: 'user', content: [text('<system>CHECKPOINT 0</system>')] },
      { role: '_usage', token_count: 10 },
      { role: 'assistant', content: [{ type: 'think', think: 'private', encrypted: null }, text('Listing.')], tool_calls: [{ type: 'function', id: 'tc1', function: { name: 'Shell', arguments: '{"command": "ls"}' } }] },
      { role: 'tool', content: [text('<system>ERROR: Command failed with exit code: 2.</system>'), text('ls: nope')], tool_call_id: 'tc1' },
      { role: 'assistant', content: [text('It failed.')], tool_calls: [{ type: 'function', id: 'tc2', function: { name: 'SetTodoList', arguments: '{"todos": [{"title": "retry", "status": "pending"}]}' } }] },
      { role: 'tool', content: [text('<system>Todo list updated</system>')], tool_call_id: 'tc2' },
    ],
    // `kimi migrate` copied this legacy session into the current store as ses_<uuid>
    [`${bucket}/${MIGRATED}/context.jsonl`]: [sysPrompt, { role: 'user', content: 'old copy' }],
    [join(migratedBucket, 'agents/main/wire.jsonl')]: migratedWire(),
    [join(migratedBucket, 'state.json')]: state({ cwd: projectDir, custom: { imported_from_kimi_cli: true, kimi_cli_session_id: MIGRATED } }),
  });
  return { home, projectDir };
}

test('finds legacy sessions by md5 bucket: stubs skipped, print runs flagged, migrated copies deduplicated', async () => {
  const { home, projectDir } = legacyFixture();
  const found = await kimi.findSessions(resolveProject(projectDir), fixtureContext(home));
  const byId = Object.fromEntries(found.map((c) => [c.id, c]));

  assert.deepEqual(Object.keys(byId).sort(), [LEG, LEG_BG, LEG_CTX, `ses_${MIGRATED}`].sort());
  assert.equal(byId[LEG_STUB], undefined, 'a session with only _system_prompt is a stub');
  assert.equal(byId[MIGRATED], undefined, 'the legacy copy of a migrated session is dropped');

  assert.equal(byId[LEG].lastActivity, sec(6) * 1000, 'last user/assistant record of the wire, in ms');
  assert.equal(byId[LEG].title, 'Run the failing tests');
  assert.equal(byId[LEG].preview, 'Run the failing tests');
  assert.equal(byId[LEG].cwd, projectDir);
  assert.equal(byId[LEG].score, 3);
  assert.equal(byId[LEG].background, false);
  assert.equal(byId[LEG_BG].background, true);
  assert.equal(byId[LEG_BG].preview, 'summarize the repo');
  assert.equal(byId[LEG_CTX].preview, 'list the files');
  assert.ok(byId[LEG_CTX].lastActivity > 0);
});

test('loads a legacy session from its wire journal', async () => {
  const { home, projectDir } = legacyFixture();
  const ctx = fixtureContext(home);
  const candidate = (await kimi.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === LEG);
  const { meta, events } = await kimi.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), ['Run the failing tests', 'also fix lint']);
  assert.deepEqual(events.filter((e) => e.kind === 'reply').map((r) => [r.text, r.final ?? false]), [['Running them.', false], ['One test fails.\nNext I fix it.', true]]);
  assert.ok(!events.some((e) => /private reasoning|subagent noise/.test(e.text ?? '')));

  const shell = events.find((e) => e.tool === 'Shell');
  assert.deepEqual([shell.action, shell.target, shell.ok, shell.exit], ['command', 'npm test', false, 1]);
  assert.equal(shell.error, 'Command failed with exit code: 1.\nFAIL parser.spec.js');
  assert.equal(events.filter((e) => e.target === 'npm run lint').length, 1, 'streamed ToolCallPart arguments complete the call');
  assert.ok(!events.some((e) => e.tool === 'SetTodoList'));
  assert.deepEqual(s.plan.items.map((i) => [i.text, i.status]), [['fix tests', 'active'], ['ship', 'pending']]);
  assert.deepEqual(s.files.map((f) => f.path), [`${projectDir}/src/a.js`]);

  assert.equal(s.compaction.summary, 'Summary: tests were failing on the parser.', 'the journal marks the compaction, context.jsonl holds the text');
  assert.equal(s.latest.interrupted, true);
  assert.equal(s.latest.prompt.text, 'also fix lint');
  assert.equal(events.find((e) => e.kind === 'prompt').ts, sec(1) * 1000);
  assert.equal(meta.startedAt, sec(1) * 1000);
  assert.equal(meta.resumeCommand, `kimi --session ${LEG}`);
  assert.match(meta.logFile, /wire\.jsonl$/);
});

test('loads a legacy session that has only context.jsonl, skipping bookkeeping and harness messages', async () => {
  const { home, projectDir } = legacyFixture();
  const ctx = fixtureContext(home);
  const candidate = (await kimi.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === LEG_CTX);
  const { meta, events } = await kimi.loadSession(candidate, ctx);

  assert.deepEqual(events.filter((e) => e.kind === 'prompt').map((e) => e.text), ['list the files']);
  assert.deepEqual(events.filter((e) => e.kind === 'reply').map((e) => e.text), ['Listing.', 'It failed.']);
  const ls = events.find((e) => e.tool === 'Shell');
  assert.deepEqual([ls.target, ls.ok, ls.exit], ['ls', false, 2]);
  assert.match(ls.error, /ls: nope/);
  assert.deepEqual(events.find((e) => e.kind === 'plan').items, [{ text: 'retry', status: 'pending' }]);
  assert.match(meta.logFile, /context\.jsonl$/);
});

test('the compaction marker in context.jsonl is matched structurally, not inside prompt text', async () => {
  const home = tempDir('copass-home-');
  const projectDir = tempDir('copass-proj-');
  writeTree(home, {
    [`.kimi/sessions/${md5(projectDir)}/${LEG}/context.jsonl`]: [
      sysPrompt,
      { role: 'user', content: [{ type: 'text', text: COMPACTED_MARK }, text('Summary: kept goals')] },
      { role: 'user', content: 'why does the log say "Previous context has been compacted"?' },
    ],
  });
  const ctx = fixtureContext(home);
  const [candidate] = await kimi.findSessions(resolveProject(projectDir), ctx);
  const { events } = await kimi.loadSession(candidate, ctx);
  assert.deepEqual(events.map((e) => e.kind), ['compaction', 'prompt']);
  assert.equal(events[0].summary, 'Summary: kept goals');
});

test('loads a session that `kimi migrate` copied from Python Kimi', async () => {
  const { home, projectDir } = legacyFixture();
  const ctx = fixtureContext(home);
  const candidate = (await kimi.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === `ses_${MIGRATED}`);
  assert.equal(candidate.preview, 'migrate me');
  const { meta, events } = await kimi.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), ['migrate me', 'now fix it'], 'reminder turns and the compaction message are not prompts');
  assert.equal(s.compaction.summary, 'Summary: ran the tests');
  assert.deepEqual(events.filter((e) => e.kind === 'reply').map((e) => [e.text, e.final ?? false]), [['Running it.', false], ['It failed with code 3.', true]]);
  const shell = events.find((e) => e.tool === 'Shell');
  assert.deepEqual([shell.target, shell.ok, shell.exit], ['npm test', false, 3]);
  assert.match(shell.error, /boom/);
  assert.deepEqual(s.plan.items, [{ text: 'fix it', status: 'pending' }]);
});

test('a journal older than turn.prompt yields prompts from its bare user messages', async () => {
  const home = tempDir('copass-home-');
  const projectDir = tempDir('copass-proj-');
  const user = (t, origin) => ({ type: 'context.append_message', message: { role: 'user', content: [text(t)], toolCalls: [], ...(origin ? { origin } : {}) }, time: ms(1) });
  writeTree(home, {
    [join('.kimi-code', 'sessions', kimi.workDirKey(projectDir), 'session_old', 'agents/main/wire.jsonl')]: [
      { type: 'metadata', protocol_version: '1.0', created_at: ms(0) },
      user('only user message'),
      user('<system-reminder>date</system-reminder>', { kind: 'injection', variant: 'date' }),
      user('steered in', { kind: 'user', inTurn: true }),
    ],
  });
  const ctx = fixtureContext(home);
  const [candidate] = await kimi.findSessions(resolveProject(projectDir), ctx);
  assert.equal(candidate.preview, 'only user message');
  const { events } = await kimi.loadSession(candidate, ctx);
  assert.deepEqual(events.map((e) => e.text), ['only user message', 'steered in'], 'injections are not prompts, a steered message is');
});

test('KIMI_SHARE_DIR relocates the legacy store', async () => {
  const { home, projectDir } = legacyFixture();
  const moved = tempDir('copass-moved-');
  const found = await kimi.findSessions(resolveProject(projectDir), fixtureContext(moved, { KIMI_SHARE_DIR: join(home, '.kimi') }));
  assert.ok(found.some((c) => c.id === LEG));
});

test('neither Kimi generation can start interactively with a first prompt', () => {
  assert.equal(kimi.launch('hello'), null);
});
