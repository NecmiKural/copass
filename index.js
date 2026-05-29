#!/usr/bin/env node

/**
 * index.js — CLI entry point for copass
 *
 * Commands:
 *   copass relay  [--from <agent>] [--messages <n>] [--dir <path>]
 *   copass list   [--dir <path>]
 *   copass --help
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

import { createHandover } from './relay.js';

// Parser imports for the `list` command
import * as claudeCode from './parsers/claude-code.js';
import * as codex from './parsers/codex.js';
import * as antigravity from './parsers/antigravity.js';
import * as vscopeCopilot from './parsers/vscode-copilot.js';

import { getGitState } from './git.js';

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

const PARSERS = [claudeCode, codex, antigravity, vscopeCopilot];
const VALID_AGENTS = PARSERS.map((p) => p.name);

// ─── Argument parsing ────────────────────────────────────────────────────────

/**
 * Minimal argv parser — supports `--key value` and `--flag` patterns.
 * Returns `{ _: [positional args], ...flags }`.
 *
 * @param {string[]} argv
 * @returns {{ _: string[], [key: string]: string | boolean }}
 */
function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i++; // skip value
      } else {
        result[key] = true;
      }
    } else {
      result._.push(arg);
    }
  }
  return result;
}

// ─── Help text ───────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${C.bold}${C.cyan}copass${C.reset} — AI ajan bağlam aktarım aracı

${C.bold}Kullanım:${C.reset}
  ${C.green}copass relay${C.reset}  [--from <ajan>] [--messages <n>] [--dir <yol>]
  ${C.green}copass list${C.reset}   [--dir <yol>]
  ${C.green}copass --help${C.reset}

${C.bold}Komutlar:${C.reset}
  ${C.cyan}relay${C.reset}   Handover XML oluştur ve panoya kopyala
  ${C.cyan}list${C.reset}    Algılanan ajan oturumlarını listele

${C.bold}Seçenekler (relay):${C.reset}
  ${C.yellow}--from${C.reset} <ajan>      Kaynak ajan: ${VALID_AGENTS.join(', ')}
  ${C.yellow}--messages${C.reset} <n>     Dahil edilecek mesaj sayısı (varsayılan: 5)
  ${C.yellow}--dir${C.reset} <yol>        Proje dizini (varsayılan: mevcut dizin)

${C.bold}Seçenekler (list):${C.reset}
  ${C.yellow}--dir${C.reset} <yol>        Proje dizini (varsayılan: mevcut dizin)

${C.bold}Örnekler:${C.reset}
  ${C.dim}# Otomatik algıla ve aktar${C.reset}
  copass relay

  ${C.dim}# Claude Code'dan Codex'e aktar${C.reset}
  copass relay --from claude-code

  ${C.dim}# Son 10 mesajı dahil et${C.reset}
  copass relay --messages 10

  ${C.dim}# Belirli bir proje dizininde çalış${C.reset}
  copass relay --dir /path/to/project
`);
}

// ─── relay command ───────────────────────────────────────────────────────────

async function cmdRelay(args) {
  const projectDir = resolve(args.dir || process.cwd());
  const from = args.from || undefined;
  const messageCount = args.messages ? parseInt(args.messages, 10) : 5;

  if (from && !VALID_AGENTS.includes(from)) {
    console.error(
      `${C.red}Hata:${C.reset} Bilinmeyen ajan "${from}". Geçerli ajanlar: ${VALID_AGENTS.join(', ')}`,
    );
    process.exit(1);
  }

  if (isNaN(messageCount) || messageCount < 1) {
    console.error(`${C.red}Hata:${C.reset} --messages değeri pozitif bir sayı olmalı.`);
    process.exit(1);
  }

  try {
    const { xml, savedPath, agentName, messageCount: extractedCount } = await createHandover(
      projectDir,
      { from, messageCount },
    );

    // Copy to clipboard (macOS)
    try {
      execSync('pbcopy', { input: xml, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      // pbcopy might not be available on non-macOS
      console.warn(`${C.yellow}Uyarı:${C.reset} Panoya kopyalanamadı (pbcopy bulunamadı).`);
    }

    // Count changed files from git status
    const gitState = await getGitState(projectDir);
    const changedFiles = gitState.status
      ? gitState.status.split('\n').filter((l) => l.trim()).length
      : 0;

    // Success output
    console.log('');
    console.log(`  ${C.green}✅ Handover oluşturuldu!${C.reset}`);
    console.log('');
    console.log(`  ${C.bold}Kaynak ajan:${C.reset}      ${C.cyan}${agentName}${C.reset}`);
    console.log(`  ${C.bold}Mesaj sayısı:${C.reset}     ${C.yellow}${extractedCount}${C.reset}`);
    console.log(
      `  ${C.bold}Git branch:${C.reset}       ${C.magenta}${gitState.branch || '(yok)'}${C.reset}`,
    );
    console.log(`  ${C.bold}Değişiklik:${C.reset}       ${C.yellow}${changedFiles} dosya${C.reset}`);
    console.log(`  ${C.bold}Kaydedildi:${C.reset}       ${C.dim}${savedPath}${C.reset}`);
    console.log('');
    console.log(
      `  ${C.green}📋 Panoya kopyalandı${C.reset} — yeni ajana yapıştırabilirsiniz!`,
    );
    console.log('');
  } catch (/** @type {any} */ err) {
    console.error(`${C.red}Hata:${C.reset} ${err.message}`);
    process.exit(1);
  }
}

// ─── list command ────────────────────────────────────────────────────────────

async function cmdList(args) {
  const projectDir = resolve(args.dir || process.cwd());

  console.log('');
  console.log(
    `  ${C.bold}${C.cyan}copass${C.reset} — Algılanan ajan oturumları  ${C.dim}(${projectDir})${C.reset}`,
  );
  console.log('');

  const results = await Promise.all(
    PARSERS.map(async (parser) => {
      try {
        const session = await parser.findLatestSession(projectDir);
        return { name: parser.name, session };
      } catch {
        return { name: parser.name, session: null };
      }
    }),
  );

  const gitState = await getGitState(projectDir);

  // ── Table dimensions ──────────────────────────────────────────────────
  const colWidths = {
    agent: 18,
    found: 8,
    timestamp: 22,
    messages: 10,
    branch: 20,
  };

  const totalWidth =
    colWidths.agent + colWidths.found + colWidths.timestamp + colWidths.messages + colWidths.branch + 6; // 6 for separators

  // Helpers
  const pad = (str, len) => str.slice(0, len).padEnd(len);

  // ── Header ────────────────────────────────────────────────────────────
  const topBorder = `  ┌${'─'.repeat(colWidths.agent)}┬${'─'.repeat(colWidths.found)}┬${'─'.repeat(colWidths.timestamp)}┬${'─'.repeat(colWidths.messages)}┬${'─'.repeat(colWidths.branch)}┐`;
  const headerRow = `  │${C.bold}${pad(' Ajan', colWidths.agent)}${C.reset}│${C.bold}${pad(' Durum', colWidths.found)}${C.reset}│${C.bold}${pad(' Zaman Damgası', colWidths.timestamp)}${C.reset}│${C.bold}${pad(' Mesajlar', colWidths.messages)}${C.reset}│${C.bold}${pad(' Git Branch', colWidths.branch)}${C.reset}│`;
  const midBorder = `  ├${'─'.repeat(colWidths.agent)}┼${'─'.repeat(colWidths.found)}┼${'─'.repeat(colWidths.timestamp)}┼${'─'.repeat(colWidths.messages)}┼${'─'.repeat(colWidths.branch)}┤`;
  const bottomBorder = `  └${'─'.repeat(colWidths.agent)}┴${'─'.repeat(colWidths.found)}┴${'─'.repeat(colWidths.timestamp)}┴${'─'.repeat(colWidths.messages)}┴${'─'.repeat(colWidths.branch)}┘`;

  console.log(topBorder);
  console.log(headerRow);
  console.log(midBorder);

  for (const { name, session } of results) {
    const found = session ? `${C.green} ✅${C.reset}     ` : `${C.red} ❌${C.reset}     `;
    const ts = session?.timestamp
      ? pad(' ' + new Date(session.timestamp).toISOString().slice(0, 19).replace('T', ' '), colWidths.timestamp)
      : pad(' —', colWidths.timestamp);
    const msgs = session?.messages
      ? pad(' ' + String(session.messages.length), colWidths.messages)
      : pad(' —', colWidths.messages);
    const branch = pad(' ' + (gitState.branch || '—'), colWidths.branch);

    console.log(
      `  │${C.cyan}${pad(' ' + name, colWidths.agent)}${C.reset}│${found}│${ts}│${msgs}│${branch}│`,
    );
  }

  console.log(bottomBorder);
  console.log('');
}

// ─── Main dispatch ───────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  switch (command) {
    case 'relay':
      await cmdRelay(args);
      break;

    case 'list':
      await cmdList(args);
      break;

    case undefined:
      printHelp();
      break;

    default:
      console.error(`${C.red}Hata:${C.reset} Bilinmeyen komut "${command}". --help ile kullanımı görün.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${C.red}Beklenmeyen hata:${C.reset} ${err.message}`);
  process.exit(1);
});
