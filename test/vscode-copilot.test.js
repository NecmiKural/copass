import assert from 'node:assert/strict';
import { utimesSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import * as copilot from '../agents/vscode-copilot.js';
import { assemble } from '../lib/assemble.js';
import { resolveProject } from '../lib/project.js';
import { fixtureContext, tempDir, writeTree } from './helpers.js';

const S1 = '11111111-2222-4333-8444-555555555555';
const EMPTY = '22222222-2222-4333-8444-555555555555';
const LEGACY = '33333333-2222-4333-8444-555555555555';
const CLI = '44444444-2222-4333-8444-555555555555';
const FRESH = '55555555-2222-4333-8444-555555555555';
const EXTERNAL = '66666666-2222-4333-8444-555555555555';
const SUB = '77777777-2222-4333-8444-555555555555';
const OTHER = '88888888-2222-4333-8444-555555555555';
const MULTI = '99999999-2222-4333-8444-555555555555';
const WINDOWLESS = 'aaaaaaaa-2222-4333-8444-555555555555';
const STRAY = 'bbbbbbbb-2222-4333-8444-555555555555';

const t = (m) => Date.UTC(2026, 9, 25, 9, m);
const uri = (p) => pathToFileURL(p).href;
const ref = (p) => ({ $mid: 1, fsPath: p, external: uri(p), path: p, scheme: 'file' });
const md = (value) => ({ value, supportHtml: false, supportThemeIcons: false });
const tool = (toolId, extra = {}) => ({ kind: 'toolInvocationSerialized', toolId, toolCallId: `${toolId}-${Math.random()}`, isComplete: true, isConfirmed: { type: 1 }, ...extra });
const linked = (verb, p) => ({ value: `${verb} [](${uri(p)})`, uris: { [uri(p)]: { $mid: 1, path: p, scheme: 'file' } } });

/** A request as VS Code serializes it. */
function request(id, minute, text, extra = {}) {
  return {
    requestId: id,
    timestamp: t(minute),
    agent: { id: 'github.copilot.editsAgent' },
    modelId: 'copilot/auto',
    message: { text, parts: [{ kind: 'text', text }] },
    variableData: { variables: [{ kind: 'promptFile', name: 'AGENTS.md', automaticallyAdded: true, value: 'Always use tabs.' }] },
    response: [md('ok')],
    result: { timings: { totalElapsed: 1000 } },
    modelState: { value: 1, completedAt: t(minute) + 1000 },
    ...extra,
  };
}

const session = (id, requests, extra = {}) => [{ kind: 0, v: { version: 3, creationDate: t(0), sessionId: id, initialLocation: 'panel', requests, pendingRequests: [], inputState: { inputText: '' }, ...extra } }];

/** The main session: an append-only mutation log with rewinds, a summary, a retry and a quota stop. */
function mainLog(dir) {
  const parser = join(dir, 'src/parser.js');
  const lexer = join(dir, 'src/lexer.js');
  const first = request('r1', 1, "Fix the parser. Don't change the API.", {
    variableData: { variables: [{ kind: 'promptFile', name: 'CLAUDE.md', automaticallyAdded: true, value: 'x' }, { kind: 'image', name: 'shot.png' }] },
    response: [
      { kind: 'mcpServersStarting' },
      { kind: 'thinking', value: 'private chain of thought' },
      md('Looking at '),
      { kind: 'inlineReference', inlineReference: { $mid: 1, path: parser, scheme: 'file' } },
      md(' first.'),
      { kind: 'thinking', value: ['more', 'thinking'] },
      md('Then the lexer.'),
      tool('copilot_readFile', { invocationMessage: linked('Reading', parser) }),
      tool('copilot_applyPatch', { invocationMessage: linked('Editing', parser) }),
      md('\n```\n'), { kind: 'undoStop', id: 'u1' }, { kind: 'codeblockUri', uri: ref(parser), isEdit: true }, { kind: 'textEditGroup', uri: ref(parser), edits: [], done: true }, md('\n```\n'),
      tool('copilot_replaceString', { invocationMessage: 'Replace string in file' }),
      md('\n```\n'), { kind: 'codeblockUri', uri: ref(lexer), isEdit: true }, { kind: 'textEditGroup', uri: ref(lexer), edits: [], done: true }, md('\n```\n'),
      md('Streaming draft that VS Code replaced'),
    ],
    result: { timings: { totalElapsed: 60000 }, metadata: { resolvedModel: 'gpt-5.3-codex', toolCallRounds: [{ id: 'round-1', timestamp: t(1) + 500 }] } },
    modelState: { value: 0 },
  });
  const tests = request('r2', 3, 'Run the tests', {
    response: [
      tool('run_in_terminal', {
        toolSpecificData: {
          kind: 'terminal',
          commandLine: { original: 'npm test', toolEdited: 'npm test' },
          terminalCommandState: { exitCode: 1, duration: 900 },
          terminalCommandOutput: { text: '\x1b[31m1 test failed: parser.spec.js\x1b[0m\x1b[?2004h', lineCount: 1 },
        },
      }),
      tool('manage_todo_list', { toolSpecificData: { kind: 'todoList', todoList: [{ id: 1, title: 'fix tokenizer', status: 'completed' }, { id: 2, title: 'fix tests', status: 'in-progress' }, { id: 3, title: 'docs', status: 'not-started' }] } }),
      md('Tests fail in parser.spec.js.'),
    ],
    result: {
      timings: { totalElapsed: 2000 },
      metadata: {
        toolCallRounds: [{ id: 'round-2', timestamp: t(3) + 500 }],
        // Foreground summaries are stored twice; the second copy has no source.
        summaries: [{ toolCallRoundId: 'round-2', text: 'Summary: the parser was fixed.', source: 'foreground' }, { toolCallRoundId: 'round-2', text: 'Summary: the parser was fixed.' }],
      },
    },
  });
  return [
    ...session(S1, [first]),
    // Truncate-then-push: the streamed draft (index 19) is replaced by the final text.
    { kind: 2, k: ['requests', 0, 'response'], i: 19, v: [md('Parser fixed.')] },
    { kind: 1, k: ['requests', 0, 'modelState'], v: { value: 1, completedAt: t(2) } },
    { kind: 2, k: ['requests'], v: [tests, request('r3', 4, 'phantom: an edited-away request')] },
    { kind: 2, k: ['requests'], i: 2 }, // pure truncation: the user edited r3 away
    {
      kind: 2,
      k: ['requests'],
      v: [
        request('r4', 5, 'Background terminal finished: npm run build', { isSystemInitiated: true, systemInitiatedLabel: 'npm run build', response: [md('The background build finished.')] }),
        request('r5', 6, 'Now also handle unicode identifiers', { response: [], result: { errorDetails: { code: 'failed', message: 'Request failed' } }, modelState: { value: 3, completedAt: t(6) } }),
        request('r6', 7, '@agent Try Again', {
          confirmation: 'Try Again',
          response: [],
          result: { errorDetails: { code: 'quotaExceeded', isQuotaExceeded: true, message: "You've reached your monthly limit.", responseIsIncomplete: true } },
          modelState: { value: 3, completedAt: t(7) },
        }),
      ],
    },
    { kind: 2, k: ['pendingRequests'], v: [{ id: 'p1', kind: 0, request: request('q1', 8, 'and update the README') }] },
    { kind: 1, k: ['inputState', 'inputText'], v: 'half-typed idea' },
    { kind: 1, k: ['customTitle'], v: 'Parser fixes' },
    { kind: 1, k: ['followups'], v: [] },
    { kind: 3, k: ['customTitle'] },
    { kind: 1, k: ['customTitle'], v: 'Parser fixes' },
  ];
}

function fixture() {
  const home = tempDir('copass-home-');
  const root = tempDir('copass-proj-');
  const projectDir = join(root, 'my app'); // percent-encoded in workspace.json
  writeTree(projectDir, { 'README.md': 'x', 'sub/a.txt': 'x' });
  const user = join(home, 'appdata', 'Code', 'User');
  const ws = (hash, files) => writeTree(join(user, 'workspaceStorage', hash), files);
  const codeWorkspace = join(home, 'work', 'all.code-workspace');

  ws('a1', {
    'workspace.json': { folder: uri(projectDir) },
    // The log ends with a torn line from a write in progress.
    [`chatSessions/${S1}.jsonl`]: `${mainLog(projectDir).map((e) => JSON.stringify(e)).join('\n')}\n{"kind":1,"k":["inputSt`,
    [`chatSessions/${EMPTY}.jsonl`]: session(EMPTY, []),
    [`chatSessions/${LEGACY}.json`]: { version: 2, sessionId: LEGACY, creationDate: t(0), requests: [{ message: { text: 'legacy question' }, timestamp: t(0), response: [{ value: 'legacy answer' }] }] },
    [`chatSessions/${CLI}.jsonl`]: session(CLI, [request('c1', 9, 'run by the Copilot CLI', { agent: { id: 'copilotcli' } })]),
    [`chatSessions/${FRESH}.jsonl`]: session(FRESH, [request('f1', 2, 'brand-new chat')]),
    [`chatSessions/${EXTERNAL}.jsonl`]: session(EXTERNAL, [request('e1', 2, 'cloud mirror')]),
  });
  ws('b2', { 'workspace.json': { folder: uri(join(projectDir, 'sub')) }, [`chatSessions/${SUB}.jsonl`]: session(SUB, [request('s1', 1, 'in a subfolder')]) });
  ws('c3', { 'workspace.json': { folder: uri(`${projectDir}-backup`) }, [`chatSessions/${OTHER}.jsonl`]: session(OTHER, [request('o1', 1, 'elsewhere')]) });
  ws('d4', { 'workspace.json': { workspace: uri(codeWorkspace) }, [`chatSessions/${MULTI}.jsonl`]: session(MULTI, [request('m1', 1, 'multi-root')]) });
  writeTree(dirname(codeWorkspace), {
    'all.code-workspace': `{\n  // JSONC, as VS Code writes it\n  "folders": [\n    { "path": "${relative(dirname(codeWorkspace), projectDir)}" }, /* main */\n    { "uri": "${uri(`${projectDir}-backup`)}" },\n  ],\n}\n`,
  });
  writeTree(join(user, 'globalStorage', 'emptyWindowChatSessions'), {
    [`${WINDOWLESS}.jsonl`]: session(WINDOWLESS, [request('w1', 1, 'from the Agents window')], { workingDirectory: uri(projectDir) }),
    [`${STRAY}.jsonl`]: session(STRAY, [request('x1', 1, 'no folder at all')]),
  });
  return { home, projectDir, user, ctx: fixtureContext(home, { VSCODE_APPDATA: join(home, 'appdata') }) };
}

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Node without node:sqlite: the index test is skipped and adapters scan the logs.
}

/** Write a state.vscdb holding the chat index, dated after every file except FRESH. */
function writeIndex(user) {
  const dir = join(user, 'workspaceStorage', 'a1');
  const db = new DatabaseSync(join(dir, 'state.vscdb'));
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const entry = (id, extra) => ({ sessionId: id, title: 'New Chat', lastMessageDate: t(1), timing: { created: t(0) }, isEmpty: false, isExternal: false, ...extra });
  const entries = {
    [S1]: entry(S1, { title: 'Parser fixes (index)', lastMessageDate: t(7), timing: { created: t(0), lastRequestStarted: t(7), lastRequestEnded: t(7) + 5 } }),
    [EMPTY]: entry(EMPTY, { isEmpty: true }),
    [FRESH]: entry(FRESH, { isEmpty: true }), // stale: the first request was written after the flush
    [EXTERNAL]: entry(EXTERNAL, { isExternal: true }),
  };
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('chat.ChatSessionStore.index', JSON.stringify({ version: 1, entries }));
  db.close();
  const old = new Date(t(30));
  for (const id of [S1, EMPTY, EXTERNAL]) utimesSync(join(dir, 'chatSessions', `${id}.jsonl`), old, old);
  utimesSync(join(dir, 'state.vscdb'), new Date(t(40)), new Date(t(40)));
  utimesSync(join(dir, 'chatSessions', `${FRESH}.jsonl`), new Date(t(50)), new Date(t(50)));
}

test('replays the mutation log exactly: truncating pushes, deletes and a torn last line', () => {
  const { user } = fixture();
  const state = copilot.readSession(join(user, 'workspaceStorage', 'a1', 'chatSessions', `${S1}.jsonl`));
  assert.deepEqual(state.requests.map((r) => r.requestId), ['r1', 'r2', 'r4', 'r5', 'r6']);
  assert.equal(state.requests[0].response.length, 20);
  assert.equal(state.requests[0].response.at(-1).value, 'Parser fixed.');
  assert.equal(state.customTitle, 'Parser fixes');
  assert.equal(state.inputState.inputText, 'half-typed idea');
});

test('finds sessions in every matching window; folder-less ones only by workingDirectory', async () => {
  const { projectDir, ctx } = fixture();
  const found = await copilot.findSessions(resolveProject(projectDir), ctx);
  const byId = Object.fromEntries(found.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), [S1, LEGACY, FRESH, EXTERNAL, SUB, MULTI, WINDOWLESS].sort());
  assert.equal(byId[S1].score, 3);
  assert.equal(byId[SUB].score, 1);
  assert.equal(byId[MULTI].cwd, projectDir);
  assert.equal(byId[WINDOWLESS].cwd, projectDir);
  assert.equal(byId[S1].lastActivity, t(7), 'activity = the last response end, not the file mtime');
  assert.equal(byId[S1].title, 'Parser fixes');
  assert.equal(byId[S1].preview, "Fix the parser. Don't change the API.\n[image attached]");
  assert.ok(found.every((c) => c.current === false && c.background === false));
});

test('trusts the state.vscdb index only for files not written after it', { skip: !DatabaseSync && 'node:sqlite unavailable' }, async () => {
  const { projectDir, user, ctx } = fixture();
  writeIndex(user);
  const found = await copilot.findSessions(resolveProject(projectDir), ctx);
  const byId = Object.fromEntries(found.map((c) => [c.id, c]));
  assert.ok(!byId[EMPTY] && !byId[EXTERNAL], 'empty and external sessions are skipped');
  assert.equal(byId[S1].lastActivity, t(7) + 5, 'activity from the index');
  assert.equal(byId[S1].title, 'Parser fixes (index)');
  assert.ok(byId[FRESH], 'a session written after the index flush is replayed, not dropped as empty');
  assert.equal(byId[FRESH].lastActivity, t(2) + 1000);
});

test('loads genuine prompts, visible replies, tools, plan, compaction, stop, queued and draft', async () => {
  const { projectDir, ctx } = fixture();
  const found = await copilot.findSessions(resolveProject(projectDir), ctx);
  const { meta, events } = await copilot.loadSession(found.find((c) => c.id === S1), ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), ["Fix the parser. Don't change the API.\n[image attached]", 'Run the tests', 'Now also handle unicode identifiers']);
  assert.equal(s.latest.started, false);
  assert.equal(s.stop.reason, 'quota');
  assert.match(s.stop.message, /monthly limit/);
  assert.deepEqual(s.latest.queued.map((q) => q.text), ['and update the README']);
  assert.equal(s.latest.draft.text, 'half-typed idea');

  const replies = events.filter((e) => e.kind === 'reply').map((e) => e.text);
  assert.deepEqual(replies, ['Looking at `parser.js` first.\n\nThen the lexer.', 'Parser fixed.', 'Tests fail in parser.spec.js.', 'The background build finished.']);
  assert.equal(events.find((e) => e.text === 'Parser fixed.').final, true);
  assert.ok(!/chain of thought|phantom|Streaming draft|```/.test(JSON.stringify(events)), 'no thinking, rewound request, replaced draft or bare fences');

  assert.equal(events.filter((e) => e.kind === 'compaction').length, 1, 'the duplicated summary is emitted once');
  assert.equal(s.compaction.summary, 'Summary: the parser was fixed.');
  assert.equal(events[s.cut + 1].text, 'Run the tests', 'the summary sits before the request that owns its round');

  assert.deepEqual(s.files.map((f) => [f.path, f.count]), [[join(projectDir, 'src/lexer.js'), 1], [join(projectDir, 'src/parser.js'), 1]]);
  assert.deepEqual(events.filter((e) => e.action === 'read').map((e) => e.target), [join(projectDir, 'src/parser.js')]);
  assert.deepEqual(s.failures.map((f) => [f.target, f.exit, f.error]), [['npm test', 1, '1 test failed: parser.spec.js']]);
  assert.equal(s.testCommand.target, 'npm test');
  assert.deepEqual(s.plan.items.map((i) => i.status), ['done', 'active', 'pending']);

  assert.equal(meta.title, 'Parser fixes');
  assert.equal(meta.startedAt, t(0));
  assert.equal(meta.lastActivity, t(7));
  assert.equal(meta.model, 'copilot/auto');
  assert.equal(meta.resumeCommand, undefined);
});

/** One window for `projectDir` holding the given chat logs; returns the store dirs and a context. */
function smallStore(files) {
  const home = tempDir('copass-home-');
  const projectDir = tempDir('copass-proj-');
  const user = join(home, 'appdata', 'Code', 'User');
  const dir = join(user, 'workspaceStorage', 'w1');
  writeTree(dir, { 'workspace.json': { folder: uri(projectDir) }, ...files });
  return { projectDir, dir, ctx: fixtureContext(home, { VSCODE_APPDATA: join(home, 'appdata') }) };
}

test('a cancelled last request is an interrupt, not an error stop; queued notifications are not prompts', async () => {
  const id = 'cccccccc-2222-4333-8444-555555555555';
  const run = tool('run_in_terminal', {
    toolSpecificData: { kind: 'terminal', commandLine: { original: 'cd /proj && npm test', toolEdited: ' npm test', forDisplay: ' npm test' }, terminalCommandState: { exitCode: 0 } },
  });
  const cancelled = request('r1', 1, 'run the tests', {
    response: [run, md('Running')],
    // VS Code stores errorDetails 'Canceled' (with or without code 'canceled') on a user cancel.
    result: { errorDetails: { message: 'Canceled', responseIsIncomplete: true } },
    modelState: { value: 2, completedAt: t(2) },
  });
  const notification = { id: 'p1', kind: 'steering', sendOptions: { isSystemInitiated: true, systemInitiatedLabel: 'npm run dev' }, request: request('n1', 3, '[Terminal 1 notification: command completed]') };
  const typed = { id: 'p2', kind: 'steering', sendOptions: {}, request: request('n2', 4, 'also check lint') };
  const { dir } = smallStore({ [`chatSessions/${id}.jsonl`]: session(id, [cancelled], { pendingRequests: [notification, typed] }) });
  const { meta, events } = await copilot.loadSession({ id, ref: { file: join(dir, 'chatSessions', `${id}.jsonl`) } }, {});
  const s = assemble(meta, events);
  assert.equal(s.stop, null, 'no error stop for a cancel');
  assert.equal(s.latest.interrupted, true);
  assert.deepEqual(s.latest.queued.map((q) => q.text), ['also check lint']);
  assert.equal(s.commands[0].target, 'npm test', 'the command that ran, without the redundant cd');
  assert.equal(s.testCommand?.target, 'npm test');
});

test('an index entry flushed while a request ran is replayed, not trusted', { skip: !DatabaseSync && 'node:sqlite unavailable' }, async () => {
  const id = 'dddddddd-2222-4333-8444-555555555555';
  const long = request('r1', 1, 'long task', { modelState: { value: 1, completedAt: t(40) } });
  const { projectDir, dir, ctx } = smallStore({ [`chatSessions/${id}.jsonl`]: session(id, [long]) });
  const db = new DatabaseSync(join(dir, 'state.vscdb'));
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  // Pending at flush time: lastRequestEnded falls back to the response start.
  const entry = { sessionId: id, title: 'long task', lastMessageDate: t(1), timing: { created: t(0), lastRequestStarted: t(1), lastRequestEnded: t(1) }, isEmpty: false, isExternal: false, lastResponseState: 2 };
  db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('chat.ChatSessionStore.index', JSON.stringify({ version: 1, entries: { [id]: entry } }));
  db.close();
  utimesSync(join(dir, 'chatSessions', `${id}.jsonl`), new Date(t(45)), new Date(t(45)));
  utimesSync(join(dir, 'state.vscdb'), new Date(t(50)), new Date(t(50)));
  const [found] = await copilot.findSessions(resolveProject(projectDir), ctx);
  assert.equal(found.lastActivity, t(40));
});

test('logs past the replay budget are still listed, dated from their tail', async () => {
  const big = 'eeeeeeee-2222-4333-8444-555555555555';
  const old = 'ffffffff-2222-4333-8444-555555555555';
  const { projectDir, dir, ctx } = smallStore({
    [`chatSessions/${big}.jsonl`]: session(big, [request('b1', 30, 'big', { response: [md('x'.repeat(9 * 1024 * 1024))] })]),
    [`chatSessions/${old}.jsonl`]: session(old, [request('o1', 10, 'older')]),
  });
  utimesSync(join(dir, 'chatSessions', `${big}.jsonl`), new Date(t(31)), new Date(t(31)));
  utimesSync(join(dir, 'chatSessions', `${old}.jsonl`), new Date(t(11)), new Date(t(11)));
  const byId = Object.fromEntries((await copilot.findSessions(resolveProject(projectDir), ctx)).map((c) => [c.id, c]));
  assert.equal(byId[big].lastActivity, t(30) + 1000);
  assert.equal(byId[old].lastActivity, t(10) + 1000, 'activity from the request record, not the mtime');
  assert.equal(byId[old].score, 3);
});

test('copilotcli sessions are left to the copilot-cli adapter', async () => {
  const { user } = fixture();
  const file = join(user, 'workspaceStorage', 'a1', 'chatSessions', `${CLI}.jsonl`);
  const { events } = await copilot.loadSession({ id: CLI, ref: { file } }, {});
  assert.deepEqual(events, []);
});

test('user data roots follow VS Code per OS', () => {
  const home = tempDir('copass-home-');
  writeTree(home, { 'Library/Application Support/Code - Insiders/User/x': '', '.config/VSCodium/User/x': '', 'roaming/Code/User/x': '' });
  const dirs = (platform, env = {}) => copilot.userDirs({ home, platform, env, now: 0 });
  assert.deepEqual(dirs('darwin'), [join(home, 'Library/Application Support/Code - Insiders/User')]);
  assert.deepEqual(dirs('linux'), [join(home, '.config/VSCodium/User')]);
  assert.deepEqual(dirs('win32', { APPDATA: join(home, 'roaming') }), [join(home, 'roaming/Code/User')]);
});

test('launch opens Copilot Chat in agent mode with the prompt', () => {
  assert.deepEqual(copilot.launch('hi'), ['code', ['chat', '--mode', 'agent', 'hi']]);
});
