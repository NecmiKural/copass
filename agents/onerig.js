/**
 * onerig — runs of the onerig orchestrator.
 *
 * onerig keeps each run in <main checkout>/.onerig/runs/<run id>/ with a
 * state.json and a plan.json; its work happens in a separate git worktree of
 * the same repository. Those two files are a documented, versioned format
 * ("v": 1; fields are only added within a version), so this adapter reads
 * nothing else. A run is listed while it is unfinished: paused, failed, or in
 * a working phase.
 *
 * The user's goal is the only text the user wrote. The current task was
 * derived from it by onerig's planner model, so it is passed on as a reply,
 * not as a prompt: copass tells the next agent that only prompts are the
 * user's instructions.
 */

import { join } from 'node:path';

import { listDir, readJson } from '../lib/fsx.js';
import { samePath } from '../lib/project.js';

export const name = 'onerig';
export const label = 'onerig';

const FORMAT_VERSION = 1;
const WORKING = new Set(['planning', 'executing', 'reviewing']);
const STOP_REASONS = {
  quota: 'quota',
  no_lane: 'quota',
  interrupted: 'interrupted',
  auth: 'error',
  attempts_exhausted: 'error',
  job_failed: 'error',
  git_error: 'error',
};

/** A run this adapter can describe: known format, unfinished, and its worktree belongs to the project. */
function usable(state, project) {
  return (
    state?.v === FORMAT_VERSION &&
    typeof state.run_id === 'string' &&
    typeof state.worktree === 'string' &&
    Number.isFinite(state.updated_at) &&
    state.phase !== 'done' &&
    // A state.json copied in from elsewhere names a worktree git does not list.
    project.roots.some((root) => samePath(root, state.worktree))
  );
}

/**
 * @param {import('../lib/project.js').Project} project
 * @param {import('./index.js').Context} _ctx
 */
export async function findSessions(project, _ctx) {
  const out = [];
  for (const root of project.roots) {
    const runs = join(root, '.onerig', 'runs');
    for (const entry of listDir(runs)) {
      if (!entry.isDirectory()) continue;
      const ref = join(runs, entry.name);
      const state = readJson(join(ref, 'state.json'));
      if (!usable(state, project)) continue;
      const score = project.match(state.worktree);
      if (!score) continue;
      out.push({
        agent: name,
        id: state.run_id,
        lastActivity: state.updated_at,
        score,
        cwd: state.worktree,
        title: state.goal,
        background: WORKING.has(state.phase),
        ref,
      });
    }
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}

function planEvent(plan, taskIndex) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  if (tasks.length === 0) return null;
  const status = (position) =>
    !taskIndex ? 'pending' : position < taskIndex ? 'done' : position === taskIndex ? 'active' : 'pending';
  return {
    kind: 'plan',
    items: tasks.map((task, i) => ({ text: `${task.id}: ${task.title}`, status: status(i + 1) })),
  };
}

function taskReply(state, plan) {
  const task = plan?.tasks?.[(state.task_index ?? 0) - 1];
  if (!task) return null;
  const lines = [
    `Current task ${state.task_index} of ${plan.tasks.length} (${task.id}), written by onerig's planner, not by the user:`,
    task.title,
    task.instructions,
    'Acceptance criteria:',
    ...(task.acceptance ?? []).map((item) => `- ${item}`),
  ];
  if (state.issues?.length) {
    lines.push('', 'Review issues to fix:', ...state.issues.map((i) => `- ${i.file}: ${i.note}`));
  }
  if (state.last_output_tail) {
    lines.push('', 'Last output of the previous worker:', state.last_output_tail);
  }
  return { kind: 'reply', text: lines.join('\n'), ts: state.updated_at };
}

function stopEvent(state) {
  if (state.phase === 'failed') return { kind: 'stop', reason: 'error', ts: state.updated_at };
  const reason = STOP_REASONS[state.paused?.reason];
  if (state.phase !== 'paused' || !reason) return null;
  return {
    kind: 'stop',
    reason,
    message: state.paused.message,
    resetsAt: state.paused.until,
    ts: state.updated_at,
  };
}

/**
 * @param {import('./index.js').Candidate} candidate
 * @param {import('./index.js').Context} _ctx
 */
export async function loadSession(candidate, _ctx) {
  const state = readJson(join(candidate.ref, 'state.json'));
  const plan = readJson(join(candidate.ref, 'plan.json'));
  const events = [
    { kind: 'prompt', text: state.goal },
    planEvent(plan, state.task_index),
    taskReply(state, plan),
    stopEvent(state),
  ].filter(Boolean);
  return {
    meta: {
      agent: name,
      sessionId: state.run_id,
      title: state.goal,
      cwd: state.worktree,
      logFile: join(candidate.ref, 'log.jsonl'),
      lastActivity: state.updated_at,
      branch: state.branch,
      resumeCommand: `onerig resume ${state.run_id}`,
    },
    events,
  };
}

/** onerig takes no interactive first prompt; its runs continue with `onerig resume`. */
export function launch() {
  return null;
}

export const launchNote = 'onerig cannot take a hand-over; continue its run with `onerig resume <run id>`.';
