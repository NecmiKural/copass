/**
 * relay.js — Handover XML generator for copass
 *
 * Discovers the most recent (or explicitly selected) AI-agent session,
 * combines it with current git state, and produces a portable XML document
 * that the next agent can ingest to resume where the previous one left off.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getGitState } from './git.js';

// Parser imports — each must export { name, findLatestSession }
import * as claudeCode from './parsers/claude-code.js';
import * as codex from './parsers/codex.js';
import * as antigravity from './parsers/antigravity.js';
import * as vscopeCopilot from './parsers/vscode-copilot.js';

/** All registered parsers in a stable order. */
const PARSERS = [claudeCode, codex, antigravity, vscopeCopilot];

/**
 * Escape XML special characters in a string.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Create a handover XML document from the best available session and current
 * git state.
 *
 * @param {string} projectDir                  - Absolute path to the project root.
 * @param {{ from?: string, messageCount?: number }} [options]
 * @returns {Promise<{ xml: string, savedPath: string, agentName: string, messageCount: number }>}
 */
export async function createHandover(projectDir, options = {}) {
  const { from, messageCount = 5 } = options;

  // ── 1. Discover sessions ──────────────────────────────────────────────
  const results = await Promise.all(
    PARSERS.map(async (parser) => {
      try {
        const session = await parser.findLatestSession(projectDir);
        return session ? { ...session, parserName: parser.name } : null;
      } catch {
        return null;
      }
    }),
  );

  // ── 2. Select the winning session ─────────────────────────────────────
  let selected = null;

  if (from) {
    // User explicitly chose an agent
    const match = results.find((r) => r && r.parserName === from);
    if (!match) {
      throw new Error(`"${from}" ajanı için oturum bulunamadı.`);
    }
    selected = match;
  } else {
    // Pick the session with the most recent timestamp
    const valid = results.filter(Boolean);
    if (valid.length === 0) {
      throw new Error('Hiçbir ajan oturumu bulunamadı.');
    }
    selected = valid.reduce((best, cur) => {
      const bestTs = best.timestamp ? new Date(best.timestamp).getTime() : 0;
      const curTs = cur.timestamp ? new Date(cur.timestamp).getTime() : 0;
      return curTs > bestTs ? cur : best;
    });
  }

  // ── 3. Trim messages to requested count ───────────────────────────────
  const messages = (selected.messages || []).slice(-messageCount);

  // ── 4. Get git state ──────────────────────────────────────────────────
  const gitState = await getGitState(projectDir);

  // ── 5. Build handover XML ─────────────────────────────────────────────
  const now = new Date().toISOString();
  const agentName = selected.parserName;

  const messagesXml = messages
    .map((m) => `    <message role="${escapeXml(m.role)}">${escapeXml(m.content)}</message>`)
    .join('\n');

  const xml = `<handover>
  <meta>
    <source_agent>${escapeXml(agentName)}</source_agent>
    <session_id>${escapeXml(selected.sessionId || '')}</session_id>
    <project>${escapeXml(projectDir)}</project>
    <git_branch>${escapeXml(gitState.branch)}</git_branch>
    <timestamp>${escapeXml(now)}</timestamp>
  </meta>

  <git_state>
    <status>${escapeXml(gitState.status)}</status>
    <diff_summary>${escapeXml(gitState.diffStat)}</diff_summary>
    <diff_content>${escapeXml(gitState.diffContent)}</diff_content>
  </git_state>

  <conversation_context>
${messagesXml}
  </conversation_context>

  <instruction>
    Yukarıdaki context'i oku. Bir önceki ajanın (${escapeXml(agentName)}) kotası bitti ve ben bu projeyi sana devrediyorum.
    Git durumunu ve konuşma geçmişini analiz et, kaldığımız yerden devam et.
  </instruction>
</handover>`;

  // ── 6. Persist to disk ────────────────────────────────────────────────
  const copassDir = join(projectDir, '.copass');
  mkdirSync(copassDir, { recursive: true });

  const safeTs = now.replace(/[:.]/g, '-');
  const savedPath = join(copassDir, `handover-${safeTs}.xml`);
  writeFileSync(savedPath, xml, 'utf8');

  return { xml, savedPath, agentName, messageCount: messages.length };
}
