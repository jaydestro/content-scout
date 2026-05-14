#!/usr/bin/env node
// CLI: search reports/ and social-posts/ markdown for a query.
//
// Usage:
//   node tools/search.mjs "azure cosmos"
//   node tools/search.mjs --regex "vector\\s+search"
//   node tools/search.mjs --kind reports "managed identity"
//   node tools/search.mjs --json "rate limit"
//
// Mirrors the web UI's /api/search file-content layer so chat / terminal
// users get the same corpus.

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { searchCorpus } from './lib/corpus-search.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');

function parseArgs(argv) {
  const out = { regex: false, json: false, kinds: null, queryParts: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--regex') out.regex = true;
    else if (a === '--json') out.json = true;
    else if (a === '--kind' || a === '--kinds') {
      const v = argv[++i] || '';
      out.kinds = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '-h' || a === '--help') {
      out.help = true;
    } else {
      out.queryParts.push(a);
    }
  }
  out.query = out.queryParts.join(' ').trim();
  return out;
}

function printHelp() {
  console.log(`scout search — full-text grep over reports/*.md and social-posts/*.md

Usage:
  node tools/search.mjs [options] <query…>

Options:
  --regex           Treat <query> as a JS regex (case-insensitive)
  --kind <list>     Comma-separated subset of: reports, social-posts
  --json            Print machine-readable JSON instead of pretty text
  -h, --help        Show this help

Examples:
  node tools/search.mjs "vector search"
  node tools/search.mjs --kind reports "rate limit"
  node tools/search.mjs --regex "RU/?s\\s+spike"
`);
}

const ANSI = process.stdout.isTTY
  ? { dim: '\x1b[2m', reset: '\x1b[0m', bold: '\x1b[1m', cyan: '\x1b[36m', yellow: '\x1b[33m' }
  : { dim: '', reset: '', bold: '', cyan: '', yellow: '' };

function highlight(text, query, regex) {
  if (!query) return text;
  try {
    const re = regex ? new RegExp(query, 'gi') : new RegExp(escapeRegex(query), 'gi');
    return text.replace(re, (m) => `${ANSI.yellow}${m}${ANSI.reset}`);
  } catch {
    return text;
  }
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.query) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const result = await searchCorpus({
    repoRoot: REPO_ROOT,
    query: args.query,
    options: {
      regex: args.regex,
      kinds: args.kinds || undefined,
    },
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (!result.results.length) {
    console.log(`No matches for ${ANSI.bold}${args.query}${ANSI.reset} in reports/ or social-posts/.`);
    return;
  }

  console.log(
    `${ANSI.bold}${result.totals.files}${ANSI.reset} file(s), ` +
      `${ANSI.bold}${result.totals.hits}${ANSI.reset} match(es) for ${ANSI.cyan}${args.query}${ANSI.reset}\n`
  );
  for (const r of result.results) {
    console.log(`${ANSI.bold}${r.path}${ANSI.reset}  ${ANSI.dim}(${r.hits} hit${r.hits === 1 ? '' : 's'})${ANSI.reset}`);
    for (const s of r.snippets) {
      const text = highlight(s.text, args.query, args.regex);
      console.log(`  ${ANSI.dim}L${s.line}${ANSI.reset}  ${text}`);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(2);
});
