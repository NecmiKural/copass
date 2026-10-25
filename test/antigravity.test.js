import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import * as agy from '../agents/antigravity.js';
import { assemble } from '../lib/assemble.js';
import { resolveProject } from '../lib/project.js';
import { fixtureContext, tempDir, writeTree } from './helpers.js';

// The fixture indexes are written with node:sqlite directly; keep its ExperimentalWarning out of the output.
const emitWarning = process.emitWarning;
process.emitWarning = () => {};
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emitWarning;

const ID = '11111111-2222-4333-8444-555555555555';
const SUB = '22222222-2222-4333-8444-555555555555';
const EMPTY = '33333333-2222-4333-8444-555555555555';
const SIBLING = '44444444-2222-4333-8444-555555555555';
const LOOSE = '55555555-2222-4333-8444-555555555555'; // no workspace; its tools worked in the project
const ELSEWHERE = '66666666-2222-4333-8444-555555555555'; // no workspace; mostly another repo
const STUB = '77777777-2222-4333-8444-555555555555';
const LATE = '88888888-2222-4333-8444-555555555555'; // in brain/ but not yet in the index
const PB_ID = '99999999-2222-4333-8444-555555555555';
const PB_SUB = 'aaaaaaaa-2222-4333-8444-555555555555';
const SCAN_ID = 'bbbbbbbb-2222-4333-8444-555555555555';

const t = (m) => Date.UTC(2026, 0, 15, 9, m);
const iso = (m) => new Date(t(m)).toISOString();
const dbTime = (m) => `${new Date(t(m)).toISOString().replace('T', ' ').replace('Z', '')}000+00:00`;

// ── A minimal protobuf encoder for the synthetic summaries ──────────────
function varint(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}
const field = (n, v) =>
  typeof v === 'number'
    ? Buffer.concat([varint(n * 8), varint(v)])
    : Buffer.concat([varint(n * 8 + 2), varint(Buffer.byteLength(v)), Buffer.from(v)]);
const msg = (...parts) => Buffer.concat(parts);
const stamp = (m) => msg(field(1, Math.floor(t(m) / 1000)));

function summary({ title, uri, branch, steps = 10, parent, created = 0, input = 0 }) {
  return msg(
    field(1, title),
    field(2, steps),
    field(3, stamp(input)),
    field(7, stamp(created)),
    ...(uri ? [field(9, msg(field(1, uri), ...(branch ? [field(4, branch)] : [])))] : []),
    field(10, stamp(input)),
    field(17, msg(...(parent ? [field(5, parent)] : []))),
  );
}

const userInput = (i, m, text, extra = {}) => ({ step_index: i, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(m), content: text, ...extra });
const planner = (i, m, content, calls, extra = {}) => ({ step_index: i, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(m), ...(content ? { content } : {}), ...(calls ? { tool_calls: calls } : {}), ...extra });
const result = (i, m, type, content, extra = {}) => ({ step_index: i, source: 'MODEL', type, status: 'DONE', created_at: iso(m), content, ...extra });
const system = (i, m, type, extra) => ({ step_index: i, source: 'SYSTEM', type, status: 'DONE', created_at: iso(m), ...extra });
const logs = (id) => `brain/${id}/.system_generated/logs`;

const META = '<ADDITIONAL_METADATA>\nThe current local time is: 2026-01-15T22:00:00+13:00.\nActive Document: /tmp/a.ts\n</ADDITIONAL_METADATA>';
const MODEL_SWITCH = '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment on this change.\n</USER_SETTINGS_CHANGE>';
const HEADER = `Created At: ${iso(1)}\nCompleted At: ${iso(1)}\n`;

function mainTranscript(projectDir, home) {
  return [
    // step 0 only survives in the lossy copy (transcript_full starts late)
    system(1, 1, 'CONVERSATION_HISTORY', { content: '<conversation_summaries> # Conversation History of other chats' }),
    planner(2, 2, 'Looking at the parser.', [
      { name: 'run_command', args: { CommandLine: 'npm test', Cwd: projectDir, toolSummary: 'run tests' } },
      { name: 'view_file', args: { AbsolutePath: `${projectDir}/parser.js` } },
    ], { thinking: 'secret thoughts' }),
    result(3, 2, 'RUN_COMMAND', `${HEADER}\n\t\t\t\tThe command failed with exit code: 1\n\t\t\t\tOutput:\n1 test failed: parser.spec.js\n`),
    result(4, 2, 'VIEW_FILE', `${HEADER}file body`),
    system(5, 2, 'CHECKPOINT', { content: '{{ CHECKPOINT 0 }}\n**The earlier parts of this conversation have been truncated**\n# USER Objective: fix the parser' }),
    planner(6, 3, null, [
      { name: 'replace_file_content', args: { TargetFile: `${projectDir}/parser.js` } },
      { name: 'write_to_file', args: { TargetFile: join(home, '.gemini/antigravity', logs(ID), '../../task.md'), IsArtifact: true } },
    ]),
    result(7, 3, 'CODE_ACTION', 'edited'),
    result(8, 3, 'GENERIC', 'written'),
    planner(9, 4, 'Fixed the tokenizer.'),
    { step_index: 10, source: 'USER_EXPLICIT', type: 'CODE_ACTION', status: 'DONE', created_at: iso(5), content: 'a user-side code action' },
    userInput(11, 6, `Comments on artifact URI: file:///tmp/implementation_plan.md\nComment: use a lexer table\n<USER_REQUEST>\n</USER_REQUEST>\n${META}`),
    planner(12, 7, null, [{ name: 'ask_question', args: { questions: [{ question: 'Which lexer?', options: ['table', 'regex'] }] } }]),
    result(13, 8, 'ASK_QUESTION', `${HEADER}A1: table`),
    system(14, 9, 'CHECKPOINT', { content: '# Resuming from a compaction\nYou are continuing work on the parser task.' }),
    system(15, 10, 'ERROR_MESSAGE', { error: 'API error (attempt 1): request failed: connection refused' }),
    planner(16, 11, 'Retrying after the error.'),
    userInput(17, 12, `<USER_REQUEST>\nNow also handle unicode identifiers\n</USER_REQUEST>\n${META}`),
    system(18, 13, 'ERROR_MESSAGE', { error: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 1h30m.' }),
  ];
}

function looseTranscript(dir, m) {
  return [
    userInput(0, m, '<USER_REQUEST>\nlook around\n</USER_REQUEST>'),
    planner(1, m, null, [
      { name: 'view_file', args: { AbsolutePath: `${dir}/a.js` } },
      { name: 'list_dir', args: { DirectoryPath: dir } },
      { name: 'run_command', args: { CommandLine: 'ls', Cwd: dir } },
    ]),
  ];
}

function writeIndex(path, rows) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '',
    workspace_uris text NOT NULL, last_user_input_time datetime NOT NULL, last_modified_time datetime NOT NULL,
    nesting_depth integer NOT NULL DEFAULT 0, step_count integer NOT NULL DEFAULT 0, raw_summary blob)`);
  const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) insert.run(r.id, r.title ?? '', r.ws, r.lu, r.lm, r.depth ?? 0, r.steps ?? 10, r.rs ?? null);
  db.close();
}

function writeModelDb(path, model) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE gen_metadata (idx integer, data blob, size integer)');
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(0, msg(field(3, msg(field(28, model)))), 0);
  db.close();
}

function fixture() {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'my_app.v2');
  const other = join(tempDir('copass-other-'), 'other');
  writeTree(projectDir, { 'README.md': 'x' });
  const root = join(home, '.gemini/antigravity');
  const uri = pathToFileURL(projectDir).href;
  writeTree(root, {
    [`${logs(ID)}/transcript_full.jsonl`]: mainTranscript(projectDir, home),
    [`${logs(ID)}/transcript.jsonl`]: [
      userInput(0, 1, `<USER_REQUEST>\nFix the parser. Don't change the API.\n</USER_REQUEST>\n${META}\n${MODEL_SWITCH}`, { media: [{ mime_type: 'image/png', uri: 'file:///tmp/x.png' }] }),
      system(1, 1, 'CONVERSATION_HISTORY', { content: 'a truncated copy that _full overrides', truncated_fields: ['content'] }),
    ],
    [`brain/${ID}/task.md`]: '# Task\n- [x] fix tokenizer\n- [/] fix tests\n- [ ] update docs\n',
    [`brain/${ID}/task.md.metadata.json`]: { summary: 'task list', updatedAt: iso(12) },
    [`${logs(SUB)}/transcript_full.jsonl`]: [userInput(0, 40, '<USER_REQUEST>\nresearch\n</USER_REQUEST>')],
    [`${logs(SIBLING)}/transcript_full.jsonl`]: [userInput(0, 40, '<USER_REQUEST>\nhi\n</USER_REQUEST>')],
    [`${logs(LOOSE)}/transcript_full.jsonl`]: looseTranscript(projectDir, 5),
    [`${logs(ELSEWHERE)}/transcript_full.jsonl`]: [
      ...looseTranscript(other, 30),
      planner(2, 30, null, [{ name: 'view_file', args: { AbsolutePath: `${projectDir}/README.md` } }]),
    ],
    [`${logs(STUB)}/transcript_full.jsonl`]: [system(0, 40, 'SYSTEM_MESSAGE', { content: '<SYSTEM_MESSAGE>x</SYSTEM_MESSAGE>' })],
    [`${logs(LATE)}/transcript_full.jsonl`]: looseTranscript(projectDir, 50),
    'brain/tempmediaStorage/x.png': 'not a conversation',
    'conversations/.keep': '',
  });
  writeIndex(join(root, 'conversation_summaries.db'), [
    { id: ID, ws: JSON.stringify([uri]), lu: dbTime(12), lm: dbTime(13), rs: summary({ title: 'Parser fixes', uri, branch: 'feature/x', created: 1, input: 12 }) },
    { id: SUB, ws: JSON.stringify([uri]), lu: dbTime(40), lm: dbTime(40), depth: 1, rs: summary({ title: 'research', uri, parent: ID }) },
    { id: EMPTY, ws: JSON.stringify([uri]), lu: '0001-01-01 00:00:00+00:00', lm: dbTime(40), steps: 0 },
    // '/x/my_app.v2-old' starts with the project path but is another directory.
    { id: SIBLING, ws: JSON.stringify([pathToFileURL(`${projectDir}-old`).href]), lu: dbTime(40), lm: dbTime(40) },
    { id: LOOSE, ws: '', lu: '0001-01-01 00:00:00+00:00', lm: dbTime(5) },
    { id: ELSEWHERE, ws: '', lu: dbTime(30), lm: dbTime(30) },
    { id: STUB, ws: JSON.stringify([uri]), lu: dbTime(40), lm: dbTime(40) },
  ]);
  writeModelDb(join(root, 'conversations', `${LOOSE}.db`), 'gemini-3.8-flash-high');
  return { home, projectDir, root };
}

test('finds project conversations from the index, skipping subagents, stubs and look-alike folders', async () => {
  const { home, projectDir } = fixture();
  const project = resolveProject(projectDir);
  const found = await agy.findSessions(project, fixtureContext(home));
  assert.deepEqual(found.map((c) => c.id), [LATE, ID, LOOSE]);
  const main = found.find((c) => c.id === ID);
  assert.equal(main.title, 'Parser fixes');
  assert.equal(main.score, 3);
  assert.equal(main.cwd, projectDir);
  assert.equal(main.lastActivity, t(12), 'activity = last user/assistant step, not the error after it');
  assert.equal(main.current, false);

  const self = await agy.findSessions(project, fixtureContext(home, { ANTIGRAVITY_CONVERSATION_ID: ID }));
  assert.equal(self.find((c) => c.id === ID).current, true);
});

test('loads clean prompts, tool outcomes, plan, compaction and the quota stop', async () => {
  const { home, projectDir } = fixture();
  const ctx = fixtureContext(home);
  const candidate = (await agy.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === ID);
  const { meta, events } = await agy.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), [
    "Fix the parser. Don't change the API.\n[image attached]",
    'Comments on artifact URI: file:///tmp/implementation_plan.md\nComment: use a lexer table',
    'A1: table',
    'Now also handle unicode identifiers',
  ]);
  assert.equal(s.latest.started, false);
  assert.equal(s.stop.reason, 'quota');
  assert.equal(s.stop.resetsAt, t(13) + 90 * 60_000);
  assert.equal(events.filter((e) => e.kind === 'stop').length, 1, 'the retried API error is not a stop');
  assert.equal(events.filter((e) => e.kind === 'compaction').length, 1, 'the CHECKPOINT 0 anchor is not a compaction');
  assert.match(s.compaction.summary, /^# Resuming from a compaction/);
  assert.deepEqual(s.files.map((f) => f.path), [`${projectDir}/parser.js`], "the agent's own task.md is not a project file");
  assert.equal(s.failures[0].target, 'npm test');
  assert.equal(s.failures[0].exit, 1);
  assert.equal(s.failures[0].error, '1 test failed: parser.spec.js');
  assert.deepEqual(s.plan.items.map((i) => i.status), ['done', 'active', 'pending']);
  assert.ok(events.some((e) => e.kind === 'reply' && e.final && e.text === 'Fixed the tokenizer.'));
  assert.ok(events.some((e) => e.kind === 'reply' && e.text.startsWith('Which lexer?\n- table')));
  assert.ok(!JSON.stringify(events).includes('secret thoughts'));
  assert.ok(!JSON.stringify(events).includes('Conversation History'));
  assert.equal(meta.model, 'Gemini 3.8 Flash (High)');
  assert.equal(meta.branch, 'feature/x');
  assert.equal(meta.startedAt, t(1));
  assert.equal(meta.resumeCommand, `agy --conversation ${ID}`);
  assert.match(meta.logFile, /transcript_full\.jsonl$/);
});

test('a conversation without a workspace takes its model from the conversation database', async () => {
  const { home, projectDir } = fixture();
  const ctx = fixtureContext(home);
  const candidate = (await agy.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === LOOSE);
  assert.equal(candidate.score, 3);
  const { meta } = await agy.loadSession(candidate, ctx);
  assert.equal(meta.model, 'gemini-3.8-flash-high');
});

test('falls back to the protobuf index, then to scanning brain/', async () => {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'app');
  writeTree(projectDir, { 'README.md': 'x' });
  const uri = pathToFileURL(projectDir).href;
  const entry = (id, s) => field(1, msg(field(1, id), field(2, s)));
  writeTree(join(home, '.gemini/antigravity-cli'), {
    [`${logs(PB_ID)}/transcript_full.jsonl`]: [userInput(0, 20, '<USER_REQUEST>\nfrom the CLI\n</USER_REQUEST>')],
    [`${logs(PB_SUB)}/transcript_full.jsonl`]: [userInput(0, 30, '<USER_REQUEST>\nsubagent\n</USER_REQUEST>')],
  });
  writeTree(join(home, '.gemini/jetski'), { [`${logs(SCAN_ID)}/transcript_full.jsonl`]: looseTranscript(projectDir, 10) });
  // writeTree writes text; the index is binary.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    join(home, '.gemini/antigravity-cli/agyhub_summaries_proto.pb'),
    msg(entry(PB_ID, summary({ title: 'CLI run', uri, branch: 'main' })), entry(PB_SUB, summary({ title: 'sub', uri, parent: PB_ID }))),
  );
  const found = await agy.findSessions(resolveProject(projectDir), fixtureContext(home));
  assert.deepEqual(found.map((c) => [c.id, c.title]), [[PB_ID, 'CLI run'], [SCAN_ID, undefined]]);
});

test('prompt text survives inputs cut short in the lossy transcript copy', () => {
  assert.equal(agy.promptText('<USER_REQUEST>\nfix the <truncated 120 bytes>', undefined), 'fix the …');
  assert.equal(agy.promptText('<USER_REQUEST>\nfix it\n<ADDITIONAL_METADATA>\nThe current local', undefined), 'fix it');
  assert.equal(agy.promptText(`plain text\n${META}`, [{}, {}]), 'plain text\n[2 images attached]');
});

test('launch starts agy interactively with the prompt', () => {
  assert.deepEqual(agy.launch('hi'), ['agy', ['-i', 'hi']]);
});

// ── Regressions found on real data in review ────────────────────────────

const REVIEW = 'cccccccc-2222-4333-8444-555555555555';
const STALE = 'dddddddd-2222-4333-8444-555555555555'; // index says step_count 0, but the log has a real turn
const TRAJECTORY = 'eeeeeeee-2222-4333-8444-555555555555';
const ARTIFACTS = 'ffffffff-2222-4333-8444-555555555555'; // no workspace; mostly writes its own plan files
const NOTICE =
  'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] task-7 finished\n</SYSTEM_MESSAGE>';

function reviewFixture() {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'app');
  writeTree(projectDir, { 'README.md': 'x' });
  const root = join(home, '.gemini/antigravity');
  const uri = pathToFileURL(projectDir).href;
  writeTree(root, {
    [`${logs(REVIEW)}/transcript_full.jsonl`]: [
      userInput(0, 1, '<USER_REQUEST>\nread the big files and refactor\n</USER_REQUEST>'),
      planner(1, 1, null, [{ name: 'view_file', args: { AbsolutePath: `${projectDir}/big.js` } }]),
      result(2, 1, 'GENERIC', 'huge file body'),
      // The first turn overflowed: a CHECKPOINT 0 that carries a real summary, not the '# USER Objective:' anchor.
      system(3, 2, 'CHECKPOINT', { content: '{{ CHECKPOINT 0 }}\n# User Requests\n- refactor\n# Previous Session Summary:\nRead big.js.' }),
      planner(4, 3, `Build started.\n\n${NOTICE}\n\nThe build finished, running the tests now.`, [
        { name: 'run_command', args: { CommandLine: 'npm run build', Cwd: projectDir } },
        { name: 'run_command', args: { CommandLine: 'npm test', Cwd: projectDir } },
        { name: 'run_command', args: { Cwd: projectDir } },
        { name: 'search_web', args: { query: 'lexer tables' } },
      ]),
      result(5, 3, 'RUN_COMMAND', `${HEADER}\n\t\tEncountered error in step execution: sandbox denied`, { status: 'ERROR' }),
      result(6, 3, 'GENERIC', `${HEADER}Command exited with code 2.\n\nCommand output:\nTypeError: x is undefined\n`),
      result(7, 3, 'GENERIC', 'Error in tool call: missing parameter CommandLine', { status: 'INVALID' }),
      result(8, 3, 'SEARCH_WEB', 'results'),
    ],
    [`${logs(STALE)}/overview.txt`]: [userInput(0, 0, '<USER_REQUEST>\nold question\n</USER_REQUEST>'), planner(1, 0, 'old answer')],
    [`${logs(ARTIFACTS)}/transcript_full.jsonl`]: [
      userInput(0, -2, '<USER_REQUEST>\nplan the refactor\n</USER_REQUEST>'),
      planner(1, -1, null, [
        { name: 'view_file', args: { AbsolutePath: `${projectDir}/a.js` } },
        { name: 'run_command', args: { CommandLine: 'ls', Cwd: projectDir } },
        ...['task.md', 'implementation_plan.md', 'walkthrough.md'].map((f) => ({
          name: 'write_to_file',
          args: { TargetFile: join(root, 'brain', ARTIFACTS, f), IsArtifact: true },
        })),
      ]),
    ],
    'conversations/.keep': '',
  });
  writeIndex(join(root, 'conversation_summaries.db'), [
    { id: ARTIFACTS, ws: '', lu: dbTime(-2), lm: dbTime(-1) },
    { id: REVIEW, ws: JSON.stringify([uri]), lu: dbTime(1), lm: dbTime(3) },
    { id: STALE, ws: JSON.stringify([uri]), lu: '0001-01-01 00:00:00+00:00', lm: '0001-01-01 00:00:00+00:00', steps: 0 },
  ]);
  const db = new DatabaseSync(join(root, 'conversations', `${REVIEW}.db`));
  db.exec('CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer, source integer)');
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 4, 22)').run(TRAJECTORY, REVIEW);
  db.close();
  return { home, projectDir };
}

test('a CHECKPOINT 0 holding a real summary is a compaction; harness notices and result headers are stripped', async () => {
  const { home, projectDir } = reviewFixture();
  const ctx = fixtureContext(home);
  const found = await agy.findSessions(resolveProject(projectDir), ctx);
  assert.deepEqual(found.map((c) => c.id), [REVIEW, STALE, ARTIFACTS], 'step_count 0 in a stale index row does not hide a real conversation');
  assert.equal(found[2].score, 3, "the agent's own plan files do not outvote the project folder");
  const { meta, events } = await agy.loadSession(found[0], ctx);
  const s = assemble(meta, events);

  assert.equal(s.compaction?.summary, '# User Requests\n- refactor\n# Previous Session Summary:\nRead big.js.');
  const reply = events.find((e) => e.kind === 'reply');
  assert.equal(reply.text, 'Build started.\n\nThe build finished, running the tests now.');
  const [sandbox, build, invalid, search] = events.filter((e) => e.kind === 'tool' && e.tool !== 'view_file');
  assert.deepEqual([sandbox.ok, sandbox.error], [false, 'Encountered error in step execution: sandbox denied']);
  assert.deepEqual([build.ok, build.exit, build.error], [false, 2, 'TypeError: x is undefined']);
  assert.equal(invalid.ok, false);
  assert.deepEqual([search.action, search.target, search.ok], ['search', 'lexer tables', true]);
});

test('current comes from the trajectory id Antigravity gives the commands it runs', async () => {
  const { home, projectDir } = reviewFixture();
  const found = await agy.findSessions(resolveProject(projectDir), fixtureContext(home, { ANTIGRAVITY_TRAJECTORY_ID: TRAJECTORY }));
  assert.deepEqual(found.map((c) => [c.id, c.current]), [[REVIEW, true], [STALE, false], [ARTIFACTS, false]]);
  const other = await agy.findSessions(resolveProject(projectDir), fixtureContext(home, { ANTIGRAVITY_TRAJECTORY_ID: 'ffffffff-0000-4000-8000-000000000000' }));
  assert.ok(other.every((c) => !c.current));
});
