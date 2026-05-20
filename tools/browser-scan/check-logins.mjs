#!/usr/bin/env node
// check-logins.mjs — verify you're signed in to X, LinkedIn, and Reddit
// in the running Edge instance (CDP attach on port 9222 by default).
//
// Usage: node tools/browser-scan/check-logins.mjs [--port 9222]
//
// For each platform it opens (or focuses) the relevant authenticated URL
// and reports whether Edge ended up on a login wall vs the real page.

import { chromium } from 'playwright';

const flags = { port: 9222, json: false };
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') flags.port = Number(process.argv[++i] || 9222);
  else if (process.argv[i] === '--json') flags.json = true;
}

const PROBES = [
  {
    platform: 'x',
    url: 'https://x.com/home',
    // Path-anchored login patterns — must be followed by /, ?, #, or end-of-string
    // so things like `/feed/login-celebrations` don't false-positive.
    loginPattern: /\/(?:i\/flow\/login|login)(?:[\/?#]|$)/,
    okPattern: /x\.com\/home|x\.com\/(?!i\/flow|login)/,
    // CSS selector that only exists when signed in (Home column nav).
    okSelector: 'a[href="/home"][aria-label*="Home"]',
  },
  {
    platform: 'linkedin',
    url: 'https://www.linkedin.com/feed/',
    // LinkedIn only sends truly-signed-out users to /authwall, /login,
    // or /uas/login. /checkpoint/ is a signed-in-but-needs-verification
    // state (new device, 2FA, identity challenge) — cookies are valid,
    // the user just has to complete the prompt. Report it separately so
    // we don't tell them to "sign in again" when they already have.
    loginPattern: /\/(?:login|uas\/login|authwall)(?:[\/?#]|$)/,
    verificationPattern: /\/checkpoint(?:[\/?#]|$)/,
    okPattern: /linkedin\.com\/feed/,
    // The "Me" avatar in the global nav exists ONLY for signed-in users.
    okSelector: '.global-nav__me, button[data-test-global-nav-me], [data-control-name="identity_welcome_message"]',
  },
  {
    platform: 'reddit',
    url: 'https://www.reddit.com/',
    loginPattern: /\/login(?:[\/?#]|$)/,
    okPattern: /reddit\.com\/?($|\?|#)/,
    // The user-drawer button is only rendered when signed in.
    okSelector: 'faceplate-tracker[noun="user_account_menu"] button, #USER_DROPDOWN_ID, a[href*="/user/"]',
  },
];

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${flags.port}`, { timeout: 5000 });
} catch (e) {
  if (flags.json) {
    console.log(JSON.stringify({ ok: false, error: `cdp-unreachable: ${e.message}`, port: flags.port }));
    process.exit(2);
  }
  console.error(`Could not attach to Edge on port ${flags.port}: ${e.message}`);
  console.error('Run `node tools/browser-scan/launch-edge.mjs` first.');
  process.exit(1);
}
const ctx = browser.contexts()[0];
if (!ctx) {
  if (flags.json) {
    console.log(JSON.stringify({ ok: false, error: 'no-context' }));
    process.exit(2);
  }
  console.error('Edge has no contexts. Open a tab and re-run.');
  process.exit(1);
}

const results = [];
for (const probe of PROBES) {
  const page = await ctx.newPage();
  try {
    await page.goto(probe.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Give SPA frameworks a moment to redirect (login wall, checkpoint).
    await page.waitForTimeout(2500);
    const finalUrl = page.url();
    const onLogin = probe.loginPattern.test(finalUrl);
    const onVerify = probe.verificationPattern ? probe.verificationPattern.test(finalUrl) : false;
    const onOk = probe.okPattern.test(finalUrl);
    // DOM fallback: even if the URL ends somewhere unexpected, the
    // presence of a signed-in-only nav element is conclusive proof of
    // a valid session. We only consult it when the URL check is
    // ambiguous (not on-login, not on-okPattern, not on-verify).
    let domSignedIn = false;
    if (!onLogin && !onVerify && !onOk && probe.okSelector) {
      try {
        domSignedIn = await page.locator(probe.okSelector).first().isVisible({ timeout: 1500 });
      } catch { /* selector not present — stays false */ }
    }
    let status;
    if (onLogin) status = 'NOT SIGNED IN';
    else if (onVerify) status = 'NEEDS VERIFICATION';
    else if (onOk || domSignedIn) status = 'OK';
    else status = `unclear (final URL: ${finalUrl})`;
    results.push({ platform: probe.platform, status, finalUrl });
  } catch (e) {
    results.push({ platform: probe.platform, status: `error: ${e.message}`, finalUrl: '-' });
  } finally {
    await page.close().catch(() => {});
  }
}

await browser.close().catch(() => {}); // disconnects, doesn't kill Edge

if (flags.json) {
  const byPlatform = {};
  for (const r of results) {
    let state = 'unclear';
    if (r.status === 'OK') state = 'signed-in';
    else if (typeof r.status === 'string' && r.status.startsWith('NOT')) state = 'signed-out';
    else if (typeof r.status === 'string' && r.status.startsWith('NEEDS')) state = 'needs-verification';
    else if (typeof r.status === 'string' && r.status.startsWith('error')) state = 'error';
    byPlatform[r.platform] = { state, finalUrl: r.finalUrl, raw: r.status };
  }
  console.log(JSON.stringify({
    ok: true,
    port: flags.port,
    checkedAt: new Date().toISOString(),
    platforms: byPlatform,
  }));
  process.exit(0);
}

const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
console.log('');
console.log(pad('Platform', 12) + pad('Status', 22) + 'Final URL');
console.log(pad('--------', 12) + pad('------', 22) + '---------');
for (const r of results) {
  const tag =
    r.status === 'OK' ? '\x1b[32mOK\x1b[0m                  ' :
    r.status.startsWith('NOT') ? '\x1b[31mNOT SIGNED IN\x1b[0m       ' :
    r.status.startsWith('NEEDS') ? '\x1b[33mNEEDS VERIFICATION\x1b[0m  ' :
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
  if (results.some((r) => r.status === 'NEEDS VERIFICATION')) {
    console.log('\x1b[33mOne or more platforms want device/2FA verification.\x1b[0m');
    console.log('Open the platform tab in the CDP browser, complete the prompt, then re-run.');
  }
  if (results.some((r) => r.status === 'NOT SIGNED IN')) {
    console.log('\x1b[33mSign in to the platforms marked NOT SIGNED IN, then re-run this script.\x1b[0m');
  }
  process.exit(1);
}
