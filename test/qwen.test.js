import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import * as qwen from '../agents/qwen.js';
import { assemble } from '../lib/assemble.js';
import { resolveProject } from '../lib/project.js';
import { fixtureContext, tempDir, writeTree } from './helpers.js';

const ID = '3b1f9a52-7c4e-4d1a-9f6e-0a1b2c3d4e5f';
const STUB = '4c2f9a52-7c4e-4d1a-9f6e-0a1b2c3d4e5f';
const AGENT = '5d3f9a52-7c4e-4d1a-9f6e-0a1b2c3d4e5f';
const CRON = '6e4f9a52-7c4e-4d1a-9f6e-0a1b2c3d4e5f';
const OTHER = '7f5f9a52-7c4e-4d1a-9f6e-0a1b2c3d4e5f';
const ARCHIVED = '8a6f9a52-7c4e-4d1a-9f6e-0a1b2c3d4e5f';
const FRAGMENT = 'aaaaaaaa-0000-4000-8000-00000000f001';

const PROVENANCE = { user: 'real_user', assistant: 'assistant_output', tool_result: 'tool_result', system: 'system' };
const at = (s) => Date.UTC(2026, 9, 25, 9, 0, s);

/** A session file builder: records chain through parentUuid like chatRecordingService writes them. */
function session(sessionId, cwd) {
  let n = 0;
  let tail = null;
  const records = [];
  return {
    records,
    get tail() {
      return tail;
    },
    rewindTo: (uuid) => {
      tail = uuid;
    },
    add(type, s, extra = {}) {
      const uuid = extra.uuid ?? `${sessionId.slice(0, 8)}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      const r = {
        uuid,
        parentUuid: tail,
        sessionId,
        timestamp: new Date(at(s)).toISOString(),
        type,
        provenance: PROVENANCE[type],
        cwd,
        version: '0.26.1',
        gitBranch: 'feature/x',
        ...extra,
      };
      tail = uuid;
      records.push(r);
      return r;
    },
  };
}

const textMessage = (role, text) => ({ role, parts: [{ text }] });
const typed = (text) => ({
  message: { role: 'user', parts: [{ text: '<system-reminder>\nToday is Sunday.\n</system-reminder>' }, { text }] },
  systemPayload: { displayText: text, hookContext: '' },
});
const call = (id, name, args, extra = {}) => ({ model: 'qwen3-coder-plus', message: { role: 'model', parts: [{ functionCall: { id, name, args } }] }, ...extra });
const result = (id, name, response, toolCallResult) => ({
  message: { role: 'user', parts: [{ functionResponse: { id, name, response } }] },
  toolCallResult: { callId: id, ...toolCallResult },
});
const system = (subtype, systemPayload) => ({ subtype, systemPayload });
const telemetry = (uiEvent) => system('ui_telemetry', { uiEvent });

function fixture() {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'my_app.v2'); // '_' and '.' are lossy in Qwen's encoding
  writeTree(projectDir, { 'README.md': 'x' });
  const chats = `.qwen/projects/${qwen.sanitize(projectDir)}/chats`;
  const cwd = projectDir;

  const s = session(ID, cwd);
  s.add('system', 0, system('session_source', { sourceType: 'default' }));
  s.add('user', 1, typed("Fix the parser. Don't change the API."));
  s.add('assistant', 2, {
    model: 'qwen3-coder-plus',
    message: { role: 'model', parts: [{ text: 'weighing options', thought: true }, { text: 'Looking at the parser.' }, { functionCall: { id: 'c1', name: 'read_file', args: { file_path: `${cwd}/parser.js` } } }] },
  });
  s.add('tool_result', 3, result('c1', 'read_file', { output: 'export const parse = () => {};' }, { status: 'success', resultDisplay: '' }));
  // The user rewound here: the next two records sit on a dead branch.
  const rewindPoint = s.tail;
  s.add('user', 4, typed('Actually rewrite everything in Rust'));
  s.add('assistant', 5, { model: 'qwen3-coder-plus', message: textMessage('model', 'Sure, starting the Rust port.') });
  s.rewindTo(rewindPoint);
  s.add('assistant', 6, call('c2', 'edit', { file_path: `${cwd}/parser.js`, old_string: 'a', new_string: 'b' }));
  s.add('tool_result', 7, result('c2', 'edit', { output: 'ok' }, { status: 'success', resultDisplay: { fileDiff: '-a\n+b', fileName: 'parser.js', originalContent: 'a', newContent: 'b' } }));
  s.add('assistant', 8, call('c3', 'write_file', { file_path: `${cwd}/tokens.js`, content: 'export {};' }));
  s.add('tool_result', 9, result('c3', 'write_file', { output: 'ok' }, { status: 'success', resultDisplay: '' }));
  s.add('assistant', 10, call('c4', 'run_shell_command', { command: 'npm test', is_background: false }));
  s.add(
    'tool_result',
    11,
    result(
      'c4',
      'run_shell_command',
      { error: 'Command: npm test\nDirectory: (root)\nOutput: 1 test failed: parser.spec.js\nError: (none)\nExit Code: 1\nSignal: (none)' },
      { status: 'error', resultDisplay: { type: 'shell_result', version: 1, text: '', output: '1 test failed: parser.spec.js', directory: cwd, exitCode: 1, signal: null, pid: 4242, error: null, outcome: 'failed', notices: [], truncated: false, outputFiles: [] } },
    ),
  );
  // A request that failed and was retried successfully is not a stop.
  s.add('system', 12, telemetry({ 'event.name': 'api_error', model: 'qwen3-coder-plus', error_message: 'Service unavailable', status_code: 503, prompt_id: 'p1' }));
  s.add('assistant', 13, call('c5', 'todo_write', { todos: [{ id: '1', content: 'fix tokenizer', status: 'completed' }, { id: '2', content: 'fix tests', status: 'in_progress' }, { id: '3', content: 'update docs', status: 'pending', blockedBy: ['2'] }] }));
  s.add('tool_result', 14, result('c5', 'todo_write', { output: 'ok' }, { status: 'success', resultDisplay: '' }));
  // One streamed message recorded as two fragments with the same uuid.
  const first = s.add('assistant', 15, { uuid: FRAGMENT, model: 'qwen3-coder-plus', message: textMessage('model', 'Tests fail on') });
  s.records.push({ ...first, timestamp: new Date(at(16)).toISOString(), message: textMessage('model', 'the tokenizer, fixing next.') });
  s.add('assistant', 17, { isSidechain: true, agentId: 'explore-1', message: textMessage('model', 'subagent noise') });
  s.add('user', 18, { subtype: 'notification', provenance: 'system', message: textMessage('user', '<task-notification>done</task-notification>'), systemPayload: { displayText: 'Background agent completed' } });
  s.add('system', 19, system('chat_compression', {
    info: { originalTokenCount: 900000, newTokenCount: 12000, compressionStatus: 1, triggerReason: 'token_limit' },
    compressedHistory: [
      { role: 'user', parts: [{ text: '<state_snapshot>\n<overall_goal>fix the parser</overall_goal>\n</state_snapshot>\n\nResume the prior task using the summary above. Continue from the last in-flight step; do not acknowledge the summary, do not re-introduce, do not greet the user again.' }] },
      { role: 'model', parts: [{ text: 'Got it. Thanks for the additional context!' }] },
    ],
    contextPrefixLength: 2,
    summaryPrefixLength: 2,
  }));
  s.add('system', 20, system('slash_command', { phase: 'invocation', rawCommand: '/model qwen3', sentToModel: false }));
  s.add('system', 20, system('slash_command', { phase: 'result', rawCommand: '/model qwen3', outputHistoryItems: [{ type: 'info', text: 'Switched model' }] }));
  s.add('system', 21, system('slash_command', { phase: 'invocation', rawCommand: '/review src', sentToModel: true }));
  s.add('user', 21, { message: textMessage('user', 'Review the code in src and report issues.\n\n(expanded command template)') });
  s.add('assistant', 22, { model: 'qwen3-coder-plus', message: textMessage('model', 'No issues found.') });
  s.add('system', 30, system('at_command', { filesRead: [`${cwd}/a.js`], status: 'success', userText: 'explain @a.js' }));
  s.add('user', 30, { message: { role: 'user', parts: [{ text: 'explain @a.js' }, { text: '--- Content from referenced files ---\nfile body' }] } });
  s.add('assistant', 31, { model: 'qwen3-coder-plus', message: textMessage('model', 'It exports a parser.') });
  s.add('system', 32, telemetry({ 'event.name': 'request_lifecycle', kind: 'request', phase: 'ended', outcome: 'cancelled', promptId: 'p2' }));
  s.add('user', 33, { subtype: 'mid_turn_user_message', message: textMessage('user', 'also keep it fast'), systemPayload: { displayText: 'also keep it fast' } });
  s.add('user', 40, typed('Now also handle unicode identifiers'));
  s.add('system', 41, telemetry({ 'event.name': 'api_error', model: 'qwen3-coder-plus', error_type: 'insufficient_quota', error_message: 'You exceeded your current quota', status_code: 429, prompt_id: 'p3' }));
  s.add('system', 42, system('custom_title', { customTitle: 'Parser fixes', titleSource: 'manual' }));

  const stub = session(STUB, cwd);
  stub.add('system', 0, system('session_source', { sourceType: 'default' }));
  stub.add('system', 1, system('custom_title', { customTitle: 'nothing here' }));
  const agent = session(AGENT, cwd);
  agent.add('system', 0, system('session_source', { sourceType: 'agent', sourceId: 'reviewer' }));
  agent.add('user', 1, typed('owned by an agent'));
  const cron = session(CRON, cwd);
  cron.add('system', 0, system('session_source', { sourceType: 'scheduled_task', sourceId: 't1' }));
  cron.add('user', 1, typed('nightly check'));
  cron.add('assistant', 2, { model: 'qwen3-coder-plus', message: textMessage('model', 'all green') });
  // A sibling like ".../my_app.v2-backup" shares the directory-name prefix; its recorded cwd rules it out.
  const other = session(OTHER, `${cwd}-backup`);
  other.add('user', 1, typed('hi'));
  const archived = session(ARCHIVED, cwd);
  archived.add('user', 1, typed('archived session'));

  writeTree(home, {
    [`${chats}/${ID}.jsonl`]: s.records,
    [`${chats}/${ID}.runtime.json`]: { sessionId: ID, workDir: cwd },
    [`${chats}/${STUB}.jsonl`]: stub.records,
    [`${chats}/${AGENT}.jsonl`]: agent.records,
    [`${chats}/${CRON}.jsonl`]: cron.records,
    [`${chats}/archive/${ARCHIVED}.jsonl`]: archived.records,
    [`.qwen/projects/${qwen.sanitize(`${cwd}-backup`)}/chats/${OTHER}.jsonl`]: other.records,
  });
  return { home, projectDir };
}

test('sanitize matches Qwen Code, lower-casing on Windows', () => {
  assert.equal(qwen.sanitize('/Users/me/my_app.v2', 'darwin'), '-Users-me-my-app-v2');
  assert.equal(qwen.sanitize('C:\\Users\\Me\\App', 'win32'), 'c--users-me-app');
});

test('finds the real session, skips stubs, agent-owned, archived and unrelated dirs, flags automation and the running one', async () => {
  const { home, projectDir } = fixture();
  const project = resolveProject(projectDir);
  const found = await qwen.findSessions(project, fixtureContext(home));
  assert.deepEqual(found.map((c) => c.id), [ID, CRON]);
  assert.equal(found[0].title, 'Parser fixes');
  assert.equal(found[0].score, 3);
  assert.equal(found[0].cwd, projectDir);
  assert.equal(found[0].preview, "Fix the parser. Don't change the API.");
  assert.equal(found[0].lastActivity, at(40), 'activity = last prompt/answer, not the trailing error or title records');
  assert.equal(found[0].background, false);
  assert.equal(found[1].background, true);
  assert.equal(found[0].current, false);

  const self = await qwen.findSessions(project, fixtureContext(home, { QWEN_CODE_SESSION_ID: ID }));
  assert.equal(self[0].current, true);
});

test('honours QWEN_HOME', async () => {
  const { home, projectDir } = fixture();
  const alt = join(home, 'alt');
  writeTree(alt, { [`projects/${qwen.sanitize(projectDir)}/chats/${OTHER}.jsonl`]: [{ uuid: 'u1', parentUuid: null, sessionId: OTHER, timestamp: new Date(at(1)).toISOString(), type: 'user', cwd: projectDir, message: textMessage('user', 'from alt home') }] });
  const found = await qwen.findSessions(resolveProject(projectDir), fixtureContext(home, { QWEN_HOME: alt }));
  assert.ok(found.some((c) => c.id === OTHER && c.preview === 'from alt home'));
});

test('loads prompts, tools, plan, compaction, stop, interrupt and the active branch only', async () => {
  const { home, projectDir } = fixture();
  const ctx = fixtureContext(home);
  const [candidate] = await qwen.findSessions(resolveProject(projectDir), ctx);
  const { meta, events } = await qwen.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(
    s.prompts.map((p) => p.text),
    ["Fix the parser. Don't change the API.", '/review src', 'explain @a.js', 'also keep it fast', 'Now also handle unicode identifiers'],
  );
  assert.equal(s.latest.started, false, 'the last prompt was never answered');
  assert.equal(s.stop.reason, 'quota');
  assert.equal(events.filter((e) => e.kind === 'stop').length, 1, 'the retried 503 is not a stop');
  assert.ok(events.some((e) => e.kind === 'interrupt'));

  assert.match(s.compaction.summary, /^<overall_goal>fix the parser<\/overall_goal>$/);
  assert.equal(s.compaction.trigger, 'auto');
  assert.deepEqual(s.files.map((f) => f.path), [`${projectDir}/tokens.js`, `${projectDir}/parser.js`]);
  assert.equal(s.failures.length, 1);
  assert.equal(s.failures[0].error, '1 test failed: parser.spec.js');
  assert.equal(s.failures[0].exit, 1);
  assert.equal(s.testCommand.target, 'npm test');
  assert.deepEqual(s.plan.items.map((i) => i.status), ['done', 'active', 'blocked']);

  const replies = events.filter((e) => e.kind === 'reply').map((e) => e.text);
  assert.ok(replies.includes('Tests fail on\nthe tokenizer, fixing next.'), 'fragments of one message are merged');
  assert.equal(events.find((e) => e.text === 'Looking at the parser.').final, false, 'a reply that continues into tool calls is not final');
  assert.equal(events.find((e) => e.text === 'No issues found.').final, true);
  assert.ok(!events.some((e) => /weighing options|Rust|subagent noise|Background agent|file body|Today is/.test(e.text ?? '')));
  assert.equal(events.find((e) => e.tool === 'read_file').action, 'read');

  assert.equal(meta.branch, 'feature/x');
  assert.equal(meta.model, 'qwen3-coder-plus');
  assert.equal(meta.title, 'Parser fixes');
  assert.equal(meta.resumeCommand, `qwen --resume ${ID}`);

  const inWorktree = await qwen.loadSession({ ...candidate, cwd: `${projectDir}/.qwen/worktrees/feat-1` }, ctx);
  assert.equal(inWorktree.meta.resumeCommand, `qwen --resume ${ID} --worktree=feat-1`);
});

test('launch starts the interactive TUI with a first prompt', () => {
  assert.deepEqual(qwen.launch('continue the parser fix'), ['qwen', ['-i', 'continue the parser fix']]);
});
