// Strips secrets from any text that may end up in a log, in the store or in an agent's prompt.
const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic (sk-ant-…), Stripe
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}/g, // Telegram bot token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/gi, // credentials in URLs
];
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const ASSIGN = /\b([A-Za-z0-9_]*(?:pass(?:word)?|passwd|secret|token|api[_-]?key|apikey|auth|credential|private[_-]?key)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)(?!Bearer\b|Basic\b|\[redacted\])(?=[^\s"',;]*\d)[^\s"',;]{6,}\3/gi; // needs a digit: "tokens: commands" is not a secret
const LONG_BLOB = /[A-Za-z0-9+/_-]{40,}={0,2}/g; // tokens without a known prefix

export function redact(text, extra = []) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const re of [...PATTERNS, ...extra]) out = out.replace(re, '[redacted]');
  out = out.replace(BEARER, '$1 [redacted]');
  out = out.replace(ASSIGN, '$1$2[redacted]');
  // A token mixes upper case, lower case and digits with no separators; paths, slugs and hex hashes stay
  return out.replace(LONG_BLOB, (m) => (/[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m) && !m.includes('/') ? '[redacted]' : m));
}
