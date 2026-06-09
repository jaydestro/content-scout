// doc-meta.mjs — light-weight metadata extractor for the reports + social
// markdown files shown in the web UI's left-rail list. Pulled out so the
// server can render real titles, kinds, and summaries instead of raw
// filenames like "2026-05-21-1004-azure-cosmos-db-content.md".
//
// Cheap and pure: takes the raw markdown + the filename and returns a small
// metadata object. No I/O, no deps.

// Map filename suffix → human label + sort-friendly kind id. The list view
// uses this to badge each row so a user can tell at a glance which of the
// /scout-* commands produced it.
const KIND_TABLE = [
  // social/
  { match: /-posting-calendar\.md$/i,         id: 'calendar',     label: 'Calendar' },
  { match: /-alt-[^.]+\.md$/i,                id: 'alt-text',     label: 'Alt text' },
  { match: /-solo-[^.]*\.md$/i,               id: 'social-solo',  label: 'Solo post' },
  { match: /-social-posts\.md$/i,             id: 'social-bulk',  label: 'Social posts' },
  // reports/
  { match: /-content\.md$/i,                  id: 'content',      label: 'Full Report' },
  { match: /-mindshare\.md$/i,                id: 'mindshare',    label: 'Mindshare' },
  { match: /-supplemental\.md$/i,             id: 'supplemental', label: 'Supplemental' },
  { match: /-trends\.md$/i,                   id: 'trends',       label: 'Trends' },
  { match: /-gaps\.md$/i,                     id: 'gaps',         label: 'Gaps' },
  { match: /-seo[-.]/i,                       id: 'seo',          label: 'SEO' },
  { match: /-cfps?\.md$/i,                    id: 'cfp',          label: 'CFPs' },
  { match: /-conferences?\.md$/i,             id: 'conference',   label: 'Conference' },
];

export function detectKind(name) {
  for (const k of KIND_TABLE) if (k.match.test(name)) return { id: k.id, label: k.label };
  return { id: 'doc', label: 'Doc' };
}

// Filenames look like: 2026-05-21-1004-azure-cosmos-db-content.md
// Capture the stamp + slug so the UI can group runs and surface the
// subject independent of the wordy H1 title.
const FILENAME_RE = /^(\d{4}-\d{2}-\d{2})-(\d{4})-(.+?)-(content|mindshare|supplemental|trends|gaps|cfps?|conferences?|social-posts|posting-calendar|alt-.+|solo[-.].+|seo[-.].+)\.md$/i;

export function parseFilename(name) {
  const m = String(name || '').match(FILENAME_RE);
  if (!m) return { date: null, time: null, subject: null, suffix: null };
  return { date: m[1], time: m[2], subject: m[3], suffix: m[4] };
}

// Pull the first H1 (without the markdown #) from the document body, if any.
// Falls back to the filename's subject slug so the row is never blank.
function extractTitle(raw, subject) {
  const m = String(raw || '').match(/^\s*#\s+(.+?)\s*$/m);
  if (m) {
    // Strip noisy boilerplate prefixes ("Content Scout Report: ", etc.) so
    // the meaningful part of the title shows in the narrow rail.
    return m[1]
      .replace(/^content\s+scout\s+report\s*[:\-—]\s*/i, '')
      .replace(/^scout\s+report\s*[:\-—]\s*/i, '')
      .trim();
  }
  if (subject) return subject.replace(/-/g, ' ');
  return '';
}

// Find the first useful paragraph — the explicit "## Summary" block if it
// exists, otherwise the first non-front-matter paragraph after the H1.
function extractSummary(raw) {
  const text = String(raw || '');
  // Try a "## Summary" / "## Overview" / "## TL;DR" / "## Highlights" block.
  const blockRe = /^#{2,3}\s+(summary|overview|tl;?dr|highlights|executive summary)\s*$([\s\S]*?)(?=^#{1,3}\s|^---\s*$|\Z)/im;
  const block = text.match(blockRe);
  let body = block ? block[2] : '';
  if (!body) {
    // Fall back: first paragraph after the H1, skipping bold "metadata"
    // lines like "**Date range:** ..." that almost every report opens with.
    const afterH1 = text.replace(/^[\s\S]*?^\s*#\s+.+$/m, '');
    const paragraphs = afterH1
      .split(/\r?\n\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    body = paragraphs.find((p) =>
      !/^\*\*[^*]+:\*\*/.test(p) &&
      !p.startsWith('---') &&
      !p.startsWith('|') &&
      !p.startsWith('#')
    ) || '';
  }
  // Strip markdown noise → clean one-liner suitable for a list row.
  const clean = body
    .replace(/\r/g, '')
    .replace(/^\s*[-*]\s+/gm, '')          // bullet markers
    .replace(/^\s*\d+\.\s+/gm, '')         // numbered list markers
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')// links → text
    .replace(/`([^`]+)`/g, '$1')           // inline code
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1') // bold/italic
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  // Trim to first sentence-ish, capped at ~220 chars so it fits in the rail.
  const sentenceEnd = clean.search(/(?<=[.!?])\s/);
  let out = sentenceEnd > 60 && sentenceEnd < 260 ? clean.slice(0, sentenceEnd + 1) : clean;
  if (out.length > 220) out = out.slice(0, 219).trimEnd() + '…';
  return out;
}

// Pull the "**Date range:**" / "**Period:**" line so the list row can show
// what window the report covers (much more useful than just file mtime).
function extractDateRange(raw) {
  const text = String(raw || '');
  const m = text.match(/^\s*\*\*(?:Date\s*range|Period|Window|Coverage)\s*:\*\*\s*(.+?)\s*$/im);
  if (m) return m[1].trim();
  return '';
}

// Detect which special H2 sections a (scan) report contains so the web UI's
// Mindshare / CFPs & Events tabs can filter the list down to only reports
// that actually carry that section — instead of listing every content report
// and making the user click through to find one. Mirrors the client-side
// TAB_SECTION_MATCH regexes in app.js.
const SECTION_MATCHERS = {
  mindshare: /^#{2,3}\s+mindshare\b/im,
  cfp: /^#{2,3}\s+(open calls for papers|cfps?\b|calls? for papers\b|conferences?\b|conference content\b)/im,
};

function extractSectionFlags(raw) {
  const text = String(raw || '');
  return {
    mindshare: SECTION_MATCHERS.mindshare.test(text),
    cfp: SECTION_MATCHERS.cfp.test(text),
  };
}

// Combine everything into the shape the web UI / API rely on.
export function extractDocMeta(raw, name) {
  const kind = detectKind(name);
  const file = parseFilename(name);
  const title = extractTitle(raw, file.subject);
  const summary = extractSummary(raw);
  const dateRange = extractDateRange(raw);
  return {
    kind: kind.id,
    kindLabel: kind.label,
    title,
    subject: file.subject || '',
    subjectLabel: file.subject ? file.subject.replace(/-/g, ' ') : '',
    date: file.date || '',
    time: file.time || '',
    summary,
    dateRange,
    sections: extractSectionFlags(raw),
  };
}
