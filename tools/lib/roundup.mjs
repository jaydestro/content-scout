// roundup.mjs — deterministic monthly community-content roundup generator.
//
// A roundup is ONE regenerable index per calendar month that aggregates every
// pointable content artifact (videos, blogs/articles, official evangelism
// posts, and code samples) discovered across that month's scan reports. Unlike
// dated scan reports, a roundup file uses a FIXED, monthly filename
// (`{YYYY-MM}-{slug}-roundup.md`) so re-generating overwrites it in place
// instead of creating a new dated file.
//
// Pure Node, no deps. Reuses the shared report parser (report-index.mjs) so the
// roundup sees exactly the same items the rest of the web UI does (JSON sidecar
// preferred, markdown fallback for legacy reports).
//
// Exports:
//   - currentMonthKey()                      -> 'YYYY-MM' for today (local)
//   - availableMonths(reportsDir, slug)      -> ['YYYY-MM', ...] desc, months with reports
//   - listRoundups(reportsDir, slug)         -> [{ name, month }] existing roundup files
//   - buildMonthlyRoundup({ ... })           -> { fileName, markdown, month, counts }
//   - generateMonthlyRoundup({ ... })        -> buildMonthlyRoundup + writes file

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadReport, canonicalUrlKey } from './report-index.mjs';

const CONTENT_RE_FOR = (slug) =>
  new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})-(\\d{4})-${escapeRe(slug)}-content\\.md$`);

function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function currentMonthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// Human-readable month label, e.g. "June 2026", from a 'YYYY-MM' key.
export function monthLabel(monthKey) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ''));
  if (!m) return String(monthKey || '');
  const date = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

// Resolve the 'YYYY-MM' a content item belongs to. Prefers an explicit date on
// the item; falls back to the source report file's month when the item date is
// missing or unparseable so the roundup stays bounded to plausible content.
function itemMonthKey(dateStr, fallbackMonthKey) {
  const s = String(dateStr || '').trim();
  if (s) {
    const iso = /^(\d{4})-(\d{2})/.exec(s);
    if (iso) return `${iso[1]}-${iso[2]}`;
    // "Jun 19" / "June 19, 2026" style — anchor a year if absent.
    const fallbackYear = (fallbackMonthKey || '').slice(0, 4) || String(new Date().getFullYear());
    const withYear = /\b\d{4}\b/.test(s) ? s : `${s} ${fallbackYear}`;
    const t = Date.parse(withYear);
    if (Number.isFinite(t)) return currentMonthKey(new Date(t));
  }
  return fallbackMonthKey || null;
}

const OFFICIAL_URL_RE = /devblogs\.microsoft\.com|learn\.microsoft\.com|techcommunity\.microsoft\.com|azure\.microsoft\.com\/(?:en-us\/)?(?:blog|updates)/i;
const SOCIAL_KINDS = new Set(['reddit', 'bluesky', 'linkedin', 'x', 'hn', 'stackoverflow']);

function isOfficialItem(item) {
  const section = String(item.section || '');
  const url = String(item.url || '');
  const source = String(item.source || '');
  if (/^\s*official\b/i.test(section)) return true;
  if (OFFICIAL_URL_RE.test(url)) return true;
  if (/microsoft\s+reactor/i.test(source) || /microsoft\s+reactor/i.test(section)) return true;
  return false;
}

// Map a parsed report item to a roundup bucket, or null to drop it.
//   video   -> talks, recordings, tutorials on YouTube
//   article -> blogs / articles / written tutorials / news
//   repo    -> code samples & projects
// Social conversation rows (reddit/x/linkedin/bluesky/hn/SO) are NOT content
// you point an audience to, so they are dropped.
function bucketFor(item) {
  const url = String(item.url || '');
  const hasUrl = /^https?:\/\//i.test(url);
  if (!hasUrl) return null;
  switch (item.kind) {
    case 'video':
      return 'video';
    case 'repo':
      return 'repo';
    case 'blog':
      return 'article';
    case 'other':
      return 'article';
    default:
      return SOCIAL_KINDS.has(item.kind) ? null : 'article';
  }
}

// Merge a duplicate into an existing aggregate, keeping the richest fields and
// the earliest publication date. Prefers a real personal author over a generic
// placeholder ("Team", "—", a blog name, etc.).
function mergeItem(into, dup) {
  if (dup.author && (!cleanAuthor(into.author) && cleanAuthor(dup.author))) into.author = dup.author;
  if (!into.source && dup.source) into.source = dup.source;
  if (!into.sourceUrl && dup.sourceUrl) into.sourceUrl = dup.sourceUrl;
  if ((dup.tags || []).length > (into.tags || []).length) into.tags = dup.tags;
  if (cleanTitle(dup.title).length > cleanTitle(into.title).length) into.title = dup.title;
  if (dup.official) into.official = true;
  // Keep the earliest parseable date.
  const a = Date.parse(into.date || '');
  const b = Date.parse(dup.date || '');
  if (Number.isFinite(b) && (!Number.isFinite(a) || b < a)) into.date = dup.date;
}

// ---- field cleaning -------------------------------------------------------

// Decode XML/HTML entities and unwrap CDATA (used for RSS feed text).
function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strip markdown link syntax to plain text and remove stray wrapping brackets.
// Fixes titles that arrive already linked (`[Title](url)`) so they don't get
// double-wrapped into `[[Title](url)](url)`.
function cleanTitle(s) {
  let t = String(s || '').trim();
  for (let i = 0; i < 3 && /\]\(/.test(t); i++) {
    t = t.replace(/\[([^\][]*?)\]\([^()]*?\)/g, '$1');
  }
  return t.replace(/^\[+/, '').replace(/\]+$/, '').replace(/\s+/g, ' ').trim();
}

// Generic / placeholder author labels that are not real bylines.
const PLACEHOLDER_AUTHOR =
  /^(—|-|n\/a|team|the team|community|youtube creator|azure cosmos db blog|azure cosmos db|azure blog|official blog|microsoft|docs|unknown)$/i;

// Clean an author cell: drop trailing "·"-delimited date/stat fragments, emoji
// badges, and placeholder values. Returns '' when nothing real remains.
function cleanAuthor(s) {
  let a = String(s || '').trim();
  if (!a) return '';
  a = a.split('·')[0].trim();
  a = a.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2728}\u{FE0F}]/gu, '').trim();
  a = a.replace(/[,;:]\s*$/, '').trim();
  return PLACEHOLDER_AUTHOR.test(a) ? '' : a;
}

const MONTHS_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?\b/i;

// Find a real ISO date (YYYY-MM-DD) inside any of the supplied strings.
// Report tables sometimes cram the date into the author cell or leave junk
// ("views: 32") in the date column, so we search several candidates.
function extractIsoDate(candidates, fallbackYear) {
  for (const raw of candidates) {
    const s = String(raw || '').trim();
    if (!s) continue;
    const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const m = s.match(MONTHS_RE);
    if (m) {
      const withYear = /\d{4}/.test(m[0]) ? m[0] : `${m[0]} ${fallbackYear}`;
      const t = Date.parse(withYear);
      if (Number.isFinite(t)) {
        const d = new Date(t);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
    }
  }
  return '';
}

// CFP / conference / "call for papers" rows that must never appear in a
// content roundup (they leak in from scan reports as sessionize.com links).
function isCfpOrConference(item) {
  const u = String(item.url || '').toLowerCase();
  const t = String(item.title || '').toLowerCase();
  const s = String(item.source || '').toLowerCase();
  if (/sessionize\.com|pretalx|papercall|\/cfp(\/|\b)/.test(u)) return true;
  if (/\bcfp\b|call for papers|deadline|register interest|closes? \w+ \d/.test(t)) return true;
  if (/sessionize|direct-fetch|brave-search/.test(s) && /\bcfp\b/.test(t)) return true;
  return false;
}

// Derive a clean Source label from the recorded source + URL.
function cleanSource(rawSource, url, kind) {
  if (kind === 'repo') return 'GitHub';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube';
  const v = String(rawSource || '').replace(/\s+/g, ' ').trim();
  if (v && !/^(—|-|n\/a|youtube|docs)$/i.test(v)) return v;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ---- network: official RSS feed + YouTube oEmbed --------------------------

async function fetchText(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'ContentScout/1.0 (+monthly-roundup)' },
    });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function pickTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

const FEED_TAG_DROP = /^(azure cosmos db|cosmosdb|azure|microsoft|uncategorized|nosql|azure cosmos db for nosql)$/i;
function feedCategoriesToTags(block) {
  const out = [];
  const seen = new Set();
  for (const m of block.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)) {
    const c = decodeEntities(m[1]);
    const tag = c.toLowerCase().replace(/\s+/g, '-');
    if (!tag || FEED_TAG_DROP.test(c) || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out.slice(0, 6);
}

// Fetch + parse the official blog RSS feed; return clean official rows for the
// target month (authoritative title / author / date / tags).
async function fetchOfficialFeedRows(feedUrl, targetMonth) {
  if (!feedUrl) return [];
  const xml = await fetchText(feedUrl, 12000);
  if (!xml) return [];
  const rows = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const block = m[0];
    const title = cleanTitle(pickTag(block, 'title'));
    const url = pickTag(block, 'link').trim();
    const creator = decodeEntities((block.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i) || [])[1] || '');
    const pub = pickTag(block, 'pubDate');
    const t = pub ? Date.parse(pub) : NaN;
    if (!Number.isFinite(t) || !title || !url) continue;
    const d = new Date(t);
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    if (iso.slice(0, 7) !== targetMonth) continue;
    rows.push({
      title,
      url,
      date: iso,
      author: creator,
      source: 'DevBlogs',
      sourceUrl: 'https://devblogs.microsoft.com/cosmosdb/',
      tags: feedCategoriesToTags(block),
      bucket: 'article',
      official: true,
    });
  }
  return rows;
}

// YouTube oEmbed gives the real creator name + channel URL with no API key.
async function fetchYouTubeMeta(videoUrl, timeoutMs = 8000) {
  const o = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;
  const txt = await fetchText(o, timeoutMs);
  if (!txt) return null;
  try {
    const j = JSON.parse(txt);
    return { author: String(j.author_name || '').trim(), channel: String(j.author_url || '').trim() };
  } catch {
    return null;
  }
}

// Enrich any YouTube rows in-place with the real creator + channel link, using
// a small on-disk cache so repeat generations don't re-fetch.
async function enrichYouTubeRows(rows, reportsDir) {
  const targets = rows.filter((r) => /youtube\.com|youtu\.be/i.test(r.url || ''));
  if (!targets.length) return;
  const cacheFile = path.join(reportsDir, '.roundup-yt-cache.json');
  let cache = {};
  try {
    cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  } catch {}
  let changed = false;
  const queue = [...targets];
  async function worker() {
    while (queue.length) {
      const r = queue.shift();
      const key = canonicalUrlKey(r.url) || r.url;
      let meta = cache[key];
      if (meta === undefined) {
        meta = await fetchYouTubeMeta(r.url);
        // Only cache successful lookups so a transient oEmbed failure retries
        // on the next generation instead of being remembered as "no author".
        if (meta && meta.author) {
          cache[key] = meta;
          changed = true;
        }
      }
      if (meta && meta.author) {
        r.author = meta.author;
        r.source = 'YouTube';
        if (meta.channel) r.sourceUrl = meta.channel;
      }
    }
  }
  await Promise.all(Array.from({ length: 5 }, () => worker()));
  if (changed) {
    try {
      await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2));
    } catch {}
  }
}

// Fetch the author byline from a DevBlogs (WordPress) post page. The feed only
// carries the ~15 most recent posts, so older in-month official posts fall back
// to scan-report data where the author was recorded as "Team"/blank — but the
// real author is right there on the page.
async function fetchDevblogsAuthor(url, timeoutMs = 15000) {
  const html = await fetchText(url, timeoutMs);
  if (!html) return '';
  let m =
    html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']author["']/i);
  if (m) return decodeEntities(m[1]);
  m = html.match(/"author"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]+)"/i);
  if (m) return decodeEntities(m[1]);
  m = html.match(/\/author\/[^"']+["'][^>]*>\s*([^<]+?)\s*</i);
  if (m) return decodeEntities(m[1]);
  return '';
}

// Enrich official DevBlogs rows that still lack a real author (not covered by
// the RSS feed) by fetching the byline from each post page. Cached on disk;
// only successful lookups are cached so misses retry.
async function enrichDevblogsAuthors(rows, reportsDir) {
  const targets = rows.filter(
    (r) => /devblogs\.microsoft\.com/i.test(r.url || '') && !cleanAuthor(r.author)
  );
  if (!targets.length) return;
  const cacheFile = path.join(reportsDir, '.roundup-author-cache.json');
  let cache = {};
  try {
    cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  } catch {}
  let changed = false;
  const queue = [...targets];
  async function worker() {
    while (queue.length) {
      const r = queue.shift();
      const key = canonicalUrlKey(r.url) || r.url;
      let name = cache[key];
      if (name === undefined) {
        name = await fetchDevblogsAuthor(r.url);
        if (name) {
          cache[key] = name;
          changed = true;
        }
      }
      if (name) {
        r.author = name;
        if (!r.sourceUrl) {
          r.source = 'DevBlogs';
          r.sourceUrl = 'https://devblogs.microsoft.com/cosmosdb/';
        }
      }
    }
  }
  // DevBlogs pages are large (~240KB) and rate-limit bursts, so keep
  // concurrency low to avoid throttled/timed-out fetches leaving authors blank.
  await Promise.all(Array.from({ length: 2 }, () => worker()));
  if (changed) {
    try {
      await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2));
    } catch {}
  }
}

async function listContentReports(reportsDir, slug) {
  let entries = [];
  try {
    entries = await fs.readdir(reportsDir);
  } catch {
    return [];
  }
  const re = CONTENT_RE_FOR(slug);
  return entries
    .filter((f) => re.test(f))
    .sort();
}

// All months (YYYY-MM, desc) that have at least one content report on disk.
export async function availableMonths(reportsDir, slug) {
  const files = await listContentReports(reportsDir, slug);
  const re = CONTENT_RE_FOR(slug);
  const months = new Set();
  for (const f of files) {
    const m = re.exec(f);
    if (m) months.add(`${m[1]}-${m[2]}`);
  }
  return [...months].sort().reverse();
}

// Existing roundup files for a slug, newest month first.
export async function listRoundups(reportsDir, slug) {
  let entries = [];
  try {
    entries = await fs.readdir(reportsDir);
  } catch {
    return [];
  }
  const re = new RegExp(`^(\\d{4}-\\d{2})-${escapeRe(slug)}-roundup\\.md$`);
  return entries
    .map((f) => {
      const m = re.exec(f);
      return m ? { name: f, month: m[1] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.month.localeCompare(a.month));
}

function escapeCell(s) {
  return String(s == null ? '' : s)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TAG_NOISE = new Set([
  'video', 'shorts', 'short', 'livestream', 'live', 'stream', 'known-author',
  'podcast', 'youtube',
]);
function formatTags(tags) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(tags) ? tags : []) {
    for (const piece of String(t).split(/[\s,;]+/)) {
      const tag = piece.replace(/^#/, '').trim().toLowerCase();
      if (!tag || TAG_NOISE.has(tag) || seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
    }
  }
  const list = out.slice(0, 6);
  return list.length ? list.map((t) => `#${t}`).join(' ') : '—';
}

function renderTable(rows) {
  if (!rows.length) return '_None this month._\n';
  const header =
    '| # | Date | Title | Author | Source | Tags |\n' +
    '|---|------|-------|--------|--------|------|\n';
  const body = rows
    .map((r, i) => {
      const titleText = escapeCell(cleanTitle(r.title)) || '(untitled)';
      const title = r.url ? `[${titleText}](${r.url})` : titleText;
      const author = escapeCell(cleanAuthor(r.author)) || '—';
      const srcLabel = escapeCell(r.source) || '—';
      const source = r.sourceUrl
        ? `[${srcLabel === '—' ? 'link' : srcLabel}](${r.sourceUrl})`
        : srcLabel;
      const tags = escapeCell(formatTags(r.tags));
      const date = escapeCell(r.date) || '—';
      return `| ${i + 1} | ${date} | ${title} | ${author} | ${source} | ${tags} |`;
    })
    .join('\n');
  return header + body + '\n';
}

function sortByDateDesc(a, b) {
  const ta = Date.parse(a.date || '');
  const tb = Date.parse(b.date || '');
  if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
  if (Number.isFinite(ta)) return -1;
  if (Number.isFinite(tb)) return 1;
  return 0;
}

// Build (but do not write) the monthly roundup for a slug + month.
//   reportsDir      : absolute path to the reports/ directory
//   slug            : product slug (e.g. 'azure-cosmos-db')
//   month           : 'YYYY-MM' (defaults to the current local month)
//   topicName       : display name for the heading (defaults to slug)
//   officialFeedUrl : RSS feed for the official blog (authoritative official rows)
//   enrich          : when true (default), fetch RSS + YouTube oEmbed for clean data
export async function buildMonthlyRoundup({
  reportsDir,
  slug,
  month,
  topicName,
  officialFeedUrl,
  enrich = true,
}) {
  if (!slug) throw new Error('buildMonthlyRoundup: slug is required');
  const targetMonth = /^\d{4}-\d{2}$/.test(month || '') ? month : currentMonthKey();
  const name = topicName || slug;
  const targetYear = targetMonth.slice(0, 4);

  const files = await listContentReports(reportsDir, slug);

  // Aggregate + dedup across every content report. Only keep items whose
  // resolved publication date lands in the target month (this stops, e.g., May
  // videos leaking into the June roundup when their date cell holds junk).
  const byKey = new Map();
  let sourceReports = 0;
  for (const file of files) {
    let parsed;
    try {
      parsed = await loadReport(reportsDir, file);
    } catch {
      continue;
    }
    sourceReports++;
    for (const item of parsed.items || []) {
      if (isCfpOrConference(item)) continue;
      const bucket = bucketFor(item);
      if (!bucket) continue;
      // Resolve a real date from the date cell, or recover one from the author/
      // title cells where report tables crammed it. No in-month date → skip.
      const date = extractIsoDate([item.date, item.author, item.source, item.title], targetYear);
      if (!date || date.slice(0, 7) !== targetMonth) continue;
      const key = item.url
        ? canonicalUrlKey(item.url)
        : `t:${cleanTitle(item.title).toLowerCase()}::${cleanAuthor(item.author).toLowerCase()}`;
      if (!key) continue;
      const official = isOfficialItem(item);
      const record = {
        title: cleanTitle(item.title),
        url: item.url || '',
        date,
        author: item.author || '',
        source: cleanSource(item.source, item.url, item.kind),
        sourceUrl: '',
        tags: Array.isArray(item.tags) ? item.tags : [],
        bucket,
        official,
      };
      if (byKey.has(key)) mergeItem(byKey.get(key), record);
      else byKey.set(key, record);
    }
  }

  // Official blog posts come authoritatively from the RSS feed (clean title /
  // author / date). They overwrite any matching report-derived rows.
  if (enrich && officialFeedUrl) {
    const feedRows = await fetchOfficialFeedRows(officialFeedUrl, targetMonth);
    for (const fr of feedRows) {
      const key = canonicalUrlKey(fr.url);
      if (!key) continue;
      const existing = byKey.get(key);
      if (existing) {
        existing.title = fr.title;
        existing.author = fr.author || existing.author;
        existing.date = fr.date;
        existing.source = 'DevBlogs';
        existing.sourceUrl = fr.sourceUrl;
        existing.official = true;
        if (fr.tags.length) existing.tags = fr.tags;
      } else {
        byKey.set(key, fr);
      }
    }
  }

  const all = [...byKey.values()];

  // Fill in real creator + channel link for every YouTube row via oEmbed, and
  // recover authors for older official DevBlogs posts the feed no longer carries.
  if (enrich) {
    await enrichYouTubeRows(all, reportsDir);
    await enrichDevblogsAuthors(all, reportsDir);
  }

  const official = all.filter((r) => r.official).sort(sortByDateDesc);
  const community = all.filter((r) => !r.official);
  const videos = community.filter((r) => r.bucket === 'video').sort(sortByDateDesc);
  const articles = community.filter((r) => r.bucket === 'article').sort(sortByDateDesc);
  const repos = community.filter((r) => r.bucket === 'repo').sort(sortByDateDesc);

  const counts = {
    total: all.length,
    official: official.length,
    videos: videos.length,
    articles: articles.length,
    repos: repos.length,
    sourceReports,
  };

  const generatedAt = new Date().toISOString();
  const label = monthLabel(targetMonth);

  const md = [];
  md.push(`# ${name} — Monthly Community Roundup: ${label}`);
  md.push('');
  md.push(`**Generated:** ${generatedAt}`);
  md.push(`**Month:** ${targetMonth}`);
  md.push(`**Source reports aggregated:** ${counts.sourceReports}`);
  md.push(
    `**Total items indexed:** ${counts.total} — ` +
      `${counts.official} official · ${counts.videos} videos · ` +
      `${counts.articles} blogs/articles · ${counts.repos} code samples`
  );
  md.push('');
  md.push(
    `> A single, regenerable index of every community and evangelism artifact ` +
      `published about ${name} in ${label}. Official posts come straight from the ` +
      `blog's RSS feed; video creators and channel links come from YouTube. ` +
      `Re-running "Generate monthly roundup" rewrites this file in place — it is ` +
      `keyed to the month, not the run.`
  );
  md.push('');
  md.push('## Official & Evangelism (Microsoft)');
  md.push('Developer-education and outreach content from official channels — DevBlogs, Microsoft Reactor, and Learn.');
  md.push('');
  md.push(renderTable(official));
  md.push('## Community Videos & Talks');
  md.push('Independent videos, recorded talks, and screencasts.');
  md.push('');
  md.push(renderTable(videos));
  md.push('## Community Blogs & Articles');
  md.push('Written tutorials, deep-dives, opinion pieces, and news from the community.');
  md.push('');
  md.push(renderTable(articles));
  md.push('## Code Samples & Projects');
  md.push('Sample apps, repos, and reference implementations worth pointing developers to.');
  md.push('');
  md.push(renderTable(repos));

  const markdown = md.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  const fileName = `${targetMonth}-${slug}-roundup.md`;
  return { fileName, markdown, month: targetMonth, counts };
}

// Build + write the roundup to reportsDir. Overwrites any existing file for the
// same month (the whole point: one durable index per month).
export async function generateMonthlyRoundup({ reportsDir, slug, month, topicName, officialFeedUrl, enrich }) {
  const result = await buildMonthlyRoundup({ reportsDir, slug, month, topicName, officialFeedUrl, enrich });
  await fs.writeFile(path.join(reportsDir, result.fileName), result.markdown, 'utf8');
  return result;
}
