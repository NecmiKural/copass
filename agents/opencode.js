/**
 * OpenCode adapter — not implemented yet; finds no sessions.
 */

export const name = 'opencode';
export const label = 'OpenCode';

/** @returns {Promise<import('./index.js').Candidate[]>} */
export async function findSessions() {
  return [];
}

export async function loadSession() {
  return { meta: null, events: [] };
}

export function launch(prompt) {
  return ['opencode', [prompt]];
}
