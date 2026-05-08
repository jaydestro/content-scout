// Minimal config loader for scout-config-{slug}.prompt.md files.
// Extracts: search terms (text and hashtag) and the topic slug.
// We only need the search terms for the browser scanner — date filtering
// happens against the --days flag in index.mjs.

import fs from 'node:fs';
import path from 'node:path';

export function loadConfig(root, slug) {
  const configPath = path.join(root, '.github', 'prompts', `scout-config-${slug}.prompt.md`);
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
  const searchTerms = extractSearchTerms(raw);
  return {
    slug,
    path: configPath,
    raw,
    searchTerms,
  };
}

function extractSearchTerms(md) {
  // Look for a "## Search Terms" section followed by bullet lines.
  // Falls back to "## Text Search Terms" / "## Hashtags" headers.
  const out = new Set();
  const sections = ['Search Terms', 'Text Search Terms', 'Hashtags', 'Search Phrases'];
  for (const header of sections) {
    const re = new RegExp(`##\\s+${header}[^\\n]*\\n([\\s\\S]*?)(?:\\n##\\s+|$)`, 'i');
    const m = md.match(re);
    if (!m) continue;
    const block = m[1];
    for (const line of block.split(/\r?\n/)) {
      const bullet = line.match(/^[\s]*[-*+]\s+(.+?)\s*$/);
      if (!bullet) continue;
      const term = bullet[1]
        .replace(/^["']/, '')
        .replace(/["']$/, '')
        .replace(/\s*\(.*?\)\s*$/, '') // strip trailing parenthetical notes
        .trim();
      if (term && term.length < 120) out.add(term);
    }
  }
  return [...out];
}
