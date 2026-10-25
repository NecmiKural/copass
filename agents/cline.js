/**
 * Cline adapter — not implemented yet; finds no sessions.
 */

export const name = 'cline';
export const label = 'Cline';

/** @returns {Promise<import('./index.js').Candidate[]>} */
export async function findSessions() {
  return [];
}

export async function loadSession() {
  return { meta: null, events: [] };
}

export function launch(prompt) {
  return ['cline', [prompt]];
}
