#!/usr/bin/env node
// Content Scout — Browser Scan
// Drives Microsoft Edge to scrape X, LinkedIn, and Reddit search results
// from the logged-in UI. Writes normalized JSON sidecars that `scout scan`
// ingests as Layer 0.
//
// Default mode is CDP attach: you start Edge yourself with
//   node tools/browser-scan/launch-edge.mjs
// then run scans against that running Edge. This is the only reliable way
// to log in to X (X actively flags fresh Playwright profiles).
//
// Commands:
//   node index.mjs launch                            # spawn Edge with debug port + login tabs
//   node index.mjs scan --slug <slug>                # CDP attach by default
//   node index.mjs scan --slug <slug> --mode launch  # legacy: Playwright launches its own profile
//   node index.mjs login --platform x|linkedin|reddit   # legacy launch-mode helper (NOT recommended)
//
// See README.md for the full flow.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanX, openXLogin } from './platforms/x.mjs';
import { scanLinkedIn, openLinkedInLogin } from './platforms/linkedin.mjs';
import { scanReddit, openRedditLogin } from './platforms/reddit.mjs';
import { loadConfig } from './lib/config.mjs';
import { ensureProfileDir, launchEdge, attachEdge, newPage } from './lib/browser.mjs';
import { filterHiring } from './lib/hiring-filter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// ---- arg parsing ----
const argv = process.argv.slice(2);
const command = argv[0];
const flags = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { flags[key] = next; i++; }
    else flags[key] = true;
  }
}

const PLATFORMS = ['x', 'linkedin', 'reddit'];
const DEFAULT_CDP_PORT = 9222;

function usageAndExit(code = 1) {
  console.error(`
Content Scout — Browser Scan

Usage:
  node index.mjs launch [--port 9222] [--use-default-profile]
      Spawn Edge with --remote-debugging-port enabled and open the three
      login tabs. Sign in once; leave Edge running.

  node index.mjs scan --slug <slug>
                      [--platforms x,linkedin,reddit]
                      [--mode cdp|launch]              (default: cdp)
                      [--port 9222]                    (cdp port)
                      [--days 30] [--max-per-term 25] [--headed]

  node index.mjs login --platform x|linkedin|reddit    (LEGACY launch-mode only)

Examples:
  node index.mjs launch
  node index.mjs scan --slug azure-cosmos-db
  node index.mjs scan --slug azure-cosmos-db --platforms linkedin
  node index.mjs scan --slug azure-cosmos-db --mode launch --headed
`);
  process.exit(code);
}

if (!command) usageAndExit();

// ---- launch command (delegates to launch-edge.mjs) ----
if (command === 'launch') {
  const launcherPath = path.join(__dirname, 'launch-edge.mjs');
  const childArgs = [launcherPath];
  if (flags.port) { childArgs.push('--port', String(flags.port)); }
  if (flags['use-default-profile']) { childArgs.push('--use-default-profile'); }
  const child = spawn(process.execPath, childArgs, { stdio: 'inherit' });
  child.on('exit', (c) => process.exit(c ?? 0));
} else if (command === 'login') {
  // ---- login (legacy launch-mode helper) ----
  const platform = String(flags.platform || '').toLowerCase();
  if (!PLATFORMS.includes(platform)) {
    console.error(`Unknown platform: ${platform}. Use one of: ${PLATFORMS.join(', ')}`);
    process.exit(1);
  }
  console.warn('[browser-scan] WARNING: `login` uses the legacy launch-mode profile, which X frequently refuses to log in to.');
  console.warn('[browser-scan] Recommended instead: run `node index.mjs launch` and sign in there once. Then `scan` (default --mode cdp).');
  const profileDir = ensureProfileDir(__dirname, platform);
  console.log(`[browser-scan] Opening Edge with persistent profile: ${profileDir}`);
  console.log(`[browser-scan] Sign in to ${platform}, then close the browser window.`);
  const handle = await launchEdge({ profileDir, headed: true });
  const browser = handle.browser;
  try {
    if (platform === 'x') await openXLogin(handle);
    else if (platform === 'linkedin') await openLinkedInLogin(handle);
    else if (platform === 'reddit') await openRedditLogin(handle);
    await new Promise((resolve) => browser.on('close', resolve));
  } finally {
    if (browser.isConnected && browser.isConnected()) await browser.close().catch(() => {});
  }
  console.log(`[browser-scan] Saved session for ${platform} to ${profileDir}`);
  process.exit(0);
} else if (command === 'scan') {
  // ---- scan ----
  const slug = String(flags.slug || '').trim();
  if (!slug) {
    console.error('--slug is required (matches scout-config-{slug}.prompt.md)');
    process.exit(1);
  }
  const requested = String(flags.platforms || PLATFORMS.join(','))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => PLATFORMS.includes(s));
  if (requested.length === 0) {
    console.error(`No valid platforms in --platforms. Use any of: ${PLATFORMS.join(', ')}`);
    process.exit(1);
  }
  const mode = (String(flags.mode || 'cdp').toLowerCase() === 'launch') ? 'launch' : 'cdp';
  const port = Number(flags.port || DEFAULT_CDP_PORT);
  const headed = !!flags.headed;
  const days = Number(flags.days || 30);
  const maxPerTerm = Number(flags['max-per-term'] || 25);

  const config = loadConfig(ROOT, slug);
  if (!config) {
    console.error(`No scout-config-${slug}.prompt.md found in .github/prompts/`);
    process.exit(1);
  }
  console.log(`[browser-scan] Loaded config "${slug}" — ${config.searchTerms.length} search terms, ${days}d window, mode=${mode}`);

  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const stamp = formatStamp(new Date());
  const outDir = path.join(ROOT, 'reports', '.browser-scan', slug);
  fs.mkdirSync(outDir, { recursive: true });

  // Per-scan meta sidecar — captures hiring-drop counts so the agent can
  // surface them in the report as "X hiring posts dropped" without ever
  // seeing the post bodies. Keyed by platform.
  const hiringDropped = {};
  // Per-month bucketing of dropped hiring items, keyed by YYYY-MM of the
  // post_date, then by platform. Lets the report quantify hiring-context
  // mentions for a given month as a market-demand signal. Items missing a
  // valid post_date are bucketed under "unknown".
  const hiringDroppedByMonth = {};

  // In CDP mode, attach ONCE and reuse the same context for all platforms —
  // the user is already logged in to all three in one Edge window.
  let sharedHandle = null;
  let sharedPage = null;
  if (mode === 'cdp') {
    try {
      sharedHandle = await attachEdge({ port });
      console.log(`[browser-scan] Attached to Edge over CDP at http://127.0.0.1:${port}`);
      // Open ONE tab and reuse it across all platforms / queries. This
      // replaces the old behaviour where each platform opened + closed its
      // own tab — the user used to see 3 tabs flicker in and out of their
      // attached browser per scan, which felt like the agent was thrashing
      // their session. With a shared tab we open once at the start and
      // close once at the end (or leave it open between scans — see
      // SCOUT_KEEP_SCAN_TAB).
      sharedPage = await newPage(sharedHandle);
      console.log('[browser-scan] Opened shared scan tab — will navigate in place across all platforms.');
    } catch (e) {
      console.error(`[browser-scan] ${e.message}`);
      process.exit(1);
    }
  }

  for (const platform of requested) {
    let handle = sharedHandle;
    let ownsHandle = false;
    if (mode === 'launch') {
      const profileDir = ensureProfileDir(__dirname, platform);
      if (!hasSession(profileDir)) {
        console.warn(`[browser-scan] ${platform}: no session in launch-mode profile — run "node index.mjs login --platform ${platform}" or switch to --mode cdp. Skipping.`);
        continue;
      }
      console.log(`[browser-scan] ${platform}: launching Edge (headed=${headed})…`);
      handle = await launchEdge({ profileDir, headed });
      ownsHandle = true;
    }

    let items = [];
    try {
      const ctx = {
        searchTerms: config.searchTerms,
        sinceMs,
        maxPerTerm,
        slug,
        // In CDP mode, hand the shared tab to the platform so it navigates
        // in place instead of opening + closing its own tab. In launch
        // mode each platform still owns its tab (separate Playwright
        // browser per platform).
        page: mode === 'cdp' ? sharedPage : undefined,
      };
      if (platform === 'x') items = await scanX(handle, ctx);
      else if (platform === 'linkedin') items = await scanLinkedIn(handle, ctx);
      else if (platform === 'reddit') items = await scanReddit(handle, ctx);
    } catch (e) {
      console.error(`[browser-scan] ${platform}: error — ${e.message}`);
    } finally {
      if (ownsHandle) await handle.browser.close().catch(() => {});
    }
    const outFile = path.join(outDir, `${stamp}-${platform}.json`);
    // Hard-drop hiring/recruiting/job-search posts before persisting the
    // sidecar. The agent prompt already says "drop hiring content from every
    // section", but in practice (especially on LinkedIn) recruiter posts
    // leak through into reports — enforcing it here means the agent never
    // even sees them. See lib/hiring-filter.mjs.
    const { kept, dropped } = filterHiring(items);
    if (dropped.length) hiringDropped[platform] = dropped.length;
    for (const it of dropped) {
      let bucket = 'unknown';
      const d = it && it.post_date ? new Date(it.post_date) : null;
      if (d && !Number.isNaN(d.getTime())) {
        bucket = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      }
      hiringDroppedByMonth[bucket] = hiringDroppedByMonth[bucket] || {};
      hiringDroppedByMonth[bucket][platform] = (hiringDroppedByMonth[bucket][platform] || 0) + 1;
    }
    fs.writeFileSync(outFile, JSON.stringify(kept, null, 2));
    const droppedNote = dropped.length ? ` (dropped ${dropped.length} hiring/recruiting)` : '';
    console.log(`[browser-scan] ${platform}: ${kept.length} items${droppedNote} → ${path.relative(ROOT, outFile)}`);
  }

  // Write the meta sidecar (always, even when zero drops, so absence of the
  // file means "no scan ran" rather than "scan ran but zeros").
  const totalDropped = Object.values(hiringDropped).reduce((a, b) => a + b, 0);
  const metaFile = path.join(outDir, `${stamp}-meta.json`);
  fs.writeFileSync(metaFile, JSON.stringify({
    stamp,
    slug,
    platforms: requested,
    hiringDropped,
    hiringDroppedTotal: totalDropped,
    hiringDroppedByMonth,
  }, null, 2));

  // In CDP mode we do NOT close the user's Edge — they own it. Just
  // disconnect. Close the shared scan tab unless the user asked us to keep
  // it (SCOUT_KEEP_SCAN_TAB=1) — handy when iterating so the cookies and
  // any half-loaded results stay around for inspection.
  if (sharedPage && !process.env.SCOUT_KEEP_SCAN_TAB) {
    await sharedPage.close().catch(() => {});
  }
  if (sharedHandle) await sharedHandle.browser.close().catch(() => {});

  console.log(`[browser-scan] Done. scout scan will pick up results from reports/.browser-scan/${slug}/ on its next run.`);
  process.exit(0);
} else {
  usageAndExit();
}

// ---- helpers ----
function formatStamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function hasSession(profileDir) {
  const cookiesPath = path.join(profileDir, 'Default', 'Cookies');
  try {
    const st = fs.statSync(cookiesPath);
    return st.size > 4096;
  } catch {
    return false;
  }
}
