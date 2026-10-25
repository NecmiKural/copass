/**
 * redact.js — scrub credentials before a hand-over leaves the agents' stores
 * (clipboard, files another agent reads).
 *
 * Transcripts routinely contain pasted keys and .env lines. Each match is
 * replaced with `[redacted:<kind>]`; nothing is logged. Assignments are only
 * redacted when the value looks like a secret, so code such as
 * `password: z.string()` or `const tokenizer = make()` survives intact.
 */

const PATTERNS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['huggingface-token', /\bhf_[A-Za-z0-9]{30,}/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36,}/g],
  ['aws-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['stripe-key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
];

const AUTH_HEADER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]{16,}={0,2}/g;
// user:password@host — the lookbehind anchors the scheme so long dashed runs cannot cause backtracking.
const URL_PASSWORD = /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,100}:)[^\s@/]{1,200}@/gi;
const MYSQL_PASSWORD = /\b(mysql|mysqldump|mysqladmin|mariadb)\b([^\n]*?\s)-p(?=[^\s-])\S+/g;
const ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_.-]{0,60})(["']?[ \t]*([=:])[ \t]*)(?:"([^"\n]{4,200})"|'([^'\n]{4,200})'|([^\s"'`,;)\]}]{6,200}))/g;

const SECRET_WORDS = new Set(['secret', 'secrets', 'token', 'password', 'passwd', 'pwd', 'credential', 'credentials', 'apikey']);
const KEY_PREFIXES = new Set(['api', 'private', 'access', 'secret', 'encryption', 'app', 'signing', 'master', 'client', 'auth']);
const PLACEHOLDER = /^(?:string|number|boolean|null|undefined|none|true|false|changeme|xxx+|\.\.\.|<[^>]*>|\[redacted.*|your[-_ ].*)$/i;

/** True when an identifier names a credential: "API_KEY", "dbPassword", "client_secret" — not "tokenizer". */
function isSecretName(name) {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_.-]+/)
    .filter(Boolean);
  return parts.some((p, i) => SECRET_WORDS.has(p) || (p === 'key' && i > 0 && KEY_PREFIXES.has(parts[i - 1])));
}

/** True when an unquoted value looks like a secret rather than code. */
function looksSecret(value, separator) {
  if (PLACEHOLDER.test(value) || /^(?:process\.env|os\.environ|env\.|\$)/.test(value)) return false;
  if (/[()<>[\]{}]/.test(value)) return false; // calls, generics, indexing
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false; // settings.password
  if (separator === ':' && /^[A-Za-z_]\w*$/.test(value) && !/\d/.test(value)) return false; // type annotation
  return value.length >= 8 && (/\d/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)) || value.length >= 24);
}

/**
 * @param {string} text
 * @returns {{ text: string, count: number }}
 */
export function redact(text) {
  let count = 0;
  const hit = (replacement) => {
    count++;
    return replacement;
  };
  let out = String(text ?? '');
  for (const [kind, re] of PATTERNS) out = out.replace(re, () => hit(`[redacted:${kind}]`));
  out = out.replace(AUTH_HEADER, (_, scheme) => hit(`${scheme} [redacted:auth]`));
  out = out.replace(URL_PASSWORD, (_, prefix) => hit(`${prefix}[redacted:password]@`));
  out = out.replace(MYSQL_PASSWORD, (_, bin, args) => hit(`${bin}${args}-p[redacted:password]`));
  out = out.replace(ASSIGNMENT, (match, name, middle, separator, dq, sq, bare) => {
    if (!isSecretName(name)) return match;
    const quoted = dq ?? sq;
    if (quoted !== undefined) {
      if (PLACEHOLDER.test(quoted.trim())) return match;
      const q = dq !== undefined ? '"' : "'";
      return hit(`${name}${middle}${q}[redacted:secret]${q}`);
    }
    return looksSecret(bare, separator) ? hit(`${name}${middle}[redacted:secret]`) : match;
  });
  return { text: out, count };
}

/**
 * Redact every text field of normalized events before anything is clipped,
 * so a cut can never leave half a secret behind.
 *
 * @param {import('./assemble.js').Event[]} events
 * @returns {{ events: import('./assemble.js').Event[], count: number }}
 */
export function redactEvents(events) {
  let count = 0;
  const scrub = (s) => {
    if (typeof s !== 'string') return s;
    const r = redact(s);
    count += r.count;
    return r.text;
  };
  const out = events.map((e) => {
    if (!e || typeof e !== 'object') return e;
    const copy = { ...e };
    for (const field of ['text', 'target', 'error', 'summary', 'message']) copy[field] = scrub(copy[field]);
    if (Array.isArray(copy.items)) copy.items = copy.items.map((i) => ({ ...i, text: scrub(i?.text) }));
    for (const k of Object.keys(copy)) if (copy[k] === undefined && !(k in e)) delete copy[k];
    return copy;
  });
  return { events: out, count };
}
