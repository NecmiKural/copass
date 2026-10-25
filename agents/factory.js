/**
 * Factory Droid adapter — not implemented yet; finds no sessions.
 */

export const name = 'factory';
export const label = 'Factory Droid';

/** @returns {Promise<import('./index.js').Candidate[]>} */
export async function findSessions() {
  return [];
}

export async function loadSession() {
  return { meta: null, events: [] };
}

export function launch(prompt) {
  return ['droid', [prompt]];
}
