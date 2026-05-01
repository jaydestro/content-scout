// Validation for scout-config-{slug}.prompt.md raw content posted via PUT /api/configs/:slug.
// Goal: prevent obviously-broken or oversized writes from corrupting a config file.
// Strict structural validation lives in the YAML/markdown layer of the agent itself; this
// is just a guardrail at the API boundary so a stray client cannot replace a config with
// arbitrary garbage.

// 256 KB cap. Real configs are well under 50 KB; anything bigger is almost certainly a bug.
export const MAX_CONFIG_BYTES = 256 * 1024;

// Required marker every scout-config file starts with. Matches the H1 emitted by
// renderConfigTemplate. Allow optional leading whitespace / BOM.
const HEADER_RE = /^\uFEFF?\s*#\s+scout-config:\s+/m;

/**
 * Validate a raw scout-config markdown payload.
 * Returns { ok: true } when the payload is acceptable, or
 * { ok: false, error, code } describing the first failure.
 */
export function validateRawConfig(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'not-string', error: 'raw must be a string' };
  }
  if (!raw.trim()) {
    return { ok: false, code: 'empty', error: 'raw is empty' };
  }
  // Byte-length check (UTF-8) so multi-byte content is measured fairly.
  const byteLen = Buffer.byteLength(raw, 'utf8');
  if (byteLen > MAX_CONFIG_BYTES) {
    return {
      ok: false,
      code: 'too-large',
      error: `raw exceeds ${MAX_CONFIG_BYTES} bytes (got ${byteLen})`,
    };
  }
  if (!HEADER_RE.test(raw)) {
    return {
      ok: false,
      code: 'missing-header',
      error: 'raw must contain a "# scout-config: ..." header',
    };
  }
  return { ok: true };
}
