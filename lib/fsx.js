/**
 * fsx.js — small file helpers shared by the agent adapters.
 *
 * Everything here is read-only and never throws: agent stores are written
 * concurrently by running agents, so torn lines and vanished files are normal.
 */

import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';

const NEWLINE = 10;

/** `statSync` that returns null instead of throwing. */
export function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** Directory entries (with file types), or [] when the directory is missing. */
export function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Parse a JSON string, or return null. */
export function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Parse a JSON file, or return null. */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Read a text file, or return null. */
export function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Parse every line of a JSONL file. Malformed lines — typically the
 * half-written last line of a live session — are skipped.
 *
 * @param {string} path
 * @returns {any[]}
 */
export function readJsonl(path) {
  const raw = readText(path);
  if (!raw) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const obj = tryJson(line);
    if (obj !== null) out.push(obj);
  }
  return out;
}

/**
 * First line of a file, read in growing chunks so that huge first lines
 * (Codex embeds ~45 KB of instructions in line 1) are still returned whole.
 *
 * @param {string} path
 * @param {number} [maxBytes]
 * @returns {string|null}
 */
export function readFirstLine(path, maxBytes = 8 * 1024 * 1024) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const chunks = [];
    let pos = 0;
    let size = 64 * 1024;
    while (pos < maxBytes) {
      const buf = Buffer.alloc(size);
      const n = readSync(fd, buf, 0, size, pos);
      if (n === 0) break;
      const nl = buf.subarray(0, n).indexOf(NEWLINE);
      if (nl >= 0) {
        chunks.push(buf.subarray(0, nl));
        break;
      }
      chunks.push(buf.subarray(0, n));
      pos += n;
      size *= 2;
    }
    return chunks.length ? Buffer.concat(chunks).toString('utf8') : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Yield the lines of a file from the end, newest first. Splits on the
 * newline byte, so multi-byte UTF-8 characters are never cut. Stop iterating
 * early to avoid reading the rest of a large file.
 *
 * @param {string} path
 * @param {number} [chunkSize]
 * @returns {Generator<string>}
 */
export function* linesFromEnd(path, chunkSize = 1024 * 1024) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return;
  }
  try {
    let pos = fstatSync(fd).size;
    let rest = Buffer.alloc(0);
    while (pos > 0) {
      const len = Math.min(chunkSize, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      const data = rest.length ? Buffer.concat([buf, rest]) : buf;
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== NEWLINE) continue;
        if (end > i + 1) yield data.toString('utf8', i + 1, end);
        end = i;
      }
      rest = data.subarray(0, end);
    }
    if (rest.length) yield rest.toString('utf8');
  } finally {
    closeSync(fd);
  }
}
