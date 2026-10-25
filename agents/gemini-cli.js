/**
 * Gemini CLI adapter — not implemented yet; finds no sessions.
 */

export const name = 'gemini-cli';
export const label = 'Gemini CLI';

/** @returns {Promise<import('./index.js').Candidate[]>} */
export async function findSessions() {
  return [];
}

export async function loadSession() {
  return { meta: null, events: [] };
}

export function launch(prompt) {
  return ['gemini', [prompt]];
}
