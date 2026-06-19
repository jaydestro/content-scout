#!/usr/bin/env node
// Launch a Chromium-family browser with the Chrome DevTools Protocol
// enabled, so the browser-scan tool can attach over CDP and reuse the
// real session (cookies, passkeys, 2FA).
//
// Browser selection (in order):
//   1. --browser flag if passed
//   2. The OS's default browser, if it's Chromium-family (Edge / Chrome /
//      Brave / Vivaldi / Arc / Opera)
//   3. Fallback to whichever Chromium-family browser is installed
//
// Firefox / Safari are NOT supported because Playwright's connectOverCDP
// doesn't speak Firefox's remote debugging protocol and Safari has no
// remote debugging endpoint at all. If your default is Firefox, this
// script will fall back to Edge (or another Chromium-family browser) for
// the *browser-scan window only* — your real default stays untouched.
//
// Usage:
//   node launch-edge.mjs                        # auto-detect default; port 9222
//   node launch-edge.mjs --port 9333
//   node launch-edge.mjs --browser "Google Chrome"
//   node launch-edge.mjs --use-default-profile  # share your real Chrome profile
//   node launch-edge.mjs --list                 # show detected browsers + exit
//
// IMPORTANT: by default this launches with a DEDICATED user-data-dir
// at `.local/state/browser-profile/` (gitignored). You sign in once;
// the session sticks across runs. The script's name is historical — it
// now launches whichever Chromium-family browser fits, not just Edge.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBrowser, listKnownBrowsers } from './lib/browser-detect.mjs';
import { BROWSER_PROFILE_DIR, LEGACY_BROWSER_PROFILE_DIR } from '../lib/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const flags = { port: 9222, 'use-default-profile': false, browser: null, list: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') { flags.port = Number(argv[++i] || 9222); }
  else if (a === '--use-default-profile') { flags['use-default-profile'] = true; }
  else if (a === '--browser') { flags.browser = String(argv[++i] || ''); }
  else if (a === '--list') { flags.list = true; }
  else if (a === '--help' || a === '-h') {
    console.log(`Usage: node launch-edge.mjs [--port 9222] [--browser "Name"] [--use-default-profile] [--list]`);
    process.exit(0);
  }
}

if (flags.list) {
  console.log('[launch-edge] Known browsers on this OS:');
  for (const b of listKnownBrowsers()) {
    const tag = b.kind === 'chromium' ? '✓ supported' : (b.kind === 'firefox' ? '✗ Firefox (no CDP)' : '✗ unsupported');
    const inst = b.installed ? 'installed' : 'not installed';
    console.log(`  ${b.name.padEnd(22)} [${tag}, ${inst}]`);
  }
  process.exit(0);
}

// Browser selection priority:
//   1. --browser flag         (explicit — hard requirement; error if missing)
//   2. SCOUT_BROWSER env var   (soft preference; falls back to OS default if
//                               that browser isn't installed)
//   3. OS default browser
// The CDP profile is a dedicated, isolated profile, so preferring a
// specific browser here never touches your everyday browsing.
const explicitBrowser = flags.browser || null;
const envBrowser = (process.env.SCOUT_BROWSER || '').trim() || null;
let pick = pickBrowser({ preferred: explicitBrowser || envBrowser });
if (!pick.ok && !explicitBrowser && envBrowser) {
  // The env-var preference isn't usable (e.g. Edge not installed on this
  // machine). Don't fail the launch — fall back to the OS default browser.
  console.warn(`[launch-edge] SCOUT_BROWSER="${envBrowser}" not usable (${pick.error}) — falling back to the default browser.`);
  pick = pickBrowser({});
}
if (!pick.ok) {
  console.error(`[launch-edge] ${pick.error}`);
  process.exit(1);
}
const { browser, notice, source } = pick;
if (notice) {
  console.warn(`[launch-edge] ${notice}`);
}
console.log(`[launch-edge] Browser: ${browser.name} (${source}) — ${browser.path}`);

const args = [`--remote-debugging-port=${flags.port}`];

// Keep every tab responsive to CDP for the whole lifetime of the window.
// This browser is meant to be left running between scans, so the
// browser's memory-saver features (Edge "sleeping tabs", renderer
// backgrounding, background timer throttling, occlusion-based freezing)
// would otherwise freeze the idle login tabs. A frozen tab's CDP target
// stops answering attach/enable, which makes Playwright's connectOverCDP
// finish the WebSocket handshake and then hang on post-handshake target
// enumeration until it times out (symptom: "<ws connected>" followed by a
// 30s Timeout). Disabling these keeps the attach fast and reliable.
// Unknown feature tokens are ignored by Chromium, so this is safe across
// Edge / Chrome / Brave / Vivaldi / Arc / Opera.
args.push(
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,HighEfficiencyModeAvailable,TabFreezeAndDiscard,ProactiveTabFreezeAndDiscard',
);

if (!flags['use-default-profile']) {
  // Prefer the canonical .local/state/browser-profile, but if the user
  // already has a populated legacy .cdp-profile (signed-in cookies), keep
  // using it to avoid forcing a re-login.
  let cdpProfileDir = BROWSER_PROFILE_DIR;
  if (
    !fs.existsSync(BROWSER_PROFILE_DIR) &&
    fs.existsSync(LEGACY_BROWSER_PROFILE_DIR)
  ) {
    cdpProfileDir = LEGACY_BROWSER_PROFILE_DIR;
  }
  fs.mkdirSync(cdpProfileDir, { recursive: true });
  args.push(`--user-data-dir=${cdpProfileDir}`);
  console.log(`[launch-edge] Using dedicated CDP profile: ${cdpProfileDir}`);
} else {
  console.log(`[launch-edge] Using your DEFAULT ${browser.name} profile. Close all other ${browser.name} windows first or this will fail.`);
}

// Open the login / landing pages so the user can sign in once.
// (Google News works anonymously, but we open it so personalization can
// be enabled by signing in if the user wants. Microsoft Tech Community
// content is behind a sign-in wall, so sign in there to let the
// content-sites scanner read it; DZone / C# Corner / Hashnode need no
// login.)
args.push(
  'https://x.com/login',
  'https://www.linkedin.com/login',
  'https://www.reddit.com/login/',
  'https://news.google.com/',
  'https://techcommunity.microsoft.com/'
);

console.log(`[launch-edge] Debug port: ${flags.port}`);
console.log(`[launch-edge] Sign in to X, LinkedIn, Reddit, and Microsoft Tech Community in the window that just opened. Google News, DZone, C# Corner, and Hashnode work without sign-in.`);
console.log(`[launch-edge] Once signed in, leave the browser running and start a scan in another terminal:`);
console.log(`[launch-edge]   node tools/browser-scan/index.mjs scan --slug <your-slug>`);
console.log(`[launch-edge] (the scanner attaches over CDP and reuses these sessions)`);

const child = spawn(browser.path, args, {
  detached: false,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', (code) => {
  console.log(`[launch-edge] ${browser.name} exited with code ${code ?? 0}.`);
  process.exit(code ?? 0);
});

process.on('SIGINT', () => { try { child.kill('SIGINT'); } catch { /* ignore */ } });
process.on('SIGTERM', () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } });
