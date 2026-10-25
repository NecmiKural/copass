import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import * as factory from '../agents/factory.js';
import { assemble } from '../lib/assemble.js';
import { resolveProject } from '../lib/project.js';
import { fixtureContext, tempDir, writeTree } from './helpers.js';

const ID = '11111111-2222-4333-8444-555555555555';
const STUB = '99999999-2222-4333-8444-555555555555';
const SUBAGENT = '88888888-2222-4333-8444-555555555555';
const OTHER = '77777777-2222-4333-8444-555555555555';
const SUBDIR = '66666666-2222-4333-8444-555555555555';
const RENAMED = '55555555-2222-4333-8444-555555555555';
const VARIANT = '44444444-2222-4333-8444-555555555555';
const LEGACY = '33333333-2222-4333-8444-555555555555';
const PROJECTS = '22222222-2222-4333-8444-555555555555';

const t = (m, s = 0) => new Date(Date.UTC(2026, 9, 25, 9, m, s)).toISOString();
let seq = 0;
const row = (ts, message, extra = {}) => ({ type: 'message', id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, timestamp: ts, ...extra, message });
const text = (s) => ({ type: 'text', text: s });
const user = (ts, content, extra) => row(ts, { role: 'user', content: typeof content === 'string' ? [text(content)] : content, ...extra });
const assistant = (ts, content, extra) => row(ts, { role: 'assistant', content, modelId: 'claude-sonnet-5', ...extra });
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const result = (id, content, isError = false) => ({ type: 'tool_result', tool_use_id: id, is_error: isError, content });
const start = (id, cwd, extra) => ({ type: 'session_start', id, title: 'New Session', owner: 'me', version: 2, cwd, hostId: 'host-1', isSessionTitleManuallySet: false, ...extra });
// droid injects its environment as a user row with visibility llm_only and a context- id
const context = (ts, body = '') =>
  row(ts, { role: 'user', content: [text(`<system-reminder>\nUser system info (darwin 25.2.0)\n\n% pwd\n/x\n${body}</system-reminder>`)], visibility: 'llm_only' }, { id: `context-${ID}` });

function fixture() {
  const home = tempDir('copass-home-');
  const projectDir = join(tempDir('copass-proj-'), 'my app.v2'); // a space and a dot survive in droid's folder names
  writeTree(projectDir, { 'README.md': 'x', 'pkg/index.js': 'x' });
  const store = `.factory/sessions/${factory.slug(projectDir)}`;
  const cwd = projectDir;
  writeTree(home, {
    [`${store}/${ID}.jsonl`]: [
      start(ID, cwd, { title: 'Fix the parser', sessionTitle: 'Parser tokenizer fixes', sessionTitleAutoStage: 'first_message' }),
      context(t(0), '\n% git status -b --porcelain | head -n1\n## feature/x...origin/feature/x [ahead 1]\n\n'),
      user(t(1), [text('<system-reminder>IMPORTANT: TodoWrite was not called yet.</system-reminder>'), text("Fix the parser. Don't change the API.")], { interactionMode: 'auto' }),
      assistant(t(2), [{ type: 'thinking', thinking: 'secret reasoning', signature: 'sig' }, text('Looking at the parser.'), use('tu1', 'Edit', { file_path: `${cwd}/parser.js`, old_str: 'a', new_str: 'b' })]),
      user(t(2, 5), [result('tu1', 'Edited')]),
      assistant(t(3), [use('tu2', 'Execute', { summary: 'Run tests', command: 'npm test', riskLevel: 'low', riskLevelReason: 'tests' })]),
      user(t(3, 5), [result('tu2', 'FAIL parser.spec.js\n1 test failed\n\n[Process exited with code 1]')]),
      assistant(t(4), [use('tu3', 'ApplyPatch', { input: '*** Begin Patch\n*** Update File: lib/a.js\n@@\n-x\n+y\n*** Add File: /abs/new.js\n+z\n*** End Patch' })]),
      user(t(4, 5), [result('tu3', 'Success')]),
      assistant(t(5), [use('tu4', 'TodoWrite', { todos: '1. [completed] fix tokenizer\n2. [in_progress] fix tests\n3. [pending] update docs' })]),
      { type: 'todo_state', id: 'todo-1', timestamp: t(5), todos: { todos: '1. [completed] fix tokenizer\n2. [in_progress] fix tests\n3. [pending] update docs' }, messageIndex: 9 },
      user(t(5, 5), [result('tu4', 'TODO List Updated')]),
      { type: 'compaction_state', id: 'cmp-1', timestamp: t(6), summaryText: 'Primary request: fix the parser.', summaryTokens: 900, summaryKind: 'manual', anchorMessage: 'x', removedCount: 9 },
      user(t(7), 'Now also handle unicode identifiers'),
      // the user cancels a tool whose assistant row was never persisted, then interrupts
      user(t(8), [result('gone', 'Error: Tool execution cancelled by user', true)], { visibility: 'user_only' }),
      user(t(8, 1), 'Request interrupted by user', { visibility: 'llm_only' }),
      user(t(8, 2), 'Request cancelled by user', { visibility: 'llm_only' }),
      assistant(t(9), [text('Unicode identifiers are handled.')]),
      user(t(10), 'and update the README'),
      user(t(11), 'You have reached your usage limit. Upgrade your plan to continue.', { visibility: 'user_only' }),
      context(t(20)), // injected again on resume: not activity
    ],
    // no prompt was ever typed
    [`${store}/${STUB}.jsonl`]: [start(STUB, cwd), context(t(0))],
    // a subagent run holds the parent's task, not a prompt
    [`${store}/${SUBAGENT}.jsonl`]: [start(SUBAGENT, cwd, { callingSessionId: ID }), user(t(1), 'subagent task'), assistant(t(2), [text('done')])],
    // a sibling sharing the folder-name prefix is told apart by its recorded cwd
    [`.factory/sessions/${factory.slug(`${projectDir}-backup`)}/${OTHER}.jsonl`]: [start(OTHER, `${projectDir}-backup`), user(t(1), 'hi')],
    [`.factory/sessions/${factory.slug(`${projectDir}/pkg`)}/${SUBDIR}.jsonl`]: [start(SUBDIR, `${cwd}/pkg`), user(t(30), 'work in a package'), assistant(t(31), [text('ok')])],
    [`${store}/${RENAMED}.jsonl`]: [start(RENAMED, cwd, { title: 'My rename', isSessionTitleManuallySet: true }), user(t(40), 'rename me'), row(t(41), { role: 'assistant', content: [text('ok')] })],
    // older builds wrote straight into sessions/; the hooks docs name projects/
    [`.factory/sessions/${LEGACY}.jsonl`]: [start(LEGACY, cwd), context(t(49), '\nModel: Kimi K2.6 [HF Router]\n'), user(t(50), 'legacy layout'), row(t(51), { role: 'assistant', content: [text('ok')] })],
    [`.factory/projects/${factory.slug(projectDir)}/${PROJECTS}.jsonl`]: [start(PROJECTS, cwd), user(t(60), 'projects layout'), assistant(t(61), [text('ok')])],
    [`${store}/${ID}.settings.json`]: { model: 'settings-model', tokenUsage: { inputTokens: 1 } },
    [`${store}/${VARIANT}.jsonl`]: [
      start(VARIANT, cwd),
      row(t(70), { role: 'user', content: 'string content' }),
      row(t(71), { role: 'assistant', content: 'plain answer' }),
      user(t(72), [text('<command-name>/compress</command-name>\n<command-args>now</command-args>')]),
      user(t(72, 30), [{ type: 'image', source: { type: 'base64' } }, text('what is in this?')]),
      assistant(t(73), [use('p1', 'TodoWrite', { todos: [{ content: 'ship it', status: 'in_progress' }, { content: 'celebrate', status: 'pending' }] })]),
      { type: 'compaction_state', timestamp: t(74), summary: { title: 'Progress', body: 'Shipped most of it.' } },
      { type: 'compaction_state', timestamp: t(75), summaryText: '', openaiEncryptedContent: 'gAAAA' },
      user(t(76), 'Usage is at 80% of your usage limit', { visibility: 'user_only' }),
    ],
  });
  return { home, projectDir };
}

async function load(id, { home, projectDir }) {
  const ctx = fixtureContext(home);
  const candidate = (await factory.findSessions(resolveProject(projectDir), ctx)).find((c) => c.id === id);
  const { meta, events } = await factory.loadSession(candidate, ctx);
  return { candidate, meta, events, session: assemble(meta, events) };
}

test('slug matches droid, including Windows drives, spaces and hyphens', () => {
  assert.equal(factory.slug('/Users/me/my app.v2'), '-Users-me-my app.v2');
  assert.equal(factory.slug('C:\\Users\\josj\\AppData\\Local\\Temp'), '-C-Users-josj-AppData-Local-Temp');
  assert.equal(factory.slug('D:/GitHub/zirv-w2-droid/target/probe-cwd-a/sub dir'), '-D-GitHub-zirv-w2-droid-target-probe-cwd-a-sub dir');
});

test('finds the project sessions, skips stubs, subagents and lookalike folders', async () => {
  const fx = fixture();
  const found = await factory.findSessions(resolveProject(fx.projectDir), fixtureContext(fx.home));
  assert.deepEqual([...found.map((c) => c.id)].sort(), [ID, LEGACY, PROJECTS, RENAMED, SUBDIR, VARIANT].sort());
  assert.deepEqual(found.map((c) => c.lastActivity), found.map((c) => c.lastActivity).sort((a, b) => b - a), 'newest first');
  const main = found.find((c) => c.id === ID);
  assert.equal(main.title, 'Parser tokenizer fixes', 'the generated title, not the first prompt copied into `title`');
  assert.equal(main.score, 3);
  assert.equal(main.lastActivity, Date.UTC(2026, 9, 25, 9, 10), 'last typed prompt, not the injected context, the notice or file mtime');
  assert.equal(main.current, undefined, 'droid exposes no session id to child processes');
  assert.equal(found.find((c) => c.id === SUBDIR).score, 1);
  assert.equal(found.find((c) => c.id === RENAMED).title, 'My rename');
  assert.equal(found.find((c) => c.id === LEGACY).preview, 'legacy layout', 'no title yet: the first prompt stands in');
});

test('loads prompts, replies, tools with outcomes, plan, compaction, interrupt and stop', async () => {
  const { meta, events, session: s } = await load(ID, fixture());

  assert.deepEqual(s.prompts.map((p) => p.text), ["Fix the parser. Don't change the API.", 'Now also handle unicode identifiers', 'and update the README']);
  assert.equal(s.latest.answered, false, 'the last prompt stays even though nothing answered it');
  assert.equal(s.stop.reason, 'quota');
  assert.match(s.stop.message, /usage limit/);
  assert.equal(s.compaction.summary, 'Primary request: fix the parser.');
  assert.equal(s.compaction.trigger, 'manual');
  assert.deepEqual(s.files.map((f) => f.path).sort(), [`${meta.cwd}/lib/a.js`, `${meta.cwd}/parser.js`, '/abs/new.js'].sort());
  assert.equal(s.failures.length, 1);
  assert.equal(s.failures[0].target, 'npm test');
  assert.equal(s.failures[0].exit, 1);
  assert.match(s.failures[0].error, /1 test failed/);
  assert.deepEqual(s.plan.items.map((i) => i.status), ['done', 'active', 'pending'], 'one plan per todo_state, TodoWrite is not repeated');
  assert.equal(events.filter((e) => e.kind === 'plan').length, 1);
  assert.equal(events.filter((e) => e.kind === 'interrupt').length, 1, 'a cancelled tool and two interrupt rows are one interrupt');
  assert.equal(events.some((e) => e.kind === 'tool' && e.ok === false && /cancelled/.test(e.error ?? '')), false);

  const replies = events.filter((e) => e.kind === 'reply');
  assert.deepEqual(replies.map((e) => [e.text, Boolean(e.final)]), [['Looking at the parser.', false], ['Unicode identifiers are handled.', true]]);
  assert.ok(!JSON.stringify(events).includes('secret reasoning'), 'thinking never leaves the adapter');

  assert.equal(meta.branch, 'feature/x');
  assert.equal(meta.model, 'claude-sonnet-5', 'the assistant rows name the model; the sidecar is the fallback');
  assert.equal(meta.startedAt, Date.UTC(2026, 9, 25, 9, 0));
  assert.equal(meta.resumeCommand, `droid --resume ${ID}`);
  assert.equal(meta.title, 'Parser tokenizer fixes');
});

test('reads string content, todo arrays, slash commands, images and compaction variants', async () => {
  const { events, session: s } = await load(VARIANT, fixture());
  assert.deepEqual(s.prompts.map((p) => p.text), ['string content', '/compress now', '[image attached]\nwhat is in this?']);
  assert.deepEqual(events.filter((e) => e.kind === 'reply').map((e) => [e.text, e.final]), [['plain answer', true]]);
  assert.deepEqual(s.plan.items, [{ text: 'ship it', status: 'active' }, { text: 'celebrate', status: 'pending' }], 'TodoWrite is the plan when the file has no todo_state');

  const [readable, encrypted] = events.filter((e) => e.kind === 'compaction');
  assert.equal(readable.summary, 'Shipped most of it.');
  assert.equal(encrypted.summary, undefined);
  assert.equal(encrypted.encrypted, true);
  assert.equal(events.some((e) => e.kind === 'stop'), false, 'a usage warning is not a stop');
});

test('a session without a recorded model falls back to the settings sidecar, then the startup context', async () => {
  const fx = fixture();
  assert.equal((await load(RENAMED, fx)).meta.model, undefined);
  assert.equal((await load(LEGACY, fx)).meta.model, 'Kimi K2.6 [HF Router]');
  writeTree(fx.home, { [`.factory/sessions/${factory.slug(fx.projectDir)}/${RENAMED}.settings.json`]: { model: 'gpt-5.6-sol' } });
  assert.equal((await load(RENAMED, fx)).meta.model, 'gpt-5.6-sol');
});

test('finds nothing without a droid store, and survives a half-written last line', async () => {
  const empty = fixtureContext(tempDir('copass-home-'));
  assert.deepEqual(await factory.findSessions(resolveProject(tempDir('copass-proj-')), empty), []);

  const fx = fixture();
  const file = join(fx.home, '.factory/sessions', factory.slug(fx.projectDir), `${ID}.jsonl`);
  appendFileSync(file, '{"type":"message","id":"torn","timestamp":"2026-10-25T09:5');
  const { candidate, session } = await load(ID, fx);
  assert.equal(candidate.lastActivity, Date.UTC(2026, 9, 25, 9, 10));
  assert.equal(session.prompts.length, 3);
});

test('launch starts the interactive REPL with the prompt', () => {
  assert.deepEqual(factory.launch('hello there'), ['droid', ['hello there']]);
});
