/**
 * output.js — where a hand-over goes: the project's .copass/ folder, the
 * clipboard, or straight into the next agent.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEEP = 10;
const STORE = '.copass';

/**
 * Paths for a new hand-over. The transcript path must be known before the
 * hand-over is rendered, because the hand-over points at it.
 *
 * @param {string} projectDir
 * @param {number} now
 */
export function handoverPaths(projectDir, now) {
  const dir = join(projectDir, STORE);
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    dir,
    handover: join(dir, `handover-${stamp}.md`),
    transcript: join(dir, `transcript-${stamp}.md`),
    latest: join(dir, 'latest.md'),
  };
}

/**
 * Create .copass/ (owner-only) with a `.gitignore` of `*`, so conversation
 * text and diffs are never committed. A repository could commit .copass as a
 * symlink to make copass overwrite files elsewhere — refuse that.
 *
 * @param {ReturnType<typeof handoverPaths>} paths
 */
export function prepareStore(paths) {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(paths.dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${paths.dir} is a symlink or not a directory — refusing to write there`);
  const ignore = join(paths.dir, '.gitignore');
  if (!existsSync(ignore)) writeSafe(ignore, '# copass hand-overs contain conversation text and diffs — never commit them.\n*\n');
}

/** Write through a temp file and rename: rename replaces a planted symlink instead of following it. */
function writeSafe(path, content) {
  const tmp = `${path}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}

/** Delete all but the newest KEEP files of one kind. Timestamps sort lexically. */
function prune(dir, prefix) {
  const old = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.startsWith(prefix) && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort()
    .reverse()
    .slice(KEEP);
  for (const f of old) rmSync(join(dir, f), { force: true });
}

/**
 * Write the hand-over, its transcript and latest.md into a prepared store.
 *
 * @param {ReturnType<typeof handoverPaths>} paths
 * @param {string} handover
 * @param {string} transcript
 */
export function writeHandover(paths, handover, transcript) {
  prepareStore(paths);
  writeSafe(paths.transcript, transcript);
  writeSafe(paths.handover, handover);
  writeSafe(paths.latest, handover);
  prune(paths.dir, 'handover-');
  prune(paths.dir, 'transcript-');
}

/**
 * Copy text to the system clipboard.
 *
 * @param {string} text
 * @returns {string|null}  the tool used, or null when none worked
 */
export function copyToClipboard(text) {
  const tools =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']], ['clip.exe', []]];
  // pbcopy decodes its input with the locale; without one it mangles UTF-8.
  const env = { ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' };
  for (const [cmd, args] of tools) {
    try {
      execFileSync(cmd, args, { input: text, env, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
      return cmd;
    } catch {
      // try the next tool
    }
  }
  return null;
}

/** The short first prompt for a launched agent; the hand-over itself stays in the file. */
export const POINTER_PROMPT =
  'Continue my coding session from another agent: read .copass/latest.md (the hand-over copass just wrote) and follow its instruction section.';

/** True when the agent can be started from the command line with a first prompt. */
export function canLaunch(adapter, ctx) {
  return typeof adapter?.launch === 'function' && Boolean(adapter.launch(POINTER_PROMPT, ctx));
}

/**
 * Start the target agent in the project directory, interactively, and wait for it.
 * Ctrl-C belongs to the agent while it runs, so copass ignores SIGINT meanwhile.
 *
 * @param {{ launch: (prompt: string, ctx?: object) => [string, string[]]|null }} adapter
 * @param {string} projectDir
 * @param {import('../agents/index.js').Context} [ctx]
 * @returns {{ status: number } | { error: string, bin?: string }}
 */
export function launchAgent(adapter, projectDir, ctx) {
  const command = adapter.launch(POINTER_PROMPT, ctx);
  if (!command) return { error: 'cannot start with a first prompt' };
  const [bin, args] = command;
  const ignore = () => {};
  process.on('SIGINT', ignore);
  try {
    const result = spawnSync(bin, args, { cwd: projectDir, stdio: 'inherit' });
    if (result.error) {
      return { error: result.error.code === 'ENOENT' ? 'not installed or not on PATH' : result.error.message, bin };
    }
    return { status: result.status ?? 1 };
  } finally {
    process.off('SIGINT', ignore);
  }
}
