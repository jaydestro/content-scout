// Persistent "muted accounts" list for Conversations & mentions.
//
// Hides every conversation row authored by a muted handle so noisy
// accounts (recruiters, spammers, off-topic creators) don't clutter the
// inbox. State lives at <repo>/reports/.muted-accounts.json and is
// shared by the web UI and the CLI helper (tools/conversations-cli.mjs).
//
// Schema:
//
//   {
//     "version": 1,
//     "items": {
//       "<platform>::<handle>": {
//         "platform": "<lowercased platform or '*' for any>",
//         "handle":   "<lowercased, leading @ stripped>",
//         "reason":   "<short freeform string, optional>",
//         "note":     "<freeform string, optional>",
//         "mutedAt":  "<ISO timestamp>"
//       }
//     }
//   }
//
// Platform "*" matches any platform — useful for muting a handle that
// posts the same noise on multiple networks.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const MUTED_FILE_NAME = '.muted-accounts.json';
export const NO_TRIAGE_REASON = 'microsoft-employee';

export function normHandle(h) {
  return String(h == null ? '' : h).trim().replace(/^@+/, '').toLowerCase();
}

export function normPlatform(p) {
  const s = String(p == null ? '' : p).trim().toLowerCase();
  return s || '*';
}

export function muteKey(platform, handle) {
  return `${normPlatform(platform)}::${normHandle(handle)}`;
}

export async function loadMuted(reportsDir) {
  const file = path.join(reportsDir, MUTED_FILE_NAME);
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
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.rename(file, file + '.corrupt-' + stamp);
    } catch {}
    return emptyState();
  }
}

export async function saveMuted(reportsDir, state) {
  const file = path.join(reportsDir, MUTED_FILE_NAME);
  await fs.mkdir(reportsDir, { recursive: true });
  const out = {
    version: 1,
    items: state && state.items && typeof state.items === 'object' ? state.items : {},
  };
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
  return out;
}

function emptyState() {
  return { version: 1, items: {} };
}

export async function muteAccount(reportsDir, { platform, handle, reason, note, owned }) {
  const cleanHandle = normHandle(handle);
  if (!cleanHandle) {
    const err = new Error('handle is required');
    err.code = 'HANDLE_REQUIRED';
    throw err;
  }
  const state = await loadMuted(reportsDir);
  const key = muteKey(platform, cleanHandle);
  const reasonText = reason ? String(reason).trim().slice(0, 100) : '';
  state.items[key] = {
    platform: normPlatform(platform),
    handle: cleanHandle,
    reason: reasonText,
    note: note ? String(note).trim().slice(0, 500) : '',
    owned: !!owned,
    noTriage: reasonText === NO_TRIAGE_REASON,
    mutedAt: new Date().toISOString(),
  };
  await saveMuted(reportsDir, state);
  return { state, key };
}

// Parse "Official social accounts" lines out of a scout-config-*.prompt.md
// raw markdown body. Recognises common patterns like:
//   - LinkedIn: @yourproduct
//   - X/Twitter: @YourProduct, @YourTeam
//   - Bluesky: yourproduct.bsky.social
//   - Reddit: u/yourbot
//   - YouTube: @YourChannel (channelId: UC...)
// Returns a deduplicated array of { platform, handle } records.
export function parseOwnedAccountsFromConfig(raw) {
  const out = [];
  const seen = new Set();
  const text = String(raw == null ? '' : raw);
  // Pull the "Official social accounts" block (until the next blank-line
  // separated section / heading / horizontal rule).
  const m = text.match(/Official social accounts[^\n]*\n([\s\S]*?)(?:\r?\n\s*#{1,6}\s|\r?\n-{3,}\s*\r?\n|\r?\n\s*\r?\n\s*\*\*)/);
  const block = m ? m[1] : '';
  if (!block) return out;
  const lines = block.split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = lineRaw.replace(/^[-*\s]+/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const platLabel = line.slice(0, colon).trim().toLowerCase();
    const rest = line.slice(colon + 1).trim();
    if (!rest || /^none$/i.test(rest)) continue;
    let platform = platLabel;
    if (/twitter|x\b|x\/twitter|^x$/.test(platLabel)) platform = 'x';
    else if (/linkedin/.test(platLabel)) platform = 'linkedin';
    else if (/bluesky|bsky/.test(platLabel)) platform = 'bluesky';
    else if (/reddit/.test(platLabel)) platform = 'reddit';
    else if (/mastodon/.test(platLabel)) platform = 'mastodon';
    else if (/youtube/.test(platLabel)) platform = 'youtube';
    else if (/threads/.test(platLabel)) platform = 'threads';
    else if (/github/.test(platLabel)) platform = 'github';
    // Split on commas / "and" / whitespace+@ so multi-handle lines work.
    const tokens = rest
      .replace(/\(channelId:[^)]+\)/gi, '')
      .replace(/\(@[^)]+\)/g, (s) => ' ' + s.replace(/[()]/g, '') + ' ')
      .split(/[,;]| and |\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    for (const tokRaw of tokens) {
      // Strip trailing punctuation, parens, common URL noise.
      let tok = tokRaw.replace(/[)\].,;:]+$/g, '').replace(/^[(\[]+/g, '');
      if (!tok) continue;
      if (/^https?:\/\//i.test(tok)) {
        // Try to pull a handle from a profile URL.
        const url = tok;
        const mh = url.match(/(?:twitter\.com|x\.com)\/@?([^/?#]+)/i);
        const ml = url.match(/linkedin\.com\/(?:in|company)\/([^/?#]+)/i);
        const mb = url.match(/bsky\.app\/profile\/([^/?#]+)/i);
        const mr = url.match(/reddit\.com\/(?:user|u)\/([^/?#]+)/i);
        const my = url.match(/youtube\.com\/(?:@([^/?#]+)|c\/([^/?#]+)|user\/([^/?#]+))/i);
        const mg = url.match(/github\.com\/([^/?#]+)/i);
        if (mh) { tok = mh[1]; platform = 'x'; }
        else if (ml) { tok = ml[1]; platform = 'linkedin'; }
        else if (mb) { tok = mb[1]; platform = 'bluesky'; }
        else if (mr) { tok = mr[1]; platform = 'reddit'; }
        else if (my) { tok = my[1] || my[2] || my[3]; platform = 'youtube'; }
        else if (mg) { tok = mg[1]; platform = 'github'; }
        else continue;
      }
      // Strip platform-specific prefixes.
      tok = tok.replace(/^u\//i, '').replace(/^r\//i, '').replace(/^@+/, '');
      // Bluesky handles often look like name.bsky.social — keep the
      // left-hand label as the handle.
      if (platform === 'bluesky' && tok.includes('.')) tok = tok.split('.')[0];
      if (!tok || /^none$/i.test(tok)) continue;
      const handle = tok.toLowerCase();
      const key = `${platform}::${handle}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ platform, handle });
    }
  }
  return out;
}

export async function unmuteMany(reportsDir, keys) {
  const state = await loadMuted(reportsDir);
  let removed = 0;
  for (const k of Array.isArray(keys) ? keys : []) {
    if (k && state.items[k]) {
      delete state.items[k];
      removed++;
    }
  }
  await saveMuted(reportsDir, state);
  return { state, removed };
}

// Test if a conversation row is muted by the current state. Matches
// either an exact platform+handle entry or a cross-platform (platform
// = '*') entry on the same handle.
export function isMutedConv(state, conv) {
  if (!state || !state.items || !conv) return false;
  const handle = normHandle(conv.author);
  if (!handle) return false;
  const platform = normPlatform(conv.platform);
  return !!(state.items[`${platform}::${handle}`] || state.items[`*::${handle}`]);
}

export function mutedInfoForConv(state, conv) {
  if (!state || !state.items || !conv) return null;
  const handle = normHandle(conv.author);
  if (!handle) return null;
  const platform = normPlatform(conv.platform);
  return state.items[`${platform}::${handle}`] || state.items[`*::${handle}`] || null;
}

export function isNoTriageInfo(info) {
  if (!info || typeof info !== 'object') return false;
  return !!info.noTriage || info.reason === NO_TRIAGE_REASON;
}

export function isNoTriageConv(state, conv) {
  return isNoTriageInfo(mutedInfoForConv(state, conv));
}
