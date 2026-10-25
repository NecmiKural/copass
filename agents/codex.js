/**
 * Codex adapter — not implemented yet; finds no sessions.
 */

export const name = 'codex';
export const label = 'Codex';

/** @returns {Promise<import('./index.js').Candidate[]>} */
export async function findSessions() {
  return [];
}

export async function loadSession() {
  return { meta: null, events: [] };
}

export function launch(prompt) {
  return ['codex', [prompt]];
}
