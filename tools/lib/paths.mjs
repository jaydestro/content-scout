// Central path resolver for Content Scout.
//
// All "personal to this user" artifacts live under a single gitignored
// `.local/` directory at the repo root. Everything else stays in the
// repo so the project remains a clean, general-purpose template.
//
// Layout (current scope: configs + state — reports/social-posts stay
// where they are for now since they're already gitignored and dozens of
// docs/prompts reference those paths):
//
//   .local/
//   ├── configs/scout-config-{slug}.md      (was .github/prompts/scout-config-*.prompt.md)
//   ├── team-members.md                     (was .github/team-members.md)
//   └── state/
//       ├── seen-links.json                 (was reports/.seen-links.json)
//       ├── closed-conversations.json
//       ├── muted-accounts.json
//       ├── sentiment-overrides.json
//       ├── cached-bodies.json
//       ├── web-settings.json
//       ├── scout-state/                    (was reports/.scout-state/)
//       ├── scan-prompts/                   (was reports/.scan-prompts/)
//       ├── browser-scan/                   (was reports/.browser-scan/)
//       ├── browser-profile/                (was tools/browser-scan/.cdp-profile/)
//       └── mcp-config.json
//
// Back-compat shim: readers prefer `.local/state/{name}` if present,
// otherwise fall back to the legacy location. Writers always go to
// `.local/state/`. First write to any state file naturally migrates it.
//
// Override via env var SCOUT_LOCAL_ROOT (advanced/testing only).
//
// `.env` intentionally stays at the repo root — every dotenv loader
// expects it there.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// tools/lib/paths.mjs → repo root is two levels up
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const LOCAL_ROOT =
  process.env.SCOUT_LOCAL_ROOT && process.env.SCOUT_LOCAL_ROOT.trim()
    ? path.resolve(process.env.SCOUT_LOCAL_ROOT)
    : path.join(REPO_ROOT, '.local');

export const STATE_DIR = path.join(LOCAL_ROOT, 'state');
export const CONFIGS_DIR = path.join(LOCAL_ROOT, 'configs');
export const BRAND_DIR = path.join(LOCAL_ROOT, 'brand');

// State sub-paths
export const SCOUT_STATE_DIR = path.join(STATE_DIR, 'scout-state');
export const SCAN_PROMPTS_DIR = path.join(STATE_DIR, 'scan-prompts');
export const BROWSER_SCAN_DIR = path.join(STATE_DIR, 'browser-scan');
export const BROWSER_PROFILE_DIR = path.join(STATE_DIR, 'browser-profile');

// Named state files
export const SEEN_LINKS_FILE = 'seen-links.json';
export const CLOSED_CONVERSATIONS_FILE = 'closed-conversations.json';
export const MUTED_ACCOUNTS_FILE = 'muted-accounts.json';
export const SENTIMENT_OVERRIDES_FILE = 'sentiment-overrides.json';
export const CACHED_BODIES_FILE = 'cached-bodies.json';
export const WEB_SETTINGS_FILE = 'web-settings.json';

// Legacy file names (used by back-compat shim — these were dotfiles
// inside reports/).
const LEGACY_NAMES = Object.freeze({
  [SEEN_LINKS_FILE]: '.seen-links.json',
  [CLOSED_CONVERSATIONS_FILE]: '.closed-conversations.json',
  [MUTED_ACCOUNTS_FILE]: '.muted-accounts.json',
  [SENTIMENT_OVERRIDES_FILE]: '.sentiment-overrides.json',
  [CACHED_BODIES_FILE]: '.cached-bodies.json',
});

export const LEGACY_REPORTS_DIR = path.join(REPO_ROOT, 'reports');
export const LEGACY_BROWSER_PROFILE_DIR = path.join(
  REPO_ROOT, 'tools', 'browser-scan', '.cdp-profile',
);
export const LEGACY_SCOUT_STATE_DIR = path.join(LEGACY_REPORTS_DIR, '.scout-state');
export const LEGACY_SCAN_PROMPTS_DIR = path.join(LEGACY_REPORTS_DIR, '.scan-prompts');
export const LEGACY_BROWSER_SCAN_DIR = path.join(LEGACY_REPORTS_DIR, '.browser-scan');

// Returns the canonical (new) path for a named state file.
export function stateFilePath(name) {
  return path.join(STATE_DIR, name);
}

// Returns the legacy path for a state file, given a "legacy reports dir"
// (callers historically passed REPORTS_DIR). The legacy file name has a
// leading dot.
export function legacyStateFilePath(legacyDir, name) {
  const legacyName = LEGACY_NAMES[name];
  if (!legacyName) return null;
  return path.join(legacyDir || LEGACY_REPORTS_DIR, legacyName);
}

// Resolve where to READ a named state file from. Prefers .local/state,
// falls back to legacy dotfile under `legacyDir` (typically REPORTS_DIR).
// Returns null when neither exists.
export async function resolveStateRead(name, legacyDir = LEGACY_REPORTS_DIR) {
  const fresh = stateFilePath(name);
  try {
    await fs.access(fresh);
    return fresh;
  } catch {}
  const legacy = legacyStateFilePath(legacyDir, name);
  if (!legacy) return null;
  try {
    await fs.access(legacy);
    return legacy;
  } catch {}
  return null;
}

// Resolve where to WRITE a named state file. Always .local/state/{name}.
// Ensures STATE_DIR exists.
export async function resolveStateWrite(name) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  return stateFilePath(name);
}

// Convenience: ensure STATE_DIR exists (for callers that manage their
// own file naming).
export async function ensureStateDir() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  return STATE_DIR;
}

// --- Browser-scan sidecar directories -------------------------------
// Sidecars are organized per-slug. Readers should consult BOTH the new
// (.local/state/browser-scan/{slug}) and legacy (reports/.browser-scan/
// {slug}) directories and merge. Writers always use the new location.

export function browserScanSlugDir(slug) {
  return path.join(BROWSER_SCAN_DIR, slug);
}

export function legacyBrowserScanSlugDir(slug) {
  return path.join(LEGACY_BROWSER_SCAN_DIR, slug);
}

// Returns up to two dir paths to read browser-scan sidecars from for the
// given slug — new first (higher priority), then legacy. Caller should
// iterate both and dedup by filename or canonical URL.
export function browserScanReadDirs(slug) {
  return [browserScanSlugDir(slug), legacyBrowserScanSlugDir(slug)];
}

// Resolve write dir for a browser-scan slug. Ensures the dir exists.
export async function resolveBrowserScanWriteDir(slug) {
  const dir = browserScanSlugDir(slug);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
