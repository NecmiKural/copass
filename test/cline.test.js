import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import * as cline from '../agents/cline.js';
import { assemble } from '../lib/assemble.js';
import { resolveProject } from '../lib/project.js';
import { fixtureContext, tempDir, writeTree } from './helpers.js';

const EXT = '.config/Code/User/globalStorage/saoudrizwan.claude-dev'; // linux layout, chosen via ctx.platform
const CLI = '.cline/data';
const T = (m) => Date.UTC(2026, 9, 25, 9, 0) + m * 60_000;
const linuxContext = (home, env) => ({ ...fixtureContext(home, env), platform: 'linux' });
const json = (value) => JSON.stringify(value); // writeTree would write an array as JSONL

const say = (m, kind, text, extra = {}) => ({ ts: T(m), type: 'say', say: kind, text: typeof text === 'string' ? text : JSON.stringify(text), ...extra });
const ask = (m, kind, text, extra = {}) => ({ ts: T(m), type: 'ask', ask: kind, text: typeof text === 'string' ? text : JSON.stringify(text), ...extra });

function legacyFixture() {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'my_app');
  writeTree(projectDir, { 'README.md': 'x' });
  const quota = JSON.stringify({
    message: JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota. Please retry in 30s.', status: 'RESOURCE_EXHAUSTED' } }),
    status: 429,
  });
  writeTree(home, {
    [`${EXT}/state/taskHistory.json`]: json([
      { id: '1777000000000', ts: T(20), task: 'Fix the parser.', cwdOnTaskInitialization: projectDir, modelId: 'old-model' },
      { id: '1777000000002', ts: T(30), task: 'elsewhere', cwdOnTaskInitialization: `${projectDir}-backup` },
      { id: '1777000000003', ts: T(40), task: 'deleted task', cwdOnTaskInitialization: projectDir },
    ]),
    [`${EXT}/tasks/1777000000000/ui_messages.json`]: json([
      say(0, 'task', "Fix the parser. Don't change the API.", { images: ['data:image/png;base64,AAAA'] }),
      say(0, 'api_req_started', { request: '<environment_details>noise</environment_details>' }),
      say(0, 'error_retry', { attempt: 1, maxAttempts: 3, errorMessage: '503 overloaded' }),
      say(1, 'reasoning', 'private chain of thought'),
      say(1, 'text', 'Look', { partial: true }),
      say(1, 'hook_status', { hookName: 'PreToolUse', status: 'completed' }),
      say(1, 'text', 'Looking at the parser.', { modelInfo: { modelId: 'gpt-x', providerId: 'openai', mode: 'act' } }),
      say(2, 'tool', { tool: 'readFile', path: 'src/a.js' }, { partial: true }),
      say(2, 'tool', { tool: 'readFile', path: 'src/a.js', content: 'file body' }),
      say(3, 'tool', { tool: 'editedExistingFile', path: 'src/parser.js', content: '@@ diff' }),
      // A failed replace_in_file, tool-call syntax the model wrote as text, and a plan_mode_respond
      // left partial by needs_more_exploration (shown to the user, then the agent kept exploring).
      say(3, 'diff_error', 'src/lexer.js', { partial: true }),
      say(3, 'text', '<tool_name>list_files</tool_name>\n<path>src</path>\n</tool_name>'),
      say(3, 'text', '</tool_call>'),
      ask(3, 'plan_mode_respond', { response: 'Plan: split the lexer first.', options: [] }, { partial: true }),
      say(3, 'api_req_started', { request: 'x' }),
      say(4, 'command', 'npm test'),
      ask(4, 'command_output', '1 failing'),
      say(4, 'api_req_started', { request: 'x', cancelReason: 'user_cancelled' }),
      say(5, 'task_progress', '- [x] fix tokenizer\n- [ ] fix tests'),
      say(5, 'task_progress', '- [x] fix tokenizer\n- [ ] fix tests'),
      say(5, 'text', JSON.stringify({ tokensIn: 1, tokensOut: 2, cost: 0 }), { partial: true }),
      ask(5, 'condense', 'Condensed: parser work'),
      say(6, 'tool', { tool: 'summarizeTask', content: '<thinking>should I?</thinking>\nSummary of the work so far' }),
      ask(7, 'followup', { question: 'Which branch?', options: ['main', 'dev'] }),
      say(8, 'user_feedback', 'main'),
      say(9, 'completion_result', 'Parser fixed.HAS_CHANGES'),
      ask(9, 'completion_result', ''),
      say(10, 'user_feedback', 'Now also handle unicode identifiers'),
      say(10, 'api_req_started', { request: 'x', cancelReason: 'streaming_failed', streamingFailedMessage: '' }),
      say(11, 'error_retry', { attempt: 1, maxAttempts: 3, delaySeconds: 2, errorMessage: quota }),
      say(11, 'api_req_retried', ''),
      ask(12, 'resume_task', ''),
    ]),
    [`${EXT}/tasks/1777000000002/ui_messages.json`]: [say(0, 'task', 'elsewhere')],
    // The CLI 2.x store: a session started in a subdirectory of the project.
    [`${CLI}/state/taskHistory.json`]: json([{ id: '1777000000001', ts: T(5), task: 'Older task', cwdOnTaskInitialization: join(projectDir, 'src') }]),
    [`${CLI}/tasks/1777000000001/ui_messages.json`]: json([say(0, 'task', 'Older task'), say(1, 'text', 'Done.')]),
    [`${CLI}/tasks/1777000000001/focus_chain_taskid_1777000000001.md`]: '# Focus Chain\n<!-- edit freely -->\n- [x] step one\n- [ ] step two\n',
  });
  writeTree(projectDir, { 'src/a.js': 'x' });
  return { home, projectDir };
}

test('finds legacy tasks from every store, newest first, skipping other dirs and deleted tasks', async () => {
  const { home, projectDir } = legacyFixture();
  const found = await cline.findSessions(resolveProject(projectDir), linuxContext(home));
  assert.deepEqual(found.map((c) => [c.id, c.score]), [['1777000000000', 3], ['1777000000001', 1]]);
  assert.equal(found[0].lastActivity, T(20), 'activity = HistoryItem.ts, not the file mtime');
  assert.equal(found[0].preview, 'Fix the parser.');
});

test('loads a legacy task: genuine prompts, visible replies, tools, plan, compaction and the trailing stop', async () => {
  const { home, projectDir } = legacyFixture();
  const ctx = linuxContext(home);
  const [task, older] = await cline.findSessions(resolveProject(projectDir), ctx);
  const { meta, events } = await cline.loadSession(task, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), [
    "Fix the parser. Don't change the API.\n[image attached]",
    'main',
    'Now also handle unicode identifiers',
  ]);
  const replies = events.filter((e) => e.kind === 'reply');
  assert.deepEqual(replies.map((r) => [r.text, Boolean(r.final)]), [
    ['Looking at the parser.', false],
    ['Plan: split the lexer first.', false],
    ['Which branch?', false],
    ['Parser fixed.', true],
  ]);
  assert.ok(!JSON.stringify(events).includes('chain of thought'));
  assert.ok(!JSON.stringify(events).includes('tool_'), 'tool-call markup is not a reply');
  assert.deepEqual(s.files.map((f) => f.path), [join(projectDir, 'src/parser.js')]);
  assert.deepEqual(s.failures.map((f) => [f.tool, f.target]), [['replace_in_file', join(projectDir, 'src/lexer.js')]]);
  assert.deepEqual(s.commands.map((c) => c.target), ['npm test']);
  assert.equal(events.filter((e) => e.kind === 'tool' && e.action === 'read').length, 1, 'partial tool rows are snapshots');
  assert.ok(events.some((e) => e.kind === 'interrupt'));
  assert.equal(events.filter((e) => e.kind === 'plan').length, 1);
  assert.deepEqual(s.plan.items.map((i) => i.status), ['done', 'pending']);
  assert.deepEqual(events.filter((e) => e.kind === 'compaction').map((e) => [e.summary, e.trigger]), [
    ['Condensed: parser work', 'manual'],
    ['Summary of the work so far', undefined],
  ]);
  assert.equal(events.filter((e) => e.kind === 'stop').length, 1, 'a retry that recovered is not a stop');
  assert.equal(s.stop.reason, 'quota');
  assert.match(s.stop.message, /exceeded your current quota/);
  assert.equal(s.stop.resetsAt, T(11) + 30_000);
  assert.equal(s.latest.started, false);
  assert.equal(meta.model, 'gpt-x');
  assert.equal(meta.resumeCommand, undefined, 'VS Code tasks have no CLI resume');

  const second = await cline.loadSession(older, ctx);
  assert.equal(second.meta.resumeCommand, 'cline --taskId 1777000000001');
  assert.deepEqual(assemble(second.meta, second.events).plan.items.map((i) => i.text), ['step one', 'step two']);
});

test('classifies provider errors: a usage limit is quota, an auth failure is not', async () => {
  const home = tempDir('copass-home-');
  const projectDir = tempDir('copass-proj-');
  const failed = (message) => ask(1, 'api_req_failed', JSON.stringify({ message, modelId: 'm', providerId: 'p' }));
  const tasks = {
    1777000000010: failed('Codex API error: The usage limit has been reached'),
    1777000000011: failed('401 Insufficient permissions for this API key'),
  };
  writeTree(home, {
    [`${CLI}/state/taskHistory.json`]: json(Object.keys(tasks).map((id) => ({ id, ts: T(1), task: 'go', cwdOnTaskInitialization: projectDir }))),
    ...Object.fromEntries(Object.entries(tasks).map(([id, row]) => [`${CLI}/tasks/${id}/ui_messages.json`, json([say(0, 'task', 'go'), row])])),
  });
  const ctx = linuxContext(home);
  const reasons = {};
  for (const c of await cline.findSessions(resolveProject(projectDir), ctx)) {
    const { meta, events } = await cline.loadSession(c, ctx);
    reasons[c.id] = assemble(meta, events).stop?.reason;
  }
  assert.deepEqual(reasons, { 1777000000010: 'quota', 1777000000011: 'error' });
});

const SID = '1790000000000_abcde';

function sdkFixture() {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'my_app');
  writeTree(projectDir, { 'README.md': 'x' });
  const sessions = join(home, CLI, 'sessions');
  const manifest = (id, extra) => ({
    version: 1,
    session_id: id,
    source: 'cli',
    pid: 1,
    started_at: new Date(T(0)).toISOString(),
    status: 'idle',
    interactive: true,
    provider: 'anthropic',
    model: 'm1',
    cwd: projectDir,
    workspace_root: projectDir,
    messages_path: join(sessions, id, `${id}.messages.json`),
    ...extra,
  });
  const doc = (id, messages) => JSON.stringify({ version: 1, updated_at: new Date(T(9)).toISOString(), sessionId: id, messages, system_prompt: 'say "ts": 9999999999999' }, null, 2);
  writeTree(home, {
    [`${CLI}/sessions/${SID}/${SID}.json`]: manifest(SID, { metadata: { title: 'Tokenizer work', git: { branch: 'feature/x' } } }),
    [`${CLI}/sessions/${SID}/${SID}.messages.json`]: doc(SID, [
      {
        id: 'u1',
        role: 'user',
        ts: T(1),
        content: [
          { type: 'text', text: '<mode_notice>The user switched from plan mode to act mode.</mode_notice><user_input mode="act">Refactor the tokenizer, keep <task>tags</task> as typed</user_input>\n<file_content path="/x/a.js">\nconst a = 1;\n</file_content>' },
          { type: 'image', data: 'AAAA', mediaType: 'image/png' },
        ],
      },
      {
        id: 'a1',
        role: 'assistant',
        ts: T(2),
        modelInfo: { id: 'm2', provider: 'anthropic' },
        content: [
          { type: 'thinking', thinking: 'hidden reasoning' },
          { type: 'text', text: 'On it.' },
          { type: 'text', text: '<tool_call>' },
          { type: 'tool_use', id: 'c1', name: 'run_commands', input: { commands: ['npm test', 'npm run lint'] } },
          { type: 'tool_use', id: 'e1', name: 'editor', input: { path: '/abs/tokenizer.js', old_text: 'a', new_text: 'b' } },
          { type: 'tool_use', id: 'g1', name: 'run_commands', input: { command: 'git', args: ['status', '--short'] } },
        ],
      },
      {
        id: 'r1',
        role: 'user',
        ts: T(3),
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: [{ query: 'npm test', result: 'ok', success: true }, { query: 'npm run lint', result: 'src/a.js: 1 problem', error: 'Command exited with code 2', success: false }] },
          { type: 'tool_result', tool_use_id: 'e1', content: 'edited' },
          { type: 'tool_result', tool_use_id: 'g1', content: [{ query: 'git status --short', result: '', success: true }] },
        ],
      },
      { role: 'user', ts: T(3), content: [{ type: 'text', text: 'You seem to be repeating the same tool call.' }] },
      { id: 'a2', role: 'assistant', ts: T(4), content: [{ type: 'text', text: 'Tokenizer refactored.' }] },
      { id: 'u2', role: 'user', ts: T(5), content: [{ type: 'text', text: '<user_command slash="review">check edge cases</user_command>' }] },
      { id: 'err', role: 'assistant', ts: T(6), metadata: { displayOnly: true, displayRole: 'error' }, content: [{ type: 'text', text: '429 Too Many Requests: rate limit reached' }] },
    ]),
    [`${CLI}/sessions/${SID}/${SID}.compaction.json`]: {
      version: 1,
      updated_at: new Date(T(3)).toISOString(),
      source_message_count: 3,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Context summary:\n\nDid X' }], metadata: { kind: 'compaction_summary', summary: 'Did X', generatedAt: T(3) } }],
    },
    // A subagent run and a session that was opened but never used are not sessions.
    [`${CLI}/sessions/${SID}__sub1/${SID}__sub1.json`]: manifest(`${SID}__sub1`),
    [`${CLI}/sessions/${SID}__sub1/${SID}__sub1.messages.json`]: doc(`${SID}__sub1`, [{ role: 'user', ts: T(8), content: 'sub' }]),
    [`${CLI}/sessions/empty/empty.json`]: manifest('empty'),
    [`${CLI}/sessions/empty/empty.messages.json`]: doc('empty', []),
    [`${CLI}/sessions/bg/bg.json`]: manifest('bg', { interactive: false, source: 'schedule' }),
    [`${CLI}/sessions/bg/bg.messages.json`]: doc('bg', [{ role: 'user', ts: T(7), content: [{ type: 'text', text: '<user_input mode="yolo">nightly</user_input>' }] }]),
  });
  return { home, projectDir };
}

test('finds SDK sessions from manifests, flags background runs, skips subagents and empty sessions', async () => {
  const { home, projectDir } = sdkFixture();
  const found = await cline.findSessions(resolveProject(projectDir), linuxContext(home));
  assert.deepEqual(found.map((c) => [c.id, Boolean(c.background)]), [['bg', true], [SID, false]]);
  const main = found.find((c) => c.id === SID);
  assert.equal(main.lastActivity, T(6), 'activity = last message ts, not updated_at or a "ts" inside a string');
  assert.equal(main.title, 'Tokenizer work');
});

test('loads an SDK session: unwrapped prompts, final replies, batched commands, sidecar compaction, terminal error', async () => {
  const { home, projectDir } = sdkFixture();
  const ctx = linuxContext(home);
  const candidate = (await cline.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === SID);
  const { meta, events } = await cline.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), ['Refactor the tokenizer, keep <task>tags</task> as typed\n[image attached]', '/review check edge cases']);
  assert.deepEqual(events.filter((e) => e.kind === 'reply').map((r) => [r.text, Boolean(r.final)]), [
    ['On it.', false],
    ['Tokenizer refactored.', true],
  ]);
  assert.ok(!JSON.stringify(events).includes('hidden reasoning'));
  assert.deepEqual(s.commands.map((c) => [c.target, c.ok, c.exit]), [
    ['npm test', true, undefined],
    ['npm run lint', false, 2],
    ['git status --short', true, undefined],
  ]);
  assert.equal(s.failures[0].error, 'src/a.js: 1 problem\nCommand exited with code 2', 'output tail, then the exit line');
  assert.deepEqual(s.files.map((f) => f.path), ['/abs/tokenizer.js']);
  assert.equal(s.compaction.summary, 'Did X');
  assert.equal(s.events.indexOf(s.compaction), s.events.findIndex((e) => e.text === 'Tokenizer refactored.') - 1, 'placed after the replaced messages');
  assert.equal(s.stop.reason, 'rate_limit');
  assert.equal(meta.branch, 'feature/x');
  assert.equal(meta.model, 'm2');
  assert.equal(meta.resumeCommand, `cline --id ${SID}`);
});

test('uses the sessions.db index when present and prefers an SDK session over its legacy original', async () => {
  const { home, projectDir } = sdkFixture();
  const { DatabaseSync } = await import('node:sqlite');
  writeTree(home, { [`${CLI}/db/.keep`]: '' });
  const db = new DatabaseSync(join(home, CLI, 'db', 'sessions.db'));
  db.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, cwd TEXT, workspace_root TEXT, status TEXT, interactive INTEGER,
    started_at TEXT, ended_at TEXT, model TEXT, prompt TEXT, messages_path TEXT, metadata_json TEXT, is_subagent INTEGER, parent_session_id TEXT)`);
  const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?)');
  const messages = (id) => join(home, CLI, 'sessions', id, `${id}.messages.json`);
  insert.run(SID, projectDir, projectDir, 'idle', new Date(T(0)).toISOString(), 'm1', '<user_input mode="act">Refactor the tokenizer</user_input>', messages(SID), '{"title":"From DB"}', 0, null);
  insert.run(`${SID}__sub1`, projectDir, projectDir, 'idle', new Date(T(0)).toISOString(), 'm1', null, messages(`${SID}__sub1`), null, 1, SID);
  db.close();
  writeTree(home, {
    [`${CLI}/state/taskHistory.json`]: json([{ id: SID, ts: T(1), task: 'Refactor the tokenizer', cwdOnTaskInitialization: projectDir }]),
    [`${CLI}/tasks/${SID}/ui_messages.json`]: json([say(1, 'task', 'Refactor the tokenizer')]),
  });

  const found = await cline.findSessions(resolveProject(projectDir), linuxContext(home));
  assert.deepEqual(found.map((c) => [c.id, c.ref.kind]), [[SID, 'sdk']], 'bg is not in the index; the legacy copy is deduplicated');
  assert.equal(found[0].title, 'From DB');
  assert.equal(found[0].preview, 'Refactor the tokenizer');
});

test('launches the terminal UI with the prompt', () => {
  assert.deepEqual(cline.launch('continue the work'), ['cline', ['--tui', 'continue the work']]);
});
