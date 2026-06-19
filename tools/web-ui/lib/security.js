// Pure helper functions extracted from server.js so they can be unit-tested
// without booting the HTTP server. server.js re-exports the same logic.
import path from 'node:path';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function isValidSlug(s) {
  return typeof s === 'string' && SLUG_RE.test(s);
}

export const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
export function isValidFilename(s) {
  return typeof s === 'string' && FILENAME_RE.test(s) && !s.includes('..');
}

export function safeJoin(baseDir, name) {
  const resolved = path.resolve(baseDir, name);
  const baseWithSep = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (resolved !== baseDir && !resolved.startsWith(baseWithSep)) {
    throw new Error('path escapes base directory');
  }
  return resolved;
}

// =====================================================================
// Secret redaction for terminal output streamed back to the UI.
// ---------------------------------------------------------------------
// Defense-in-depth: API keys can show up in runner output (echoed env vars,
// auth-failure error messages, curl traces, etc.). Before any chunk is
// appended to a run's stored output or pushed to SSE listeners, we run
// it through redactSecrets() so the UI never displays a live secret —
// even if the underlying tool prints one. The original .env on disk is
// untouched; this only redacts what we *show*.
// =====================================================================

// Anything in the env whose key matches this RegExp is treated as a
// secret and its value will be replaced with [REDACTED:KEY] in output.
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|ACCESS|BEARER|AUTH|API|SESSION|COOKIE|SIGNATURE|SIGN|PRIVATE)/i;
const SECRET_LABEL_RE = /(api[_-]?key|app[_-]?password|password|passwd|pwd|token|secret|credential|bearer|auth|session|cookie|private[_-]?key)/i;

// Allow callers to extend / override the env source (tests pass a fixture).
export function collectSecretValues(env = process.env) {
  const out = [];
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v !== 'string') continue;
    if (v.length < 8) continue; // skip short values to avoid clobbering normal text
    if (!SECRET_KEY_RE.test(k)) continue;
    out.push({ key: k, value: v });
  }
  // Replace longest values first so a long secret containing a shorter one
  // gets fully masked before the shorter mask runs.
  out.sort((a, b) => b.value.length - a.value.length);
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Common token-shaped patterns that should be masked even when they
// don't appear in our .env (e.g. a key the user typed in chat, or one
// printed by an SDK). Conservative — only patterns that look unmistakably
// like credentials.
const TOKEN_PATTERNS = [
  // GitHub: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,
  // OpenAI / Anthropic / generic sk-
  /\bsk-(?:proj-|ant-|live_)?[A-Za-z0-9_\-]{20,}\b/g,
  // Slack
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  // AWS access key id
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Google API key
  /\bAIza[0-9A-Za-z_\-]{35}\b/g,
  // JWT (header.payload.signature)
  /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
  // Bearer / Basic auth header values
  /\b(Authorization|Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{12,}/gi,
];

// Lazy-cached redactor list. Tests can pass a custom env to bypass the cache.
let _cachedSecrets = null;
let _cachedEnvKey = null;
function getCachedSecrets() {
  // Use a coarse cache key so we rebuild if the env changes between calls.
  const envKey = Object.keys(process.env).length + '|' + (process.env.GITHUB_TOKEN || '').length;
  if (envKey !== _cachedEnvKey) {
    _cachedSecrets = collectSecretValues(process.env);
    _cachedEnvKey = envKey;
  }
  return _cachedSecrets;
}

export function redactSecrets(text, options = {}) {
  if (text == null) return text;
  let s = String(text);
  if (!s) return s;
  const secrets = options.secrets || getCachedSecrets();
  for (const { key, value } of secrets) {
    if (!value) continue;
    // Replace plain literal value.
    s = s.split(value).join(`[REDACTED:${key}]`);
  }
  for (const re of TOKEN_PATTERNS) {
    s = s.replace(re, (m, p1) => {
      // For the Authorization/Bearer pattern, keep the scheme.
      if (p1 && /^(Authorization|Bearer|Basic)$/i.test(p1)) return `${p1} [REDACTED]`;
      return '[REDACTED]';
    });
  }
  // KEY=value style assignments (env-export, JSON, query string) for any
  // key whose name matches our secret regex — covers values not in process.env.
  // Accept lowercase / dashed variants too because browser-run prompts and
  // SDK errors often print `password: ...`, `api-key=...`, or JSON fields.
  s = s.replace(
    /([A-Za-z][A-Za-z0-9_-]{2,})\s*([=:])\s*("?)([^"\s,;&]{8,})\3/g,
    (full, key, sep, q, val) => {
      if (!SECRET_KEY_RE.test(key) && !SECRET_LABEL_RE.test(key)) return full;
      if (val === '[REDACTED]' || val.startsWith('[REDACTED:')) return full;
      return `${key}${sep}${q}[REDACTED:${key}]${q}`;
    }
  );
  // Natural-language prompts / logs: "password is ...", "api key ...",
  // "token was ...". This is intentionally limited to unmistakable secret
  // labels and a non-space value of 8+ chars to avoid masking normal prose.
  s = s.replace(
    /\b((?:api[_ -]?key|app[_ -]?password|password|passwd|pwd|token|secret|credential|bearer|auth|session|cookie|private[_ -]?key)\b\s*(?:is|was|=|:)?\s*)([A-Za-z0-9._\-+/=]{8,})/gi,
    (full, label, val) => {
      if (val === '[REDACTED]' || val.startsWith('[REDACTED:')) return full;
      return `${label}[REDACTED]`;
    }
  );
  return s;
}

// For tests: clear the cached secrets so a new env can be picked up.
export function _resetSecretCacheForTests() {
  _cachedSecrets = null;
  _cachedEnvKey = null;
}

