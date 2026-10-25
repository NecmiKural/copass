/**
 * redact.js — scrub credentials before a hand-over leaves the machine's
 * agent stores (clipboard, files another agent reads).
 *
 * Transcripts routinely contain pasted keys and .env lines. Each match is
 * replaced with `[redacted:<kind>]`; nothing is logged.
 */

const PATTERNS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['aws-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['stripe-key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
];

// user:password@host — keep the user and host, drop the password.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)@/gi;

// SECRET_NAME = value / "apiKey": "value". Skips references and type annotations.
const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_]*["']?\s*[:=]\s*)(["']?)([^\s"',;]{8,})\2/gi;
const NOT_A_VALUE = /^(?:process\.env|os\.environ|env\.|\$\{|\$\(|<|\[redacted|string$|number$|boolean$|null$|undefined$|true$|false$)/i;

/**
 * @param {string} text
 * @returns {{ text: string, count: number }}
 */
export function redact(text) {
  let count = 0;
  let out = String(text ?? '');
  for (const [kind, re] of PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return `[redacted:${kind}]`;
    });
  }
  out = out.replace(URL_PASSWORD, (_, prefix) => {
    count++;
    return `${prefix}[redacted:password]@`;
  });
  out = out.replace(ASSIGNMENT, (match, prefix, quote, value) => {
    if (NOT_A_VALUE.test(value) || (!/[0-9]/.test(value) && value.length < 16)) return match;
    count++;
    return `${prefix}${quote}[redacted:secret]${quote}`;
  });
  return { text: out, count };
}
