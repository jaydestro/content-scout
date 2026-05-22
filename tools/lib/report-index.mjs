// Shared report-parsing library.
//
// Single source of truth for converting Content Scout reports (the markdown
// files the agent writes under reports/*-content.md and their structured JSON
// sidecars) into the in-memory shape consumed by the web UI's API routes and
// by local analytics helper scripts.
//
// Why this file exists: the web UI used to inline `parseReport()` /
// `normalizeSentiment()` / `classifyItem()` inside server.js. The agent
// already writes a structured JSON sidecar alongside every markdown report,
// so re-deriving the same data by parsing emoji-laden markdown cells caused
// drift between the two surfaces. This lib reads the JSON sidecar first and
// falls back to markdown parsing for legacy reports that pre-date sidecars.
//
// Pure Node, no deps. Exports:
//   - normalizeSentiment(cell)          accepts agent-enum or emoji-cell
//   - classifyItem(section, source, url) kind tag for items
//   - parseReport(rawMd, fileName)      legacy markdown parser
//   - parseReportFromJson(rawJson, fileName)  preferred JSON-sidecar parser
//   - loadReport(reportsDir, fileName)  picks JSON sidecar over markdown
//   - buildIndex(reportsDir)            aggregate across all *-content.md
//
// The return shape of parseReport / parseReportFromJson is identical so
// callers can treat them interchangeably:
//   { slug, generatedAt, items, conversations, sentimentTotals, skippedSources }

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CACHED_BODIES_FILE,
  SENTIMENT_OVERRIDES_FILE,
  browserScanReadDirs,
  resolveStateRead,
} from './paths.mjs';

const SENTIMENT_KEYS = ['positive', 'neutral', 'negative', 'mixed', 'unknown'];

function emptySentimentTotals() {
  return { positive: 0, neutral: 0, negative: 0, mixed: 0, unknown: 0 };
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTeamMemberSection(section) {
  return /team\s+member\s+mentions/i.test(String(section || ''));
}

function isProductAuthorName(name) {
  const text = String(name || '').trim();
  if (!text) return false;
  if (/\bmicrosoft\s+(mvp|most valuable professional|certified trainer)\b/i.test(text)) return false;
  if (/\bmct\b|\bregional director\b/i.test(text)) return false;
  return /^(microsoft|microsoft azure|azure cosmos db|cosmos db community|microsoft developer|microsoft reactor)(\b|\s|$)/i.test(text) || /@(msft|azure)(\b|[_-])/i.test(text);
}

function productTeamNameSet(names) {
  return new Set((Array.isArray(names) ? names : []).map(normalizeName).filter(Boolean));
}

function isProductAuthor(authorName, options = {}) {
  const normalized = normalizeName(authorName);
  return isProductAuthorName(authorName) || (!!normalized && productTeamNameSet(options.productTeamNames).has(normalized));
}

function extractNamesFromBlock(block) {
  const out = [];
  const seen = new Set();
  for (const rawLine of String(block || '').split(/\r?\n/)) {
    const line = rawLine.replace(/^[-*\s]+/, '').trim();
    if (!line || /^none$/i.test(line)) continue;
    const name = line.replace(/\([^)]*\)/g, '').replace(/[—-].*$/, '').trim();
    const key = normalizeName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function parseProductTeamNamesFromConfig(raw) {
  const text = String(raw || '').replace(/<!--[\s\S]*?-->/g, '');
  const teamMatch = text.match(/(?:^|\r?\n)\s*#{1,6}\s*Product Team Members[^\n]*\r?\n([\s\S]*?)(?=\r?\n\s*#{1,6}\s|\r?\n-{3,}\s*\r?\n|$)/i);
  const operatorMatch = text.match(/(?:^|\r?\n)\s*#{1,6}\s*Operator Identity[^\n]*\r?\n([\s\S]*?)(?=\r?\n\s*#{1,6}\s|\r?\n-{3,}\s*\r?\n|$)/i);
  const names = extractNamesFromBlock(teamMatch ? teamMatch[1] : '');
  const seen = new Set(names.map(normalizeName));
  for (const name of extractNamesFromBlock(operatorMatch ? operatorMatch[1] : '')) {
    const key = normalizeName(name);
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

function splitMarkdownTableRow(row) {
  const cells = [];
  let cell = '';
  let escaped = false;
  let started = false;
  const text = String(row || '').trim();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '|' && !escaped) {
      if (started) cells.push(cell.trim());
      started = true;
      cell = '';
      continue;
    }
    if (escaped) {
      cell += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    cell += ch;
  }
  if (started) cells.push(cell.trim());
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

export function canonicalUrlKey(url) {
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = parsed.pathname.split('/').filter(Boolean)[0] || '';
      return id ? `youtube::${id.toLowerCase()}` : '';
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      const videoId = parsed.searchParams.get('v');
      if (videoId) return `youtube::${videoId.toLowerCase()}`;
      const match = parsed.pathname.match(/\/(?:shorts|live|embed)\/([^/?#]+)/i);
      if (match) return `youtube::${match[1].toLowerCase()}`;
    }
    return `${host}${parsed.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch {
    return raw.toLowerCase().replace(/[#?].*$/, '').replace(/\/+$/, '');
  }
}

function sentimentTotalsFor(conversations) {
  const totals = emptySentimentTotals();
  for (const conversation of conversations) {
    const sentiment = SENTIMENT_KEYS.includes(conversation.sentiment)
      ? conversation.sentiment
      : 'unknown';
    totals[sentiment] = (totals[sentiment] || 0) + 1;
  }
  return totals;
}

function filterContentDuplicateConversations(conversations, items) {
  const itemUrlKeys = new Set(
    items
      .map((item) => canonicalUrlKey(item.url))
      .filter(Boolean)
  );
  if (!itemUrlKeys.size) return conversations;
  return conversations.filter((conversation) => {
    const key = canonicalUrlKey(conversation.url);
    return !key || !itemUrlKeys.has(key);
  });
}

// Accepts either the agent's enum value ("positive"|"neutral"|"negative"|
// "mixed") or a markdown cell that may contain emoji + freeform text.
// Always returns one of SENTIMENT_KEYS.
export function normalizeSentiment(cell) {
  if (cell == null) return 'unknown';
  if (typeof cell === 'string' && SENTIMENT_KEYS.includes(cell.toLowerCase())) {
    return cell.toLowerCase();
  }
  const text = String(cell);
  const lower = text.toLowerCase();
  if (text.includes('🟢') || /positive|advoc/i.test(lower)) return 'positive';
  if (text.includes('🔴') || /negative|critic|frustrat/i.test(lower)) return 'negative';
  // Per the agent spec (.github/agents/content-scout.agent.md, "Sentiment
  // Classification"), 🟡 = Neutral, NOT mixed. Only treat as 'mixed' when
  // the cell literally contains the word "mixed" (or a near-synonym), which
  // is what the agent writes when it actually means a real trade-off.
  if (text.includes('🟠') || /\bmixed\b|cautious|confus/i.test(lower)) return 'mixed';
  if (text.includes('🟡') || text.includes('⚪') || /neutral/i.test(lower)) return 'neutral';
  return 'unknown';
}

// Classify a non-conversation item to a coarse kind ('blog'|'video'|'repo'|
// 'reddit'|'hn'|'bluesky'|'x'|'stackoverflow'|'other'). Used by the web UI
// to render section badges. Matches on section name, source, and URL host.
export function classifyItem(section, source, url) {
  const s = (section + ' ' + source + ' ' + url).toLowerCase();
  if (/youtube\.com|youtu\.be|video/i.test(s)) return 'video';
  if (/dev\.to|medium\.com|hashnode|dzone|infoq|blog|article/i.test(s)) return 'blog';
  if (/github\.com|repo|project/i.test(s)) return 'repo';
  if (/reddit/i.test(s)) return 'reddit';
  if (/hacker news|news\.ycombinator/i.test(s)) return 'hn';
  if (/bluesky|bsky/i.test(s)) return 'bluesky';
  if (/twitter|^x$|\bx\/|x\.com/i.test(s)) return 'x';
  if (/stack overflow|stackoverflow/i.test(s)) return 'stackoverflow';
  if (/conf|talk|session|stream/i.test(s)) return 'video';
  return 'other';
}

// JSON-sidecar-first parser. Accepts the parsed JSON object (or raw string)
// and the matching .md filename. Produces the same shape as parseReport()
// so existing callers don't change.
//
// The agent's sidecar already classifies sentiment as an enum, so no emoji
// normalization is needed for conversations. Items are split into the two
// buckets by section name: 'mentions'/'conversations'/'social' -> conversations,
// everything else -> items.
export function parseReportFromJson(rawOrObj, fileName, options = {}) {
  const data = typeof rawOrObj === 'string' ? JSON.parse(rawOrObj) : rawOrObj;
  const slugMatch = fileName.match(/^\d{4}-\d{2}-\d{2}-\d{4}-(.+)-content\.md$/);
  const slug = slugMatch ? slugMatch[1] : data.slug || '';
  const generatedAt = data.generated_at || '';

  const items = [];
  const conversations = [];
  const sentimentTotals = emptySentimentTotals();

  for (const it of Array.isArray(data.items) ? data.items : []) {
    const section = (it.section || '').toLowerCase();
    const url = it.url || '';
    const title = (it.title || '').toString().trim();
    const date = it.date || '';
    const authorName =
      (it.author && (it.author.display_name || it.author.handle)) || '';
    const platform =
      (it.author && it.author.platform) || it.provenance?.source || '';
    const tags = Array.isArray(it.tags) ? it.tags.filter(Boolean) : [];
    const ep = Number.isFinite(it.engagement_potential)
      ? it.engagement_potential
      : null;

    const isConversation = /^(mentions|conversations|social)$/.test(section) && !isTeamMemberSection(it.section || '');

    if (isConversation) {
      const sentiment = normalizeSentiment(it.sentiment);
      const sentimentConfidence = typeof it.sentiment_confidence === 'string'
        ? it.sentiment_confidence.toLowerCase()
        : null;
      sentimentTotals[sentiment] = (sentimentTotals[sentiment] || 0) + 1;
      const community = (it.group || '').toLowerCase();
      const isProduct =
        /^(official|product|first[\s-]?party|microsoft|brand|company)$/.test(community) ||
        isProductAuthor(authorName, options);
      const engagement = it.engagement
        ? Object.entries(it.engagement)
            .filter(([, v]) => v != null && v !== '')
            .map(([k, v]) => `${k}:${v}`)
            .join(' ')
        : '';
      conversations.push({
        date,
        platform: platform || 'Unknown',
        author: authorName,
        summary: title,
        sentiment,
        sentimentConfidence,
        community: isProduct ? 'product' : 'community',
        communityRaw: community,
        engagement,
        url,
        section: it.section || '',
      });
    } else {
      if (!title) continue;
      items.push({
        title,
        url,
        date,
        ep,
        author: authorName,
        source: platform,
        tags,
        section: it.section || '',
        kind: classifyItem(it.section || '', platform, url),
      });
    }
  }

  const skippedSources = Array.isArray(data.skipped_sources)
    ? data.skipped_sources.map((s) =>
        typeof s === 'string'
          ? { name: s, reason: '' }
          : { name: s.name || '', reason: s.reason || '' }
      )
    : [];

  const filteredConversations = filterContentDuplicateConversations(conversations, items);
  return {
    slug,
    generatedAt,
    items,
    conversations: filteredConversations,
    sentimentTotals: sentimentTotalsFor(filteredConversations),
    skippedSources,
  };
}

// Legacy markdown parser. Retained for reports written before JSON sidecars
// existed and as a fallback when the sidecar is missing or malformed.
export function parseReport(raw, fileName, options = {}) {
  const lines = raw.split(/\r?\n/);
  const slugMatch = fileName.match(/^\d{4}-\d{2}-\d{2}-\d{4}-(.+)-content\.md$/);
  const slug = slugMatch ? slugMatch[1] : '';
  const genMatch = raw.match(/\*\*Generated:\*\*\s*([^\n]+)/);
  const generatedAt = genMatch ? genMatch[1].trim() : '';

  const items = [];
  const conversations = [];
  let currentSection = '';
  const seenItems = new Set();
  const sentimentTotals = emptySentimentTotals();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^##+\s+(.+)$/);
    if (headerMatch) {
      currentSection = headerMatch[1].trim();
      continue;
    }
    if (!/^\s*\|/.test(line)) continue;
    const next = lines[i + 1] || '';
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(next)) continue;
    const headers = splitMarkdownTableRow(line).map((s) => s.trim().toLowerCase());
    const idx = (names) => headers.findIndex((h) => names.includes(h));
    const titleIdx = idx(['title', 'topic', 'session', 'summary', 'post', 'thread', 'discussion', 'mention']);
    const linkIdx = idx(['link', 'url']);
    const dateIdx = idx(['date']);
    const epIdx = idx(['ep', 'score']);
    const authorIdx = idx(['speaker', 'author']);
    const sourceIdx = idx(['source', 'channel', 'platform']);
    const tagsIdx = idx(['tags']);
    const sentimentIdx = idx(['sentiment']);
    const summaryIdx = idx(['summary']);
    const communityIdx = idx(['community']);
    const engagementIdx = idx(['engagement']);
    const isTeamMember = isTeamMemberSection(currentSection);
    const isConversation = !isTeamMember && (sentimentIdx >= 0 || /conversations|community questions|mentions/i.test(currentSection));

    let j = i + 2;
    while (j < lines.length && /^\s*\|/.test(lines[j])) {
      const cells = splitMarkdownTableRow(lines[j]);
      const titleCell = titleIdx >= 0 ? cells[titleIdx] || '' : '';
      const linkCell = linkIdx >= 0 ? cells[linkIdx] || '' : '';
      const dateCell = dateIdx >= 0 ? cells[dateIdx] || '' : '';
      const epRaw = epIdx >= 0 ? cells[epIdx] || '' : '';
      const authorCell = authorIdx >= 0 ? cells[authorIdx] || '' : '';
      const sourceCell = sourceIdx >= 0 ? cells[sourceIdx] || '' : '';
      const tagsCell = tagsIdx >= 0 ? cells[tagsIdx] || '' : '';
      const sentimentCell = sentimentIdx >= 0 ? cells[sentimentIdx] || '' : '';
      const summaryCell = summaryIdx >= 0 ? cells[summaryIdx] || '' : '';
      const communityCell = communityIdx >= 0 ? cells[communityIdx] || '' : '';
      const engagementCell = engagementIdx >= 0 ? cells[engagementIdx] || '' : '';

      const linkMatch = linkCell.match(/\((https?:\/\/[^\s)]+)\)/);
      const url = linkMatch ? linkMatch[1] : '';
      const title = titleCell
        .replace(/\\\|/g, '|')
        .replace(/\s+/g, ' ')
        .trim();
      const ep = parseInt(epRaw, 10);

      if (!title || title.length < 3) {
        j++;
        continue;
      }
      const sentiment = normalizeSentiment(sentimentCell);
      const tags = tagsCell
        .split(/[,;]/)
        .map((t) => t.replace(/[`*_]/g, '').trim())
        .filter(Boolean);

      if (isConversation) {
        sentimentTotals[sentiment] = (sentimentTotals[sentiment] || 0) + 1;
        const community = (communityCell || '').replace(/[`*_]/g, '').trim().toLowerCase();
        const isProduct =
          /^(official|product|first[\s-]?party|microsoft|brand|company)$/.test(community) ||
          isProductAuthor(authorCell, options);
        conversations.push({
          date: dateCell,
          platform: sourceCell || 'Unknown',
          author: authorCell || '',
          summary: summaryCell || title,
          sentiment,
          community: isProduct ? 'product' : 'community',
          communityRaw: community || '',
          engagement: engagementCell.replace(/[`*_]/g, '').trim(),
          url,
          section: currentSection,
        });
      } else if (!isTeamMember) {
        const dedupKey = url || `${title}::${authorCell}`;
        if (!seenItems.has(dedupKey)) {
          seenItems.add(dedupKey);
          items.push({
            title,
            url,
            date: dateCell,
            ep: Number.isFinite(ep) ? ep : null,
            author: authorCell || '',
            source: sourceCell || '',
            tags,
            section: currentSection,
            kind: classifyItem(currentSection, sourceCell, url),
          });
        }
      }
      j++;
    }
    i = j - 1;
  }

  const skippedSources = [];
  const skipStart = lines.findIndex((l) =>
    /^##\s+(Sources That Could Not Be Reached|Skipped Sources|Sources Skipped)/i.test(l)
  );
  if (skipStart >= 0) {
    for (let k = skipStart + 1; k < lines.length; k++) {
      const l = lines[k];
      if (/^##\s+/.test(l)) break;
      const m = l.match(/^\s*[-*]\s+\*\*([^*]+)\*\*\s*[—:-]\s*(.+)$/);
      if (m) skippedSources.push({ name: m[1].trim(), reason: m[2].trim() });
    }
  }

  const filteredConversations = filterContentDuplicateConversations(conversations, items);
  return {
    slug,
    generatedAt,
    items,
    conversations: filteredConversations,
    sentimentTotals: sentimentTotalsFor(filteredConversations),
    skippedSources,
  };
}

// Load every browser-scan sidecar for `slug` and return a Map keyed by
// canonical URL so per-report items (which carry only the post URL) can be
// enriched with the full body text scraped from LinkedIn / X / Reddit. The
// per-report JSON sidecar leaves `title` empty for social posts because the
// platforms have no canonical title — the body text is the post.
async function loadBrowserScanBodies(reportsDir, slug) {
  const map = new Map();
  if (!slug) return map;
  // Consult both the canonical .local/state/browser-scan/{slug} and the
  // legacy reports/.browser-scan/{slug} dirs. The reportsDir argument is
  // honored for tests that pass a tmp dir.
  const dirs = [
    ...browserScanReadDirs(slug),
    path.join(reportsDir || '', '.browser-scan', slug),
  ];
  const seenDirs = new Set();
  for (const dir of dirs) {
    if (!dir || seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.json') || name.endsWith('-meta.json')) continue;
      let parsed;
      try {
        parsed = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      } catch {
        continue;
      }
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.posts) ? parsed.posts : [];
      for (const post of list) {
        const key = canonicalUrlKey(post?.url);
        if (!key) continue;
        const body = String(post?.body || '').trim();
        const title = String(post?.title || '').trim();
        if (!body && !title) continue;
        // Prefer the longer body if multiple sidecars carry the same post.
        const prev = map.get(key);
        if (!prev || (body && body.length > (prev.body || '').length)) {
          map.set(key, { body, title });
        }
      }
    }
  }
  return map;
}

// Load the side-cache of post bodies fetched from public APIs (currently
// only Bluesky — see tools/backfill-bluesky-bodies.mjs). The browser-scan
// pipeline covers LinkedIn / X / Reddit; this cache covers everything else
// whose body the agent dropped during ingestion. File is a flat object
// `{ <canonical-url-key>: { body, fetchedAt, source } }`.
async function loadCachedBodies(reportsDir) {
  const file = await resolveStateRead(CACHED_BODIES_FILE, reportsDir);
  const map = new Map();
  if (!file) return map;
  try {
    const raw = await fs.readFile(file, 'utf8');
    const obj = JSON.parse(raw);
    for (const [key, v] of Object.entries(obj || {})) {
      if (!key || !v || typeof v !== 'object') continue;
      const body = String(v.body || '').trim();
      if (!body) continue;
      map.set(key, { body, title: '' });
    }
  } catch {}
  return map;
}

// Load the sentiment overrides file written by the bulk-recheck endpoint.
// Keys are canonical URLs; values are { sentiment, confidence, rationale,
// model, provider, reviewedAt }. Returns an empty Map when missing.
async function loadSentimentOverrides(reportsDir) {
  const file = await resolveStateRead(SENTIMENT_OVERRIDES_FILE, reportsDir);
  if (!file) return new Map();
  try {
    const raw = await fs.readFile(file, 'utf8');
    const obj = JSON.parse(raw);
    const map = new Map();
    for (const [url, v] of Object.entries(obj || {})) {
      const key = canonicalUrlKey(url);
      if (key && v && typeof v === 'object') map.set(key, v);
    }
    return map;
  } catch {
    return new Map();
  }
}

// Apply LLM-derived sentiment overrides on top of whatever the agent stamped
// at scan time. Lets the user re-classify a batch of low-confidence neutrals
// from the UI without re-running the scan.
function applySentimentOverrides(parsed, overrides) {
  if (!parsed || !overrides || !overrides.size) return;
  const convs = Array.isArray(parsed.conversations) ? parsed.conversations : [];
  const totals = parsed.sentimentTotals || emptySentimentTotals();
  for (const c of convs) {
    const key = canonicalUrlKey(c.url);
    if (!key) continue;
    const hit = overrides.get(key);
    if (!hit || !hit.sentiment) continue;
    const next = normalizeSentiment(hit.sentiment);
    if (next === c.sentiment) continue;
    if (totals[c.sentiment] != null) totals[c.sentiment] = Math.max(0, totals[c.sentiment] - 1);
    totals[next] = (totals[next] || 0) + 1;
    c.sentiment = next;
    c.sentimentConfidence = (hit.confidence || 'medium').toLowerCase();
    c.sentimentOverridden = true;
  }
  parsed.sentimentTotals = totals;
}

// Mutates the parsed report in place to backfill conversation summaries from
// browser-scan sidecar bodies. The per-report JSON sidecar has no body field
// for social posts, so without this step LinkedIn / X / Reddit cards render
// with an empty summary line.
function enrichConversationsWithBodies(parsed, bodyMap) {
  if (!parsed || !bodyMap || !bodyMap.size) return;
  const convs = Array.isArray(parsed.conversations) ? parsed.conversations : [];
  for (const c of convs) {
    const key = canonicalUrlKey(c.url);
    if (!key) continue;
    const hit = bodyMap.get(key);
    if (!hit) continue;
    const current = String(c.summary || '').trim();
    const body = hit.body || hit.title || '';
    if (!body) continue;
    // Replace whenever the body is meaningfully longer than the existing
    // summary (handles empty cells and pre-truncated previews alike).
    if (body.length > current.length + 20) {
      c.summary = body;
    }
  }
}

// Load + parse a single report. Prefers the JSON sidecar (the agent's
// structured output) when present and parseable; falls back to the markdown
// parser otherwise. `fileName` is the *.md basename — the sidecar is the
// same basename with `.json`.
export async function loadReport(reportsDir, fileName) {
  const slugMatch = fileName.match(/^\d{4}-\d{2}-\d{2}-\d{4}-(.+)-content\.md$/);
  const slug = slugMatch ? slugMatch[1] : '';
  const configPath = slug ? path.join(path.dirname(reportsDir), '.github', 'prompts', `scout-config-${slug}.prompt.md`) : '';
  let parseOptions = {};
  if (configPath) {
    try {
      parseOptions = { productTeamNames: parseProductTeamNamesFromConfig(await fs.readFile(configPath, 'utf8')) };
    } catch {}
  }
  const [browserBodyMap, cachedBodyMap, overrides] = await Promise.all([
    loadBrowserScanBodies(reportsDir, slug),
    loadCachedBodies(reportsDir),
    loadSentimentOverrides(reportsDir),
  ]);
  // Browser-scan sidecars take priority over the API-fetched cache when
  // both have a body for the same URL — the scraped LinkedIn body is
  // typically richer (hashtags, formatting) than what the public API returns.
  const bodyMap = new Map(cachedBodyMap);
  for (const [k, v] of browserBodyMap) bodyMap.set(k, v);
  const jsonName = fileName.replace(/\.md$/, '.json');
  const jsonPath = path.join(reportsDir, jsonName);
  try {
    const rawJson = await fs.readFile(jsonPath, 'utf8');
    const parsed = { source: 'json', ...parseReportFromJson(rawJson, fileName, parseOptions) };
    enrichConversationsWithBodies(parsed, bodyMap);
    applySentimentOverrides(parsed, overrides);
    return parsed;
  } catch {
    // Sidecar missing or malformed — fall back to markdown.
  }
  try {
    const raw = await fs.readFile(path.join(reportsDir, fileName), 'utf8');
    const parsed = { source: 'md', ...parseReport(raw, fileName, parseOptions) };
    enrichConversationsWithBodies(parsed, bodyMap);
    applySentimentOverrides(parsed, overrides);
    return parsed;
  } catch {
    return null;
  }
}
