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
import { scoreOriginality, formatOriginality, reviewAgainstDocs } from './lib/originality.mjs';
import { htmlToText } from './lib/analytics.mjs';

// Hosts treated as "official documentation" for the scraped-from-docs check.
const DOC_HOSTS = /learn\.microsoft\.com|docs\.microsoft\.com|developer\.mozilla\.org|readthedocs\.io|\.github\.io/i;

function parseArgs(argv) {
  const out = {
    json: false, inputs: [], stdin: false, text: null, minWords: 40,
    timeoutMs: 12000, help: false, docs: [], autoDocs: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--text') out.text = argv[++i] || '';
    else if (a === '--doc') out.docs.push(argv[++i] || '');
    else if (a === '--no-auto-docs') out.autoDocs = false;
    else if (a === '--min') out.minWords = parseInt(argv[++i], 10) || 40;
    else if (a === '--timeout') out.timeoutMs = parseInt(argv[++i], 10) || 12000;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-') out.stdin = true;
    else out.inputs.push(a);
  }
  out.docs = out.docs.filter(Boolean);
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchHtml(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (ContentScout originality)' },
    });
    if (!res.ok) return { html: '', error: `HTTP ${res.status}` };
    return { html: await res.text(), error: null };
  } catch (e) {
    return { html: '', error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Pull documentation links out of a content page so we can check whether the
// prose was lifted from docs it doesn't reword.
function extractDocLinks(html, max = 3) {
  const out = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
    const u = m[1].split('#')[0];
    if (DOC_HOSTS.test(u) && !seen.has(u)) {
      seen.add(u);
      out.push(u);
      if (out.length >= max) break;
    }
  }
  return out;
}

async function resolveInput(input, opts) {
  if (/^https?:\/\//i.test(input)) {
    const { html, error } = await fetchHtml(input, opts.timeoutMs);
    return { label: input, raw: html, text: htmlToText(html), error };
  }
  try {
    const raw = await fs.readFile(input, 'utf8');
    return { label: input, raw, text: raw, error: null };
  } catch {
    return { label: '(text)', raw: input, text: input, error: null };
  }
}

// Fetch + run the docs-derivative review for a scored job.
async function runDerivativeCheck(job, opts) {
  let docUrls = [...opts.docs];
  if (opts.autoDocs && job.raw) docUrls = docUrls.concat(extractDocLinks(job.raw));
  docUrls = [...new Set(docUrls)].slice(0, 4);
  if (!docUrls.length) return null;
  const docs = [];
  for (const u of docUrls) {
    const { html } = await fetchHtml(u, opts.timeoutMs);
    if (html) docs.push({ url: u, text: htmlToText(html) });
  }
  if (!docs.length) return null;
  return reviewAgainstDocs(job.text, docs, { contentRaw: job.raw });
}

function printHuman(label, result, error, derivative) {
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
  if (derivative && derivative.checked) {
    const t = derivative.top;
    console.log(`  Docs check: ${derivative.verdictLabel} (top ${t.overlapPct}% verbatim overlap, longest run ${t.longestRun} words${t.attributed ? ', attributed' : ', no attribution'})`);
    console.log(`    vs ${t.url}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node tools/originality.mjs [--json] [--doc <url>]... [--text "..."] <url|file|->');
    return;
  }

  const jobs = [];
  if (opts.text != null) jobs.push({ label: '(text)', raw: opts.text, text: opts.text, error: null });
  if (opts.stdin) { const t = await readStdin(); jobs.push({ label: '(stdin)', raw: t, text: t, error: null }); }
  for (const input of opts.inputs) jobs.push(await resolveInput(input, opts));

  if (!jobs.length) {
    console.error('No input. Pass a URL, file, --text "...", or pipe text and use "-".');
    process.exit(2);
  }

  const results = [];
  for (const j of jobs) {
    const result = j.error && !j.text ? null : scoreOriginality(j.text, { minWords: opts.minWords });
    let derivative = null;
    if (result && result.rating !== 'insufficient-text') {
      derivative = await runDerivativeCheck(j, opts);
    }
    results.push({ input: j.label, error: j.error, result, derivative });
  }

  if (opts.json) {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    return;
  }
  for (const r of results) printHuman(r.input, r.result, r.error, r.derivative);
}

main().catch((err) => {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
