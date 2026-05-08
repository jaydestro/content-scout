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
export async function attachEdge({ port = 9222 } = {}) {
  const endpoint = `http://127.0.0.1:${port}`;
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
  } catch (e) {
    throw new Error(
      `Could not connect to Edge over CDP at ${endpoint} — is Edge running with --remote-debugging-port=${port}? ` +
      `Start it with: node tools/browser-scan/launch-edge.mjs   (then sign in to the platforms once). ` +
      `Underlying error: ${e.message}`
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

