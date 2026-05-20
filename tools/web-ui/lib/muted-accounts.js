// Persistent "muted accounts" list for Conversations & mentions.
//
// Hides every conversation row authored by a muted handle so noisy
// accounts (recruiters, spammers, off-topic creators) don't clutter the
// inbox. State lives at <repo>/reports/.muted-accounts.json and is
// shared by the web UI and the local helper command (tools/conversations-cli.mjs).
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

function normalizePlatformLabel(label) {
  const platLabel = String(label || '').trim().toLowerCase();
  if (/twitter|x\b|x\/twitter|^x$/.test(platLabel)) return 'x';
  if (/linkedin/.test(platLabel)) return 'linkedin';
  if (/bluesky|bsky/.test(platLabel)) return 'bluesky';
  if (/reddit/.test(platLabel)) return 'reddit';
  if (/mastodon/.test(platLabel)) return 'mastodon';
  if (/youtube/.test(platLabel)) return 'youtube';
  if (/threads/.test(platLabel)) return 'threads';
  if (/github/.test(platLabel)) return 'github';
  if (/devto|dev\.to/.test(platLabel)) return 'devto';
  if (/medium/.test(platLabel)) return 'medium';
  if (/hn|hacker\s*news/.test(platLabel)) return 'hn';
  if (/stackoverflow|stack\s*overflow/.test(platLabel)) return 'stackoverflow';
  return platLabel;
}

function handleFromProfileUrl(url, fallbackPlatform = '') {
  const mh = url.match(/(?:twitter\.com|x\.com)\/@?([^/?#]+)/i);
  const ml = url.match(/linkedin\.com\/(?:in|company)\/([^/?#]+)/i);
  const mb = url.match(/bsky\.app\/profile\/([^/?#]+)/i);
  const mr = url.match(/reddit\.com\/(?:user|u)\/([^/?#]+)/i);
  const my = url.match(/youtube\.com\/(?:@([^/?#]+)|c\/([^/?#]+)|user\/([^/?#]+))/i);
  const mg = url.match(/github\.com\/([^/?#]+)/i);
  if (mh) return { platform: 'x', handle: mh[1] };
  if (ml) return { platform: 'linkedin', handle: ml[1] };
  if (mb) return { platform: 'bluesky', handle: mb[1] };
  if (mr) return { platform: 'reddit', handle: mr[1] };
  if (my) return { platform: 'youtube', handle: my[1] || my[2] || my[3] };
  if (mg) return { platform: 'github', handle: mg[1] };
  return { platform: fallbackPlatform, handle: '' };
}

function cleanParsedHandle(platform, handle) {
  let tok = String(handle || '').trim().replace(/[)\].,;:]+$/g, '').replace(/^[(\[]+/g, '');
  if (!tok || /^none$/i.test(tok)) return '';
  if (/^https?:\/\//i.test(tok)) {
    const parsed = handleFromProfileUrl(tok, platform);
    platform = parsed.platform || platform;
    tok = parsed.handle;
  }
  tok = String(tok || '').trim().replace(/^u\//i, '').replace(/^r\//i, '').replace(/^@+/, '').replace(/^\/in\//i, '');
  if (platform === 'bluesky' && tok.includes('.')) tok = tok.split('.')[0];
  return tok ? tok.toLowerCase() : '';
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
    let platform = normalizePlatformLabel(platLabel);
    // Split on commas / "and" / whitespace+@ so multi-handle lines work.
    const tokens = rest
      .replace(/\(channelId:[^)]+\)/gi, '')
      .replace(/\(@[^)]+\)/g, (s) => ' ' + s.replace(/[()]/g, '') + ' ')
      .split(/[,;]| and |\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    for (const tokRaw of tokens) {
      let tok = tokRaw.replace(/[)\].,;:]+$/g, '').replace(/^[(\[]+/g, '');
      if (!tok) continue;
      if (/^https?:\/\//i.test(tok)) {
        // Try to pull a handle from a profile URL.
        const parsed = handleFromProfileUrl(tok, platform);
        if (!parsed.handle) continue;
        tok = parsed.handle;
        platform = parsed.platform || platform;
      }
      const handle = cleanParsedHandle(platform, tok);
      if (!handle) continue;
      const key = `${platform}::${handle}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ platform, handle });
    }
  }
  return out;
}

function stripHtmlComments(text) {
  return String(text || '').replace(/<!--[\s\S]*?-->/g, '');
}

function sectionBlock(text, headingPattern) {
  const escaped = String(headingPattern || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?:^|\\r?\\n)\\s*#{1,6}\\s*${escaped}[^\\n]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n\\s*#{1,6}\\s|\\r?\\n-{3,}\\s*\\r?\\n|$)`,
    'i'
  );
  const m = String(text || '').match(re);
  return m ? m[1] : '';
}

function addAccount(out, seen, platform, handle, name = '') {
  const cleanPlatform = normalizePlatformLabel(platform || '');
  const cleanHandle = cleanParsedHandle(cleanPlatform, handle);
  if (!cleanHandle) return;
  const key = `${cleanPlatform || '*'}::${cleanHandle}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ platform: cleanPlatform || '', handle: cleanHandle, name: String(name || '').trim() });
}

function parseAliasList(aliasText, displayName, out, seen) {
  const aliasRe = /([a-z][a-z0-9 .\/-]*?)\s*:\s*([^,;)]+)/gi;
  let m;
  while ((m = aliasRe.exec(aliasText))) {
    addAccount(out, seen, m[1], m[2], displayName);
  }
  const urlRe = /https?:\/\/\S+/gi;
  while ((m = urlRe.exec(aliasText))) {
    const parsed = handleFromProfileUrl(m[0]);
    addAccount(out, seen, parsed.platform, parsed.handle, displayName);
  }
}

// Parse product-team people from a config into account handles that can be
// imported as no-triage. Name-only entries are intentionally skipped because
// the conversations inbox matches accounts by handle, not display name.
export function parseTeamMemberAccountsFromConfig(raw) {
  const out = [];
  const seen = new Set();
  const text = stripHtmlComments(raw);
  const block = sectionBlock(text, 'Product Team Members');
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.replace(/^[-*\s]+/, '').trim();
    if (!line || /^none$/i.test(line)) continue;
    const parens = [...line.matchAll(/\(([^)]*)\)/g)];
    if (!parens.length) continue;
    const displayName = line.replace(/\([^)]*\)/g, '').replace(/[—-].*$/, '').trim();
    for (const p of parens) parseAliasList(p[1], displayName, out, seen);
  }

  const posting = text.match(/\*\*Team members to tag:\*\*\s*([^\n]+)/i);
  if (posting && !/^none\s*$/i.test(posting[1].trim())) {
    const line = posting[1];
    parseAliasList(line, '', out, seen);
    const handleRe = /(^|[\s,;])@([a-z0-9_.-]+)/gi;
    let m;
    while ((m = handleRe.exec(line))) addAccount(out, seen, '', m[2], '');
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
