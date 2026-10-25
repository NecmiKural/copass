/**
 * Goose adapter — not implemented yet; finds no sessions.
 */

export const name = 'goose';
export const label = 'Goose';

/** @returns {Promise<import('./index.js').Candidate[]>} */
export async function findSessions() {
  return [];
}

export async function loadSession() {
  return { meta: null, events: [] };
}

export function launch(prompt) {
  return ['goose', [prompt]];
}
