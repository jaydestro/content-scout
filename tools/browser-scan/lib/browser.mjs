// Browser launcher — Microsoft Edge.
//
// Two modes:
//   1. CDP attach (RECOMMENDED): connect to a real Edge window the user
//      launched themselves with `--remote-debugging-port=9222`. The scanner
//      drives that real session — no separate profile, no automation
//      fingerprint, no separate login. Works with passkeys, 2FA, and the
//      anti-bot heuristics on X / LinkedIn / Reddit that flag fresh
//      Playwright contexts.
//   2. Persistent profile (fallback): Playwright launches its own Edge with
//      a profile dir under `tools/browser-scan/.profile/{platform}/`.
//      Faster to set up, but X in particular often refuses to log in here.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

export function ensureProfileDir(scanRoot, platform) {
  const dir = path.join(scanRoot, '.profile', platform);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Connect to a running Edge instance over the Chrome DevTools Protocol.
 * The user must have launched Edge with `--remote-debugging-port={port}`
 * (see tools/browser-scan/launch-edge.mjs).
 *
 * Returns a { browser, context } where `context` is the existing default
 * context (so cookies / login state from the user's real Edge are reused).
 */
export async function attachEdge({ port = 9222, timeout } = {}) {
  const endpoint = `http://127.0.0.1:${port}`;
  // Per-attempt timeout. Override with SCOUT_CDP_TIMEOUT_MS for a heavily
  // loaded browser (many tabs/extensions take longer to enumerate).
  const baseTimeout = Number(timeout || process.env.SCOUT_CDP_TIMEOUT_MS || 30000);

  // connectOverCDP auto-attaches to EVERY existing page target. A single
  // frozen / sleeping tab (Chrome/Edge memory-saver) can stall the whole
  // enumeration past the timeout, even though the browser itself is fine.
  // The first attach actually *resumes* those renderers as it attaches, so
  // a second attempt frequently succeeds where the first timed out. We try
  // up to twice, widening the timeout on the retry, before giving up.
  const maxAttempts = 2;
  let browser = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptTimeout = attempt === 1 ? baseTimeout : Math.round(baseTimeout * 1.5);
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: attemptTimeout });
      break;
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e);
      const enumerationHang = /Timeout\s+\d+ms exceeded/i.test(msg);
      // Only retry the enumeration-hang case — a real "browser not running"
      // (ECONNREFUSED) won't fix itself, and the caller (server preflight)
      // already polls for the port coming up before calling us.
      if (enumerationHang && attempt < maxAttempts) {
        console.warn(
          `[browser-scan] CDP attach timed out enumerating tabs (attempt ${attempt}/${maxAttempts}); ` +
          `the attach may have woken sleeping tabs — retrying with a longer timeout…`,
        );
        await sleep(2000);
        continue;
      }
      break;
    }
  }

  if (!browser) {
    const msg = String(lastErr && lastErr.message ? lastErr.message : lastErr);
    const enumerationHang = /Timeout\s+\d+ms exceeded/i.test(msg);
    if (enumerationHang) {
      throw new Error(
        `Connected to the CDP browser on port ${port} but could not read its tabs after ${maxAttempts} attempts. ` +
        `This means the browser has sleeping/frozen tabs or too many open tabs (often your everyday browser with lots of tabs + extensions), ` +
        `so a tab's debugging target stopped responding. ` +
        `Most reliable fix: fully quit that browser, then run \`node tools/browser-scan/launch-edge.mjs\` — it opens a clean dedicated profile with only the login tabs and tab-sleep disabled. ` +
        `Or, in the current window: bring it to the foreground (wakes sleeping tabs), close extra tabs so only the login tabs remain, and re-run. ` +
        `You can also raise the per-attempt timeout via SCOUT_CDP_TIMEOUT_MS. Underlying error: ${msg}`
      );
    }
    throw new Error(
      `Could not connect to Edge over CDP at ${endpoint} — is Edge running with --remote-debugging-port=${port}? ` +
      `Start it with: node tools/browser-scan/launch-edge.mjs   (then sign in to the platforms once). ` +
      `Underlying error: ${msg}`
    );
  }
  // connectOverCDP returns a Browser whose contexts() is the user's real
  // browsing contexts. Use the first non-empty one (Edge always has at
  // least the default context).
  const contexts = browser.contexts();
  const context = contexts[0];
  if (!context) {
    throw new Error('Edge is reachable but exposes no browser contexts — open at least one tab in the Edge window first.');
  }
  // Add a couple of niceties to match launch mode
  context.setDefaultNavigationTimeout(45000);
  context.setDefaultTimeout(20000);
  return { browser, context, mode: 'cdp' };
}

/**
 * Persistent-profile launch (fallback). Returns the same shape as
 * attachEdge so callers can be mode-agnostic.
 */
export async function launchEdge({ profileDir, headed = false }) {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'msedge',
    headless: !headed,
    viewport: { width: 1400, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
  if (typeof ctx.isConnected !== 'function') {
    let closed = false;
    ctx.on('close', () => { closed = true; });
    ctx.isConnected = () => !closed;
  }
  // Return the same { browser, context } shape so platform scrapers can
  // treat both modes uniformly. In persistent mode, the launched object
  // IS the context; we expose it as both.
  return { browser: ctx, context: ctx, mode: 'launch' };
}

export async function newPage(handle) {
  // `handle` is the { context } from attachEdge/launchEdge, or the raw
  // context for back-compat.
  const ctx = handle.context || handle;
  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(45000);
  page.setDefaultTimeout(20000);
  return page;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

