/**
 * git.js — the repository's current state, collected by copass itself.
 *
 * This is the "verified" part of a hand-over: the transcript says what the
 * previous agent claimed, git says what is on disk now. Commands run without
 * a shell, with external diff tools, textconv and colors disabled, and
 * without taking optional locks (another agent may be running git).
 */

import { execFileSync } from 'node:child_process';

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
const HARDENING = ['-c', 'core.quotepath=off', '-c', 'color.ui=never'];
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'];

// Generated files that would eat the diff budget without telling the next agent anything.
const GENERATED =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|Podfile\.lock|pubspec\.lock|packages\.lock\.json)$|\.min\.(?:js|css)$|\.map$/;

/** Run git; null on any failure (not a repo, timeout, corrupt index…). */
function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...HARDENING, ...args], {
      encoding: 'utf8',
      env: GIT_ENV,
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
 * @property {string} branch                 '' when HEAD is detached
 * @property {string} head                   short sha, '' in a repository without commits
 * @property {string} upstream               e.g. 'origin/main', '' when none
 * @property {number} ahead
 * @property {number} behind
 * @property {string[]|null} staged          porcelain lines; null when `git status` failed
 * @property {string[]|null} unstaged
 * @property {string[]|null} untracked       paths
 * @property {string|null} diffStat          staged + unstaged changes against HEAD
 * @property {string|null} diff              same, without generated files; null when it failed
 * @property {string[]} excluded             generated files left out of the diff
 * @property {string[]} commits              'sha subject (when)', newest first
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

  let staged = null;
  let unstaged = null;
  let untracked = null;
  const status = git(dir, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== null) {
    staged = [];
    unstaged = [];
    untracked = [];
    for (const line of status.split('\n')) {
      if (!line) continue;
      if (line.startsWith('??')) untracked.push(line.slice(3));
      else {
        if (line[0] !== ' ') staged.push(line);
        if (line[1] !== ' ') unstaged.push(line);
      }
    }
  }

  // Against HEAD so staged work is included; a fresh repo has no HEAD yet.
  const base = head ? ['HEAD'] : ['--cached'];
  const changed = (git(dir, ['diff', ...base, ...DIFF_FLAGS, '--name-only']) ?? '').split('\n').filter(Boolean);
  const excluded = changed.filter((f) => GENERATED.test(f));
  const pathspec = ['--', ':/', ...excluded.map((f) => `:(top,exclude,literal)${f}`)];
  const diffStat = git(dir, ['diff', ...base, ...DIFF_FLAGS, '--stat', '--stat-width=100']);
  const diff = git(dir, ['diff', ...base, ...DIFF_FLAGS, ...pathspec]);

  const range = since ? [`--since=${new Date(since).toISOString()}`] : ['-n', '5'];
  const commits = head
    ? (git(dir, ['log', '--no-color', '--format=%h %s (%cr)', '-n', '30', ...range]) ?? '').split('\n').filter(Boolean)
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
    excluded,
    commits,
  };
}
