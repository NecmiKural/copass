/**
 * relay.js — find the session to hand over and build the hand-over.
 */

import { homedir } from 'node:os';
import { relative } from 'node:path';

import { ADAPTERS, adapterByName } from '../agents/index.js';
import { assemble } from './assemble.js';
import { gitState } from './git.js';
import { handoverPaths, prepareStore } from './output.js';
import { redact, redactEvents } from './redact.js';
import { renderHandover } from './render.js';
import { renderTranscript } from './transcript.js';

const MAX_LOAD_ATTEMPTS = 10;

/** @returns {import('../agents/index.js').Context} */
export function defaultContext() {
  return { env: process.env, home: homedir(), platform: process.platform, now: Date.now() };
}

function debug(...args) {
  if (process.env.COPASS_DEBUG) console.error('[copass]', ...args);
}

/**
 * Every session that belongs to the project, best candidate first:
 * interactive before background, then most recent activity, then closest match.
 *
 * @param {import('./project.js').Project} project
 * @param {{ from?: string, exclude?: string[], includeSelf?: boolean }} options
 * @param {import('../agents/index.js').Context} ctx
 */
export async function findCandidates(project, { from, exclude = [], includeSelf = false } = {}, ctx = defaultContext()) {
  const adapters = from ? [adapterByName(from)].filter(Boolean) : ADAPTERS.filter((a) => !exclude.includes(a.name));
  const lists = await Promise.all(
    adapters.map(async (a) => {
      const started = performance.now();
      try {
        const found = await a.findSessions(project, ctx);
        debug(`${a.name}: ${found.length} session(s) in ${Math.round(performance.now() - started)} ms`);
        return found.map((c) => ({ ...c, agent: a.name, id: String(c.id) }));
      } catch (err) {
        debug(`${a.name} failed:`, err);
        return [];
      }
    }),
  );
  return lists
    .flat()
    .filter((c) => c.score > 0 && Number.isFinite(c.lastActivity) && (includeSelf || !c.current))
    .sort((a, b) => Number(Boolean(a.background)) - Number(Boolean(b.background)) || b.lastActivity - a.lastActivity || b.score - a.score);
}

/**
 * Load candidates in order until one holds a real conversation. Secrets are
 * redacted from the events right away, before anything gets clipped.
 *
 * @param {Awaited<ReturnType<typeof findCandidates>>} candidates
 * @param {import('../agents/index.js').Context} ctx
 * @param {{ redact?: boolean }} [options]
 */
export async function pickSession(candidates, ctx = defaultContext(), { redact: scrub = true } = {}) {
  for (const candidate of candidates.slice(0, MAX_LOAD_ATTEMPTS)) {
    const adapter = adapterByName(candidate.agent);
    try {
      const loaded = await adapter.loadSession(candidate, ctx);
      const { events, count } = scrub ? redactEvents(loaded.events ?? []) : { events: loaded.events ?? [], count: 0 };
      const meta = {
        ...loaded.meta,
        agent: candidate.agent,
        sessionId: String(loaded.meta?.sessionId ?? candidate.id),
        lastActivity: loaded.meta?.lastActivity ?? candidate.lastActivity,
      };
      const session = assemble(meta, events);
      if (session.prompts.length) return { session, adapter, candidate, redactions: count };
      debug(`${candidate.agent} ${candidate.id}: no prompts, skipping`);
    } catch (err) {
      debug(`${candidate.agent} ${candidate.id} failed to load:`, err);
    }
  }
  return null;
}

/**
 * Render the hand-over and transcript for a picked session. Nothing is
 * written yet, but the .copass/ store is prepared so the hand-over only
 * points at a transcript that can actually be saved.
 *
 * @param {{ session: import('./assemble.js').Session, adapter: { label: string }, redactions?: number }} picked
 * @param {import('./project.js').Project} project
 * @param {{ budget?: number, goal?: string, redact?: boolean, now?: number }} options
 */
export function buildHandover({ session, adapter, redactions = 0 }, project, { budget, goal, redact: scrub = true, now = Date.now() } = {}) {
  const paths = handoverPaths(project.dir, now);
  let storeError = null;
  try {
    prepareStore(paths);
  } catch (err) {
    storeError = err;
  }
  const git = gitState(project.dir, { since: session.meta.startedAt });
  const handover = renderHandover(session, git, {
    label: adapter.label,
    projectDir: project.dir,
    transcriptPath: storeError ? undefined : relative(project.dir, paths.transcript),
    goal,
    budget,
    now,
  });
  const transcript = renderTranscript(session, adapter.label);
  if (!scrub) return { paths, handover, transcript, redactions: 0, git, storeError };
  // Events were redacted on load; this pass catches the git diff and metadata.
  const h = redact(handover);
  const t = redact(transcript);
  return { paths, handover: h.text, transcript: t.text, redactions: redactions + h.count, git, storeError };
}
