// Shared report-parsing library.
//
// Single source of truth for converting Content Scout reports (the markdown
// files the agent writes under reports/*-content.md and their structured JSON
// sidecars) into the in-memory shape consumed by the web UI's API routes and
// by command-line analytics scripts.
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

const SENTIMENT_KEYS = ['positive', 'neutral', 'negative', 'mixed', 'unknown'];

function emptySentimentTotals() {
  return { positive: 0, neutral: 0, negative: 0, mixed: 0, unknown: 0 };
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
  if (text.includes('🟡') || /mixed|cautious|confus/i.test(lower)) return 'mixed';
  if (/neutral/i.test(lower)) return 'neutral';
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
export function parseReportFromJson(rawOrObj, fileName) {
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

    const isConversation = /^(mentions|conversations|social)$/.test(section);

    if (isConversation) {
      const sentiment = normalizeSentiment(it.sentiment);
      sentimentTotals[sentiment] = (sentimentTotals[sentiment] || 0) + 1;
      const community = (it.group || '').toLowerCase();
      const isProduct =
        /^(official|product|first[\s-]?party|microsoft|brand|company)$/.test(community) ||
        /microsoft|@msft|@azure/i.test(authorName);
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

  return { slug, generatedAt, items, conversations, sentimentTotals, skippedSources };
}

// Legacy markdown parser. Retained for reports written before JSON sidecars
// existed and as a fallback when the sidecar is missing or malformed.
export function parseReport(raw, fileName) {
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
    const headers = line
      .split('|')
      .slice(1, -1)
      .map((s) => s.trim().toLowerCase());
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
    const isConversation = sentimentIdx >= 0 || /conversations|mentions/i.test(currentSection);

    let j = i + 2;
    while (j < lines.length && /^\s*\|/.test(lines[j])) {
      const cells = lines[j]
        .split('|')
        .slice(1, -1)
        .map((s) => s.trim());
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
          /microsoft|@msft|@azure/i.test(authorCell);
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
      } else {
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

  return { slug, generatedAt, items, conversations, sentimentTotals, skippedSources };
}

// Load + parse a single report. Prefers the JSON sidecar (the agent's
// structured output) when present and parseable; falls back to the markdown
// parser otherwise. `fileName` is the *.md basename — the sidecar is the
// same basename with `.json`.
export async function loadReport(reportsDir, fileName) {
  const jsonName = fileName.replace(/\.md$/, '.json');
  const jsonPath = path.join(reportsDir, jsonName);
  try {
    const rawJson = await fs.readFile(jsonPath, 'utf8');
    return { source: 'json', ...parseReportFromJson(rawJson, fileName) };
  } catch {
    // Sidecar missing or malformed — fall back to markdown.
  }
  try {
    const raw = await fs.readFile(path.join(reportsDir, fileName), 'utf8');
    return { source: 'md', ...parseReport(raw, fileName) };
  } catch {
    return null;
  }
}
