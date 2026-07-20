// competitors.mjs — shared parsing + matching for the `## Competitors`
// section of a scout-config file. Pure and dependency-free so both the
// browser-scan conversations layer and the web UI can reuse it.
//
// Config format (one bullet per competitor, bold name + optional Aliases clause):
//
//   ## Competitors
//
//   - **Amazon DynamoDB** — AWS managed NoSQL. Aliases: DynamoDB, DDB, Dynamo.
//   - **MongoDB Atlas** — managed document DB. Aliases: MongoDB, Atlas, Mongo.
//
// A `_None tracked…_` placeholder (or a missing section) yields an empty list.

// Pull the raw text of the `## Competitors` section (up to the next `## `).
function extractCompetitorsSection(raw) {
  const text = String(raw || '');
  // NOTE: terminate with `(?![\s\S])` for end-of-string — JS has no `\Z`, and
  // under the /i flag a literal `\Z` degrades to a case-insensitive "z" match
  // (which would truncate the section at the "z" in "Azure").
  const m = text.match(/^##\s+Competitors\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/mi);
  return m ? m[1] : '';
}

// Strip a trailing "(parenthetical)" from a competitor name, e.g.
// "DataStax Astra DB (Apache Cassandra)" → "DataStax Astra DB".
function stripParenthetical(name) {
  return String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// Parse the `## Competitors` section into structured entries.
// Returns: [{ name, aliases: [...] }] where `aliases` always includes the
// canonical name (and the name without any trailing parenthetical). Names and
// aliases are de-duplicated case-insensitively while preserving first spelling.
export function parseCompetitors(raw) {
  const section = extractCompetitorsSection(raw);
  if (!section || /_?None tracked/i.test(section)) return [];
  const out = [];
  for (const line of section.split(/\r?\n/)) {
    const bullet = line.match(/^\s*[-*+]\s+(.+?)\s*$/);
    if (!bullet) continue; // skip intro prose + the italic "_Adjacent…_" line
    const body = bullet[1];
    // Name: prefer the **bold** span; else the text before an em/en dash,
    // colon, or "(".
    const boldMatch = body.match(/\*\*(.+?)\*\*/);
    let name = boldMatch ? boldMatch[1].trim() : body.split(/[—–:(]/)[0].trim();
    name = name.replace(/^["']|["']$/g, '').trim();
    if (!name) continue;
    // Aliases: everything after an "Aliases:" label, comma-separated, up to
    // the sentence's terminating period.
    const aliasMatch = body.match(/Aliases?\s*:\s*([^.]+?)\s*\.?\s*$/i)
      || body.match(/\(\s*aliases?\s*:\s*([^)]+)\)/i);
    const aliasList = aliasMatch
      ? aliasMatch[1].split(',').map((a) => a.trim()).filter(Boolean)
      : [];
    const aliasSet = [];
    const seen = new Set();
    for (const a of [name, stripParenthetical(name), ...aliasList]) {
      const key = a.toLowerCase();
      if (a && !seen.has(key)) { seen.add(key); aliasSet.push(a); }
    }
    out.push({ name, aliases: aliasSet });
  }
  return out;
}

export function competitorTrackingEnabled(raw) {
  const match = String(raw || '').match(/-\s*\*\*Competitor tracking:\*\*\s*(on|off)\b/i);
  return match ? match[1].toLowerCase() === 'on' : false;
}

// Build a flat, de-duplicated list of search-query terms for the conversations
// layer. Prefers the distinctive full names first (less noisy than short
// aliases like "Atlas" or "DDB"), then fills with aliases up to `max`.
export function competitorQueryTerms(competitors, { max = 12, includeAliases = true } = {}) {
  const terms = [];
  const seen = new Set();
  const push = (t) => {
    const v = String(t || '').trim();
    const key = v.toLowerCase();
    if (v && !seen.has(key)) { seen.add(key); terms.push(v); }
  };
  // Pass 1: canonical names (most distinctive).
  for (const c of competitors || []) push(stripParenthetical(c.name));
  // Pass 2: remaining aliases, if requested and budget remains.
  if (includeAliases) {
    for (const c of competitors || []) {
      for (const a of c.aliases || []) push(a);
    }
  }
  return terms.slice(0, Math.max(0, max));
}

// Escape a string for use inside a RegExp.
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Return the names of every competitor whose name or any alias appears in
// `text` (case-insensitive, word-boundary matched so "Atlas" doesn't match
// inside "Atlassian").
export function matchCompetitors(text, competitors) {
  const hay = String(text || '');
  if (!hay.trim()) return [];
  const hits = [];
  for (const c of competitors || []) {
    const matched = (c.aliases || []).some((alias) => {
      const a = String(alias || '').trim();
      if (!a) return false;
      // \b around the escaped alias; the alias may contain spaces (phrase).
      const re = new RegExp(`(^|[^\\w])${escapeRe(a)}(?=$|[^\\w])`, 'i');
      return re.test(hay);
    });
    if (matched) hits.push(c.name);
  }
  return hits;
}

// Collect the text fields a browser-scan item might carry, for matching.
function itemHaystack(item) {
  if (!item || typeof item !== 'object') return '';
  const fields = ['title', 'text', 'selftext', 'body', 'snippet', 'excerpt', 'description'];
  return fields.map((f) => item[f]).filter((v) => typeof v === 'string').join(' \u2014 ');
}

// Tag each item with the competitor(s) it mentions and drop items that mention
// none. Returns a new array; original items are shallow-cloned with two added
// fields: `competitor` (first match) and `competitorMatches` (all matches).
export function tagCompetitorItems(items, competitors) {
  const out = [];
  for (const item of items || []) {
    const matches = matchCompetitors(itemHaystack(item), competitors);
    if (!matches.length) continue;
    out.push({ ...item, competitor: matches[0], competitorMatches: matches });
  }
  return out;
}

function itemUrl(item) {
  return String(item?.url || item?.permalink || item?.link || '').trim();
}

export function canonicalCompetitorUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase()
      .replace(/^www\./, '')
      .replace(/^old\.reddit\.com$/, 'reddit.com')
      .replace(/^twitter\.com$/, 'x.com');
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_.+|ref|source|fbclid|gclid)$/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString();
  } catch {
    return String(url || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}

export function dedupeCompetitorItems(items) {
  const output = [];
  const byUrl = new Map();
  for (const item of items || []) {
    const key = canonicalCompetitorUrl(itemUrl(item));
    if (!key) {
      output.push({ ...item });
      continue;
    }
    const existing = byUrl.get(key);
    if (!existing) {
      const copy = { ...item, canonicalUrl: key };
      byUrl.set(key, copy);
      output.push(copy);
      continue;
    }
    existing.competitorMatches = [...new Set([
      ...(existing.competitorMatches || []),
      ...(item.competitorMatches || []),
    ])];
  }
  return output;
}

function aliasesFor(name, competitors) {
  const competitor = (competitors || []).find((entry) => entry.name === name);
  return competitor?.aliases?.length ? competitor.aliases : [name];
}

function mentionsAny(text, terms) {
  return (terms || []).some((term) => {
    const value = String(term || '').trim();
    return value && new RegExp(`(^|[^\\w])${escapeRe(value)}(?=$|[^\\w])`, 'i').test(text);
  });
}

export function detectSwitchingDirection(text, primaryProduct, competitors) {
  const hay = String(text || '');
  const migration = hay.match(/\b(?:migrat(?:e|ed|ing)|mov(?:e|ed|ing)|switch(?:ed|ing)?|transition(?:ed|ing)?)\s+from\s+(.{1,100}?)\s+to\s+(.{1,100}?)(?:[.!?]|$)/i);
  if (!migration) return 'none';
  const [, from, to] = migration;
  const primaryTerms = Array.isArray(primaryProduct) ? primaryProduct : [primaryProduct];
  const fromPrimary = mentionsAny(from, primaryTerms);
  const toPrimary = mentionsAny(to, primaryTerms);
  const fromCompetitor = matchCompetitors(from, competitors).length > 0;
  const toCompetitor = matchCompetitors(to, competitors).length > 0;
  if (fromCompetitor && toPrimary) return 'competitor_to_primary';
  if (fromPrimary && toCompetitor) return 'primary_to_competitor';
  if (fromCompetitor && toCompetitor) return 'competitor_to_competitor';
  return 'none';
}

function scopedSentences(text, aliases) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => mentionsAny(sentence, aliases))
    .join(' ');
}

export function classifyCompetitorSentiment(text, competitorName, competitors, switchingDirection = 'none') {
  const scoped = scopedSentences(text, aliasesFor(competitorName, competitors));
  const positive = /\b(?:love|loved|great|excellent|reliable|recommend(?:ed)?|fast|better|best|impressed|happy|satisfied)\b/i.test(scoped);
  const negative = /\b(?:hate|hated|bad|awful|unreliable|slow|worse|worst|expensive|frustrat(?:ed|ing)|outage|buggy|abandon(?:ed|ing)|left)\b/i.test(scoped);
  if (positive && negative) return { sentiment: 'mixed', confidence: 'high' };
  if (positive) return { sentiment: 'positive', confidence: 'high' };
  if (negative) return { sentiment: 'negative', confidence: 'high' };
  if (switchingDirection === 'competitor_to_competitor') {
    return { sentiment: 'neutral', confidence: 'low' };
  }
  return { sentiment: 'neutral', confidence: scoped ? 'medium' : 'low' };
}

function emptySentiments() {
  return { positive: 0, neutral: 0, negative: 0, mixed: 0, unknown: 0 };
}

export function analyzeCompetitorSources(sourceResults, competitors, {
  primaryProduct = '',
  classify = classifyCompetitorSentiment,
} = {}) {
  const sourceFailures = [];
  const collected = [];
  for (const result of sourceResults || []) {
    const source = String(result?.source || result?.platform || 'unknown');
    if (result?.error) {
      sourceFailures.push({ source, error: String(result.error.message || result.error) });
      continue;
    }
    for (const item of result?.items || []) collected.push({ ...item, platform: item.platform || source });
  }

  const tagged = tagCompetitorItems(collected, competitors);
  const deduped = dedupeCompetitorItems(tagged);
  const items = deduped.map((item) => {
    const text = itemHaystack(item);
    const switchingDirection = detectSwitchingDirection(text, primaryProduct, competitors);
    const competitorSentiments = (item.competitorMatches || []).map((name) => {
      try {
        const verdict = classify(text, name, competitors, switchingDirection) || {};
        return {
          competitor: name,
          sentiment: ['positive', 'neutral', 'negative', 'mixed', 'unknown'].includes(verdict.sentiment)
            ? verdict.sentiment
            : 'unknown',
          confidence: ['high', 'medium', 'low'].includes(verdict.confidence)
            ? verdict.confidence
            : 'low',
        };
      } catch {
        return { competitor: name, sentiment: 'unknown', confidence: 'low' };
      }
    });
    const first = competitorSentiments[0] || {
      competitor: item.competitor,
      sentiment: 'unknown',
      confidence: 'low',
    };
    return {
      ...item,
      url: itemUrl(item),
      timestamp: item.timestamp || item.post_date || item.date || item.published_at || '',
      competitorSentiments,
      competitorSentiment: first.sentiment,
      competitorSentimentConfidence: first.confidence,
      switchingDirection,
    };
  });

  const byCompetitor = {};
  const bySource = {};
  for (const item of items) {
    const source = item.platform || 'unknown';
    bySource[source] ||= { mentions: 0, sentiments: emptySentiments() };
    bySource[source].mentions += 1;
    for (const verdict of item.competitorSentiments) {
      byCompetitor[verdict.competitor] ||= {
        mentions: 0,
        sentiments: emptySentiments(),
        bySource: {},
      };
      const aggregate = byCompetitor[verdict.competitor];
      aggregate.mentions += 1;
      aggregate.sentiments[verdict.sentiment] += 1;
      aggregate.bySource[source] = (aggregate.bySource[source] || 0) + 1;
      bySource[source].sentiments[verdict.sentiment] += 1;
    }
  }

  return {
    items,
    aggregates: { mentions: items.length, byCompetitor, bySource },
    sourceFailures,
  };
}
