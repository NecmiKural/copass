/**
 * Kimi CLI adapter — not implemented yet; finds no sessions.
 */

export const name = 'kimi';
export const label = 'Kimi CLI';

/** @returns {Promise<import('./index.js').Candidate[]>} */
export async function findSessions() {
  return [];
}

export async function loadSession() {
  return { meta: null, events: [] };
}

export function launch(prompt) {
  return ['kimi', [prompt]];
}
