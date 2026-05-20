#!/usr/bin/env node
// Content Scout — Conversations close/reopen helper command
//
// Manage the persistent "dismissed / closed" state for Conversations &
// mentions rows that the web UI also reads. The state lives at
// reports/.closed-conversations.json. Both the web UI and any chat/headless agent
// (the /scout-* slash commands) should consult this file so dismissed
// rows don't reappear in new outputs.
//
// Usage:
//   node tools/conversations-cli.mjs list-closed
//   node tools/conversations-cli.mjs list-reasons
//   node tools/conversations-cli.mjs close <url-or-key> [--reason <id>] [--note "..."]
//   node tools/conversations-cli.mjs reopen <url-or-key>
//   node tools/conversations-cli.mjs is-closed <url-or-key>
//   node tools/conversations-cli.mjs list-muted
//   node tools/conversations-cli.mjs mute <handle> [--platform <name>] [--reason <text>] [--note "..."]
//   node tools/conversations-cli.mjs unmute <handle> [--platform <name>]
//   node tools/conversations-cli.mjs is-muted <handle> [--platform <name>]
//   node tools/conversations-cli.mjs no-triage <handle> [--platform <name>] [--note "..."]
//   node tools/conversations-cli.mjs list-no-triage
//   node tools/conversations-cli.mjs is-no-triage <handle> [--platform <name>]
//   node tools/conversations-cli.mjs no-triage-team <config-slug>
//   node tools/conversations-cli.mjs mute-owned <config-slug>
//
// Notes:
// - <url-or-key> may be either a full URL (matched after normalization)
//   or a previously-emitted composite key starting with "mix::".
// - Reasons: not-relevant | contacted | follow-up-pm | spam | duplicate | other
//   ("other" requires --note).
// - For mute: <handle> is the account handle (leading @ optional). When
//   --platform is omitted, the mute applies across every platform.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_REASONS,
  convoKey,
  loadClosed,
  closeMany,
  reopenMany,
} from './web-ui/lib/closed-conversations.js';
import {
  loadMuted,
  muteAccount,
  unmuteMany,
  muteKey,
  normHandle,
  normPlatform,
  NO_TRIAGE_REASON,
  isNoTriageInfo,
  parseOwnedAccountsFromConfig,
  parseTeamMemberAccountsFromConfig,
} from './web-ui/lib/muted-accounts.js';

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
  console.log(`Content Scout — close/reopen Conversations rows + mute noisy accounts

Usage:
  node tools/conversations-cli.mjs list-closed
  node tools/conversations-cli.mjs list-reasons
  node tools/conversations-cli.mjs close <url-or-key> --reason <id> [--note "..."]
  node tools/conversations-cli.mjs reopen <url-or-key>
  node tools/conversations-cli.mjs is-closed <url-or-key>

  node tools/conversations-cli.mjs list-muted
  node tools/conversations-cli.mjs mute <handle> [--platform <name>] [--reason <text>] [--note "..."]
  node tools/conversations-cli.mjs unmute <handle> [--platform <name>]
  node tools/conversations-cli.mjs is-muted <handle> [--platform <name>]
  node tools/conversations-cli.mjs no-triage <handle> [--platform <name>] [--note "..."]
  node tools/conversations-cli.mjs list-no-triage
  node tools/conversations-cli.mjs is-no-triage <handle> [--platform <name>]
  node tools/conversations-cli.mjs no-triage-team <config-slug>

Reasons: ${ALLOWED_REASONS.map((r) => r.id).join(' | ')}
"other" requires --note.

Mute notes:
  - <handle> may include a leading @ (it's stripped automatically).
  - Omit --platform to mute the handle across every platform.
  - no-triage is for verified Microsoft employees / owned people who should not enter the triage inbox. Microsoft MVP/MCT status alone is community, not employee.`);
}

function noTriageItems(state) {
  return Object.entries(state.items)
    .filter(([, info]) => isNoTriageInfo(info))
    .sort((a, b) => (b[1].mutedAt || '').localeCompare(a[1].mutedAt || ''));
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

  if (cmd === 'list-muted') {
    const state = await loadMuted(REPORTS_DIR);
    const items = Object.entries(state.items).sort((a, b) =>
      (b[1].mutedAt || '').localeCompare(a[1].mutedAt || '')
    );
    if (!items.length) {
      console.log('No muted accounts.');
      return;
    }
    console.log(`${items.length} muted account(s):\n`);
    for (const [key, info] of items) {
      const when = info.mutedAt ? info.mutedAt.slice(0, 10) : '????-??-??';
      const platform = info.platform === '*' ? '*all*' : info.platform;
      const reason = info.reason ? ` — ${info.reason}` : '';
      const note = info.note ? ` (${info.note})` : '';
      console.log(`[${when}] @${info.handle} on ${platform}${reason}${note}`);
      console.log(`  key: ${key}\n`);
    }
    return;
  }

  if (cmd === 'list-no-triage') {
    const state = await loadMuted(REPORTS_DIR);
    const items = noTriageItems(state);
    if (!items.length) {
      console.log('No no-triage accounts.');
      return;
    }
    console.log(`${items.length} no-triage account(s):\n`);
    for (const [key, info] of items) {
      const when = info.mutedAt ? info.mutedAt.slice(0, 10) : '????-??-??';
      const platform = info.platform === '*' ? '*all*' : info.platform;
      const note = info.note ? ` — ${info.note}` : '';
      console.log(`[${when}] @${info.handle} on ${platform}${note}`);
      console.log(`  key: ${key}\n`);
    }
    return;
  }

  if (cmd === 'mute') {
    const handle = positional[1];
    if (!handle) {
      console.error('mute requires <handle>');
      process.exit(2);
    }
    const platform = typeof flags.platform === 'string' ? flags.platform : '';
    const reason = typeof flags.reason === 'string' ? flags.reason : '';
    const note = typeof flags.note === 'string' ? flags.note : '';
    try {
      const { key, state } = await muteAccount(REPORTS_DIR, { platform, handle, reason, note });
      console.log(`Muted @${normHandle(handle)} on ${normPlatform(platform)}. key=${key}`);
      console.log(`(${Object.keys(state.items).length} total muted)`);
    } catch (err) {
      console.error('Failed:', err.message || err);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'no-triage') {
    const handle = positional[1];
    if (!handle) {
      console.error('no-triage requires <handle>');
      process.exit(2);
    }
    const platform = typeof flags.platform === 'string' ? flags.platform : '';
    const note = typeof flags.note === 'string' ? flags.note : 'Verified Microsoft employee or owned account; no community triage needed.';
    try {
      const { key, state } = await muteAccount(REPORTS_DIR, {
        platform,
        handle,
        reason: NO_TRIAGE_REASON,
        note,
      });
      console.log(`Marked @${normHandle(handle)} on ${normPlatform(platform)} as no-triage. key=${key}`);
      console.log(`(${noTriageItems(state).length} total no-triage)`);
    } catch (err) {
      console.error('Failed:', err.message || err);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'unmute') {
    const handle = positional[1];
    if (!handle) {
      console.error('unmute requires <handle>');
      process.exit(2);
    }
    const platform = typeof flags.platform === 'string' ? flags.platform : '';
    const key = muteKey(platform, handle);
    const { removed } = await unmuteMany(REPORTS_DIR, [key]);
    console.log(`Unmuted ${removed} account(s). key=${key}`);
    return;
  }

  if (cmd === 'is-muted') {
    const handle = positional[1];
    if (!handle) {
      console.error('is-muted requires <handle>');
      process.exit(2);
    }
    const platform = typeof flags.platform === 'string' ? flags.platform : '';
    const key = muteKey(platform, handle);
    const state = await loadMuted(REPORTS_DIR);
    if (state.items[key]) {
      const info = state.items[key];
      console.log(`MUTED (${info.reason || 'no reason'}${info.note ? ': ' + info.note : ''})`);
      process.exit(0);
    } else {
      console.log('not muted');
      process.exit(1);
    }
  }

  if (cmd === 'is-no-triage') {
    const handle = positional[1];
    if (!handle) {
      console.error('is-no-triage requires <handle>');
      process.exit(2);
    }
    const platform = typeof flags.platform === 'string' ? flags.platform : '';
    const key = muteKey(platform, handle);
    const state = await loadMuted(REPORTS_DIR);
    const globalKey = muteKey('', handle);
    const info = state.items[key] || state.items[globalKey];
    if (isNoTriageInfo(info)) {
      console.log(`NO_TRIAGE (${info.note || 'verified Microsoft employee / owned account'})`);
      process.exit(0);
    } else {
      console.log('triage required');
      process.exit(1);
    }
  }

  if (cmd === 'no-triage-team' || cmd === 'import-team-no-triage') {
    const slug = positional[1];
    if (!slug) {
      console.error(`${cmd} requires <config-slug> (e.g. azure-cosmos-db)`);
      process.exit(2);
    }
    const { promises: fs } = await import('node:fs');
    const cfgFile = path.join(REPO_ROOT, '.github', 'prompts', `scout-config-${slug}.prompt.md`);
    let raw;
    try {
      raw = await fs.readFile(cfgFile, 'utf8');
    } catch (err) {
      console.error(`Could not read config: ${cfgFile}`);
      process.exit(1);
    }
    const team = parseTeamMemberAccountsFromConfig(raw);
    if (!team.length) {
      console.log('No product-team handles found in config. Name-only entries cannot be matched to conversation authors.');
      return;
    }
    console.log(`Found ${team.length} product-team handle(s) in ${path.basename(cfgFile)}:`);
    for (const acct of team) {
      const { key } = await muteAccount(REPORTS_DIR, {
        platform: acct.platform,
        handle: acct.handle,
        reason: NO_TRIAGE_REASON,
        note: acct.name ? `Product team member from scout-config-${slug}.prompt.md: ${acct.name}` : `Product team member from scout-config-${slug}.prompt.md`,
      });
      const name = acct.name ? ` (${acct.name})` : '';
      console.log(`  no-triage @${acct.handle} on ${normPlatform(acct.platform)}${name} (key=${key})`);
    }
    const state = await loadMuted(REPORTS_DIR);
    console.log(`(${noTriageItems(state).length} total no-triage)`);
    return;
  }

  if (cmd === 'mute-owned') {
    const slug = positional[1];
    if (!slug) {
      console.error('mute-owned requires <config-slug> (e.g. azure-cosmos-db)');
      process.exit(2);
    }
    const { promises: fs } = await import('node:fs');
    const cfgFile = path.join(REPO_ROOT, '.github', 'prompts', `scout-config-${slug}.prompt.md`);
    let raw;
    try {
      raw = await fs.readFile(cfgFile, 'utf8');
    } catch (err) {
      console.error(`Could not read config: ${cfgFile}`);
      process.exit(1);
    }
    const owned = parseOwnedAccountsFromConfig(raw);
    if (!owned.length) {
      console.log('No "Official social accounts" entries found in config.');
      return;
    }
    console.log(`Found ${owned.length} owned account(s) in ${path.basename(cfgFile)}:`);
    for (const acct of owned) {
      const { key } = await muteAccount(REPORTS_DIR, {
        platform: acct.platform,
        handle: acct.handle,
        reason: 'owned-account',
        note: `Imported from scout-config-${slug}.prompt.md`,
        owned: true,
      });
      console.log(`  muted @${acct.handle} on ${acct.platform} (key=${key})`);
    }
    const state = await loadMuted(REPORTS_DIR);
    console.log(`(${Object.keys(state.items).length} total muted)`);
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
