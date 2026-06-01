/**
 * Antigravity (Gemini CLI) session parser
 *
 * Reads local Antigravity chat logs from ~/.gemini/antigravity/brain/[id]/
 * and extracts the last N user+assistant message pairs for a given project.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const AGENT_NAME = 'antigravity';
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
 * Clean a path string by trimming and removing wrapping quotes.
 * @param {string} val
 * @returns {string}
 */
function cleanPath(val) {
  if (typeof val !== 'string') return '';
  let s = val.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    s = s.slice(1, -1);
  }
  return s;
}

/**
 * Recursively extract all absolute paths from a tool call arguments object or array.
 * @param {*} obj
 * @param {string[]} paths
 */
function extractPathsFromObject(obj, paths) {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractPathsFromObject(item, paths);
    }
    return;
  }

  for (const val of Object.values(obj)) {
    if (typeof val === 'string') {
      const cleaned = cleanPath(val);
      const isAbs = cleaned.startsWith('/') || /^[a-zA-Z]:[\\\/]/.test(cleaned) || cleaned.startsWith('\\\\');
      if (isAbs) {
        try {
          paths.push(resolve(cleaned));
        } catch {
          // Ignore resolve errors
        }
      }
    } else if (val && typeof val === 'object') {
      extractPathsFromObject(val, paths);
    }
  }
}

/**
 * Check if a transcript references a given project directory.
 * Looks for the projectDir path in content strings and tool_calls fields.
 * @param {object[]} entries — parsed JSONL entries
 * @param {string} projectDir — resolved absolute path
 * @returns {boolean}
 */
function transcriptReferencesProject(entries, projectDir) {
  const target = resolve(projectDir);

  // 1. Collect all paths from tool calls across all entries
  const toolPaths = [];
  for (const entry of entries) {
    if (entry.tool_calls && Array.isArray(entry.tool_calls)) {
      extractPathsFromObject(entry.tool_calls, toolPaths);
    }
  }

  // 2. If we found tool calls with paths, decide strictly based on them
  if (toolPaths.length > 0) {
    for (const path of toolPaths) {
      if (path === target || path.startsWith(target + '/')) {
        return true;
      }
    }
    return false; // Tool calls exist, but none target the project workspace
  }

  // 3. Fallback: If no tool calls exist (e.g. brand new session or Q&A),
  // check the first user prompt for a boundary-safe path reference.
  const firstUserEntry = entries.find((e) => e.source === 'USER_EXPLICIT');
  if (firstUserEntry && typeof firstUserEntry.content === 'string') {
    const content = firstUserEntry.content;
    const index = content.indexOf(target);
    if (index >= 0) {
      const nextChar = content[index + target.length];
      if (!nextChar || /[^a-zA-Z0-9_\-\/]/.test(nextChar)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Collect all transcript.jsonl files from the antigravity brain directory.
 * @returns {{ filePath: string, mtime: number }[]}
 */
function collectTranscripts() {
  const brainDir = join(homedir(), '.gemini', 'antigravity', 'brain');
  if (!existsSync(brainDir)) return [];

  const results = [];

  try {
    const sessionDirs = readdirSync(brainDir, { withFileTypes: true });
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;

      const transcriptPath = join(
        brainDir,
        sessionDir.name,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      );

      if (existsSync(transcriptPath)) {
        try {
          const st = statSync(transcriptPath);
          results.push({ filePath: transcriptPath, mtime: st.mtimeMs });
        } catch {
          // Skip unreadable
        }
      }
    }
  } catch {
    // Brain directory unreadable
  }

  // Sort by mtime descending — check most recent first
  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

/**
 * Find the latest Antigravity session for a given project directory and return
 * the last N user+assistant message pairs.
 *
 * @param {string} projectDir — absolute path to the project directory
 * @param {number} [pairCount=5] — number of message pairs to return
 * @returns {Promise<{agent:string, sessionId:string, branch:string, messages:Array, timestamp:string}|null>}
 */
export async function findLatestSession(projectDir, pairCount = DEFAULT_PAIR_COUNT) {
  try {
    const transcripts = collectTranscripts();
    if (transcripts.length === 0) return null;

    // Find the most recent transcript that references the project
    let matchedTranscript = null;
    let matchedEntries = null;

    for (const { filePath, mtime } of transcripts) {
      const entries = parseJsonl(filePath);
      if (entries.length === 0) continue;

      if (transcriptReferencesProject(entries, projectDir)) {
        matchedTranscript = { filePath, mtime };
        matchedEntries = entries;
        break; // Already sorted by recency, first match is most recent
      }
    }

    if (!matchedTranscript || !matchedEntries) return null;

    // Extract session ID from the directory path
    // e.g. ~/.gemini/antigravity/brain/<sessionId>/.system_generated/logs/transcript.jsonl
    const pathParts = matchedTranscript.filePath.split('/');
    const brainIdx = pathParts.indexOf('brain');
    const sessionId = brainIdx >= 0 ? pathParts[brainIdx + 1] : null;

    // Collect user and assistant messages
    const messages = [];
    for (const entry of matchedEntries) {
      if (entry.source === 'USER_EXPLICIT') {
        const text = typeof entry.content === 'string' ? entry.content : '';
        if (text) {
          messages.push({
            role: 'user',
            content: truncate(text),
            ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
          });
        }
      } else if (entry.source === 'MODEL' && entry.type === 'PLANNER_RESPONSE') {
        const text = typeof entry.content === 'string' ? entry.content : '';
        if (text) {
          messages.push({
            role: 'assistant',
            content: truncate(text),
            ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
          });
        }
      }
      // Skip tool calls, system messages, and other types
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
      branch: null, // Antigravity logs don't typically store branch info
      messages: lastMessages,
      totalMessages: messages.length,
      timestamp: new Date(matchedTranscript.mtime).toISOString(),
      logFilePath: matchedTranscript.filePath,
    };
  } catch {
    return null;
  }
}
