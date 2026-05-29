/**
 * VS Code Copilot Chat session parser
 *
 * Reads local Copilot Chat logs from VS Code's workspaceStorage
 * and extracts the last N user+assistant message pairs for a given project.
 *
 * The JSONL uses a delta format:
 *   kind: 0 → initial full state (snapshot)
 *   kind: 1 → incremental delta with key path and value
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const AGENT_NAME = 'vscode-copilot';
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
 * Find the most recently modified .jsonl file in a directory.
 * @param {string} dir
 * @returns {string|null}
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
        // Skip unreadable
      }
    }
  } catch {
    return null;
  }

  return latest;
}

/**
 * Decode a file:// URI to a filesystem path.
 * @param {string} uri
 * @returns {string}
 */
function fileUriToPath(uri) {
  if (!uri) return '';
  try {
    const url = new URL(uri);
    return decodeURIComponent(url.pathname);
  } catch {
    // Fallback: strip the scheme and decode
    const stripped = uri.replace(/^file:\/\//, '');
    return decodeURIComponent(stripped);
  }
}

/**
 * Apply a delta (kind:1) to a state object.
 * The delta has `k` (key path array) and `v` (value).
 * Traverses the state following the key path and sets the final key to the value.
 * @param {object} state
 * @param {Array} keyPath — array of string/number keys
 * @param {*} value
 */
function applyDelta(state, keyPath, value) {
  if (!Array.isArray(keyPath) || keyPath.length === 0) return;

  let current = state;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i];
    if (current[key] === undefined || current[key] === null) {
      // Create intermediate container — use object by default,
      // array if next key is numeric
      const nextKey = keyPath[i + 1];
      current[key] = typeof nextKey === 'number' ? [] : {};
    }
    current = current[key];
  }

  const lastKey = keyPath[keyPath.length - 1];
  current[lastKey] = value;
}

/**
 * Reconstruct the full session state from a delta-format JSONL.
 * @param {object[]} entries — parsed JSONL entries
 * @returns {object|null} — the reconstructed session state
 */
function reconstructSession(entries) {
  if (entries.length === 0) return null;

  // Find the last kind:0 entry (full snapshot) as the base
  let state = null;
  let startIdx = 0;

  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === 0) {
      // kind:0 is the full snapshot; use its data as the state
      state = JSON.parse(JSON.stringify(entries[i]));
      delete state.kind; // Remove meta field
      startIdx = i + 1;
      break;
    }
  }

  if (!state) {
    // No snapshot found — try using the first entry as base
    state = JSON.parse(JSON.stringify(entries[0]));
    delete state.kind;
    startIdx = 1;
  }

  // Apply all subsequent kind:1 deltas
  for (let i = startIdx; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.kind === 1 && entry.k && entry.v !== undefined) {
      applyDelta(state, entry.k, entry.v);
    }
  }

  return state;
}

/**
 * Extract user+assistant messages from a reconstructed Copilot Chat session state.
 * @param {object} state
 * @returns {{ role: string, content: string, timestamp?: string }[]}
 */
function extractMessages(state) {
  const messages = [];

  // Messages are typically in state.requests array
  const requests = state.requests || state.data?.requests || [];

  if (!Array.isArray(requests)) return messages;

  for (const req of requests) {
    // User message — could be in message, prompt, inputText, or text
    const userText =
      req.message?.text ||
      req.message?.content ||
      req.prompt ||
      req.inputText ||
      req.text ||
      '';

    if (userText) {
      messages.push({
        role: 'user',
        content: truncate(typeof userText === 'string' ? userText : String(userText)),
        ...(req.timestamp ? { timestamp: req.timestamp } : {}),
      });
    }

    // Assistant response — could be in response, result, or reply
    const response = req.response || req.result || req.reply;
    if (response) {
      let assistantText = '';

      if (typeof response === 'string') {
        assistantText = response;
      } else if (response.message?.text) {
        assistantText = response.message.text;
      } else if (response.message?.content) {
        assistantText = response.message.content;
      } else if (response.value) {
        assistantText = typeof response.value === 'string'
          ? response.value
          : JSON.stringify(response.value);
      } else if (response.text) {
        assistantText = response.text;
      } else if (response.content) {
        assistantText = typeof response.content === 'string'
          ? response.content
          : JSON.stringify(response.content);
      }

      if (assistantText) {
        messages.push({
          role: 'assistant',
          content: truncate(assistantText),
          ...(response.timestamp ? { timestamp: response.timestamp } : {}),
        });
      }
    }
  }

  // Also check for a pending input in inputState
  if (state.inputState?.inputText) {
    // This represents a draft user message — not yet sent, but may be useful context
    // We include it only if the last message isn't already from the user
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'user') {
      messages.push({
        role: 'user',
        content: truncate(state.inputState.inputText),
      });
    }
  }

  return messages;
}

/**
 * Find the latest VS Code Copilot Chat session for a given project directory
 * and return the last N user+assistant message pairs.
 *
 * @param {string} projectDir — absolute path to the project directory
 * @param {number} [pairCount=5] — number of message pairs to return
 * @returns {Promise<{agent:string, sessionId:string, branch:string, messages:Array, timestamp:string}|null>}
 */
export async function findLatestSession(projectDir, pairCount = DEFAULT_PAIR_COUNT) {
  try {
    const workspaceStorageDir = join(
      homedir(),
      'Library',
      'Application Support',
      'Code',
      'User',
      'workspaceStorage'
    );

    if (!existsSync(workspaceStorageDir)) return null;

    const target = resolve(projectDir);

    // Scan workspace directories for a matching project
    let matchedWorkspaceDir = null;

    try {
      const workspaceDirs = readdirSync(workspaceStorageDir, { withFileTypes: true });

      for (const wsDir of workspaceDirs) {
        if (!wsDir.isDirectory()) continue;

        const wsPath = join(workspaceStorageDir, wsDir.name);
        const workspaceJsonPath = join(wsPath, 'workspace.json');

        if (!existsSync(workspaceJsonPath)) continue;

        try {
          const wsConfig = JSON.parse(readFileSync(workspaceJsonPath, 'utf-8'));
          const folderUri = wsConfig.folder || '';
          const folderPath = fileUriToPath(folderUri);

          if (folderPath && (resolve(folderPath) === target || resolve(folderPath).startsWith(target + '/'))) {
            matchedWorkspaceDir = wsPath;
            break;
          }
        } catch {
          // Skip unparseable workspace.json
        }
      }
    } catch {
      return null;
    }

    if (!matchedWorkspaceDir) return null;

    // Find chat session JSONL files
    const chatSessionsDir = join(matchedWorkspaceDir, 'chatSessions');
    const sessionFile = findLatestJsonlFile(chatSessionsDir);
    if (!sessionFile) return null;

    const fileStat = statSync(sessionFile);
    const entries = parseJsonl(sessionFile);
    if (entries.length === 0) return null;

    // Reconstruct the session state from delta format
    const sessionState = reconstructSession(entries);
    if (!sessionState) return null;

    // Extract messages
    const allMessages = extractMessages(sessionState);
    if (allMessages.length === 0) return null;

    // Extract the last N pairs (user + assistant)
    const pairs = [];
    let i = allMessages.length - 1;
    while (i >= 0 && pairs.length < pairCount) {
      if (allMessages[i].role === 'assistant') {
        const assistantMsg = allMessages[i];
        let j = i - 1;
        while (j >= 0 && allMessages[j].role !== 'user') j--;
        if (j >= 0) {
          pairs.unshift(allMessages[j], assistantMsg);
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

    // Extract session ID from file name (strip .jsonl extension)
    const sessionFileName = sessionFile.split('/').pop();
    const sessionId = sessionFileName ? sessionFileName.replace('.jsonl', '') : null;

    return {
      agent: AGENT_NAME,
      sessionId,
      branch: null, // Copilot Chat doesn't typically store branch info in session files
      messages: lastMessages,
      timestamp: fileStat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}
