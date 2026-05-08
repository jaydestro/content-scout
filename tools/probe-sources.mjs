#!/usr/bin/env node
// Probe each Content Scout source endpoint and report status.
// Usage: node tools/probe-sources.mjs
// Reads .env from the workspace root. No external deps (uses fetch).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// --- minimal .env loader ---
const env = {};
try {
  const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
} catch (e) {
  console.error('Could not read .env:', e.message);
}

const UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_SCOUT = env.REDDIT_USER_AGENT || 'content-scout/1.0 (probe)';

const results = [];

function record(name, ok, detail) {
  const status = ok === true ? 'OK' : ok === 'warn' ? 'WARN' : 'FAIL';
  results.push({ name, status, detail });
  const tag = ok === true ? '\x1b[32mOK  \x1b[0m' : ok === 'warn' ? '\x1b[33mWARN\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`${tag} ${name.padEnd(34)} ${detail}`);
}

async function timed(fn, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

// ---------- Reddit ----------
async function probeRedditOAuth() {
  if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET) {
    record('Reddit OAuth (auth)', 'warn', 'No REDDIT_CLIENT_ID/SECRET in .env -> will use unauth fallback');
    return null;
  }
  try {
    const basic = Buffer.from(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await timed((signal) =>
      fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA_SCOUT,
        },
        body: 'grant_type=client_credentials',
      })
    );
    if (!tokenRes.ok) {
      const body = (await tokenRes.text()).slice(0, 120);
      record('Reddit OAuth (auth)', false, `${tokenRes.status} ${tokenRes.statusText} :: ${body}`);
      return null;
    }
    const tok = await tokenRes.json();
    if (!tok.access_token) {
      record('Reddit OAuth (auth)', false, `no access_token in response: ${JSON.stringify(tok).slice(0, 120)}`);
      return null;
    }

    const searchRes = await timed((signal) =>
      fetch('https://oauth.reddit.com/search?q=cosmosdb&sort=new&t=month&limit=3', {
        signal,
        headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': UA_SCOUT },
      })
    );
    if (!searchRes.ok) {
      record('Reddit OAuth (search)', false, `${searchRes.status} ${searchRes.statusText}`);
      return null;
    }
    const j = await searchRes.json();
    const n = j?.data?.children?.length ?? 0;
    record('Reddit OAuth (auth+search)', true, `token ok, /search returned ${n} items`);
    return tok.access_token;
  } catch (e) {
    record('Reddit OAuth (auth)', false, e.message);
    return null;
  }
}

async function probeRedditUnauth() {
  try {
    const res = await timed((signal) =>
      fetch('https://www.reddit.com/search.json?q=cosmosdb&sort=new&t=month&limit=3', {
        signal,
        headers: { 'User-Agent': UA_BROWSER, Accept: 'application/json' },
      })
    );
    if (!res.ok) {
      record('Reddit unauth (.json)', false, `${res.status} ${res.statusText}`);
      return;
    }
    const j = await res.json();
    const n = j?.data?.children?.length ?? 0;
    record('Reddit unauth (.json)', true, `returned ${n} items`);
  } catch (e) {
    record('Reddit unauth (.json)', false, e.message);
  }
}

// ---------- GitHub ----------
async function probeGitHub() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': UA_SCOUT };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  try {
    const res = await timed((signal) =>
      fetch('https://api.github.com/search/repositories?q=cosmosdb+stars:%3E50&sort=updated&per_page=3', {
        signal,
        headers,
      })
    );
    const remaining = res.headers.get('x-ratelimit-remaining');
    const limit = res.headers.get('x-ratelimit-limit');
    if (!res.ok) {
      record('GitHub /search', false, `${res.status} ${res.statusText} (limit=${limit} rem=${remaining})`);
      return;
    }
    const j = await res.json();
    const auth = env.GITHUB_TOKEN ? 'authenticated' : 'unauth';
    record('GitHub /search', true, `${auth}, ${j.items?.length ?? 0} items, ratelimit ${remaining}/${limit}`);
  } catch (e) {
    record('GitHub /search', false, e.message);
  }
}

// ---------- Stack Overflow ----------
async function probeStackOverflow() {
  try {
    const res = await timed((signal) =>
      fetch(
        'https://api.stackexchange.com/2.3/questions?order=desc&sort=creation&tagged=azure-cosmosdb&site=stackoverflow&pagesize=3',
        { signal, headers: { 'User-Agent': UA_SCOUT } }
      )
    );
    if (!res.ok) {
      record('Stack Overflow API', false, `${res.status} ${res.statusText}`);
      return;
    }
    const j = await res.json();
    record('Stack Overflow API', true, `quota_remaining=${j.quota_remaining}, ${j.items?.length ?? 0} items`);
  } catch (e) {
    record('Stack Overflow API', false, e.message);
  }
}

// ---------- Hacker News (Algolia) ----------
async function probeHN() {
  try {
    const res = await timed((signal) =>
      fetch('https://hn.algolia.com/api/v1/search_by_date?query=cosmosdb&hitsPerPage=3', {
        signal,
        headers: { 'User-Agent': UA_SCOUT },
      })
    );
    if (!res.ok) {
      record('Hacker News (Algolia)', false, `${res.status} ${res.statusText}`);
      return;
    }
    const j = await res.json();
    record('Hacker News (Algolia)', true, `${j.nbHits ?? 0} total hits, ${j.hits?.length ?? 0} returned`);
  } catch (e) {
    record('Hacker News (Algolia)', false, e.message);
  }
}

// ---------- RSS-style endpoints ----------
async function probeRss(name, url) {
  try {
    const res = await timed((signal) =>
      fetch(url, { signal, headers: { 'User-Agent': UA_SCOUT, Accept: 'application/rss+xml, application/xml, */*' } })
    );
    if (!res.ok) {
      record(name, false, `${res.status} ${res.statusText}`);
      return;
    }
    const text = await res.text();
    const items = (text.match(/<item[\s>]/g) || text.match(/<entry[\s>]/g) || []).length;
    record(name, true, `${items} <item>/<entry> elements, ${text.length} bytes`);
  } catch (e) {
    record(name, false, e.message);
  }
}

// ---------- YouTube ----------
async function probeYouTube() {
  if (!env.YOUTUBE_API_KEY) {
    record('YouTube Data API', 'warn', 'No YOUTUBE_API_KEY in .env');
    return;
  }
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=cosmosdb&maxResults=3&key=${encodeURIComponent(
      env.YOUTUBE_API_KEY
    )}`;
    const res = await timed((signal) => fetch(url, { signal }));
    if (!res.ok) {
      const body = (await res.text()).slice(0, 160);
      record('YouTube Data API', false, `${res.status} ${res.statusText} :: ${body}`);
      return;
    }
    const j = await res.json();
    record('YouTube Data API', true, `${j.items?.length ?? 0} items`);
  } catch (e) {
    record('YouTube Data API', false, e.message);
  }
}

// ---------- Bluesky ----------
async function probeBluesky() {
  if (!env.BLUESKY_HANDLE || !env.BLUESKY_APP_PASSWORD) {
    record('Bluesky', 'warn', 'No BLUESKY_HANDLE / BLUESKY_APP_PASSWORD in .env');
    return;
  }
  try {
    const sessRes = await timed((signal) =>
      fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: env.BLUESKY_HANDLE, password: env.BLUESKY_APP_PASSWORD }),
      })
    );
    if (!sessRes.ok) {
      const body = (await sessRes.text()).slice(0, 160);
      record('Bluesky session', false, `${sessRes.status} ${sessRes.statusText} :: ${body}`);
      return;
    }
    const sess = await sessRes.json();
    const searchRes = await timed((signal) =>
      fetch('https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=cosmosdb&limit=3', {
        signal,
        headers: { Authorization: `Bearer ${sess.accessJwt}` },
      })
    );
    if (!searchRes.ok) {
      record('Bluesky searchPosts', false, `${searchRes.status} ${searchRes.statusText}`);
      return;
    }
    const j = await searchRes.json();
    record('Bluesky session+search', true, `${j.posts?.length ?? 0} posts`);
  } catch (e) {
    record('Bluesky', false, e.message);
  }
}

// ---------- Brave Search API ----------
async function probeBrave() {
  if (!env.BRAVE_SEARCH_API_KEY) {
    record('Brave Search API', 'warn', 'No BRAVE_SEARCH_API_KEY in .env (Reddit Layer 3 / LinkedIn Layer 1 / X Layer 2 will all fall through)');
    return;
  }
  try {
    const res = await timed((signal) =>
      fetch('https://api.search.brave.com/res/v1/web/search?q=cosmosdb+site%3Areddit.com&count=3', {
        signal,
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY,
        },
      })
    );
    if (res.status === 200) {
      const j = await res.json();
      const n = j?.web?.results?.length ?? 0;
      record('Brave Search API', true, `${n} results in probe`);
      return;
    }
    if (res.status === 422) {
      const body = (await res.text()).slice(0, 200);
      if (/SUBSCRIPTION_TOKEN_INVALID/i.test(body)) {
        record('Brave Search API', false, 'subscription token invalid (regenerate at api.search.brave.com/app/keys)');
      } else {
        record('Brave Search API', false, `422 :: ${body}`);
      }
      return;
    }
    if (res.status === 429) {
      record('Brave Search API', 'warn', 'token valid but rate-limited (free tier = 1 query/sec, 2000/month)');
      return;
    }
    const body = (await res.text()).slice(0, 200);
    record('Brave Search API', false, `${res.status} ${res.statusText} :: ${body}`);
  } catch (e) {
    record('Brave Search API', false, e.message);
  }
}

// ---------- X / Twitter ----------
async function probeX() {
  if (!env.X_BEARER_TOKEN) {
    record('X (Twitter) API', 'warn', 'No X_BEARER_TOKEN in .env');
    return;
  }
  try {
    const res = await timed((signal) =>
      fetch('https://api.twitter.com/2/tweets/search/recent?query=cosmosdb&max_results=10', {
        signal,
        headers: { Authorization: `Bearer ${env.X_BEARER_TOKEN}` },
      })
    );
    if (!res.ok) {
      const body = (await res.text()).slice(0, 160);
      record('X (Twitter) API', false, `${res.status} ${res.statusText} :: ${body}`);
      return;
    }
    const j = await res.json();
    record('X (Twitter) API', true, `${j.data?.length ?? 0} tweets, meta=${JSON.stringify(j.meta || {})}`);
  } catch (e) {
    record('X (Twitter) API', false, e.message);
  }
}

// ---------- main ----------
console.log('Probing Content Scout sources...\n');

await probeRedditOAuth();
await probeRedditUnauth();
await probeGitHub();
await probeStackOverflow();
await probeHN();
await probeRss('Dev.to RSS (cosmosdb tag)', 'https://dev.to/feed/tag/cosmosdb');
await probeRss('Medium RSS (cosmosdb tag)', 'https://medium.com/feed/tag/cosmosdb');
await probeRss('Hashnode RSS (cosmosdb tag)', 'https://hashnode.com/n/cosmosdb/rss');
await probeRss('DZone RSS', 'https://feeds.dzone.com/database');
await probeRss('InfoQ RSS', 'https://feed.infoq.com/');
await probeRss('C# Corner RSS', 'https://www.c-sharpcorner.com/rss/articles.xml');
await probeYouTube();
await probeBluesky();
await probeBrave();
await probeX();

console.log('\n--- summary ---');
const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
console.log(counts);

const failed = results.filter((r) => r.status === 'FAIL');
if (failed.length) {
  console.log('\nFailed sources:');
  for (const r of failed) console.log(`  - ${r.name}: ${r.detail}`);
  process.exit(1);
}
