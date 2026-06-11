// Persistent "closed / dismissed" state for Conversations & mentions.
//
// Storage lives at <repo>/.local/state/closed-conversations.json so both
// the web UI and the local helper command (tools/conversations-cli.mjs)
// share the same truth. Reads transparently fall back to the legacy
// path <repo>/reports/.closed-conversations.json when the new file does
// not yet exist — first write naturally migrates it. Schema:
//
//   {
//     "version": 1,
//     "items": {
//       "<key>": {
//         "reason": "<one of ALLOWED_REASONS>",
//         "note":   "<freeform string, optional>",
//         "closedAt": "<ISO timestamp>",
//         // Snapshot of identifying fields so the row can still be shown
//         // in "Closed" lists even if the source report file is removed:
//         "url": "...", "platform": "...", "author": "...",
//         "summary": "...", "date": "...", "report": "..."
//       }
//     }
//   }
//
// `convoKey()` is deterministic and shared with the client so both sides
// agree on identity even though the parsed conversations have no native
// IDs.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CLOSED_CONVERSATIONS_FILE,
  resolveStateRead,
  resolveStateWrite,
} from '../../lib/paths.mjs';

// Legacy name kept for any external imports — new code should use the
// resolver functions in paths.mjs.
export const CLOSED_FILE_NAME = '.closed-conversations.json';

export const ALLOWED_REASONS = Object.freeze([
  { id: 'not-relevant',  label: 'Not relevant' },
  { id: 'contacted',     label: 'Contacted' },
  { id: 'follow-up-pm',  label: 'Follow up with PM' },
  { id: 'spam',          label: 'Spam / job post' },
  { id: 'duplicate',     label: 'Duplicate' },
  { id: 'other',         label: 'Other' },
]);

const REASON_IDS = new Set(ALLOWED_REASONS.map((r) => r.id));

export function isValidReason(reason) {
  return typeof reason === 'string' && REASON_IDS.has(reason);
}

// Build a stable identifier for a conversation row.
// Prefer the URL (normalized: lowercased, query/fragment stripped). Fall
// back to a composite of platform|author|date|summary[:80] so manually
// imported rows without a URL can still be closed.
export function convoKey(c) {
  if (!c || typeof c !== 'object') return '';
  const url = typeof c.url === 'string' ? c.url.trim() : '';
  if (url && /^https?:\/\//i.test(url)) {
    const normalized = url
      .toLowerCase()
      .replace(/[#?].*$/, '')
      .replace(/\/+$/, '');
    return 'url::' + normalized;
  }
  const norm = (s) =>
    String(s == null ? '' : s)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  const summary = norm(c.summary).slice(0, 80);
  return (
    'mix::' +
    [norm(c.platform), norm(c.author), norm(c.date), summary].join('|')
  );
}

export async function loadClosed(reportsDir) {
  const file = await resolveStateRead(CLOSED_CONVERSATIONS_FILE, reportsDir);
  if (!file) return emptyState();
  try {
    const raw = await fs.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return emptyState();
    const items =
      data.items && typeof data.items === 'object' && !Array.isArray(data.items)
        ? data.items
        : {};
    return { version: 1, items };
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyState();
    // Corrupt file — don't lose data silently: rename and start fresh.
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.rename(file, file + '.corrupt-' + stamp);
    } catch {}
    return emptyState();
  }
}

export async function saveClosed(_reportsDir, state) {
  const file = await resolveStateWrite(CLOSED_CONVERSATIONS_FILE);
  const out = {
    version: 1,
    items: state && state.items && typeof state.items === 'object' ? state.items : {},
  };
  // Atomic-ish write: temp file + rename.
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
  return out;
}

function emptyState() {
  return { version: 1, items: {} };
}

// Apply a close action to many conversations at once.
// `entries` is an array of { key?, conv? } where conv has the snapshot
// fields. Returns the updated state object (already saved).
export async function closeMany(reportsDir, entries, reason, note) {
  if (!isValidReason(reason)) {
    const err = new Error('Invalid reason: ' + reason);
    err.code = 'INVALID_REASON';
    throw err;
  }
  if (reason === 'other' && !(note && String(note).trim())) {
    const err = new Error('Reason "other" requires a note');
    err.code = 'NOTE_REQUIRED';
    throw err;
  }
  const trimmedNote = note ? String(note).trim().slice(0, 500) : '';
  const state = await loadClosed(reportsDir);
  const closedAt = new Date().toISOString();
  let added = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const conv = entry.conv && typeof entry.conv === 'object' ? entry.conv : {};
    const key = entry.key || convoKey(conv);
    if (!key) continue;
    state.items[key] = {
      reason,
      note: trimmedNote,
      closedAt,
      url: typeof conv.url === 'string' ? conv.url : '',
      platform: typeof conv.platform === 'string' ? conv.platform : '',
      author: typeof conv.author === 'string' ? conv.author : '',
      summary: typeof conv.summary === 'string' ? conv.summary : '',
      date: typeof conv.date === 'string' ? conv.date : '',
      report: typeof conv.report === 'string' ? conv.report : '',
    };
    added++;
  }
  await saveClosed(reportsDir, state);
  return { state, added };
}

export async function reopenMany(reportsDir, keys) {
  const state = await loadClosed(reportsDir);
  let removed = 0;
  for (const key of Array.isArray(keys) ? keys : []) {
    if (key && state.items[key]) {
      delete state.items[key];
      removed++;
    }
  }
  await saveClosed(reportsDir, state);
  return { state, removed };
}
