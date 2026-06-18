/**
 * Detects if a message text contains a compaction summary (e.g., from Claude Code or Antigravity/Gemini).
 * @param {string} text
 * @returns {boolean}
 */
export function isCompactionSummary(text) {
  if (!text) return false;
  const hasContinued = text.includes('This session is being continued from a previous conversation');
  const hasKeyHeaders = text.includes('Summary:') && 
                        (text.includes('Primary Request and Intent') || 
                         text.includes('Key Technical Concepts'));
  return hasContinued || hasKeyHeaders;
}
