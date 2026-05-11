#!/usr/bin/env node
// Content Scout — Conversations close/reopen CLI
//
// Manage the persistent "dismissed / closed" state for Conversations &
// mentions rows that the web UI also reads. The state lives at
// reports/.closed-conversations.json. Both the web UI and any CLI agent
// (the /scout-* slash commands) should consult this file so dismissed
// rows don't reappear in new outputs.
//
// Usage:
//   node tools/conversations-cli.mjs list-closed
//   node tools/conversations-cli.mjs list-reasons
//   node tools/conversations-cli.mjs close <url-or-key> [--reason <id>] [--note "..."]
//   node tools/conversations-cli.mjs reopen <url-or-key>
//   node tools/conversations-cli.mjs is-closed <url-or-key>
//
// Notes:
// - <url-or-key> may be either a full URL (matched after normalization)
//   or a previously-emitted composite key starting with "mix::".
// - Reasons: not-relevant | contacted | follow-up-pm | spam | duplicate | other
//   ("other" requires --note).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_REASONS,
  convoKey,
  loadClosed,
  closeMany,
  reopenMany,
} from './web-ui/lib/closed-conversations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(REPO_ROOT, 'reports');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith('--')) {
        flags[k] = next;
        i++;
      } else {
        flags[k] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function normalizeKey(target) {
  if (!target) return '';
  if (target.startsWith('url::') || target.startsWith('mix::')) return target;
  if (/^https?:\/\//i.test(target)) return convoKey({ url: target });
  return target;
}

function usage() {
  console.log(`Content Scout — close/reopen Conversations rows

Usage:
  node tools/conversations-cli.mjs list-closed
  node tools/conversations-cli.mjs list-reasons
  node tools/conversations-cli.mjs close <url-or-key> --reason <id> [--note "..."]
  node tools/conversations-cli.mjs reopen <url-or-key>
  node tools/conversations-cli.mjs is-closed <url-or-key>

Reasons: ${ALLOWED_REASONS.map((r) => r.id).join(' | ')}
"other" requires --note.`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  if (cmd === 'list-reasons') {
    for (const r of ALLOWED_REASONS) console.log(`${r.id}\t${r.label}`);
    return;
  }

  if (cmd === 'list-closed') {
    const state = await loadClosed(REPORTS_DIR);
    const items = Object.entries(state.items).sort((a, b) =>
      (b[1].closedAt || '').localeCompare(a[1].closedAt || '')
    );
    if (!items.length) {
      console.log('No closed conversations.');
      return;
    }
    console.log(`${items.length} closed conversation(s):\n`);
    for (const [key, info] of items) {
      const when = info.closedAt ? info.closedAt.slice(0, 10) : '????-??-??';
      const who = info.author || '(unknown)';
      const plat = info.platform || '?';
      const url = info.url || key;
      const note = info.note ? ` — ${info.note}` : '';
      console.log(`[${when}] ${info.reason}${note}`);
      console.log(`  ${who} on ${plat}: ${(info.summary || '').slice(0, 100)}`);
      console.log(`  ${url}`);
      console.log(`  key: ${key}\n`);
    }
    return;
  }

  if (cmd === 'is-closed') {
    const target = positional[1];
    if (!target) {
      console.error('is-closed requires <url-or-key>');
      process.exit(2);
    }
    const key = normalizeKey(target);
    const state = await loadClosed(REPORTS_DIR);
    if (state.items[key]) {
      const info = state.items[key];
      console.log(`CLOSED (${info.reason}${info.note ? ': ' + info.note : ''})`);
      process.exit(0);
    } else {
      console.log('open');
      process.exit(1);
    }
  }

  if (cmd === 'close') {
    const target = positional[1];
    const reason = flags.reason;
    const note = typeof flags.note === 'string' ? flags.note : '';
    if (!target || !reason) {
      console.error('close requires <url-or-key> --reason <id>');
      process.exit(2);
    }
    const key = normalizeKey(target);
    const conv = /^https?:\/\//i.test(target) ? { url: target } : {};
    try {
      const { added } = await closeMany(REPORTS_DIR, [{ key, conv }], reason, note);
      console.log(`Closed ${added} conversation(s). key=${key}`);
    } catch (err) {
      console.error('Failed:', err.message || err);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'reopen') {
    const target = positional[1];
    if (!target) {
      console.error('reopen requires <url-or-key>');
      process.exit(2);
    }
    const key = normalizeKey(target);
    const { removed } = await reopenMany(REPORTS_DIR, [key]);
    console.log(`Reopened ${removed} conversation(s). key=${key}`);
    return;
  }

  console.error('Unknown command: ' + cmd);
  usage();
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
