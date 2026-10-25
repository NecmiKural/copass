/**
 * Qwen Code adapter — not implemented yet; finds no sessions.
 */

export const name = 'qwen';
export const label = 'Qwen Code';

/** @returns {Promise<import('./index.js').Candidate[]>} */
export async function findSessions() {
  return [];
}

export async function loadSession() {
  return { meta: null, events: [] };
}

export function launch(prompt) {
  return ['qwen', [prompt]];
}
