/**
 * git.js — Git state reader for copass
 *
 * Reads current branch, working-tree status, diff stats, and the actual diff
 * content from a project directory. Uses child_process.execSync so callers can
 * await the result even though the underlying work is synchronous.
 */

import { execSync } from 'node:child_process';

/** Maximum characters kept from `git diff` output. */
const DIFF_CONTENT_MAX_CHARS = 3000;

/**
 * Run a git command inside `projectDir` and return its stdout as a trimmed
 * string.  Returns an empty string on any error (missing git, not a repo, …).
 *
 * @param {string} projectDir - Absolute path to the project root.
 * @param {string[]} args     - Arguments to pass after `git -C <dir>`.
 * @returns {string}
 */
function git(projectDir, args) {
  try {
    return execSync(`git -C ${JSON.stringify(projectDir)} ${args.join(' ')}`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024, // 10 MB — large diffs
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'], // suppress stderr noise
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Collect the current git state for a project directory.
 *
 * @param {string} projectDir - Absolute path to the project root.
 * @returns {Promise<{branch: string, status: string, diffStat: string, diffContent: string}>}
 */
export async function getGitState(projectDir) {
  const branch = git(projectDir, ['branch', '--show-current']);
  const status = git(projectDir, ['status', '--short']);
  const diffStat = git(projectDir, ['diff', '--stat']);

  let diffContent = git(projectDir, ['diff']);
  if (diffContent.length > DIFF_CONTENT_MAX_CHARS) {
    diffContent = diffContent.slice(0, DIFF_CONTENT_MAX_CHARS) + '\n... [truncated]';
  }

  return { branch, status, diffStat, diffContent };
}
