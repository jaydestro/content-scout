#!/usr/bin/env node
/* Content Scout — bulk URL CLI
 *
 * Reads URLs from a .txt (one per line) or .csv (must have a `url` column) and
 * submits them to a running scout-web instance's POST /api/runs/bulk endpoint.
 * Each URL becomes its own /<command> run on the server, executed sequentially.
 *
 * Usage:
 *   scout-bulk --command scout-post --slug azure-cosmos-db --file urls.csv
 *   scout-bulk --print-template > urls.csv
 *   scout-bulk --command scout-seo --file links.txt --host http://127.0.0.1:4477
 */
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const ALLOWED = new Set(['scout-post', 'scout-seo', 'scout-reddit-import', 'scout-alt']);

const TEMPLATE =
  'url,notes\n' +
  '# url    — required. Must be http:// or https://\n' +
  '# notes  — optional. Free-text guidance that influences the generated\n' +
  '#          post (tone, audience, angle, hashtags to favor, things to\n' +
  '#          avoid). Each note is appended to that URL\'s prompt as extra\n' +
  '#          context. Wrap in double-quotes if the note has a comma.\n' +
  'https://example.com/post-one,"casual tone; emphasize the perf gains; one CTA"\n' +
  'https://example.com/post-two,"developer audience; lead with the code sample"\n';

function parseArgs(argv) {
  const out = { host: 'http://127.0.0.1:4477', extra: '', range: '', slug: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--command': case '-c': out.command = next(); break;
      case '--slug': case '-s': out.slug = next(); break;
      case '--file': case '-f': out.file = next(); break;
      case '--host': out.host = next(); break;
      case '--extra': out.extra = next(); break;
      case '--range': out.range = next(); break;
      case '--print-template': out.printTemplate = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--help': case '-h': out.help = true; break;
      default:
        if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
    }
  }
  return out;
}

function help() {
  console.log(`scout-bulk — submit a list of URLs to a running scout-web

Options:
  -c, --command <name>   One of: ${[...ALLOWED].join(', ')}
  -s, --slug <slug>      Subject config slug (optional)
  -f, --file <path>      .txt (one URL per line) or .csv (with 'url' column)
      --host <url>       scout-web base URL (default http://127.0.0.1:4477)
      --extra <text>     Extra args appended to each prompt
      --range <text>     Date-range phrase appended to each prompt
      --print-template   Print a CSV template to stdout and exit
      --dry-run          Parse and validate but do not submit
  -h, --help             Show this help`);
}

function splitCsv(row) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (q) {
      if (ch === '"' && row[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Parses a .txt or .csv body into a deduped array of { url, notes } entries.
// CSV files may include a `notes` column; its value is forwarded to the
// server which appends it to that URL's prompt as guidance for the post.
// Plain .txt input has no notes column, so notes is always ''.
function extractUrls(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const first = lines[0].toLowerCase();
  const looksCsv = first.includes(',') && /(^|,)\s*url\s*(,|$)/.test(first);
  const seen = new Map();
  if (looksCsv) {
    const headers = splitCsv(lines[0]).map((h) => h.toLowerCase().trim());
    const urlIdx = headers.indexOf('url');
    const notesIdx = headers.indexOf('notes');
    if (urlIdx === -1) return [];
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].startsWith('#')) continue;
      const cols = splitCsv(lines[i]);
      const u = (cols[urlIdx] || '').trim();
      if (!/^https?:\/\//i.test(u)) continue;
      const notes = notesIdx !== -1 ? (cols[notesIdx] || '').trim() : '';
      if (!seen.has(u)) seen.set(u, notes);
    }
  } else {
    for (const l of lines) {
      if (l.startsWith('#')) continue;
      const tok = l.split(/[\s,]/)[0].trim();
      if (/^https?:\/\//i.test(tok) && !seen.has(tok)) seen.set(tok, '');
    }
  }
  return [...seen.entries()].map(([url, notes]) => ({ url, notes }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); return; }
  if (args.printTemplate) { process.stdout.write(TEMPLATE); return; }
  if (!args.command || !ALLOWED.has(args.command)) {
    console.error(`--command required (one of: ${[...ALLOWED].join(', ')})`);
    process.exit(2);
  }
  if (!args.file) {
    console.error('--file required (.txt or .csv)');
    process.exit(2);
  }
  const text = await readFile(args.file, 'utf8');
  const urls = extractUrls(text);
  if (!urls.length) {
    console.error('No valid http(s) URLs found in file.');
    process.exit(1);
  }
  const withNotes = urls.filter((e) => e.notes).length;
  console.log(
    `Parsed ${urls.length} URL${urls.length === 1 ? '' : 's'} from ${args.file}` +
    (withNotes ? ` (${withNotes} with notes).` : '.'),
  );
  if (args.dryRun) {
    for (const e of urls) console.log(e.notes ? `  ${e.url}  — notes: ${e.notes}` : `  ${e.url}`);
    return;
  }
  const endpoint = args.host.replace(/\/+$/, '') + '/api/runs/bulk';
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        command: args.command,
        slug: args.slug,
        extra: args.extra,
        range: args.range,
        // Server accepts both plain strings and { url, notes } entries.
        urls,
      }),
    });
  } catch (err) {
    console.error(`Could not reach scout-web at ${args.host}: ${err.message}`);
    console.error('Start the web UI first: `scout-web` (or `npm start` in tools/web-ui).');
    process.exit(1);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Server returned ${res.status}: ${data.error || res.statusText}`);
    process.exit(1);
  }
  console.log(`Queued ${data.queued} runs (bulk id ${data.bulkId}).`);
  console.log(`Watch progress at ${args.host} → Run view, or ${args.host}/api/runs.`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
