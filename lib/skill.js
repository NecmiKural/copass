/**
 * skill.js — an Agent Skill that lets the receiving agent pull the hand-over
 * itself ("continue where I left off"), so nothing has to be pasted.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AGENT_NAMES } from '../agents/index.js';

// [skills directory, agent home that must exist (null = always)], relative to $HOME.
const TARGETS = [
  ['.claude/skills', '.claude'], // Claude Code
  ['.agents/skills', null], // shared location: Codex, Cursor, Antigravity, Gemini CLI, VS Code…
  ['.copilot/skills', '.copilot'], // GitHub Copilot CLI
  ['.factory/skills', '.factory'], // Factory Droid
  ['.qwen/skills', '.qwen'], // Qwen Code
];

/** @param {string} command  how to run copass, e.g. `copass` or `node "/path/index.js"` */
export function skillMarkdown(command) {
  return `---
name: copass
description: Continue a coding session that was started in another AI coding agent (Claude Code, Codex, Antigravity, GitHub Copilot, Cline, Gemini CLI, Cursor, OpenCode, pi…). Use when the user says "continue where we left off", "pick up from Claude/Codex", "kaldığımız yerden devam et", "the other agent ran out of quota/limit", or mentions copass or a hand-over.
---

# copass — continue from another agent

copass reads the other agent's local session logs (no network, no tokens) and builds a hand-over: the task, the user's standing instructions, the latest request, what was done, the plan and the verified git state.

1. In the project directory, run:

   \`\`\`sh
   ${command} relay --stdout --no-copy --exclude <you>
   \`\`\`

   Replace \`<you>\` with your own agent so copass does not hand your fresh session back to you: ${AGENT_NAMES.join(', ')}.
   If the user named the agent or session to continue from, add \`--from <agent>\` or \`--session <id>\` (\`${command} list\` shows them).
2. Read the hand-over it prints and follow its \`<instruction>\` section.
3. For exact code, commands or error messages, search the transcript file named in \`<pointers>\` instead of guessing.
`;
}

/**
 * Write the skill for every agent present in `home`.
 *
 * @param {string} home
 * @param {string} command
 * @returns {string[]} files written
 */
export function installSkill(home, command) {
  const written = [];
  for (const [dir, requires] of TARGETS) {
    if (requires && !existsSync(join(home, requires))) continue;
    const target = join(home, dir, 'copass');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), skillMarkdown(command));
    written.push(join(target, 'SKILL.md'));
  }
  return written;
}
