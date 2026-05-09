// Build a search query from a config term.
// Multi-word terms get wrapped in double quotes for phrase matching;
// single tokens (incl. hashtags like "#AzureCosmosDB") pass through.
//
// Per-platform notes:
//   - X / Twitter: phrase quotes work natively; hashtags too.
//   - LinkedIn: phrase quotes work in /search/results/content/?keywords=...
//   - Reddit: phrase quotes work; reddit ignores `#` so a hashtag term
//     should drop the leading `#` to match the bare word as a substring.

export function buildSearchQuery(term, platform) {
  if (!term) return '';
  const t = String(term).trim();
  if (!t) return '';

  // Reddit-specific: drop the leading # since reddit doesn't index hashtags.
  // The remainder is then treated as a normal token and quoted if it
  // contains spaces.
  if (platform === 'reddit' && t.startsWith('#')) {
    const stripped = t.slice(1).trim();
    if (!stripped) return '';
    return /\s/.test(stripped) ? `"${stripped}"` : stripped;
  }

  // For multi-word terms, wrap in double quotes to force phrase matching.
  // Single tokens (one word or `#hashtag`) pass through as-is.
  if (/\s/.test(t)) {
    // Strip any pre-existing wrapping quotes the user may have typed in
    // the config (the loader already strips a single leading/trailing
    // pair, but be defensive in case a future config quotes in a
    // different way).
    const inner = t.replace(/^["']+/, '').replace(/["']+$/, '');
    return `"${inner}"`;
  }
  return t;
}
