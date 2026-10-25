/**
 * text.js — text helpers used when turning transcripts into a hand-over.
 *
 * Word boundaries use Unicode lookarounds instead of `\b`, which only knows
 * ASCII and would never match Turkish words such as "sakın" or "değiştirme".
 */

const W = '[\\p{L}\\p{N}_]';
const word = (alternatives) => new RegExp(`(?<!${W})(?:${alternatives})(?!${W})`, 'iu');

/**
 * Shorten text to at most `max` characters, keeping the head and the tail —
 * conclusions usually sit at the end of a message.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function clip(text, max) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  const room = Math.max(0, max - `\n[… ${s.length} chars omitted …]\n`.length);
  const head = Math.ceil(room * 0.6);
  const tail = room - head;
  return `${s.slice(0, head).trimEnd()}\n[… ${s.length - head - tail} chars omitted …]\n${tail ? s.slice(-tail).trimStart() : ''}`;
}

/** Collapse whitespace into one line and clip it. */
export function oneLine(text, max = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const NUDGE = new RegExp(
  `^(?:ok(?:ay)?|k|yes|yep|no|go(?: ahead| on)?|continue|proceed|do it|sure|thanks?|thank you|ty|lgtm|👍|` +
    `devam(?: et)?|tamam|evet|olur|peki|yap|hadi|güzel|süper|teşekkür(?:ler)?|sağ ?ol)[\\s.!,]*$`,
  'iu',
);

/** True for acknowledgements that carry no task information ("ok", "devam", "/clear"). */
export function isNudge(text) {
  const s = String(text ?? '').trim();
  return s.length === 0 || NUDGE.test(s) || /^\/\S+$/.test(s);
}

const CONSTRAINT = word(
  [
    // English
    "don'?t|do not|never|always|must(?:n'?t)?|should(?:n'?t| not)|make sure|no need to|stop (?:doing|using)",
    'without (?:asking|approval|permission|confirmation)|not allowed|forbidden|under no circumstances',
    'only (?:use|change|edit|touch|modify|work on|run|commit)|use only',
    // Turkish
    'asla|sakın|hiçbir şekilde|her zaman|daima|sadece|yalnızca|mutlaka|kesinlikle|zorunda|olmalı|olmasın',
    '(?:yapma|etme|dokunma|değiştirme|silme|kullanma|ekleme|bozma|elleme|unutma|commitleme|pushlama)(?:y[ıi]n(?:[ıi]z)?)?',
  ].join('|'),
);

// Pasted reports, logs and code are not rules the user typed.
const PASTED = /<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>|```[\s\S]*?```/g;
const MAX_TYPED_PROMPT = 2000;
const CODE_CHARS = /[`=;{}|<>$\\]/g;

/**
 * Sentences from user prompts that state a standing rule ("don't touch X",
 * "sadece Y kullan"). Compaction keeps only a fraction of such constraints,
 * so the hand-over quotes them verbatim. Only text the user typed counts:
 * pasted blocks and very long prompts (reports, logs) are skipped.
 *
 * @param {{text: string, ts?: number}[]} prompts  oldest first
 * @param {number} [limit]
 * @returns {{text: string, ts?: number}[]}  newest last, deduplicated
 */
export function extractConstraints(prompts, limit = 12) {
  const seen = new Set();
  const found = [];
  for (const p of prompts) {
    const typed = String(p.text ?? '').replace(PASTED, ' ');
    if (typed.length > MAX_TYPED_PROMPT) continue;
    for (const sentence of typed.split(/(?<=[.!?…])\s+|\n+/)) {
      const s = sentence.trim();
      if (s.length < 8 || s.length > 400 || /[,:(]$/.test(s) || (s.match(CODE_CHARS)?.length ?? 0) > 2) continue;
      if (!CONSTRAINT.test(s)) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ text: s, ts: p.ts });
    }
  }
  return found.slice(-limit);
}

const CORRECTION = new RegExp(
  `^(?:no|nope|wrong|that'?s (?:not|wrong)|not (?:that|what)|instead|revert|undo|stop|` +
    `hayır|yanlış|olmadı|olmamış|öyle değil|geri al|dur|vazgeç|bunu değil)(?!${W})`,
  'iu',
);

/** True when a user prompt corrects the agent ("no, …", "hayır …", "revert that"). */
export function isCorrection(text) {
  return CORRECTION.test(String(text ?? '').trim());
}
