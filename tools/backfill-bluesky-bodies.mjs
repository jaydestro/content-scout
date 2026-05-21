#!/usr/bin/env node
// Backfill missing Bluesky post bodies into reports/.cached-bodies.json.
//
// Why this exists: the Bluesky API ingestion path inside `scout-scan` records
// each match with an empty `title` in the per-report JSON sidecar, so the
// Conversations view in the web UI renders those cards with no body text and
// hides the Re-check sentiment button (which is gated on having a summary).
//
// This script walks every reports/*-content.json, finds conversation items
// whose canonical URL points at bsky.app and whose `title` is empty (and not
// already cached), then fetches each one from the public Bluesky API
// (`app.bsky.feed.getPostThread`) and writes the post text into
// reports/.cached-bodies.json keyed by canonical URL.
//
// `tools/lib/report-index.mjs#loadCachedBodies` reads that file and merges it
// into the same enrichment path that already handles browser-scan sidecars,
// so the web UI picks up the summaries on the next request — no scan re-run.
//
// Usage:
//   node tools/backfill-bluesky-bodies.mjs [--force] [--dry-run] [--limit N]
//
// Flags:
//   --force    Re-fetch even URLs already in the cache.
//   --dry-run  Show what would be fetched without hitting the API or writing.
//   --limit N  Stop after N successful fetches (debugging).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalUrlKey } from './lib/report-index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(REPO_ROOT, 'reports');
const CACHE_FILE = path.join(REPORTS_DIR, '.cached-bodies.json');

const BSKY_API = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread';
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 8000;

function parseArgs(argv) {
  const args = { force: false, dryRun: false, limit: Infinity };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--limit') args.limit = Number(argv[++i]) || Infinity;
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node tools/backfill-bluesky-bodies.mjs [--force] [--dry-run] [--limit N]');
      process.exit(0);
    }
  }
  return args;
}

// Convert https://bsky.app/profile/{handle}/post/{rkey} -> { handle, rkey }.
function parseBskyUrl(url) {
  const m = String(url || '').match(/^https?:\/\/bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/i);
  if (!m) return null;
  return { handle: decodeURIComponent(m[1]), rkey: decodeURIComponent(m[2]) };
}

async function loadCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

async function saveCache(obj) {
  const tmp = CACHE_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, CACHE_FILE);
}

async function fetchPostText({ handle, rkey }) {
  const uri = `at://${handle}/app.bsky.feed.post/${rkey}`;
  const url = `${BSKY_API}?uri=${encodeURIComponent(uri)}&depth=0`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'content-scout-backfill/1.0' },
      signal: ctl.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `http ${res.status}` };
    }
    const data = await res.json();
    const text = data?.thread?.post?.record?.text;
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: 'no record.text' };
    }
    return { ok: true, body: text.trim() };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function collectTargets(cache, force) {
  const files = (await fs.readdir(REPORTS_DIR))
    .filter((f) => /^\d{4}-\d{2}-\d{2}-\d{4}-.+-content\.json$/.test(f))
    .sort();

  // urlKey -> { url, handle, rkey }
  const targets = new Map();
  for (const f of files) {
    let data;
    try {
      data = JSON.parse(await fs.readFile(path.join(REPORTS_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    for (const it of Array.isArray(data.items) ? data.items : []) {
      const section = (it.section || '').toLowerCase();
      if (!/^(mentions|conversations|social)$/.test(section)) continue;
      const url = it.url || '';
      const parsed = parseBskyUrl(url);
      if (!parsed) continue;
      // Skip if the report JSON already has body text (rare, but possible).
      if (String(it.title || '').trim()) continue;
      const key = canonicalUrlKey(url);
      if (!key) continue;
      if (!force && cache[key] && String(cache[key].body || '').trim()) continue;
      if (targets.has(key)) continue;
      targets.set(key, { url, handle: parsed.handle, rkey: parsed.rkey });
    }
  }
  return targets;
}

async function runWithConcurrency(items, worker, concurrency) {
  const queue = [...items];
  const results = [];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      results.push(await worker(item));
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  const cache = await loadCache();
  const targetsMap = await collectTargets(cache, args.force);
  const targets = [...targetsMap.entries()].slice(0, args.limit);

  console.log(`Found ${targetsMap.size} Bluesky URLs needing backfill${args.force ? ' (force re-fetch)' : ''}.`);
  if (args.limit !== Infinity) console.log(`Limiting to first ${targets.length}.`);
  if (args.dryRun) {
    for (const [key, t] of targets) console.log(`  would fetch  ${key}  (${t.url})`);
    return;
  }
  if (!targets.length) {
    console.log('Nothing to do.');
    return;
  }

  let ok = 0;
  let failed = 0;
  let processed = 0;
  await runWithConcurrency(targets, async ([key, t]) => {
    processed++;
    const r = await fetchPostText(t);
    if (r.ok) {
      cache[key] = { body: r.body, fetchedAt: new Date().toISOString(), source: 'bluesky-api' };
      ok++;
      // Persist every 10 successes so we don't lose progress on Ctrl-C.
      if (ok % 10 === 0) await saveCache(cache);
      const preview = r.body.replace(/\s+/g, ' ').slice(0, 60);
      console.log(`  [${processed}/${targets.length}] ok    ${t.url}  ${preview}`);
    } else {
      failed++;
      console.log(`  [${processed}/${targets.length}] FAIL  ${t.url}  (${r.error})`);
    }
  }, CONCURRENCY);

  await saveCache(cache);
  console.log(`\nDone: ${ok} fetched, ${failed} failed. Cache: ${CACHE_FILE}`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
