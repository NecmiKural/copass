/**
 * Claude Code session parser
 *
 * Reads local Claude Code chat logs from ~/.claude/projects/
 * and extracts the last N user+assistant message pairs for a given project.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const AGENT_NAME = 'claude-code';
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
 * Encode a project directory path into Claude Code's directory naming scheme.
 * `/Users/necmikural/Documents/projects/PMS-Backend` → `-Users-necmikural-Documents-projects-PMS-Backend`
 * @param {string} projectDir
 * @returns {string}
 */
function encodeProjectDir(projectDir) {
  const abs = resolve(projectDir);
  // Replace every `/` (including leading) with `-`
  return abs.replace(/\//g, '-');
}

/**
 * Extract text content from a Claude Code message content field.
 * The content can be a plain string or an array of content blocks.
 * @param {string|Array} content
 * @returns {string}
 */
function extractContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (block && typeof block === 'object') {
      // Blocks with type:"text" or a direct text field
      if (block.text) {
        parts.push(block.text);
      }
    }
  }
  return parts.join('\n');
}

/**
 * Find the most recently modified .jsonl file in a directory.
 * @param {string} dir
 * @returns {string|null} absolute path to the file, or null
 */
function findLatestJsonlFile(dir) {
  if (!existsSync(dir)) return null;

  let latest = null;
  let latestMtime = 0;

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const fullPath = join(dir, entry);
      try {
        const st = statSync(fullPath);
        if (st.isFile() && st.mtimeMs > latestMtime) {
          latestMtime = st.mtimeMs;
          latest = fullPath;
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    return null;
  }

  return latest;
}

/**
 * Parse a JSONL file and return parsed JSON objects (one per line).
 * Silently skips malformed lines.
 * @param {string} filePath
 * @returns {object[]}
 */
function parseJsonl(filePath) {
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
}

/**
 * Extract session metadata from the first few lines of a Claude Code JSONL log.
 * @param {object[]} entries
 * @returns {{ sessionId?: string, branch?: string }}
 */
function extractMetadata(entries) {
  const meta = {};
  // Metadata is typically in the first few lines
  const head = entries.slice(0, 10);
  for (const entry of head) {
    if (entry.sessionId) meta.sessionId = entry.sessionId;
    if (entry.gitBranch) meta.branch = entry.gitBranch;
    if (entry.cwd && !meta.cwd) meta.cwd = entry.cwd;
  }
  return meta;
}

/**
 * Find the latest Claude Code session for a given project directory and return
 * the last N user+assistant message pairs.
 *
 * @param {string} projectDir — absolute path to the project directory
 * @param {number} [pairCount=5] — number of message pairs to return
 * @returns {Promise<{agent:string, sessionId:string, branch:string, messages:Array, timestamp:string}|null>}
 */
export async function findLatestSession(projectDir, pairCount = DEFAULT_PAIR_COUNT) {
  try {
    const claudeProjectsDir = join(homedir(), '.claude', 'projects');
    if (!existsSync(claudeProjectsDir)) return null;

    const encoded = encodeProjectDir(projectDir);

    // Scan for a matching directory
    const dirs = readdirSync(claudeProjectsDir);
    let matchedDir = null;

    for (const dirName of dirs) {
      if (dirName === encoded) {
        matchedDir = join(claudeProjectsDir, dirName);
        break;
      }
    }

    if (!matchedDir || !existsSync(matchedDir)) return null;

    // Find the most recently modified JSONL session file
    const sessionFile = findLatestJsonlFile(matchedDir);
    if (!sessionFile) return null;

    const fileStat = statSync(sessionFile);
    const entries = parseJsonl(sessionFile);
    if (entries.length === 0) return null;

    // Extract metadata
    const meta = extractMetadata(entries);

    // Collect user and assistant messages, skipping tool_use/tool_result
    const messages = [];
    for (const entry of entries) {
      if (entry.type === 'human' || entry.type === 'user') {
        // Old format: entry.content; New format: entry.message.content
        const text = extractContent(entry.content || entry.message?.content || entry.message || '');
        if (text) {
          messages.push({
            role: 'user',
            content: truncate(text),
            ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
          });
        }
      } else if (entry.type === 'assistant') {
        const text = extractContent(entry.content || entry.message?.content || entry.message || '');
        if (text) {
          messages.push({
            role: 'assistant',
            content: truncate(text),
            ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
          });
        }
      }
      // Skip tool_use, tool_result, and any other types
    }

    // Extract the last N pairs (user + assistant)
    const pairs = [];
    let i = messages.length - 1;
    while (i >= 0 && pairs.length < pairCount) {
      // Walk backward to find an assistant message
      if (messages[i].role === 'assistant') {
        const assistantMsg = messages[i];
        // Look for the preceding user message
        let j = i - 1;
        while (j >= 0 && messages[j].role !== 'user') j--;
        if (j >= 0) {
          pairs.unshift(messages[j], assistantMsg);
          i = j - 1;
        } else {
          // No preceding user message — include assistant alone
          pairs.unshift(assistantMsg);
          i--;
        }
      } else {
        i--;
      }
    }

    // Trim to exactly pairCount * 2 messages (N pairs)
    const lastMessages = pairs.slice(-(pairCount * 2));

    return {
      agent: AGENT_NAME,
      sessionId: meta.sessionId || null,
      branch: meta.branch || null,
      messages: lastMessages,
      totalMessages: messages.length,
      timestamp: fileStat.mtime.toISOString(),
      logFilePath: sessionFile,
    };
  } catch {
    return null;
  }
}
