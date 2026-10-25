/**
 * Test helpers: temporary fixture trees and adapter contexts.
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A fresh temporary directory, as a real path (macOS /var is a symlink to /private/var). */
export function tempDir(prefix = 'copass-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Write a fixture tree. Values: string (raw), array (one JSON object per line), object (JSON).
 *
 * @param {string} root
 * @param {Record<string, string|object[]|object>} files
 */
export function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    const text = Array.isArray(content)
      ? `${content.map((o) => JSON.stringify(o)).join('\n')}\n`
      : typeof content === 'string'
        ? content
        : JSON.stringify(content);
    writeFileSync(path, text);
  }
}

/** An adapter context whose home is a fixture directory. */
export function fixtureContext(home, env = {}) {
  return { env, home, platform: process.platform, now: Date.now() };
}
