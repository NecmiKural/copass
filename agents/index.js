/**
 * Agent adapters.
 *
 * An adapter only translates one agent's local session store into the shared
 * shape; all hand-over semantics live in lib/assemble.js. Each module exports:
 *
 *   name: string      stable id for --from / --exclude / --to, e.g. 'claude-code'
 *   label: string     display name, e.g. 'Claude Code'
 *
 *   findSessions(project, ctx): Promise<Candidate[]>
 *     Cheap discovery (aim for < 150 ms): the sessions whose recorded working
 *     directory belongs to the project (score = project.match(cwd) > 0), newest
 *     first. lastActivity is the time of the last user/assistant record — never
 *     a file mtime, which agents bump when rewriting metadata. Skip empty/stub
 *     sessions, subagent/sidechain transcripts and archived sessions; set
 *     current: true on the session copass is running inside (detect via env),
 *     background: true on non-interactive runs (`exec`, `-p`, automation).
 *
 *   loadSession(candidate, ctx): Promise<{ meta: SessionMeta, events: Event[] }>
 *     Full parse of one session into normalized events (see lib/assemble.js):
 *     genuine prompts only, visible replies only, tool calls with outcomes,
 *     structural compaction boundaries, plan snapshots, stop reasons.
 *
 *   launch(prompt, ctx): [bin, args] | null
 *     How to start the agent interactively with a first prompt (for --to);
 *     null when the agent cannot be started that way from a shell. ctx lets
 *     an adapter point at a binary installed off PATH. Optional export
 *     launchNote: a line copass prints when the first prompt is not delivered.
 *
 * Adapters read paths from ctx.home / ctx.env (never os.homedir() or
 * process.env directly) so tests can point them at fixture directories,
 * and must never write to an agent's store.
 */

import * as aider from './aider.js';
import * as antigravity from './antigravity.js';
import * as claudeCode from './claude-code.js';
import * as cline from './cline.js';
import * as codex from './codex.js';
import * as copilotCli from './copilot-cli.js';
import * as cursor from './cursor.js';
import * as factory from './factory.js';
import * as geminiCli from './gemini-cli.js';
import * as goose from './goose.js';
import * as kimi from './kimi.js';
import * as opencode from './opencode.js';
import * as pi from './pi.js';
import * as qwen from './qwen.js';
import * as vscodeCopilot from './vscode-copilot.js';

/**
 * @typedef {object} Context
 * @property {Record<string, string|undefined>} env
 * @property {string} home
 * @property {NodeJS.Platform} platform
 * @property {number} now   epoch ms
 */

/**
 * @typedef {object} Candidate  A session found for the project, cheap to produce.
 * @property {string} agent         adapter name
 * @property {string} id            session id (what --session matches by prefix)
 * @property {number} lastActivity  epoch ms of the last user/assistant record
 * @property {number} score         project.match(cwd): 3 same dir, 2 same repo, 1 subdirectory
 * @property {string} [cwd]
 * @property {string} [title]
 * @property {string} [preview]     first user prompt, shown by `copass list` when there is no title
 * @property {boolean} [current]    the session copass itself is running inside
 * @property {boolean} [background] a non-interactive run (exec, -p, automation)
 * @property {*} [ref]              adapter-private data for loadSession (paths, rows…)
 */

export const ADAPTERS = [
  claudeCode,
  codex,
  antigravity,
  vscodeCopilot,
  copilotCli,
  cline,
  geminiCli,
  cursor,
  opencode,
  goose,
  factory,
  qwen,
  kimi,
  aider,
  pi,
];

export const AGENT_NAMES = ADAPTERS.map((a) => a.name);

/** @param {string} name */
export function adapterByName(name) {
  return ADAPTERS.find((a) => a.name === name) ?? null;
}
