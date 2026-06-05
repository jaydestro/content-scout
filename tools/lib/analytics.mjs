// Pure-Node analytics that produce the same artifacts the scout-* agent
// commands would write — used by the web UI so the toolbar buttons can act
// in-browser without going through the chat agent or a runner subprocess.
//
// Functions here return both:
//   - `markdown` — the saved report body (matches the agent's template
//      well enough to round-trip into the Reports list)
//   - `data`     — structured payload the UI panel can render directly
//
// Pure helpers. No HTTP, no fs. The web-ui server is responsible for
// supplying inputs (parsed reports / config text / fetched HTML) and
// writing the markdown to disk.

const ISO_DATE = (d = new Date()) => d.toISOString().slice(0, 10);
const STAMP = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
};

// --- config parsing -----------------------------------------------------

// Reads the comma-separated tag list under "## Topic Tags (Canonical)".
export function parseTopicTagsFromConfig(raw) {
  if (!raw) return [];
  const m = raw.match(/##+\s*Topic Tags[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!m) return [];
  const body = m[1].replace(/<!--[\s\S]*?-->/g, '').trim();
  return body
    .split(/[,\n]/)
    .map((t) => t.trim().replace(/^[-*\s]+/, ''))
    .filter((t) => t && !/^#/.test(t));
}

// --- date helpers -------------------------------------------------------

// Extract YYYY-MM from a report filename like "2026-05-08-1525-slug-content.md".
function reportMonth(name) {
  const m = String(name || '').match(/^(\d{4})-(\d{2})-\d{2}-\d{4}-/);
  return m ? `${m[1]}-${m[2]}` : '';
}
function reportDate(name) {
  const m = String(name || '').match(/^(\d{4}-\d{2}-\d{2})-/);
  return m ? m[1] : '';
}

// --- 1. Gap analysis ----------------------------------------------------

// inputs:
//   items:      flat array of items from getIndex (have `tags`, `report`)
//   configRaw:  raw scout-config-{slug}.prompt.md text
//   windowDays: only count items whose report is within N days (default 30)
//   slug:       product slug (for filename + filtering items by report slug)
export function runGaps({ items = [], configRaw = '', windowDays = 30, slug = '' }) {
  const allTags = parseTopicTagsFromConfig(configRaw);
  const cutoff = new Date(Date.now() - windowDays * 86400 * 1000)
    .toISOString()
    .slice(0, 10);
  const scoped = items.filter((it) => {
    if (slug && !(it.report || '').includes(`-${slug}-`)) return false;
    const d = reportDate(it.report);
    return d && d >= cutoff;
  });

  const counts = new Map();
  for (const tag of allTags) counts.set(tag.toLowerCase(), 0);
  for (const it of scoped) {
    for (const t of it.tags || []) {
      const key = String(t).toLowerCase().trim();
      if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    }
  }

  const rows = allTags.map((tag) => ({
    tag,
    count: counts.get(tag.toLowerCase()) || 0,
  }));
  rows.sort((a, b) => a.count - b.count || a.tag.localeCompare(b.tag));
  const gaps = rows.filter((r) => r.count === 0);
  const thin = rows.filter((r) => r.count > 0 && r.count <= 2);

  const stamp = STAMP();
  const fileName = slug
    ? `${stamp}-${slug}-gaps.md`
    : `${stamp}-gaps.md`;

  const md = [
    `# Content Gap Analysis${slug ? ` — ${slug}` : ''}`,
    '',
    `**Generated:** ${new Date().toISOString()}`,
    `**Window:** last ${windowDays} days (since ${cutoff})`,
    `**Items considered:** ${scoped.length}`,
    `**Canonical tags:** ${allTags.length}`,
    `**Zero-coverage tags:** ${gaps.length}`,
    `**Thinly-covered tags (1–2 items):** ${thin.length}`,
    '',
    '## Summary',
    '',
    gaps.length
      ? `${gaps.length} canonical topic${gaps.length === 1 ? '' : 's'} had **no coverage** in the window. ${thin.length} more had only 1–2 items. Prioritise the zero-coverage list for the next content cycle.`
      : `Every canonical topic had at least one item in the window. ${thin.length} were thinly covered (1–2 items).`,
    '',
    '## Zero coverage',
    '',
    gaps.length
      ? ['| Tag | Items |', '|---|---|', ...gaps.map((r) => `| ${r.tag} | 0 |`)].join('\n')
      : '_None — every canonical tag has at least one item._',
    '',
    '## Thin coverage (1–2 items)',
    '',
    thin.length
      ? ['| Tag | Items |', '|---|---|', ...thin.map((r) => `| ${r.tag} | ${r.count} |`)].join('\n')
      : '_None._',
    '',
    '## Full distribution',
    '',
    '| Tag | Items |',
    '|---|---|',
    ...rows.map((r) => `| ${r.tag} | ${r.count} |`),
    '',
  ].join('\n');

  return {
    fileName,
    markdown: md,
    data: {
      windowDays,
      cutoff,
      itemsConsidered: scoped.length,
      gaps,
      thin,
      rows,
    },
  };
}

// --- 2. Trends ----------------------------------------------------------

// Aggregate items + conversations by month from the index, scoped to one
// product slug. Months parameter = how many months back to include (default 4).
export function runTrends({ items = [], conversations = [], months = 4, slug = '' }) {
  const today = new Date();
  const buckets = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    buckets.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const want = new Set(buckets);

  const matchSlug = (report) => !slug || (report || '').includes(`-${slug}-`);

  const perMonth = new Map();
  for (const m of buckets) {
    perMonth.set(m, {
      month: m,
      items: 0,
      conversations: 0,
      contributors: new Set(),
      tags: new Map(),
      sentiment: { positive: 0, neutral: 0, negative: 0, mixed: 0, unknown: 0 },
    });
  }

  for (const it of items) {
    if (!matchSlug(it.report)) continue;
    const mo = reportMonth(it.report);
    if (!want.has(mo)) continue;
    const b = perMonth.get(mo);
    b.items += 1;
    if (it.author) b.contributors.add(String(it.author).toLowerCase());
    for (const t of it.tags || []) {
      const k = String(t).toLowerCase();
      b.tags.set(k, (b.tags.get(k) || 0) + 1);
    }
  }
  for (const c of conversations) {
    if (!matchSlug(c.report)) continue;
    const mo = reportMonth(c.report);
    if (!want.has(mo)) continue;
    const b = perMonth.get(mo);
    b.conversations += 1;
    if (c.author) b.contributors.add(String(c.author).toLowerCase());
    if (c.sentiment && b.sentiment[c.sentiment] != null) b.sentiment[c.sentiment] += 1;
  }

  const monthRows = buckets.map((m) => {
    const b = perMonth.get(m);
    return {
      month: m,
      items: b.items,
      conversations: b.conversations,
      contributors: b.contributors.size,
      sentiment: b.sentiment,
    };
  });

  // Tag movement: compare most recent month to previous month.
  const latest = perMonth.get(buckets[buckets.length - 1]);
  const prev = buckets.length >= 2 ? perMonth.get(buckets[buckets.length - 2]) : null;
  const tagDeltas = [];
  const allTagKeys = new Set([...latest.tags.keys(), ...(prev ? prev.tags.keys() : [])]);
  for (const k of allTagKeys) {
    const cur = latest.tags.get(k) || 0;
    const prv = prev ? prev.tags.get(k) || 0 : 0;
    tagDeltas.push({ tag: k, current: cur, previous: prv, delta: cur - prv });
  }
  tagDeltas.sort((a, b) => b.delta - a.delta || b.current - a.current);
  const rising = tagDeltas.filter((t) => t.delta > 0).slice(0, 10);
  const declining = [...tagDeltas].sort((a, b) => a.delta - b.delta).filter((t) => t.delta < 0).slice(0, 10);
  const newTags = tagDeltas.filter((t) => t.previous === 0 && t.current > 0).slice(0, 10);

  const stamp = STAMP();
  const fileName = slug
    ? `${stamp}-${slug}-trends.md`
    : `${stamp}-trends.md`;

  const fmtTable = (rows, cols) =>
    [
      `| ${cols.map((c) => c.label).join(' | ')} |`,
      `|${cols.map(() => '---').join('|')}|`,
      ...rows.map((r) => `| ${cols.map((c) => c.get(r)).join(' | ')} |`),
    ].join('\n');

  const md = [
    `# Trends Analysis${slug ? ` — ${slug}` : ''}`,
    '',
    `**Generated:** ${new Date().toISOString()}`,
    `**Window:** ${months} months (${buckets[0]} → ${buckets[buckets.length - 1]})`,
    '',
    '## Summary',
    '',
    `Items and conversations across the last ${months} months. Tag deltas compare the most recent month (${buckets[buckets.length - 1]}) against the prior month${prev ? ` (${buckets[buckets.length - 2]})` : ''}.`,
    '',
    '## Month-over-month volume',
    '',
    fmtTable(monthRows, [
      { label: 'Month', get: (r) => r.month },
      { label: 'Items', get: (r) => r.items },
      { label: 'Conversations', get: (r) => r.conversations },
      { label: 'Contributors', get: (r) => r.contributors },
      { label: 'Pos / Neu / Neg', get: (r) => `${r.sentiment.positive} / ${r.sentiment.neutral} / ${r.sentiment.negative}` },
    ]),
    '',
    '## Rising tags',
    '',
    rising.length
      ? fmtTable(rising, [
          { label: 'Tag', get: (r) => r.tag },
          { label: 'Previous', get: (r) => r.previous },
          { label: 'Current', get: (r) => r.current },
          { label: 'Δ', get: (r) => `+${r.delta}` },
        ])
      : '_No rising tags._',
    '',
    '## Declining tags',
    '',
    declining.length
      ? fmtTable(declining, [
          { label: 'Tag', get: (r) => r.tag },
          { label: 'Previous', get: (r) => r.previous },
          { label: 'Current', get: (r) => r.current },
          { label: 'Δ', get: (r) => r.delta },
        ])
      : '_No declining tags._',
    '',
    '## New tags this month',
    '',
    newTags.length
      ? fmtTable(newTags, [
          { label: 'Tag', get: (r) => r.tag },
          { label: 'Items', get: (r) => r.current },
        ])
      : '_No new tags._',
    '',
  ].join('\n');

  return {
    fileName,
    markdown: md,
    data: { months: buckets, perMonth: monthRows, rising, declining, newTags },
  };
}

// --- 3. SEO (deterministic, snapshot-only) ------------------------------

// Strip script/style + collapse whitespace. Returns plain text content.
function htmlText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function pickAttr(tag, attr) {
  if (!tag) return '';
  const re = new RegExp(`${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  return m ? (m[2] || m[3] || m[4] || '').trim() : '';
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

// Extract snapshot fields from a raw HTML string. Pure regex — good enough
// for the deterministic part of an SEO audit.
export function extractSeoSnapshot(html, url) {
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? decodeEntities(htmlText(titleM[1])) : '';

  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const metaByName = (n) => {
    for (const m of metas) {
      const name = pickAttr(m, 'name') || pickAttr(m, 'property');
      if (name && name.toLowerCase() === n.toLowerCase()) return pickAttr(m, 'content');
    }
    return '';
  };
  const description = decodeEntities(metaByName('description'));
  const ogTitle = decodeEntities(metaByName('og:title'));
  const ogDesc = decodeEntities(metaByName('og:description'));
  const ogImage = decodeEntities(metaByName('og:image'));
  const twitterCard = decodeEntities(metaByName('twitter:card'));

  const canonicalM = html.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i);
  const canonical = canonicalM ? pickAttr(canonicalM[0], 'href') : '';

  const headings = { h1: [], h2: [], h3: [] };
  for (const level of [1, 2, 3]) {
    const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
    for (const m of html.matchAll(re)) {
      const text = decodeEntities(htmlText(m[1]));
      if (text) headings[`h${level}`].push(text);
    }
  }

  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const imgsWithAlt = imgs.filter((t) => pickAttr(t, 'alt').trim() !== '');
  const altCoverage = imgs.length ? imgsWithAlt.length / imgs.length : 1;

  const internalHost = (() => {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  })();
  const linkTags = [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
  let internalLinks = 0;
  let externalLinks = 0;
  for (const href of linkTags) {
    if (/^#|^mailto:|^javascript:/i.test(href)) continue;
    try {
      const u = new URL(href, url);
      const h = u.hostname.replace(/^www\./, '');
      if (!h || h === internalHost) internalLinks += 1;
      else externalLinks += 1;
    } catch { /* skip */ }
  }

  const jsonLdTypes = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const arr = Array.isArray(data) ? data : [data];
      for (const node of arr) {
        const t = node?.['@type'];
        if (Array.isArray(t)) jsonLdTypes.push(...t);
        else if (t) jsonLdTypes.push(t);
      }
    } catch { /* skip malformed */ }
  }

  const bodyText = htmlText(html.replace(/<head[\s\S]*?<\/head>/i, ''));
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;

  return {
    url,
    title,
    titleLength: title.length,
    description,
    descriptionLength: description.length,
    canonical,
    ogTitle,
    ogDesc,
    ogImage,
    twitterCard,
    h1: headings.h1,
    h2: headings.h2,
    h3: headings.h3,
    imgCount: imgs.length,
    imgsWithAlt: imgsWithAlt.length,
    altCoverage,
    internalLinks,
    externalLinks,
    jsonLdTypes,
    wordCount,
  };
}

// Score the snapshot on observable axes only (no LLM judgment).
export function scoreSeoSnapshot(s) {
  const out = {};
  // Title
  if (!s.title) out.title = { score: 0, note: 'missing title' };
  else if (s.titleLength < 20 || s.titleLength > 65) out.title = { score: 5, note: `length ${s.titleLength} (target 30–60)` };
  else out.title = { score: 9, note: `length ${s.titleLength}` };
  // Meta description
  if (!s.description) out.description = { score: 0, note: 'missing meta description' };
  else if (s.descriptionLength < 70 || s.descriptionLength > 170) out.description = { score: 5, note: `length ${s.descriptionLength} (target 120–160)` };
  else out.description = { score: 9, note: `length ${s.descriptionLength}` };
  // Heading structure
  if (s.h1.length === 0) out.headings = { score: 0, note: 'no H1' };
  else if (s.h1.length > 1) out.headings = { score: 4, note: `${s.h1.length} H1s (use exactly one)` };
  else if (s.h2.length === 0) out.headings = { score: 5, note: '1 H1, no H2s' };
  else out.headings = { score: 8, note: `H1=1, H2=${s.h2.length}, H3=${s.h3.length}` };
  // Content depth
  if (s.wordCount < 300) out.depth = { score: 3, note: `thin content (~${s.wordCount} words)` };
  else if (s.wordCount < 700) out.depth = { score: 6, note: `~${s.wordCount} words` };
  else out.depth = { score: 9, note: `~${s.wordCount} words` };
  // Internal linking
  if (s.internalLinks === 0) out.internalLinks = { score: 2, note: 'no internal links' };
  else if (s.internalLinks < 3) out.internalLinks = { score: 5, note: `${s.internalLinks} internal links` };
  else out.internalLinks = { score: 8, note: `${s.internalLinks} internal links` };
  // Structured data
  if (s.jsonLdTypes.length === 0) out.structuredData = { score: 2, note: 'no JSON-LD' };
  else out.structuredData = { score: 8, note: s.jsonLdTypes.join(', ') };
  // Media
  if (s.imgCount === 0) out.media = { score: 6, note: 'no images' };
  else out.media = {
    score: Math.round(2 + 7 * s.altCoverage),
    note: `${s.imgsWithAlt}/${s.imgCount} images with alt`,
  };
  // Technical
  let tech = 5;
  const techNotes = [];
  if (s.canonical) { tech += 2; techNotes.push('canonical ✓'); } else techNotes.push('canonical ✗');
  if (s.ogImage) { tech += 1; techNotes.push('og:image ✓'); } else techNotes.push('og:image ✗');
  if (s.twitterCard) { tech += 1; techNotes.push('twitter:card ✓'); } else techNotes.push('twitter:card ✗');
  out.technical = { score: Math.min(10, tech), note: techNotes.join(', ') };
  // LLM readiness — observable proxies only
  let llm = 3;
  const llmNotes = [];
  if (s.h2.length >= 3) { llm += 2; llmNotes.push('multiple H2s'); }
  if (s.jsonLdTypes.some((t) => /FAQ/i.test(t))) { llm += 3; llmNotes.push('FAQ schema'); }
  if (s.jsonLdTypes.some((t) => /HowTo/i.test(t))) { llm += 2; llmNotes.push('HowTo schema'); }
  if (s.wordCount > 500) { llm += 1; llmNotes.push('substantial content'); }
  out.llmReadiness = { score: Math.min(10, llm), note: llmNotes.join(', ') || 'minimal' };

  const avg =
    Object.values(out).reduce((s, x) => s + x.score, 0) / Object.keys(out).length;
  return { axes: out, overall: Math.round(avg * 10) / 10 };
}

// Build the full audit markdown for one or more URLs already fetched.
// `pages` is [{ url, html, error? }, ...]. The fetching is the caller's job.
export function runSeoAudit({ pages = [], slug = '' }) {
  const audits = pages.map((p) => {
    if (p.error || !p.html) {
      return {
        url: p.url,
        error: p.error || 'no html',
        snapshot: null,
        scoring: null,
      };
    }
    const snapshot = extractSeoSnapshot(p.html, p.url);
    const scoring = scoreSeoSnapshot(snapshot);
    return { url: p.url, error: null, snapshot, scoring };
  });

  const stamp = STAMP();
  const hostSlug = (() => {
    try { return new URL(pages[0]?.url || 'about:blank').hostname.replace(/[^a-z0-9]+/gi, '-').toLowerCase(); }
    catch { return 'audit'; }
  })();
  const fileName = slug
    ? `${stamp}-${slug}-seo-${hostSlug}.md`
    : `${stamp}-seo-${hostSlug}.md`;

  const sections = audits.map((a) => {
    if (a.error) {
      return `## SEO Audit — ${a.url}\n\n**Error:** ${a.error}\n`;
    }
    const s = a.snapshot;
    const sc = a.scoring;
    return [
      `## SEO Audit — ${s.url}`,
      '',
      `**Overall:** ${sc.overall} / 10`,
      '',
      '### Snapshot',
      `- Title (${s.titleLength} chars): "${s.title || '_missing_'}"`,
      `- Meta description (${s.descriptionLength} chars): "${s.description || '_missing_'}"`,
      `- H1: ${s.h1.join(' | ') || '_missing_'}`,
      `- Canonical: ${s.canonical || '_missing_'}`,
      `- OG image: ${s.ogImage ? '✓' : '✗'}`,
      `- Twitter card: ${s.twitterCard || '_missing_'}`,
      `- JSON-LD: ${s.jsonLdTypes.join(', ') || '_none_'}`,
      `- Word count: ${s.wordCount}`,
      `- Images: ${s.imgsWithAlt}/${s.imgCount} with alt text`,
      `- Links: ${s.internalLinks} internal · ${s.externalLinks} external`,
      '',
      '### Scores',
      '| Axis | Score | Note |',
      '|---|---|---|',
      ...Object.entries(sc.axes).map(([k, v]) => `| ${k} | ${v.score}/10 | ${v.note} |`),
      '',
      '### Auto-detected recommendations',
      '',
      ...autoRecs(s, sc).map((r, i) => `${i + 1}. **${r.area}** — ${r.issue} → ${r.fix}`),
      '',
      '> _Suggested rewrites (new title text, alternative H1s, JSON-LD blocks) require LLM judgment. Run `/scout-seo` in the agent chat for those — this in-browser audit covers everything deterministic._',
      '',
    ].join('\n');
  });

  const overallScores = audits.filter((a) => !a.error).map((a) => a.scoring.overall);
  const portfolioAvg = overallScores.length
    ? (overallScores.reduce((s, x) => s + x, 0) / overallScores.length).toFixed(1)
    : '—';

  const md = [
    `# SEO Audit${slug ? ` — ${slug}` : ''}`,
    '',
    `**Generated:** ${new Date().toISOString()}`,
    `**URLs audited:** ${pages.length}`,
    `**Portfolio average:** ${portfolioAvg} / 10`,
    '',
    pages.length > 1 ? '## Portfolio summary\n\n| URL | Overall |\n|---|---|\n' + audits.map((a) => `| ${a.url} | ${a.error ? `error: ${a.error}` : a.scoring.overall} |`).join('\n') + '\n' : '',
    ...sections,
  ].join('\n');

  return { fileName, markdown: md, data: { audits, portfolioAvg } };
}

function autoRecs(s, sc) {
  const recs = [];
  if (!s.title) recs.push({ area: 'Title', issue: 'Page has no <title>', fix: 'Add a 30–60 char title that includes the primary keyword.' });
  else if (s.titleLength > 65) recs.push({ area: 'Title', issue: `Title is ${s.titleLength} chars (truncates in SERPs)`, fix: 'Shorten to 30–60 chars.' });
  else if (s.titleLength < 30) recs.push({ area: 'Title', issue: `Title is only ${s.titleLength} chars`, fix: 'Expand to 30–60 chars with keyword + value prop.' });
  if (!s.description) recs.push({ area: 'Meta description', issue: 'Missing meta description', fix: 'Add a 120–160 char description.' });
  else if (s.descriptionLength > 170) recs.push({ area: 'Meta description', issue: `Description is ${s.descriptionLength} chars (truncates)`, fix: 'Shorten to 120–160 chars.' });
  if (s.h1.length === 0) recs.push({ area: 'Headings', issue: 'No H1 on page', fix: 'Add exactly one H1 with the primary keyword.' });
  else if (s.h1.length > 1) recs.push({ area: 'Headings', issue: `${s.h1.length} H1s on page`, fix: 'Reduce to exactly one H1.' });
  if (!s.canonical) recs.push({ area: 'Technical', issue: 'No canonical link', fix: 'Add <link rel="canonical" href="…"> in <head>.' });
  if (!s.ogImage) recs.push({ area: 'Social', issue: 'No og:image', fix: 'Add og:image meta tag for social previews.' });
  if (s.jsonLdTypes.length === 0) recs.push({ area: 'Structured data', issue: 'No JSON-LD on page', fix: 'Add Article (and FAQ if applicable) JSON-LD.' });
  if (s.imgCount > 0 && s.altCoverage < 0.8) recs.push({ area: 'Accessibility', issue: `Only ${Math.round(s.altCoverage * 100)}% of images have alt text`, fix: 'Add descriptive alt text to remaining images.' });
  if (s.wordCount < 300) recs.push({ area: 'Content depth', issue: `Thin content (~${s.wordCount} words)`, fix: 'Expand with examples, code snippets, FAQ.' });
  if (s.internalLinks < 3) recs.push({ area: 'Internal linking', issue: `Only ${s.internalLinks} internal links`, fix: 'Add 3–5 links to related content on the same domain.' });
  return recs;
}
