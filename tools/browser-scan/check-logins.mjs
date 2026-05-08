#!/usr/bin/env node
// check-logins.mjs — verify you're signed in to X, LinkedIn, and Reddit
// in the running Edge instance (CDP attach on port 9222 by default).
//
// Usage: node tools/browser-scan/check-logins.mjs [--port 9222]
//
// For each platform it opens (or focuses) the relevant authenticated URL
// and reports whether Edge ended up on a login wall vs the real page.

import { chromium } from 'playwright';

const flags = { port: 9222 };
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') flags.port = Number(process.argv[++i] || 9222);
}

const PROBES = [
  {
    platform: 'x',
    url: 'https://x.com/home',
    loginPattern: /\/i\/flow\/login|\/login/,
    okPattern: /x\.com\/home|x\.com\/(?!i\/flow|login)/,
  },
  {
    platform: 'linkedin',
    url: 'https://www.linkedin.com/feed/',
    loginPattern: /\/login|\/checkpoint|\/uas\/login|authwall/,
    okPattern: /linkedin\.com\/feed/,
  },
  {
    platform: 'reddit',
    url: 'https://www.reddit.com/',
    loginPattern: /\/login\//,
    okPattern: /reddit\.com\/?($|\?|#)/,
  },
];

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${flags.port}`, { timeout: 5000 });
} catch (e) {
  console.error(`Could not attach to Edge on port ${flags.port}: ${e.message}`);
  console.error('Run `node tools/browser-scan/launch-edge.mjs` first.');
  process.exit(1);
}
const ctx = browser.contexts()[0];
if (!ctx) {
  console.error('Edge has no contexts. Open a tab and re-run.');
  process.exit(1);
}

const results = [];
for (const probe of PROBES) {
  const page = await ctx.newPage();
  try {
    await page.goto(probe.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Give SPA frameworks a moment to redirect to /login if no session.
    await page.waitForTimeout(2500);
    const finalUrl = page.url();
    const onLogin = probe.loginPattern.test(finalUrl);
    const onOk = probe.okPattern.test(finalUrl);
    let status;
    if (onLogin) status = 'NOT SIGNED IN';
    else if (onOk) status = 'OK';
    else status = `unclear (final URL: ${finalUrl})`;
    results.push({ platform: probe.platform, status, finalUrl });
  } catch (e) {
    results.push({ platform: probe.platform, status: `error: ${e.message}`, finalUrl: '-' });
  } finally {
    await page.close().catch(() => {});
  }
}

await browser.close().catch(() => {}); // disconnects, doesn't kill Edge

const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
console.log('');
console.log(pad('Platform', 12) + pad('Status', 18) + 'Final URL');
console.log(pad('--------', 12) + pad('------', 18) + '---------');
for (const r of results) {
  const tag =
    r.status === 'OK' ? '\x1b[32mOK\x1b[0m              ' :
    r.status.startsWith('NOT') ? '\x1b[31mNOT SIGNED IN\x1b[0m   ' :
    `\x1b[33m${r.status}\x1b[0m   `;
  console.log(pad(r.platform, 12) + tag + r.finalUrl);
}
console.log('');
const allOk = results.every((r) => r.status === 'OK');
if (allOk) {
  console.log('\x1b[32mAll three sessions look good. You can run a scan:\x1b[0m');
  console.log('  node tools/browser-scan/index.mjs scan --slug <your-slug>');
  process.exit(0);
} else {
  console.log('\x1b[33mSign in to the platforms marked NOT SIGNED IN, then re-run this script.\x1b[0m');
  process.exit(1);
}
