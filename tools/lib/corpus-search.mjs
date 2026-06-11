// Lightweight full-text search over report and social-post markdown files.
// Shared by the web UI (`/api/search`) and the local helper command (`tools/search.mjs`)
// so the same corpus + ranking is available in both surfaces.
//
// Pure Node, no deps. Case-insensitive substring match (no regex by default
// — pass { regex: true } to opt in). Returns one entry per matching file
// with up to `maxSnippetsPerFile` snippets, each containing the matched
// line + a short window of surrounding context.

import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_SNIPPETS = 5;
const SNIPPET_RADIUS = 60; // chars before/after the hit on its line

async function listMarkdown(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
    .map((e) => e.name);
}

function buildMatcher(query, { regex }) {
  if (regex) {
    try {
      const re = new RegExp(query, 'i');
      return (s) => re.test(s);
    } catch {
      // Fall through to literal if the regex is malformed
    }
  }
  const needle = query.toLowerCase();
  return (s) => s.toLowerCase().includes(needle);
}

function buildHighlightIndex(line, query, regex) {
  if (regex) {
    try {
      const re = new RegExp(query, 'i');
      const m = re.exec(line);
      return m ? { start: m.index, end: m.index + m[0].length } : null;
    } catch {
      // fall through
    }
  }
  const idx = line.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return null;
  return { start: idx, end: idx + query.length };
}

function makeSnippet(line, hit) {
  const len = line.length;
  const start = Math.max(0, hit.start - SNIPPET_RADIUS);
  const end = Math.min(len, hit.end + SNIPPET_RADIUS);
  let out = line.slice(start, end);
  if (start > 0) out = '…' + out;
  if (end < len) out = out + '…';
  return out;
}

async function searchOneDir(absDir, relLabel, query, opts) {
  const matcher = buildMatcher(query, opts);
  const files = await listMarkdown(absDir);
  const results = [];
  // Read in parallel — the corpus is small.
  await Promise.all(
    files.map(async (name) => {
      const full = path.join(absDir, name);
      let raw;
      try {
        raw = await fs.readFile(full, 'utf8');
      } catch {
        return;
      }
      if (!matcher(raw)) return;
      const lines = raw.split(/\r?\n/);
      const snippets = [];
      for (let i = 0; i < lines.length && snippets.length < opts.maxSnippetsPerFile; i++) {
        const line = lines[i];
        const hit = buildHighlightIndex(line, query, opts.regex);
        if (!hit) continue;
        snippets.push({
          line: i + 1,
          text: makeSnippet(line, hit),
        });
      }
      if (!snippets.length) return;
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        stat = null;
      }
      results.push({
        kind: relLabel,
        name,
        path: path.posix.join(relLabel, name),
        mtime: stat ? stat.mtimeMs : 0,
        hits: snippets.length,
        snippets,
      });
    })
  );
  return results;
}

/**
 * Search reports/ and social-posts/ markdown for a query string.
 *
 * @param {object} args
 * @param {string} args.repoRoot   Absolute path to the workspace root.
 * @param {string} args.query      Search string (case-insensitive substring,
 *                                 or regex when `regex: true`).
 * @param {object} [args.options]
 * @param {boolean} [args.options.regex=false]
 * @param {number}  [args.options.maxFiles=40]            Hard cap on returned files (per kind).
 * @param {number}  [args.options.maxSnippetsPerFile=5]
 * @param {string[]} [args.options.kinds]                 Subset of ['reports','social-posts'].
 * @returns {Promise<{query:string, builtAt:number, totals:{files:number,hits:number}, results: Array}>}
 */
export async function searchCorpus({ repoRoot, query, options = {} }) {
  const q = String(query || '').trim();
  if (!q) {
    return { query: '', builtAt: Date.now(), totals: { files: 0, hits: 0 }, results: [] };
  }
  const opts = {
    regex: !!options.regex,
    maxFiles: Number.isFinite(options.maxFiles) ? options.maxFiles : DEFAULT_MAX_FILES,
    maxSnippetsPerFile: Number.isFinite(options.maxSnippetsPerFile)
      ? options.maxSnippetsPerFile
      : DEFAULT_MAX_SNIPPETS,
  };
  const kinds = Array.isArray(options.kinds) && options.kinds.length
    ? options.kinds
    : ['reports', 'social-posts'];

  const all = [];
  for (const kind of kinds) {
    const dir = path.join(repoRoot, kind);
    const matches = await searchOneDir(dir, kind, q, opts);
    matches.sort((a, b) => b.mtime - a.mtime);
    all.push(...matches.slice(0, opts.maxFiles));
  }
  // Newest first across both kinds.
  all.sort((a, b) => b.mtime - a.mtime);
  const totalHits = all.reduce((sum, r) => sum + r.hits, 0);
  return {
    query: q,
    builtAt: Date.now(),
    totals: { files: all.length, hits: totalHits },
    results: all,
  };
}
