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
const DEFAULT_PAIR_COUNT = 5;
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
 * Check if a transcript references a given project directory.
 * Looks for the projectDir path in content strings and tool_calls fields.
 * @param {object[]} entries — parsed JSONL entries
 * @param {string} projectDir — resolved absolute path
 * @returns {boolean}
 */
function transcriptReferencesProject(entries, projectDir) {
  const target = resolve(projectDir);

  for (const entry of entries) {
    // Check content field
    if (typeof entry.content === 'string' && entry.content.includes(target)) {
      return true;
    }

    // Check tool_calls — may be an array of objects or a string
    if (entry.tool_calls) {
      const toolStr = typeof entry.tool_calls === 'string'
        ? entry.tool_calls
        : JSON.stringify(entry.tool_calls);
      if (toolStr.includes(target)) {
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
      timestamp: new Date(matchedTranscript.mtime).toISOString(),
    };
  } catch {
    return null;
  }
}
