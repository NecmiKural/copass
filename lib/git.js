/**
 * git.js — the repository's current state, collected by copass itself.
 *
 * This is the "verified" part of a hand-over: the transcript says what the
 * previous agent claimed, git says what is actually on disk. Commands run
 * without a shell, so unusual directory names are safe.
 */

import { execFileSync } from 'node:child_process';

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, '-c', 'core.quotepath=off', ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    }).trimEnd();
  } catch {
    return null;
  }
}

/**
 * @typedef {object} GitState
 * @property {string} top
 * @property {string} branch           '' when HEAD is detached
 * @property {string} head             short sha, '' in a repository without commits
 * @property {string} upstream         e.g. 'origin/main', '' when none
 * @property {number} ahead
 * @property {number} behind
 * @property {string[]} staged         porcelain lines
 * @property {string[]} unstaged
 * @property {string[]} untracked      paths
 * @property {string} diffStat         staged + unstaged changes against HEAD
 * @property {string} diff
 * @property {string[]} commits        'sha subject (when)' since the session started, newest first
 */

/**
 * @param {string} dir
 * @param {{ since?: number }} [options]  since = session start (epoch ms), for "commits made since"
 * @returns {GitState|null}  null outside a git repository
 */
export function gitState(dir, { since } = {}) {
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return null;

  const head = git(dir, ['rev-parse', '--short', 'HEAD']) ?? '';
  const upstream = git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) ?? '';
  const [behind = 0, ahead = 0] = upstream
    ? (git(dir, ['rev-list', '--left-right', '--count', '@{u}...HEAD']) ?? '').split(/\s+/).map(Number)
    : [];

  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const line of (git(dir, ['status', '--porcelain=v1', '--untracked-files=all']) ?? '').split('\n')) {
    if (!line) continue;
    if (line.startsWith('??')) untracked.push(line.slice(3));
    else {
      if (line[0] !== ' ') staged.push(line);
      if (line[1] !== ' ') unstaged.push(line);
    }
  }

  // Against HEAD so staged work is included; a fresh repo has no HEAD yet.
  const base = head ? ['HEAD'] : ['--cached'];
  const diffStat = git(dir, ['diff', ...base, '--stat']) ?? '';
  const diff = git(dir, ['diff', ...base]) ?? '';

  const range = since ? [`--since=${new Date(since).toISOString()}`] : ['-n', '5'];
  const commits = head
    ? (git(dir, ['log', '--format=%h %s (%cr)', '-n', '30', ...range]) ?? '').split('\n').filter(Boolean)
    : [];

  return {
    top,
    branch: git(dir, ['branch', '--show-current']) ?? '',
    head,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    diffStat,
    diff,
    commits,
  };
}
