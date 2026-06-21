#!/usr/bin/env node
// validate-urls.mjs — verify that every URL is real, reachable content
// before Content Scout presents it (in a report, social post, or chat reply).
//
// This is the scout-wide enforcement of the rule "never show a link you
// haven't validated." Run it on a finished report, on a list of URLs, or on
// piped stdin. Exits non-zero when any URL is dead so it can gate a commit /
// publish step.
//
// Usage:
//   node tools/validate-urls.mjs reports/2026-05-21-1004-azure-cosmos-db-content.md
//   node tools/validate-urls.mjs https://example.com https://dead.example/x
//   echo "https://example.com" | node tools/validate-urls.mjs -
//   node tools/validate-urls.mjs --json reports/latest-content.md
//   node tools/validate-urls.mjs --dead-only reports/latest-content.md
//
// Flags:
//   --json        machine-readable output ({ checked, dead, results })
//   --dead-only   only print URLs judged dead (quiet success)
//   --timeout N   per-URL probe timeout in ms (default 6000)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { validateUrls } from './lib/url-validate.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');

// Pull every http(s) URL out of a blob of text (markdown, JSON, plain).
// Trailing markdown/punctuation noise is trimmed so probes hit clean URLs.
const URL_RE = /https?:\/\/[^\s)<>"'\]}`]+/gi;
function extractUrls(text) {
  const out = [];
  for (const m of String(text || '').matchAll(URL_RE)) {
    let u = m[0].replace(/[.,;:!?]+$/, ''); // strip trailing sentence punctuation
    out.push(u);
  }
  return out;
}

function parseArgs(argv) {
  const out = { json: false, deadOnly: false, timeoutMs: 6000, inputs: [], stdin: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--dead-only') out.deadOnly = true;
    else if (a === '--timeout') out.timeoutMs = parseInt(argv[++i], 10) || 6000;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-') out.stdin = true;
    else out.inputs.push(a);
  }
  return out;
}

function printHelp() {
  console.log(`validate-urls — check that URLs are reachable before presenting them

Usage:
  node tools/validate-urls.mjs <file.md|file.json|URL ...>
  node tools/validate-urls.mjs --json reports/latest-content.md
  node tools/validate-urls.mjs --dead-only reports/latest-content.md
  echo "https://example.com" | node tools/validate-urls.mjs -

Exit code is non-zero when any URL is judged dead.`);
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function collectUrls(opts) {
  const urls = [];
  for (const input of opts.inputs) {
    if (/^https?:\/\//i.test(input)) {
      urls.push(input);
      continue;
    }
    // Treat as a file path (relative to repo root or CWD).
    const candidates = [input, path.resolve(REPO_ROOT, input), path.resolve(process.cwd(), input)];
    let text = null;
    for (const c of candidates) {
      try { text = await fs.readFile(c, 'utf8'); break; } catch { /* try next */ }
    }
    if (text == null) {
      console.error(`! could not read: ${input}`);
      continue;
    }
    urls.push(...extractUrls(text));
  }
  if (opts.stdin) {
    const text = await readStdin();
    urls.push(...extractUrls(text));
  }
  return urls;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.inputs.length && !opts.stdin)) {
    printHelp();
    process.exit(opts.help ? 0 : 2);
  }

  const urls = await collectUrls(opts);
  if (!urls.length) {
    if (opts.json) console.log(JSON.stringify({ checked: 0, dead: 0, results: [] }, null, 2));
    else console.log('No URLs found.');
    process.exit(0);
  }

  const results = await validateUrls(urls, { timeoutMs: opts.timeoutMs });
  const dead = results.filter((r) => r.dead);

  if (opts.json) {
    console.log(JSON.stringify({ checked: results.length, dead: dead.length, results }, null, 2));
  } else {
    const shown = opts.deadOnly ? dead : results;
    for (const r of shown) {
      const mark = r.dead ? 'DEAD' : 'ok  ';
      const status = r.status ? `[${r.status}]` : r.reason ? `[${r.reason}]` : '[?]';
      console.log(`${mark} ${status.padEnd(14)} ${r.url}`);
    }
    console.log('');
    console.log(`${results.length} checked · ${dead.length} dead · ${results.length - dead.length} ok`);
    if (dead.length) console.log('Drop or replace the DEAD links before presenting this content.');
  }

  process.exit(dead.length ? 1 : 0);
}

main().catch((err) => {
  console.error(String((err && err.stack) || err));
  process.exit(2);
});
