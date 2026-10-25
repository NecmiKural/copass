/**
 * project.js — decide which agent sessions belong to the project copass runs for.
 *
 * Agents record the working directory a session was started in. That path may
 * be the repo root, a subdirectory, a git worktree, a symlink or a differently
 * cased spelling of the same directory, so matching is done on canonical paths
 * and on the repository the path belongs to — never on string prefixes.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

/** realpath that falls back to path.resolve for paths that no longer exist. */
export function realpathOr(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/** Canonical comparison key: real path, NFC, no trailing separator, case-folded where the OS is. */
export function canon(p) {
  let s = realpathOr(p).normalize('NFC');
  if (s.length > 1 && s.endsWith(sep)) s = s.slice(0, -1);
  return CASE_INSENSITIVE ? s.toLowerCase() : s;
}

export function samePath(a, b) {
  return canon(a) === canon(b);
}

/** True when `child` is strictly inside `parent`. */
export function isInside(child, parent) {
  const rel = relative(canon(parent), canon(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

/** True when a directory between `p` (inclusive) and `top` (exclusive) is its own git repository. */
function inNestedRepo(p, top) {
  let dir = realpathOr(p);
  const stop = canon(top);
  while (canon(dir) !== stop) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

/**
 * @typedef {object} Project
 * @property {string} dir        real path of the directory copass runs for
 * @property {string|null} top   git top-level, if inside a repository
 * @property {string[]} roots    dir, top and every worktree of the same repository
 * @property {(cwd: string|undefined|null) => number} match
 *   Score a session's recorded working directory: 3 = same directory,
 *   2 = same repository (top-level or a worktree), 1 = a subdirectory, 0 = unrelated.
 *   A session started in a parent directory (e.g. the home dir) never matches.
 */

/**
 * @param {string} dir
 * @returns {Project}
 */
export function resolveProject(dir) {
  const real = realpathOr(resolve(dir));
  const topRaw = git(real, ['rev-parse', '--show-toplevel']);
  const top = topRaw ? realpathOr(topRaw) : null;
  const worktrees = top
    ? git(real, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => realpathOr(l.slice('worktree '.length)))
    : [];
  const roots = [...new Map([real, top, ...worktrees].filter(Boolean).map((p) => [canon(p), p])).values()];

  // From $HOME or / every session lives in a subdirectory; only exact matches make sense there.
  const broad = samePath(real, homedir()) || dirname(real) === real;
  const match = (cwd) => {
    if (!cwd) return 0;
    if (samePath(cwd, real)) return 3;
    if (roots.some((r) => samePath(cwd, r))) return 2;
    if (broad) return 0;
    const base = top ?? real;
    const owner = roots.find((r) => isInside(cwd, r)) ?? (isInside(cwd, base) ? base : null);
    if (owner && !inNestedRepo(cwd, owner)) return 1;
    return 0;
  };

  return { dir: real, top, roots, match };
}
