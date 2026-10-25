import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import * as zlib from 'node:zlib';

import * as codex from '../agents/codex.js';
import { assemble } from '../lib/assemble.js';
import { resolveProject } from '../lib/project.js';
import { openReadOnly } from '../lib/sqlite.js';
import { fixtureContext, tempDir, writeTree } from './helpers.js';

const ID = '019a0000-0000-7000-8000-000000000001';
const LEGACY = '019a0000-0000-7000-8000-000000000002';
const STUB = '019a0000-0000-7000-8000-000000000003';
const SUB = '019a0000-0000-7000-8000-000000000004';
const EXEC = '019a0000-0000-7000-8000-000000000005';
const IMPORTED = '019a0000-0000-7000-8000-000000000006';
const CLAUDE_COPY = '019a0000-0000-7000-8000-000000000007';
const ARCHIVED = '019a0000-0000-7000-8000-000000000008';
const OTHER = '019a0000-0000-7000-8000-000000000009';

const t = (day, m) => new Date(Date.UTC(2026, 0, day, 9, m)).toISOString();
const rec = (timestamp, type, payload) => ({ timestamp, type, payload });
const meta = (ts, id, cwd, extra = {}) =>
  rec(ts, 'session_meta', { id, timestamp: ts, cwd, originator: 'codex_vscode', cli_version: '0.131.0', source: 'vscode', base_instructions: { text: 'x'.repeat(30000) }, ...extra });
const turnContext = (ts, cwd) => rec(ts, 'turn_context', { cwd, model: 'gpt-5.5', effort: 'high' });
const userItem = (ts, text, extra = []) =>
  rec(ts, 'event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: `u-${ts}`, content: [{ type: 'text', text, text_elements: [] }, ...extra] } });
const userMirror = (ts, text) => rec(ts, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const assistant = (ts, text, phase) => rec(ts, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], ...(phase && { phase }) });
const call = (ts, callId, name, args) => rec(ts, 'response_item', { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) });
const output = (ts, callId, text) => rec(ts, 'response_item', { type: 'function_call_output', call_id: callId, output: text });
const event = (ts, payload) => rec(ts, 'event_msg', payload);
const execOutput = (status, body) => `Chunk ID: a1\nWall time: 3.1 seconds\n${status}\nOriginal token count: 9\nOutput:\n${body}`;

/** The newest, paginated generation: prompts in item_completed, IDE wrapper, rollback, remote compaction, quota hit. */
function paginated(cwd) {
  const d = 15;
  return [
    meta(t(d, 0), ID, cwd, { history_mode: 'paginated', originator: 'Codex Desktop', git: { branch: 'feature/x', commit_hash: 'abc123', repository_url: 'git@example.com:me/app.git' } }),
    rec(t(d, 0), 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>sandboxed</permissions instructions>' }] }),
    userMirror(t(d, 0), `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>be nice</INSTRUCTIONS>`),
    userMirror(t(d, 0), `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>`),
    turnContext(t(d, 1), cwd),
    event(t(d, 1), { type: 'task_started', turn_id: 't1' }),
    userItem(t(d, 1), "# Context from my IDE setup:\n\n## Active file: src/a.ts\n\n## My request for Codex:\nFix the parser. Don't change the API."),
    userMirror(t(d, 1), 'Fix the parser.'),
    rec(t(d, 2), 'response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'secret thinking' }], encrypted_content: 'gAAA' }),
    assistant(t(d, 2), 'Looking at the parser.', 'commentary'),
    rec(t(d, 3), 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1', input: '*** Begin Patch\n*** Update File: src/parser.js\n@@\n-a\n+b\n*** End Patch' }),
    event(t(d, 3), { type: 'item_completed', item: { type: 'FileChange', id: 'c1', status: 'completed', changes: { [`${cwd}/src/parser.js`]: { type: 'update', unified_diff: '-a\n+b' } } } }),
    rec(t(d, 3), 'response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: JSON.stringify({ output: 'Success. Updated the following files:\nM src/parser.js', metadata: { exit_code: 0 } }) }),
    call(t(d, 4), 'c2', 'exec_command', { cmd: 'npm test', workdir: cwd }),
    output(t(d, 4), 'c2', execOutput('Process running with session ID 7', 'running…')),
    call(t(d, 5), 'c3', 'write_stdin', { session_id: 7, chars: '' }),
    output(t(d, 5), 'c3', execOutput('Process exited with code 1', '1 test failed: parser.spec.js')),
    call(t(d, 6), 'c4', 'update_plan', { plan: [{ step: 'fix tokenizer', status: 'completed' }, { step: 'fix tests', status: 'in_progress' }, { step: 'docs', status: 'pending' }] }),
    output(t(d, 6), 'c4', 'Plan updated'),
    assistant(t(d, 7), 'Parser fixed; one test still fails.', 'final_answer'),
    event(t(d, 7), { type: 'task_complete', turn_id: 't1', last_agent_message: 'Parser fixed; one test still fails.' }),
    rec(t(d, 8), 'compacted', { message: '', replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the parser.' }] }, { type: 'compaction', encrypted_content: 'gAAAA' }] }),
    event(t(d, 8), { type: 'item_completed', item: { type: 'ContextCompaction', id: 'cc1' } }),
    // A turn the user interrupted and then undid: none of it may survive.
    event(t(d, 10), { type: 'task_started', turn_id: 't2' }),
    userItem(t(d, 10), 'Try a completely different approach'),
    assistant(t(d, 11), 'Rewriting everything.', 'commentary'),
    event(t(d, 12), { type: 'turn_aborted', turn_id: 't2', reason: 'interrupted' }),
    userMirror(t(d, 12), '<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>'),
    event(t(d, 13), { type: 'thread_rolled_back', num_turns: 1 }),
    event(t(d, 14), { type: 'thread_name_updated', thread_id: ID, thread_name: 'Parser fixes' }),
    turnContext(t(d, 29), cwd),
    event(t(d, 29), { type: 'task_started', turn_id: 't3' }),
    userItem(t(d, 29), 'Now also handle unicode identifiers', [{ type: 'local_image', path: '/tmp/shot.png' }]),
    userMirror(t(d, 29), 'Now also handle unicode identifiers'),
    event(t(d, 30), { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 100, window_minutes: 300, resets_at: 1768500000 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1769000000 } } }),
    event(t(d, 30), { type: 'error', message: "You've hit your usage limit.", codex_error_info: 'usage_limit_exceeded' }),
    event(t(d, 30), { type: 'task_complete', turn_id: 't3', last_agent_message: null }),
  ];
}

/** The legacy generation: prompts in event_msg.user_message, structured end events, no reply phase, local compaction. */
function legacy(cwd) {
  const d = 14;
  return [
    meta(t(d, 0), LEGACY, cwd, { source: 'cli', originator: 'codex-tui' }),
    turnContext(t(d, 1), cwd),
    event(t(d, 1), { type: 'user_message', message: 'Add a --verbose flag', images: [], local_images: [], text_elements: [] }),
    userMirror(t(d, 1), 'Add a --verbose flag'),
    call(t(d, 2), 'l1', 'exec_command', { cmd: 'ls lib' }),
    event(t(d, 2), { type: 'exec_command_end', call_id: 'l1', exit_code: 0, stdout: 'cli.js', stderr: '', aggregated_output: 'cli.js' }),
    output(t(d, 2), 'l1', execOutput('Process exited with code 0', 'cli.js')),
    rec(t(d, 3), 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'l2', input: '*** Begin Patch\n*** Add File: lib/flag.js\n+x\n*** End Patch' }),
    event(t(d, 3), { type: 'patch_apply_end', call_id: 'l2', success: true, stdout: '', stderr: '', changes: { [`${cwd}/lib/flag.js`]: { type: 'add', content: 'x' } } }),
    assistant(t(d, 4), 'Added the flag.'),
    event(t(d, 4), { type: 'agent_message', message: 'Added the flag.' }),
    event(t(d, 4), { type: 'task_complete', turn_id: 'l', last_agent_message: 'Added the flag.' }),
    rec(t(d, 5), 'compacted', {
      message:
        'Another language model started to solve this problem and produced a summary of its thinking process. Here is the summary:\nThe user wants a verbose flag.',
      replacement_history: [],
    }),
  ];
}

/** A minimal thread that Codex ran: one prompt and one reply. */
function simple(id, cwd, day, extra = {}, { ranTurn = true } = {}) {
  return [
    meta(t(day, 0), id, cwd, extra),
    ...(ranTurn ? [turnContext(t(day, 1), cwd)] : []),
    userItem(t(day, 1), `prompt of ${id}`),
    assistant(t(day, 2), 'done', 'final_answer'),
  ];
}

const rollout = (day, id, ext = 'jsonl') => `.codex/sessions/2026/01/${day}/rollout-2026-01-${day}T09-00-00-${id}.${ext}`;

function fixture({ zstd = true } = {}) {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'app');
  writeTree(projectDir, { 'README.md': 'x', 'sub/.keep': '' });
  const other = tempDir('copass-other-');
  const legacyLines = legacy(join(projectDir, 'sub'));
  const files = {
    [rollout(15, ID)]: paginated(projectDir),
    [rollout(16, STUB)]: [meta(t(16, 0), STUB, projectDir, { originator: 'Codex Desktop' })],
    [rollout(16, SUB)]: simple(SUB, projectDir, 16, { source: { subagent: { thread_spawn: { parent_thread_id: ID, depth: 1 } } } }),
    [rollout(13, EXEC)]: simple(EXEC, projectDir, 13, { source: 'exec', originator: 'codex_exec' }),
    [rollout(16, IMPORTED)]: simple(IMPORTED, projectDir, 16),
    [rollout(16, CLAUDE_COPY)]: simple(CLAUDE_COPY, projectDir, 16, {}, { ranTurn: false }),
    [rollout(16, OTHER)]: simple(OTHER, other, 16),
    [`.codex/archived_sessions/rollout-2026-01-16T09-00-00-${ARCHIVED}.jsonl`]: simple(ARCHIVED, projectDir, 16),
    [rollout(16, `x-${ID}`, 'jsonl.paginated.tmp')]: simple(ID, projectDir, 16),
    '.codex/external_agent_session_imports.json': { records: [{ source_path: '/x.jsonl', content_sha256: 'f', imported_thread_id: IMPORTED, imported_at: 1 }] },
  };
  // Codex compresses rollouts older than 7 days to .jsonl.zst (Node >= 22.15 can read them).
  const canZstd = zstd && typeof zlib.zstdCompressSync === 'function';
  if (!canZstd) files[rollout(14, LEGACY)] = legacyLines;
  writeTree(home, files);
  if (canZstd) {
    const text = `${legacyLines.map((o) => JSON.stringify(o)).join('\n')}\n`;
    const path = join(home, rollout(14, LEGACY, 'jsonl.zst'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, zlib.zstdCompressSync(Buffer.from(text)));
  }
  return { home, projectDir };
}

test('cleanPrompt keeps only what the user typed', () => {
  assert.equal(codex.cleanPrompt('# Context from my IDE setup:\n\n## Open tabs:\n- a.ts\n\n## My request for Codex:\n  do it\n'), 'do it');
  assert.equal(codex.cleanPrompt('# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>…</INSTRUCTIONS>'), '');
  assert.equal(codex.cleanPrompt('<environment_context>\n<cwd>/x</cwd>\n</environment_context>'), '');
  assert.equal(codex.cleanPrompt('<skill>\n<name>graphify</name>\n</skill>'), '');
  assert.equal(codex.cleanPrompt('<skills_instructions>…</skills_instructions>'), '');
  assert.equal(codex.cleanPrompt('<ide_opened_file>The user opened a.ts</ide_opened_file>fix this'), 'fix this');
  assert.equal(codex.cleanPrompt('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>PR 7</command-args>'), '/review PR 7');
  assert.equal(codex.cleanPrompt('$graphify map the repo'), '$graphify map the repo');
});

test('finds interactive sessions, skips stubs, subagents, imports, archived and unrelated ones', async () => {
  const { home, projectDir } = fixture();
  const project = resolveProject(projectDir);
  const found = await codex.findSessions(project, fixtureContext(home));

  assert.deepEqual(found.map((c) => c.id), [ID, LEGACY, EXEC]);
  const [main, old, exec] = found;
  assert.equal(main.score, 3);
  assert.equal(old.score, 1, 'started in a subdirectory');
  assert.equal(main.lastActivity, Date.parse(t(15, 29)), 'activity = last real prompt, not the error, token count or metadata');
  assert.equal(main.preview, "Fix the parser. Don't change the API.");
  assert.equal(old.preview, 'Add a --verbose flag');
  assert.equal(exec.background, true);
  assert.equal(main.background, false);
  assert.ok(!found.some((c) => c.current));

  const self = await codex.findSessions(project, fixtureContext(home, { CODEX_THREAD_ID: ID }));
  assert.equal(self.find((c) => c.id === ID).current, true);

  const moved = await codex.findSessions(project, fixtureContext(tempDir('copass-empty-'), { CODEX_HOME: join(home, '.codex') }));
  assert.equal(moved.length, 3, 'CODEX_HOME overrides ~/.codex');
});

test('loads prompts, replies, tools, plan, compaction and the quota stop of a paginated session', async () => {
  const { home, projectDir } = fixture();
  const ctx = fixtureContext(home);
  const [candidate] = await codex.findSessions(resolveProject(projectDir), ctx);
  const { meta, events } = await codex.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), ["Fix the parser. Don't change the API.", 'Now also handle unicode identifiers\n[image attached]']);
  assert.ok(!events.some((e) => /different approach|Rewriting/.test(e.text ?? '')), 'rolled-back turn removed');
  assert.ok(!events.some((e) => /thinking|AGENTS|environment_context/.test(e.text ?? '')), 'no reasoning or injected context');
  assert.equal(s.latest.started, false);
  assert.equal(s.stop.reason, 'quota');
  assert.equal(s.stop.resetsAt, 1768500000 * 1000, 'reset time of the exhausted window');
  assert.equal(s.compaction.encrypted, true);
  assert.equal(s.compaction.summary, undefined);
  assert.deepEqual(s.files.map((f) => f.path), [`${projectDir}/src/parser.js`]);
  assert.deepEqual(s.commands.map((c) => [c.target, c.ok, c.exit]), [['npm test', false, 1]]);
  assert.equal(s.failures[0].error, '1 test failed: parser.spec.js');
  assert.deepEqual(s.plan.items.map((i) => i.status), ['done', 'active', 'pending']);
  const replies = events.filter((e) => e.kind === 'reply');
  assert.deepEqual(replies.map((r) => r.final), [false, true]);

  assert.equal(meta.title, 'Parser fixes');
  assert.equal(meta.model, 'gpt-5.5');
  assert.equal(meta.branch, 'feature/x');
  assert.equal(meta.commit, 'abc123');
  assert.equal(meta.startedAt, Date.parse(t(15, 0)));
  assert.equal(meta.resumeCommand, `codex resume ${ID}`);
  assert.ok(!existsSync(join(home, '.codex', 'queue_1.sqlite')), 'never creates files in the agent store');
});

test('loads a legacy (and zstd-compressed) session: user_message prompts, end events, local compaction', async () => {
  const { home, projectDir } = fixture();
  const ctx = fixtureContext(home);
  const candidate = (await codex.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === LEGACY);
  const { meta, events } = await codex.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), ['Add a --verbose flag']);
  assert.equal(s.compaction.summary, 'The user wants a verbose flag.');
  assert.deepEqual(s.files.map((f) => f.path), [`${projectDir}/sub/lib/flag.js`]);
  assert.deepEqual(s.commands.map((c) => [c.target, c.ok, c.exit]), [['ls lib', true, 0]]);
  assert.equal(events.filter((e) => e.kind === 'reply').length, 1, 'agent_message duplicates are ignored');
  assert.equal(s.latest.answered, true);
  assert.equal(events.find((e) => e.kind === 'reply').final, true, 'no phase: the reply before task_complete is final');
  assert.equal(meta.branch, undefined);
});

test('uses the SQLite thread index and the queue when they exist', async (tc) => {
  const { home, projectDir } = fixture({ zstd: false });
  await openReadOnly(join(home, 'warm-up.sqlite')); // loads node:sqlite with its warning suppressed
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    tc.skip('node:sqlite unavailable');
    return;
  }
  const dir = join(home, '.codex');
  const state = new DatabaseSync(join(dir, 'state_5.sqlite'));
  state.exec(`CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, source TEXT, title TEXT, name TEXT,
    first_user_message TEXT, archived INTEGER, model TEXT)`);
  const insert = state.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run(ID, join(home, rollout(15, ID)), projectDir, 'vscode', 'Fix the parser', 'From the index', 'Fix the parser', 0, 'gpt-5.5');
  insert.run(CLAUDE_COPY, join(home, rollout(16, CLAUDE_COPY)), projectDir, 'vscode', 'x', null, 'x', 0, null);
  insert.run(LEGACY, join(home, rollout(14, LEGACY)), join(projectDir, 'sub'), 'cli', 'x', null, 'x', 1, 'gpt-5.5');
  insert.run(SUB, join(home, rollout(16, SUB)), projectDir, JSON.stringify({ subagent: 'memory_consolidation' }), 'x', null, 'x', 0, 'gpt-5.5');
  state.close();
  const queue = new DatabaseSync(join(dir, 'queue_1.sqlite'));
  queue.exec('CREATE TABLE queued_items (id TEXT, thread_id TEXT, payload_json TEXT, queue_order INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)');
  const payload = JSON.stringify({ UserInput: { content: [{ type: 'text', text: 'and update the README', text_elements: [] }], client_id: null } });
  queue.prepare('INSERT INTO queued_items VALUES (?, ?, ?, ?, ?, ?)').run('q1', ID, payload, 0, Date.parse(t(15, 31)), 0);
  queue.close();
  const before = readFileSync(join(dir, 'state_5.sqlite'));

  const ctx = fixtureContext(home);
  const found = await codex.findSessions(resolveProject(projectDir), ctx);
  assert.deepEqual(found.map((c) => c.id), [ID], 'archived, model-less (never run) and subagent rows are skipped');
  assert.equal(found[0].title, 'From the index');
  assert.equal(found[0].lastActivity, Date.parse(t(15, 29)), 'recency from the rollout tail, not the index');

  const { meta, events } = await codex.loadSession(found[0], ctx);
  const s = assemble(meta, events);
  assert.deepEqual(s.latest.queued.map((q) => q.text), ['and update the README']);
  assert.deepEqual(readFileSync(join(dir, 'state_5.sqlite')), before, 'index opened read-only');
  rmSync(home, { recursive: true, force: true });
});

test('regressions: error tails without an Output marker, memory citations, per-limit reset times, copied threads', async () => {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'app');
  writeTree(projectDir, { 'README.md': 'x' });
  const d = 20;
  const window = (used, resetsAt) => ({ used_percent: used, window_minutes: 300, resets_at: resetsAt });
  const lines = (id) => [
    meta(t(d, 0), id, projectDir),
    turnContext(t(d, 1), projectDir),
    userItem(t(d, 1), 'Translate the strings'),
    rec(t(d, 2), 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p1', input: '*** Begin Patch\n*** Update File: a.arb\n@@\n-x\n+y\n*** End Patch' }),
    rec(t(d, 2), 'response_item', { type: 'custom_tool_call_output', call_id: 'p1', output: 'apply_patch verification failed: Failed to find expected lines in a.arb' }),
    assistant(t(d, 3), 'Done.\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[x]\n</citation_entries>\n</oai-mem-citation>', 'final_answer'),
    event(t(d, 3), { type: 'task_complete', turn_id: 't1' }),
    userItem(t(d, 4), 'Now the German ones'),
    // The 'codex' limit is exhausted; the 'premium' snapshot written right before the error has no windows.
    event(t(d, 5), { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: window(100, 1769000000), secondary: window(100, 1768000000) } }),
    event(t(d, 5), { type: 'token_count', info: null, rate_limits: { limit_id: 'premium', primary: null, secondary: null } }),
    event(t(d, 5), { type: 'error', message: "You've hit your usage limit.", codex_error_info: 'usage_limit_exceeded' }),
  ];
  const COPY = '019a0000-0000-7000-8000-00000000000a';
  // A restored clone: written later under a newer id, converted lossily (the error record is gone).
  writeTree(home, { [rollout(20, ID)]: lines(ID), [rollout(21, COPY)]: lines(COPY).filter((r) => r.payload.type !== 'error') });
  const ctx = fixtureContext(home);

  const found = await codex.findSessions(resolveProject(projectDir), ctx);
  assert.deepEqual(found.map((c) => c.id), [ID], 'a copy that ends on the same record is listed once, as the original');
  const loaded = await codex.loadSession(found[0], ctx);
  const { events } = loaded;
  const s = assemble(loaded.meta, events);

  assert.equal(s.failures.length, 1);
  assert.equal(s.failures[0].error, 'apply_patch verification failed: Failed to find expected lines in a.arb');
  assert.equal(events.find((e) => e.kind === 'reply').text, 'Done.', 'memory citations are not visible text');
  assert.equal(s.stop.reason, 'quota');
  assert.equal(s.stop.resetsAt, 1769000000 * 1000, "the exhausted window of the other limit; the one that already reset is ignored");
  rmSync(home, { recursive: true, force: true });
});

test('launches the interactive CLI with the prompt', () => {
  assert.deepEqual(codex.launch('continue'), ['codex', ['continue']]);
});
