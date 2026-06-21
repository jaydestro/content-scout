// url-validate.mjs — the single source of truth for "is this URL safe to
// present to the user as real, reachable content?"
//
// Content Scout's rule (now scout-wide): never put a URL in front of the user
// — in a report, a social post, the dashboard, or a chat reply — without
// validating it first. This module is the shared primitive that the web-ui
// server (/api/check-url), the validate-urls CLI, and any agent/scan flow all
// call so they agree on what "dead" means.
//
// Two layers:
//   1. isLikelyDeadUrl(url)  — cheap, offline, syntactic. Catches malformed
//      URLs and known-non-navigable shapes (e.g. LinkedIn SDUI permalinks)
//      without a network round-trip.
//   2. probeUrl(url)         — live HEAD→GET liveness check with a browser UA
//      and a short timeout. Treats auth/bot walls (401/403/429) as reachable
//      because a human clicking through sees the page; only 404/410/0 (and
//      other hard failures) count as genuinely dead.
//
// Pure ESM, no third-party deps — runs in the server, a CLI, or a worker.

export const URL_CHECK_TIMEOUT_MS = 6000;

// Browser-shaped UA: some hosts (x.com / bsky.app / linkedin.com) return
// 403/404 to "compatible;" bot UAs even on GET. Pretend to be a recent
// Chromium so liveness probes match what a user would actually see.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Hosts that routinely block automated HEAD/GET probes (bot walls, 403, 999,
// silent timeouts) even though the URL is perfectly valid for a human. A
// failed probe to these is usually a false negative, so callers that want to
// avoid stripping real-but-unprobable links can consult this list.
export const PROBE_EXEMPT_HOSTS =
  /(^|\.)(x\.com|twitter\.com|linkedin\.com|reddit\.com|bsky\.app|youtube\.com|youtu\.be)$/i;

export function isProbeExemptUrl(url) {
  try { return PROBE_EXEMPT_HOSTS.test(new URL(url).hostname); } catch { return false; }
}

// Known-dead URL shapes we can reject without touching the network. Each entry
// is { test(parsedUrl) => bool, reason }. Add to this list as new
// non-navigable synthetic-permalink patterns are discovered.
const DEAD_SHAPES = [
  {
    // LinkedIn SDUI search results expose only a synthesized
    // `/feed/sdui-post/{hash}/` permalink — LinkedIn lazy-loads the real post
    // URL on "..." menu open, so this hash never resolves to a public page.
    reason: 'linkedin-sdui-post',
    test: (u) => /(^|\.)linkedin\.com$/i.test(u.hostname) && /\/feed\/sdui-post\//i.test(u.pathname),
  },
];

// Syntactic gate. Returns { dead: boolean, reason } so callers can log WHY a
// link was rejected. `dead: true` means "do not even bother probing — this
// can never be a valid public link."
export function classifyUrlShape(raw) {
  if (!raw || typeof raw !== 'string') return { dead: true, reason: 'empty' };
  let parsed;
  try { parsed = new URL(raw.trim()); } catch { return { dead: true, reason: 'malformed' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { dead: true, reason: 'bad-protocol' };
  }
  if (!parsed.hostname || !parsed.hostname.includes('.')) {
    return { dead: true, reason: 'no-host' };
  }
  for (const shape of DEAD_SHAPES) {
    if (shape.test(parsed)) return { dead: true, reason: shape.reason };
  }
  return { dead: false, reason: '' };
}

// Convenience boolean wrapper around classifyUrlShape.
export function isLikelyDeadUrl(raw) {
  return classifyUrlShape(raw).dead;
}

// Live liveness probe. HEAD first, GET fallback for hosts that 4xx HEAD.
// Returns { ok, status, error? }. `ok` is true for 2xx/3xx and for the
// auth/bot-wall codes (401/403/429) where the page exists but we can't see it
// anonymously.
export async function probeUrl(url, { timeoutMs = URL_CHECK_TIMEOUT_MS } = {}) {
  const shape = classifyUrlShape(url);
  if (shape.dead) return { ok: false, status: 0, reason: shape.reason };

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let r = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'user-agent': BROWSER_UA, accept: '*/*' },
    });
    // Many SPAs (bsky.app, some LinkedIn routes, x.com) return 404 to HEAD
    // even though the page renders 200 on GET. 4xx that might be the server
    // lying about HEAD support gets a second-chance GET.
    if (r.status === 404 || r.status === 405 || r.status === 410 || r.status === 501 || r.status === 403) {
      r = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: ac.signal,
        headers: { 'user-agent': BROWSER_UA, accept: 'text/html,*/*' },
      });
    }
    const s = r.status;
    const ok = (s >= 200 && s < 400) || s === 401 || s === 403 || s === 429;
    return { ok, status: s };
  } catch (err) {
    return { ok: false, status: 0, error: String((err && err.message) || err) };
  } finally {
    clearTimeout(t);
  }
}

// A URL is "genuinely gone" only on 404/410. Other probe failures on bot-
// walled hosts (403/429/0) are ambiguous and should NOT be treated as dead.
export function isDefinitelyGone(status) {
  return status === 404 || status === 410;
}

// Batch-validate a list of URLs with bounded concurrency. Returns an array of
// { url, ok, status, reason, dead } in input order. `dead` reflects the
// "should we ever present this?" decision: a hard-dead shape, a 404/410, or
// (for non-exempt hosts only) any unreachable result.
export async function validateUrls(urls, { concurrency = 6, timeoutMs = URL_CHECK_TIMEOUT_MS } = {}) {
  const list = [...new Set((urls || []).map((u) => String(u || '').trim()).filter(Boolean))];
  const results = new Map();
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const u = list[i++];
      const shape = classifyUrlShape(u);
      if (shape.dead) {
        results.set(u, { url: u, ok: false, status: 0, reason: shape.reason, dead: true });
        continue;
      }
      const r = await probeUrl(u, { timeoutMs });
      const gone = isDefinitelyGone(r.status);
      const dead = gone || (!r.ok && !isProbeExemptUrl(u));
      results.set(u, { url: u, ok: !!r.ok, status: r.status || 0, reason: r.reason || r.error || '', dead });
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return list.map((u) => results.get(u));
}
