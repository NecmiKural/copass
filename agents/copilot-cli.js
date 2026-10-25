/**
 * GitHub Copilot CLI adapter — not implemented yet; finds no sessions.
 */

export const name = 'copilot-cli';
export const label = 'GitHub Copilot CLI';

/** @returns {Promise<import('./index.js').Candidate[]>} */
export async function findSessions() {
  return [];
}

export async function loadSession() {
  return { meta: null, events: [] };
}

export function launch(prompt) {
  return ['copilot', [prompt]];
}
