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
