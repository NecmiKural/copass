#!/usr/bin/env node

/**
 * index.js — copass CLI: continue an unfinished coding session in another AI agent.
 *
 *   copass [relay]        build a hand-over from the latest session in this project
 *   copass list           show the sessions copass can hand over
 *   copass install-skill  let agents pull hand-overs themselves
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { ADAPTERS, AGENT_NAMES, adapterByName } from './agents/index.js';
import { copyToClipboard, launchAgent, writeHandover } from './lib/output.js';
import { resolveProject } from './lib/project.js';
import { buildHandover, defaultContext, findCandidates, pickSession } from './lib/relay.js';
import { installSkill } from './lib/skill.js';
import { oneLine } from './lib/text.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

// ─── Output helpers ──────────────────────────────────────────────────────────

const useColor = (stream) => stream.isTTY && !process.env.NO_COLOR;
const paint = (stream) => {
  const on = useColor(stream);
  const code = (n) => (s) => (on ? `\x1b[${n}m${s}\x1b[0m` : String(s));
  return { bold: code(1), dim: code(2), red: code(31), green: code(32), yellow: code(33), cyan: code(36) };
};

function ago(ms, now = Date.now()) {
  const min = Math.round((now - ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

class UsageError extends Error {}

function checkAgent(name, flag) {
  if (name && !adapterByName(name)) throw new UsageError(`Unknown agent for ${flag}: "${name}". Agents: ${AGENT_NAMES.join(', ')}`);
}

const HELP = `
copass ${VERSION} — continue an unfinished coding session in another AI agent

Usage:
  copass [relay] [options]   Build a hand-over from the latest session in this project
  copass list [options]      Show the sessions copass can hand over
  copass install-skill       Let agents pull hand-overs themselves ("continue where I left off")

Relay options:
  --to <agent>        Start that agent here with the hand-over, e.g. --to codex
  --from <agent>      Only consider this agent's sessions
  --session <id>      A specific session (id prefix from \`copass list\`)
  --goal "<text>"     What the next agent should do (default: continue the last request)
  --budget <tokens>   Approximate hand-over size (default 12000)
  --stdout            Print the hand-over instead of copying it (for skills and pipes)
  --no-copy           Leave the clipboard alone
  --exclude <agent>   Ignore an agent's sessions; repeatable (e.g. the agent you are in)
  --include-self      Allow handing over the session copass is running inside
  --no-redact         Keep secrets in the output (not recommended)
  --dir <path>        Project directory (default: current directory)

list options: --from, --exclude, --dir, --json

Agents: ${AGENT_NAMES.join(', ')}

The hand-over is saved to .copass/latest.md (git-ignored) together with the full
transcript, and copied to the clipboard unless --stdout, --no-copy or --to is given.
`;

// ─── relay ───────────────────────────────────────────────────────────────────

function describeStop(session) {
  const { stop, latest } = session;
  if (stop) return `${stop.reason.replace('_', ' ')}${stop.message ? ` — ${oneLine(stop.message, 90)}` : ''}`;
  if (latest.prompt && !latest.started) return 'before answering the last message';
  return null;
}

async function relay(values) {
  checkAgent(values.from, '--from');
  checkAgent(values.to, '--to');
  for (const e of values.exclude ?? []) checkAgent(e, '--exclude');
  const budget = values.budget === undefined ? undefined : Number(values.budget);
  if (budget !== undefined && !(budget >= 1000)) throw new UsageError('--budget must be a number of tokens, at least 1000.');

  const project = resolveProject(values.dir ?? process.cwd());
  const ctx = defaultContext();
  const all = await findCandidates(
    project,
    { from: values.from, exclude: values.exclude, includeSelf: values['include-self'] || Boolean(values.session) },
    ctx,
  );
  const candidates = values.session ? all.filter((c) => c.id.startsWith(values.session)) : all;
  if (!candidates.length) {
    const scope = values.from ? `${adapterByName(values.from).label} sessions` : 'agent sessions';
    throw new Error(`No ${scope} found for ${project.dir}.${values.session ? ' Check the id with `copass list`.' : ''}`);
  }
  const picked = await pickSession(candidates, ctx);
  if (!picked) throw new Error('Found sessions, but none with a conversation copass could read. Run with COPASS_DEBUG=1 for details.');

  const now = Date.now();
  const built = buildHandover(picked, project, { budget, goal: values.goal, redact: !values['no-redact'], now });
  writeHandover(built.paths, built.handover, built.transcript);

  const out = values.stdout ? process.stderr : process.stdout;
  const c = paint(out);
  if (values.stdout) process.stdout.write(`${built.handover}\n`);
  const clipboard = values.stdout || values['no-copy'] || values.to ? null : copyToClipboard(built.handover);

  const { session } = picked;
  const { meta } = session;
  const stop = describeStop(session);
  const contents = [
    `${session.prompts.length} request(s)`,
    session.files.length && `${session.files.length} file(s) changed`,
    session.commands.length && `${session.commands.length} command(s)`,
    session.plan && `plan ${session.plan.items.filter((i) => i.status === 'done').length}/${session.plan.items.length}`,
    session.compaction && 'compaction summary',
  ].filter(Boolean);
  const lines = [
    '',
    `  ${c.green('✓')} ${c.bold('Hand-over ready')}`,
    `  From      ${c.cyan(picked.adapter.label)}${meta.title ? ` — "${oneLine(meta.title, 60)}"` : ''} ${c.dim(`(${meta.sessionId.slice(0, 8)}, ${ago(meta.lastActivity, now)})`)}`,
    stop && `  Stopped   ${c.yellow(stop)}`,
    `  Contents  ${contents.join(' · ')}`,
    `  Size      ~${Math.round(built.handover.length / 4 / 100) / 10}k tokens${built.redactions ? ` · ${built.redactions} secret(s) redacted` : ''}`,
    `  Saved     ${relative(process.cwd(), built.paths.latest) || built.paths.latest} ${c.dim('(+ full transcript)')}`,
    clipboard && `  Copied    ${c.green('to the clipboard')} — paste it into your next agent`,
    !clipboard && !values.stdout && !values.to && !values['no-copy'] && `  Copied    ${c.yellow('no clipboard tool found')} — open the saved file instead`,
    '',
  ].filter((l) => l !== false && l !== null && l !== undefined);
  out.write(`${lines.join('\n')}\n`);

  if (values.to) {
    const target = adapterByName(values.to);
    out.write(`  Starting ${target.label}…\n\n`);
    process.exitCode = launchAgent(target, project.dir);
  } else if (!values.stdout) {
    out.write(c.dim('  Tip: `copass --to <agent>` starts the next agent with it directly.\n\n'));
  }
}

// ─── list ────────────────────────────────────────────────────────────────────

async function list(values) {
  checkAgent(values.from, '--from');
  for (const e of values.exclude ?? []) checkAgent(e, '--exclude');
  const project = resolveProject(values.dir ?? process.cwd());
  const candidates = await findCandidates(project, { from: values.from, exclude: values.exclude, includeSelf: true }, defaultContext());

  if (values.json) {
    process.stdout.write(`${JSON.stringify(candidates.map(({ ref, ...c }) => c), null, 2)}\n`);
    return;
  }
  const c = paint(process.stdout);
  const now = Date.now();
  process.stdout.write(`\n  ${c.bold('copass')} — sessions for ${c.dim(project.dir)}\n\n`);
  if (!candidates.length) process.stdout.write('  None found.\n');
  for (const s of candidates.slice(0, 20)) {
    const label = adapterByName(s.agent).label.padEnd(20);
    const flags = [s.current && c.yellow('this session'), s.background && c.dim('background'), s.score < 3 && c.dim(relative(project.dir, s.cwd ?? '') || s.cwd)].filter(Boolean);
    process.stdout.write(
      `  ${c.cyan(label)} ${ago(s.lastActivity, now).padEnd(12)} ${c.dim(s.id.slice(0, 8))}  ${s.title ? oneLine(s.title, 50) : c.dim(oneLine(s.preview ?? '', 50))}${flags.length ? `  ${flags.join(' ')}` : ''}\n`,
    );
  }
  const found = new Set(candidates.map((s) => s.agent));
  const missing = ADAPTERS.filter((a) => !found.has(a.name)).map((a) => a.label);
  process.stdout.write(`\n  ${c.dim(`Nothing here from: ${missing.join(', ')}`)}\n\n`);
}

// ─── install-skill ───────────────────────────────────────────────────────────

function skill() {
  const viaBin = basename(process.argv[1] ?? '') === 'copass';
  const command = viaBin ? 'copass' : `node "${join(ROOT, 'index.js')}"`;
  const written = installSkill(homedir(), command);
  process.stdout.write(`\n  Installed the copass skill for your agents:\n${written.map((f) => `   ${f}`).join('\n')}\n\n  In the next agent, just say "continue where I left off".\n\n`);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      session: { type: 'string' },
      goal: { type: 'string' },
      budget: { type: 'string' },
      dir: { type: 'string' },
      exclude: { type: 'string', multiple: true },
      stdout: { type: 'boolean' },
      'no-copy': { type: 'boolean' },
      'include-self': { type: 'boolean' },
      'no-redact': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help) return void process.stdout.write(HELP);
  if (values.version) return void process.stdout.write(`${VERSION}\n`);

  const command = positionals[0] ?? 'relay';
  if (command === 'relay') return relay(values);
  if (command === 'list') return list(values);
  if (command === 'install-skill') return skill();
  throw new UsageError(`Unknown command "${command}". Run \`copass --help\`.`);
}

// `copass list | head` closes the pipe early; that is not an error.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

main().catch((err) => {
  const c = paint(process.stderr);
  const usage = err instanceof UsageError || err?.code?.startsWith?.('ERR_PARSE_ARGS');
  process.stderr.write(`${c.red('Error:')} ${err.message}${usage ? '' : process.env.COPASS_DEBUG ? `\n${err.stack}` : ''}\n`);
  process.exitCode = usage ? 2 : 1;
});
