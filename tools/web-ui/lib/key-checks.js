// Per-key format validators + live reachability tests for credentials in .env.
// Shared by /api/env/test and the scout-keys agent flow so both paths give the
// same verdict.
//
// Format validators are intentionally lenient: they catch obvious mistakes
// (wrong prefix, paste truncated, main-password instead of app-password)
// without rejecting legitimate edge cases. Reachability tests do a single
// minimal HTTP call per source.

const TIMEOUT_MS = 8000;

function withTimeout(promise, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t), promise };
}

async function safeFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return { ok: true, status: res.status, res };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Format validators. Each returns { ok, message }. `ok=true` does NOT mean
// the credential works — only that it's well-shaped enough to bother testing.
// ---------------------------------------------------------------------------

const FORMAT = {
  YOUTUBE_API_KEY(v) {
    if (!v) return { ok: false, message: 'empty' };
    if (!v.startsWith('AIza')) return { ok: false, message: 'YouTube API keys start with "AIza"' };
    if (v.length !== 39) return { ok: false, message: `expected 39 chars, got ${v.length}` };
    return { ok: true };
  },
  GITHUB_TOKEN(v) {
    if (!v) return { ok: false, message: 'empty' };
    if (!/^(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)/.test(v)) {
      return { ok: false, message: 'expected prefix github_pat_ or ghp_' };
    }
    if (v.length < 40) return { ok: false, message: `token looks truncated (${v.length} chars, expected ≥40)` };
    return { ok: true };
  },
  BLUESKY_HANDLE(v) {
    if (!v) return { ok: false, message: 'empty' };
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]+$/i.test(v)) {
      return { ok: false, message: 'expected something like yourname.bsky.social' };
    }
    return { ok: true };
  },
  BLUESKY_APP_PASSWORD(v) {
    if (!v) return { ok: false, message: 'empty' };
    // Bluesky app passwords are formatted as xxxx-xxxx-xxxx-xxxx (19 chars).
    if (!/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i.test(v)) {
      return {
        ok: false,
        message: 'expected app-password format xxxx-xxxx-xxxx-xxxx (generate at bsky.app → Settings → App Passwords). Do NOT use your main account password.',
      };
    }
    return { ok: true };
  },
  REDDIT_CLIENT_ID(v) {
    if (!v) return { ok: false, message: 'empty' };
    if (v.length < 8 || v.length > 30) return { ok: false, message: `expected 8–30 chars, got ${v.length}` };
    return { ok: true };
  },
  REDDIT_CLIENT_SECRET(v) {
    if (!v) return { ok: false, message: 'empty' };
    if (v.length < 20) return { ok: false, message: `secret looks truncated (${v.length} chars, expected ≥20)` };
    return { ok: true };
  },
  REDDIT_USER_AGENT(v) {
    if (!v) return { ok: false, message: 'empty' };
    if (v.length < 5) return { ok: false, message: 'too short — use something like "content-scout/1.0 by yourhandle"' };
    return { ok: true };
  },
  X_BEARER_TOKEN(v) {
    if (!v) return { ok: false, message: 'empty' };
    if (!v.startsWith('AAAA')) return { ok: false, message: 'X bearer tokens start with "AAAA"' };
    if (v.length < 100) return { ok: false, message: `token looks truncated (${v.length} chars, expected ≥100)` };
    return { ok: true };
  },
  GOOGLE_PSE_KEY(v) {
    if (!v) return { ok: false, message: 'empty' };
    if (!v.startsWith('AIza')) return { ok: false, message: 'Google API keys start with "AIza"' };
    if (v.length !== 39) return { ok: false, message: `expected 39 chars, got ${v.length}` };
    return { ok: true };
  },
  GOOGLE_PSE_CX(v) {
    if (!v) return { ok: false, message: 'empty' };
    // Programmable Search Engine IDs are typically 17–40 chars, alphanumeric
    // with optional `:` separator (legacy format) or a single token.
    if (!/^[a-z0-9:_-]{8,40}$/i.test(v)) {
      return { ok: false, message: 'expected 8–40 alphanumeric chars (with optional `:`/`-`/`_`)' };
    }
    return { ok: true };
  },
  BRAVE_SEARCH_API_KEY(v) {
    if (!v) return { ok: false, message: 'empty' };
    // Brave keys are typically 32 chars, alphanumeric with `_` / `-`. Be
    // lenient on exact length since Brave hasn't publicly committed to a
    // fixed format — just sanity-check length and charset.
    if (v.length < 20 || v.length > 64) return { ok: false, message: `expected 20–64 chars, got ${v.length}` };
    if (!/^[A-Za-z0-9_-]+$/.test(v)) return { ok: false, message: 'expected alphanumeric + `_`/`-` only' };
    return { ok: true };
  },
  SCOUT_WEBHOOK_URL(v) {
    if (!v) return { ok: false, message: 'empty' };
    try {
      const u = new URL(v);
      if (!/^https?:$/.test(u.protocol)) return { ok: false, message: 'must be http(s) URL' };
    } catch {
      return { ok: false, message: 'not a valid URL' };
    }
    return { ok: true };
  },
};

export function validateFormat(key, value) {
  const fn = FORMAT[String(key || '').toUpperCase()];
  if (!fn) return { ok: true, message: 'no format validator for this key (skipping)' };
  return fn(value || '');
}

// ---------------------------------------------------------------------------
// Reachability testers. Each takes the full bag of env values (so multi-key
// sources like Reddit can read all three) and returns
// { reachable, status, message }.
// ---------------------------------------------------------------------------

const REACH = {
  async YOUTUBE_API_KEY({ YOUTUBE_API_KEY }) {
    if (!YOUTUBE_API_KEY) return { reachable: false, status: 0, message: 'no key set' };
    const r = await safeFetch(
      `https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=${encodeURIComponent(YOUTUBE_API_KEY)}`
    );
    if (!r.ok) return { reachable: false, status: 0, message: r.error };
    if (r.status === 200) return { reachable: true, status: 200, message: 'videos.list returned 200' };
    if (r.status === 400 || r.status === 403) {
      const body = await r.res.text().catch(() => '');
      return { reachable: false, status: r.status, message: `quota or key rejected: ${body.slice(0, 200)}` };
    }
    return { reachable: false, status: r.status, message: `unexpected ${r.status}` };
  },

  async GITHUB_TOKEN({ GITHUB_TOKEN }) {
    if (!GITHUB_TOKEN) return { reachable: false, status: 0, message: 'no token set' };
    const r = await safeFetch('https://api.github.com/rate_limit', {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'content-scout-key-check',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!r.ok) return { reachable: false, status: 0, message: r.error };
    if (r.status === 200) {
      const j = await r.res.json().catch(() => null);
      const limit = j?.resources?.core?.limit;
      if (limit === 5000) return { reachable: true, status: 200, message: 'authenticated (5000/hr)' };
      if (limit === 60) return { reachable: false, status: 200, message: 'request succeeded but rate limit is 60/hr — token not authenticated' };
      return { reachable: true, status: 200, message: `core limit ${limit}` };
    }
    return { reachable: false, status: r.status, message: `unexpected ${r.status}` };
  },

  async BLUESKY_APP_PASSWORD({ BLUESKY_HANDLE, BLUESKY_APP_PASSWORD }) {
    if (!BLUESKY_HANDLE) return { reachable: false, status: 0, message: 'BLUESKY_HANDLE not set' };
    if (!BLUESKY_APP_PASSWORD) return { reachable: false, status: 0, message: 'no password set' };
    const r = await safeFetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: BLUESKY_HANDLE, password: BLUESKY_APP_PASSWORD }),
    });
    if (!r.ok) return { reachable: false, status: 0, message: r.error };
    if (r.status === 200) return { reachable: true, status: 200, message: 'createSession ok' };
    if (r.status === 401) return { reachable: false, status: 401, message: 'rejected — regenerate app password at bsky.app/settings/app-passwords' };
    return { reachable: false, status: r.status, message: `unexpected ${r.status}` };
  },

  // Alias so the UI can test from either field.
  async BLUESKY_HANDLE(env) { return REACH.BLUESKY_APP_PASSWORD(env); },

  async REDDIT_CLIENT_ID({ REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT }) {
    if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) {
      return { reachable: false, status: 0, message: 'need both REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET' };
    }
    const auth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
    const r = await safeFetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': REDDIT_USER_AGENT || 'content-scout/1.0 (key-check)',
      },
      body: 'grant_type=client_credentials',
    });
    if (!r.ok) return { reachable: false, status: 0, message: r.error };
    if (r.status === 200) {
      const j = await r.res.json().catch(() => null);
      if (j?.access_token) return { reachable: true, status: 200, message: 'OAuth token issued' };
      return { reachable: false, status: 200, message: 'no access_token in response' };
    }
    if (r.status === 401) return { reachable: false, status: 401, message: 'invalid client_id / client_secret' };
    return { reachable: false, status: r.status, message: `unexpected ${r.status}` };
  },
  async REDDIT_CLIENT_SECRET(env) { return REACH.REDDIT_CLIENT_ID(env); },
  async REDDIT_USER_AGENT(env) { return REACH.REDDIT_CLIENT_ID(env); },

  async GOOGLE_PSE_KEY({ GOOGLE_PSE_KEY, GOOGLE_PSE_CX }) {
    if (!GOOGLE_PSE_KEY) return { reachable: false, status: 0, message: 'no key set' };
    if (!GOOGLE_PSE_CX) return { reachable: false, status: 0, message: 'GOOGLE_PSE_CX not set' };
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(GOOGLE_PSE_KEY)}&cx=${encodeURIComponent(GOOGLE_PSE_CX)}&q=test+site:reddit.com&num=1`;
    const r = await safeFetch(url);
    if (!r.ok) return { reachable: false, status: 0, message: r.error };
    if (r.status === 200) return { reachable: true, status: 200, message: 'customsearch.list returned 200' };
    if (r.status === 403) {
      const body = await r.res.text().catch(() => '');
      // Detect the specific "closed to new customers" wording so we can warn.
      if (/does not have the access to Custom Search/i.test(body)) {
        return { reachable: false, status: 403, message: 'Custom Search JSON API is closed to new customers since early 2026 — use BRAVE_SEARCH_API_KEY instead. (Existing pre-2026 PSE projects keep working until Jan 1, 2027.)' };
      }
      return { reachable: false, status: 403, message: `Custom Search API not enabled or quota exhausted: ${body.slice(0, 200)}` };
    }
    if (r.status === 400) {
      const body = await r.res.text().catch(() => '');
      return { reachable: false, status: 400, message: `bad request — check CX value: ${body.slice(0, 200)}` };
    }
    return { reachable: false, status: r.status, message: `unexpected ${r.status}` };
  },
  async GOOGLE_PSE_CX(env) { return REACH.GOOGLE_PSE_KEY(env); },

  async BRAVE_SEARCH_API_KEY({ BRAVE_SEARCH_API_KEY }) {
    if (!BRAVE_SEARCH_API_KEY) return { reachable: false, status: 0, message: 'no key set' };
    // The /web/search endpoint is the primary one Content Scout uses. A 1-result
    // probe is the cheapest possible call against the user's free quota.
    const r = await safeFetch(
      'https://api.search.brave.com/res/v1/web/search?q=test&count=1',
      {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': BRAVE_SEARCH_API_KEY,
        },
      }
    );
    if (!r.ok) return { reachable: false, status: 0, message: r.error };
    if (r.status === 200) {
      const j = await r.res.json().catch(() => null);
      const n = j?.web?.results?.length ?? 0;
      return { reachable: true, status: 200, message: `web/search ok (${n} results in probe)` };
    }
    if (r.status === 401 || r.status === 403) {
      const body = await r.res.text().catch(() => '');
      return { reachable: false, status: r.status, message: `subscription token rejected (regenerate at api.search.brave.com/app/keys): ${body.slice(0, 200)}` };
    }
    if (r.status === 422) {
      const body = await r.res.text().catch(() => '');
      // Brave returns 422 with code "SUBSCRIPTION_TOKEN_INVALID" for bad tokens.
      if (/SUBSCRIPTION_TOKEN_INVALID/i.test(body)) {
        return { reachable: false, status: 422, message: 'subscription token invalid (regenerate at api.search.brave.com/app/keys)' };
      }
      return { reachable: false, status: 422, message: `bad request: ${body.slice(0, 200)}` };
    }
    if (r.status === 429) return { reachable: true, status: 429, message: 'token valid but rate-limited (free tier = 1 query/sec, 2000/month)' };
    return { reachable: false, status: r.status, message: `unexpected ${r.status}` };
  },

  async X_BEARER_TOKEN({ X_BEARER_TOKEN }) {
    if (!X_BEARER_TOKEN) return { reachable: false, status: 0, message: 'no token set' };
    // Hit a cheap endpoint. Free tier 403s on most search endpoints; that's
    // not a credential failure, just a tier restriction — surface it clearly.
    const r = await safeFetch('https://api.twitter.com/2/tweets/20', {
      headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
    });
    if (!r.ok) return { reachable: false, status: 0, message: r.error };
    if (r.status === 200) return { reachable: true, status: 200, message: 'token authenticated' };
    if (r.status === 401) return { reachable: false, status: 401, message: 'invalid bearer token' };
    if (r.status === 403) return { reachable: true, status: 403, message: 'token valid but Free tier blocks this endpoint — search calls will likely 403 too' };
    if (r.status === 429) return { reachable: true, status: 429, message: 'token valid but rate-limited' };
    return { reachable: false, status: r.status, message: `unexpected ${r.status}` };
  },

  async SCOUT_WEBHOOK_URL({ SCOUT_WEBHOOK_URL }) {
    if (!SCOUT_WEBHOOK_URL) return { reachable: false, status: 0, message: 'no URL set' };
    // Don't actually POST a payload — just probe with HEAD/GET so we don't
    // spam the user's Slack/Teams channel with a test message.
    const r = await safeFetch(SCOUT_WEBHOOK_URL, { method: 'GET' });
    if (!r.ok) return { reachable: false, status: 0, message: r.error };
    // Many webhook endpoints return 4xx for GET; treat anything <500 as "host reachable".
    if (r.status < 500) return { reachable: true, status: r.status, message: `host reachable (${r.status})` };
    return { reachable: false, status: r.status, message: `server error ${r.status}` };
  },
};

export async function testReachability(key, envBag) {
  const fn = REACH[String(key || '').toUpperCase()];
  if (!fn) return { reachable: null, status: 0, message: 'no reachability test for this key' };
  try {
    return await fn(envBag || {});
  } catch (err) {
    return { reachable: false, status: 0, message: String(err.message || err) };
  }
}

export function listSupportedKeys() {
  return Object.keys(FORMAT);
}
