import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

import * as onerig from '../agents/onerig.js';
import { assemble } from '../lib/assemble.js';
import { resolveProject } from '../lib/project.js';
import { fixtureContext, tempDir, writeTree } from './helpers.js';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' }).toString();

const RUN = '20261123-190112-9514';

/** A repository with one commit and a linked worktree outside it, as onerig makes them. */
function repoWithWorktree() {
  const root = tempDir('copass-onerig-');
  const main = join(root, 'shop');
  const worktree = join(root, 'data', 'onerig', 'worktrees', 'shop', RUN);
  writeTree(main, { README: 'hi\n' });
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.name', 'T');
  git(main, 'config', 'user.email', 't@example.invalid');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'first');
  git(main, 'worktree', 'add', '-q', '-b', `onerig/${RUN}`, worktree, 'HEAD');
  return { main, worktree };
}

// state.json and plan.json as onerig 0.1.0 wrote them for a run whose second
// task stopped on an empty DeepSeek balance (paths replaced).
function runFiles(main, worktree, changes = {}) {
  const state = {
    v: 1,
    run_id: RUN,
    goal: 'Add retries to the HTTP client',
    updated_at: 1795460474096,
    repo: main,
    worktree,
    branch: `onerig/${RUN}`,
    phase: 'paused',
    paused: {
      reason: 'no_lane',
      resume_phase: 'executing',
      message: 'w1: quota exhausted\nAfterwards: onerig resume 20261123-190112-9514',
    },
    task_index: 2,
    task_base: '10f2cea6233cdbbe21547ab06487004060ee715d',
    attempt: 1,
    attempts_used: 1,
    lane: 'w1',
    unknown_streak: 0,
    skipped: [],
    last_end: 'quota',
    approved: false,
    issues: [{ file: 'src/client.js', note: 'Retry only on 5xx.' }],
    last_output_tail: 'Wiring retry into send()',
    job_seq: 4,
    lanes: { w1: { exhausted: true, exhausted_until: null } },
    ...changes,
  };
  const plan = {
    tasks: [
      { id: 'retry-helper', title: 'Add a retry helper', instructions: 'Write retry() in src/retry.js.', acceptance: ['retry() retries three times'] },
      { id: 'wire-in', title: 'Use the helper in the client', instructions: 'Call retry() from send().', acceptance: ['send() retries on 5xx'] },
    ],
  };
  writeTree(join(main, '.onerig', 'runs', RUN), { 'state.json': state, 'plan.json': plan });
}

const ctx = fixtureContext('/nonexistent-home');

test('an unfinished run is listed from its worktree and from the main checkout', async () => {
  const { main, worktree } = repoWithWorktree();
  runFiles(main, worktree);

  const fromWorktree = await onerig.findSessions(resolveProject(worktree), ctx);
  const fromMain = await onerig.findSessions(resolveProject(main), ctx);

  assert.equal(fromWorktree.length, 1);
  assert.equal(fromWorktree[0].id, RUN);
  assert.equal(fromWorktree[0].score, 3);
  assert.equal(fromWorktree[0].title, 'Add retries to the HTTP client');
  assert.equal(fromWorktree[0].background, false, 'a paused run is waiting for a person');
  assert.equal(fromMain[0].score, 2);
});

test('the hand-over keeps the goal as the only prompt and the task as agent output', async () => {
  const { main, worktree } = repoWithWorktree();
  runFiles(main, worktree);
  const [candidate] = await onerig.findSessions(resolveProject(worktree), ctx);

  const { meta, events } = await onerig.loadSession(candidate, ctx);
  const s = assemble(meta, events);

  assert.deepEqual(s.prompts.map((p) => p.text), ['Add retries to the HTTP client']);
  assert.deepEqual(
    s.plan.items.map((i) => i.status),
    ['done', 'active'],
  );
  const reply = events.find((e) => e.kind === 'reply').text;
  assert.match(reply, /^Current task 2 of 2 \(wire-in\), written by onerig's planner, not by the user:/);
  assert.match(reply, /- src\/client\.js: Retry only on 5xx\./);
  assert.match(reply, /Wiring retry into send\(\)/);
  assert.equal(s.latest.started, true, 'the goal was worked on, not left unanswered');
  assert.equal(s.stop.reason, 'quota');
  assert.equal(meta.resumeCommand, `onerig resume ${RUN}`);
  assert.equal(meta.cwd, worktree);
});

test('finished runs, unknown formats and copied-in runs are not listed', async () => {
  for (const changes of [{ phase: 'done' }, { v: 2 }]) {
    const { main, worktree } = repoWithWorktree();
    runFiles(main, worktree, changes);
    assert.deepEqual(await onerig.findSessions(resolveProject(main), ctx), [], JSON.stringify(changes));
  }
  const { main } = repoWithWorktree();
  runFiles(main, '/somewhere/else/worktree');
  assert.deepEqual(await onerig.findSessions(resolveProject(main), ctx), []);
});

test('a run in a working phase counts as background and a failed run stops with an error', async () => {
  const { main, worktree } = repoWithWorktree();
  runFiles(main, worktree, { phase: 'executing', paused: undefined });
  const [working] = await onerig.findSessions(resolveProject(worktree), ctx);
  assert.equal(working.background, true);

  runFiles(main, worktree, { phase: 'failed', paused: undefined });
  const [failed] = await onerig.findSessions(resolveProject(worktree), ctx);
  const { events } = await onerig.loadSession(failed, ctx);
  assert.equal(events.at(-1).kind, 'stop');
  assert.equal(events.at(-1).reason, 'error');
});

test('a manual hand-over pause adds no stop reason', async () => {
  const { main, worktree } = repoWithWorktree();
  runFiles(main, worktree, { paused: { reason: 'handover', resume_phase: 'reviewing', message: 'cd … && agy' } });
  const [candidate] = await onerig.findSessions(resolveProject(worktree), ctx);

  const { events } = await onerig.loadSession(candidate, ctx);

  assert.equal(events.some((e) => e.kind === 'stop'), false);
});

test('onerig cannot be started with a hand-over', () => {
  assert.equal(onerig.launch('ignored'), null);
  assert.match(onerig.launchNote, /onerig resume/);
});
