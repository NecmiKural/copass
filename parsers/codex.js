/**
 * Codex session parser
 *
 * Reads local Codex chat logs from ~/.codex/sessions/
 * and extracts the last N user+assistant message pairs for a given project.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const AGENT_NAME = 'codex';
export const name = AGENT_NAME;
const DEFAULT_PAIR_COUNT = 10;
const MAX_CONTENT_LENGTH = 2000;

/**
 * Truncate a string to maxLen chars, appending a suffix if truncated.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(text, maxLen = MAX_CONTENT_LENGTH) {
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen) + ' [...truncated]';
}

/**
 * Recursively collect all .jsonl files under a directory.
 * @param {string} dir
 * @param {string[]} result
 * @returns {string[]}
 */
function collectJsonlFiles(dir, result = []) {
  if (!existsSync(dir)) return result;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        collectJsonlFiles(fullPath, result);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        result.push(fullPath);
      }
    }
  } catch {
    // Skip unreadable directories
  }

  return result;
}

/**
 * Parse a JSONL file and return parsed JSON objects (one per line).
 * Silently skips malformed lines.
 * @param {string} filePath
 * @returns {object[]}
 */
function parseJsonl(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n');
    const objects = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        objects.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines
      }
    }
    return objects;
  } catch {
    return [];
  }
}

/**
 * Check if the first line of a JSONL file is a session_meta entry
 * whose payload.cwd matches the given project directory.
 * @param {string} filePath
 * @param {string} projectDir — resolved absolute path
 * @returns {{ match: boolean, meta?: object }}
 */
function checkSessionMeta(filePath, projectDir) {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const firstNewline = raw.indexOf('\n');
    const firstLine = firstNewline === -1 ? raw : raw.slice(0, firstNewline);
    const parsed = JSON.parse(firstLine.trim());

    if (parsed.type === 'session_meta' && parsed.payload && parsed.payload.cwd) {
      const cwd = resolve(parsed.payload.cwd);
      const target = resolve(projectDir);
      if (cwd === target || cwd.startsWith(target + '/')) {
        return { match: true, meta: parsed };
      }
    }
  } catch {
    // Not a valid session file
  }
  return { match: false };
}

/**
 * Extract text content from a message content field.
 * @param {string|Array|object} content
 * @returns {string}
 */
function extractContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === 'string') parts.push(block);
      else if (block && block.text) parts.push(block.text);
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * Find the latest Codex session for a given project directory and return
 * the last N user+assistant message pairs.
 *
 * @param {string} projectDir — absolute path to the project directory
 * @param {number} [pairCount=5] — number of message pairs to return
 * @returns {Promise<{agent:string, sessionId:string, branch:string, messages:Array, timestamp:string}|null>}
 */
export async function findLatestSession(projectDir, pairCount = DEFAULT_PAIR_COUNT) {
  try {
    const sessionsDir = join(homedir(), '.codex', 'sessions');
    if (!existsSync(sessionsDir)) return null;

    const allFiles = collectJsonlFiles(sessionsDir);
    if (allFiles.length === 0) return null;

    // Find matching files and pick the most recent one
    let bestFile = null;
    let bestMtime = 0;
    let bestMeta = null;

    for (const filePath of allFiles) {
      const { match, meta } = checkSessionMeta(filePath, projectDir);
      if (!match) continue;

      try {
        const st = statSync(filePath);
        if (st.mtimeMs > bestMtime) {
          bestMtime = st.mtimeMs;
          bestFile = filePath;
          bestMeta = meta;
        }
      } catch {
        // Skip unreadable
      }
    }

    if (!bestFile) return null;

    const fileStat = statSync(bestFile);
    const entries = parseJsonl(bestFile);
    if (entries.length === 0) return null;

    // Extract session metadata
    const sessionId = bestMeta?.payload?.sessionId || bestMeta?.payload?.id || null;
    const branch = bestMeta?.payload?.gitBranch || bestMeta?.payload?.branch || null;

    // Collect user and assistant messages (skip session_meta and tool entries)
    const messages = [];
    for (const entry of entries) {
      if (entry.type === 'session_meta') continue;

      // ── New format: response_item with payload ──
      if (entry.type === 'response_item') {
        const payload = entry.payload;
        if (!payload || payload.type !== 'message') continue;

        const role = payload.role;
        if (role !== 'user' && role !== 'assistant') continue;

        // Content lives in payload.content — an array of {type, text} blocks
        let text = '';
        if (Array.isArray(payload.content)) {
          const parts = [];
          for (const block of payload.content) {
            if (typeof block === 'string') parts.push(block);
            else if (block && block.text) parts.push(block.text);
          }
          text = parts.join('\n');
        } else {
          text = extractContent(payload.content || '');
        }

        if (text) {
          messages.push({
            role,
            content: truncate(text),
            ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
          });
        }
        continue;
      }

      // ── Old format: flat entries with role or type field ──
      const role = entry.role || entry.type;
      if (role === 'user' || role === 'human') {
        const text = extractContent(entry.content || entry.message || '');
        if (text) {
          messages.push({
            role: 'user',
            content: truncate(text),
            ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
          });
        }
      } else if (role === 'assistant') {
        const text = extractContent(entry.content || entry.message || '');
        if (text) {
          messages.push({
            role: 'assistant',
            content: truncate(text),
            ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
          });
        }
      }
      // Skip tool_use, tool_result, function_call, etc.
    }

    // Extract the last N pairs (user + assistant)
    const pairs = [];
    let i = messages.length - 1;
    while (i >= 0 && pairs.length < pairCount) {
      if (messages[i].role === 'assistant') {
        const assistantMsg = messages[i];
        let j = i - 1;
        while (j >= 0 && messages[j].role !== 'user') j--;
        if (j >= 0) {
          pairs.unshift(messages[j], assistantMsg);
          i = j - 1;
        } else {
          pairs.unshift(assistantMsg);
          i--;
        }
      } else {
        i--;
      }
    }

    const lastMessages = pairs.slice(-(pairCount * 2));

    return {
      agent: AGENT_NAME,
      sessionId,
      branch,
      messages: lastMessages,
      totalMessages: messages.length,
      timestamp: fileStat.mtime.toISOString(),
      logFilePath: bestFile,
    };
  } catch {
    return null;
  }
}
