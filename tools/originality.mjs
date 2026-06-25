#!/usr/bin/env node
// originality.mjs — CLI for the originality / AI-generated-content scorer.
//
// Content Scout calls this during a scan (when "Originality scoring" is enabled
// in the product config) to attach an originality score to each content item.
// It is a transparent heuristic over the documented signs of AI writing — a
// review aid, not a definitive AI detector.
//
// Usage:
//   node tools/originality.mjs https://example.com/post        # fetch + score a URL
//   node tools/originality.mjs --json https://example.com/post # machine-readable
//   node tools/originality.mjs path/to/article.md              # score a local file
//   echo "some text" | node tools/originality.mjs -            # score stdin
//   node tools/originality.mjs --text "paste prose here"       # score inline text
//
// Flags:
//   --json        emit { score, score100, rating, ratingLabel, wordCount, signals }
//   --text <str>  score the given string directly
//   --min N       minimum word count to score (default 40; below → n/a)
//   --timeout N   per-URL fetch timeout ms (default 12000)

import { promises as fs } from 'node:fs';
import process from 'node:process';
import { scoreOriginality, formatOriginality } from './lib/originality.mjs';
import { htmlToText } from './lib/analytics.mjs';

function parseArgs(argv) {
  const out = { json: false, inputs: [], stdin: false, text: null, minWords: 40, timeoutMs: 12000, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--text') out.text = argv[++i] || '';
    else if (a === '--min') out.minWords = parseInt(argv[++i], 10) || 40;
    else if (a === '--timeout') out.timeoutMs = parseInt(argv[++i], 10) || 12000;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-') out.stdin = true;
    else out.inputs.push(a);
  }
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (ContentScout originality)' },
    });
    if (!res.ok) return { text: '', error: `HTTP ${res.status}` };
    const html = await res.text();
    return { text: htmlToText(html), error: null };
  } catch (e) {
    return { text: '', error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveInput(input, opts) {
  if (/^https?:\/\//i.test(input)) {
    const { text, error } = await fetchText(input, opts.timeoutMs);
    return { label: input, text, error };
  }
  try {
    const raw = await fs.readFile(input, 'utf8');
    return { label: input, text: raw, error: null };
  } catch {
    // Treat as raw text if it isn't a readable path.
    return { label: '(text)', text: input, error: null };
  }
}

function printHuman(label, result, error) {
  if (error && !result) {
    console.log(`${label}\n  could not score: ${error}`);
    return;
  }
  console.log(label);
  console.log(`  Originality: ${formatOriginality(result)}  (${result.wordCount} words)`);
  if (result.signals.length) {
    const top = result.signals.slice(0, 5).map((s) => `${s.label} ×${s.count}`).join('; ');
    console.log(`  Signals: ${top}`);
  } else if (result.rating !== 'insufficient-text') {
    console.log('  Signals: none detected');
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node tools/originality.mjs [--json] [--text "..."] <url|file|->');
    return;
  }

  const jobs = [];
  if (opts.text != null) jobs.push({ label: '(text)', text: opts.text, error: null });
  if (opts.stdin) jobs.push({ label: '(stdin)', text: await readStdin(), error: null });
  for (const input of opts.inputs) jobs.push(await resolveInput(input, opts));

  if (!jobs.length) {
    console.error('No input. Pass a URL, file, --text "...", or pipe text and use "-".');
    process.exit(2);
  }

  const results = jobs.map((j) => ({
    input: j.label,
    error: j.error,
    result: j.error && !j.text ? null : scoreOriginality(j.text, { minWords: opts.minWords }),
  }));

  if (opts.json) {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    return;
  }
  for (const r of results) printHuman(r.input, r.result, r.error);
}

main().catch((err) => {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
