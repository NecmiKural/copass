/**
 * transcript.js — the whole session as Markdown, written next to the
 * hand-over so the receiving agent can grep exact wording, code, commands
 * and errors that the hand-over only summarizes.
 */

import { localTime } from './render.js';
import { clean, oneLine } from './text.js';

const STATUS_MARK = { done: 'x', active: '>', pending: ' ', blocked: '!' };

/** Quote agent-written text as a blockquote so it can never pose as a "User" heading. */
const quote = (text) => clean(text).replace(/^/gm, '> ');

function toolLine(e) {
  const target = e.target ? ` \`${oneLine(e.target, 400)}\`` : '';
  let outcome = '';
  if (e.ok === true) outcome = ' → ✓';
  else if (e.ok === false) {
    const exit = e.exit !== undefined ? ` exit ${e.exit}` : '';
    outcome = ` → ✗${exit}${e.error ? `\n  ${clean(e.error).trim().replace(/\n/g, '\n  ')}` : ''}`;
  }
  return `- ${e.tool}${target}${outcome}`;
}

/**
 * @param {import('./assemble.js').Session} session
 * @param {string} label
 * @returns {string}
 */
export function renderTranscript(session, label) {
  const { meta, events } = session;
  const out = [
    `# ${label} session ${meta.sessionId}${meta.title ? ` — ${oneLine(meta.title, 200)}` : ''}`,
    '',
    `- Working directory: ${meta.cwd ?? '?'}`,
    meta.logFile && `- Original log: ${meta.logFile}`,
    meta.model && `- Model: ${meta.model}`,
    `- Last activity: ${localTime(meta.lastActivity)}`,
    '',
  ].filter((l) => l !== undefined && l !== false && l !== null);

  let inTools = false;
  for (const e of events) {
    if (e.kind !== 'tool' && inTools) {
      out.push('');
      inTools = false;
    }
    switch (e.kind) {
      case 'prompt':
        out.push(`## [${localTime(e.ts)}] User${e.source ? ` (${e.source}, never sent)` : ''}`, '', clean(e.text), '');
        break;
      case 'reply':
        out.push(`### ${label}${e.partial ? ' (cut off)' : ''}`, '', quote(e.text), '');
        break;
      case 'tool':
        out.push(toolLine(e));
        inTools = true;
        break;
      case 'compaction':
        out.push('---', `## [${localTime(e.ts)}] Context compacted${e.trigger ? ` (${e.trigger})` : ''}`, '', e.summary ? quote(e.summary) : '_(summary not stored in readable form)_', '', '---', '');
        break;
      case 'plan':
        out.push('**Plan updated:**', ...e.items.map((i) => `- [${STATUS_MARK[i.status] ?? ' '}] ${i.text}`), '');
        break;
      case 'stop':
        out.push(`**[${localTime(e.ts)}] Stopped (${e.reason})${e.message ? `: ${oneLine(e.message, 300)}` : ''}**`, '');
        break;
      case 'interrupt':
        out.push('_[the user interrupted this turn]_', '');
        break;
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}
