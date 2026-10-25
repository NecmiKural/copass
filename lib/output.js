/**
 * output.js — where a hand-over goes: the project's .copass/ folder, the
 * clipboard, or straight into the next agent.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** Delete all but the newest KEEP files of one kind. Timestamps sort lexically. */
function prune(dir, prefix) {
  const old = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(KEEP);
  for (const f of old) rmSync(join(dir, f), { force: true });
}

/**
 * Write the hand-over, its transcript and latest.md. The folder gets a
 * `.gitignore` of `*` so conversation text and diffs are never committed.
 *
 * @param {ReturnType<typeof handoverPaths>} paths
 * @param {string} handover
 * @param {string} transcript
 */
export function writeHandover(paths, handover, transcript) {
  mkdirSync(paths.dir, { recursive: true });
  const ignore = join(paths.dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '# copass hand-overs contain conversation text and diffs — never commit them.\n*\n');
  writeFileSync(paths.transcript, transcript);
  writeFileSync(paths.handover, handover);
  writeFileSync(paths.latest, handover);
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
  for (const [cmd, args] of tools) {
    try {
      execFileSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
      return cmd;
    } catch {
      // try the next tool
    }
  }
  return null;
}

/** The short first prompt for a launched agent; the hand-over itself stays in the file. */
export const POINTER_PROMPT =
  'Continue my coding session from another agent: read .copass/latest.md (the hand-over copass just wrote) and follow its <instruction> section.';

/**
 * Start the target agent in the project directory, interactively, and wait for it.
 *
 * @param {{ launch: (prompt: string) => [string, string[]], label: string }} adapter
 * @param {string} projectDir
 * @returns {number} exit code
 */
export function launchAgent(adapter, projectDir) {
  const [bin, args] = adapter.launch(POINTER_PROMPT);
  const result = spawnSync(bin, args, { cwd: projectDir, stdio: 'inherit' });
  if (result.error) {
    const why = result.error.code === 'ENOENT' ? 'it is not installed or not on PATH' : result.error.message;
    throw new Error(`Could not start ${adapter.label} (\`${bin}\`): ${why}.`);
  }
  return result.status ?? 0;
}
