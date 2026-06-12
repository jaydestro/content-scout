// Developer content sites — logged-in / real-browser scraper.
//
// These four sources can't be reached by the normal API/RSS scan layers:
//   - Microsoft Tech Community — sign-in wall blocks anonymous content.
//   - DZone — anti-bot 403 on every anonymous request.
//   - C# Corner — RSS feeds return 500.
//   - Hashnode — tag-RSS endpoints return 404 (only the global feed works).
//
// A real, logged-in Chromium-family browser attached over CDP sidesteps
// all four: Tech Community sees the user's session, and DZone / C# Corner /
// Hashnode get a genuine browser fingerprint + JS execution instead of a
// bare fetch. We drive each site's own search page for every configured
// search term and scrape the article-listing links it renders.
//
// This mirrors the Google scanner: ONE platform key (`content-sites`),
// several sub-sources, ONE sidecar (`*-content-sites.json`), and
// "blog-shaped" items (no engagement counts, empty body — title +
// publisher + permalink only) so the existing scout-scan dedup / filter /
// scoring pipeline ingests them as Layer 0 with no special-casing. Each
// item carries `subSource` (`techcommunity` / `dzone` / `csharpcorner` /
// `hashnode`) so reports can attribute origin.
//
// Per-site failure is graceful: a sign-in wall, captcha, or zero results
// writes a debug snapshot and skips that site without throwing, so one
// blocked site never sinks the rest of the scan.

import fs from 'node:fs';
import path from 'node:path';
import { newPage, sleep } from '../lib/browser.mjs';
import { buildSearchQuery } from '../lib/query.mjs';

// Site definitions. `linkPattern` / `loginPattern` are STRINGS, not RegExp
// objects, because they're compiled inside page.evaluate() — RegExp can't
// cross the Node↔page boundary. Each is matched case-insensitively.
const SITES = [
  {
    key: 'techcommunity',
    label: 'Microsoft Tech Community',
    // The 2024+ platform's search page. Old Khoros search URLs redirect here.
    searchUrl: (q) => `https://techcommunity.microsoft.com/search?q=${encodeURIComponent(q)}`,
    // Permalinks: old Khoros boards use /ba-p/<id>, /m-p/<id>, /td-p/<id>;
    // the new platform uses /<area>/<slug>/<numeric-id>.
    linkPattern:
      'techcommunity\\.microsoft\\.com/.+/(?:ba-p|m-p|td-p|bc-p)/\\d+' +
      '|techcommunity\\.microsoft\\.com/(?:blog|discussions|t5|category)/[^?#]+/\\d+(?:[/?#]|$)',
    // A redirect to a Microsoft sign-in host (or the legacy login route)
    // means we have no session — tell the user to sign in once.
    loginPattern: 'login\\.microsoftonline\\.com|login\\.live\\.com|/sign-in(?:[/?#]|$)|/t5/user/login',
    needsLogin: true,
  },
  {
    key: 'dzone',
    label: 'DZone',
    searchUrl: (q) => `https://dzone.com/search?query=${encodeURIComponent(q)}`,
    linkPattern: 'dzone\\.com/articles/[^?#]+',
    loginPattern: null,
    needsLogin: false,
  },
  {
    key: 'csharpcorner',
    label: 'C# Corner',
    searchUrl: (q) => `https://www.c-sharpcorner.com/search/${encodeURIComponent(q)}`,
    linkPattern: 'c-sharpcorner\\.com/(?:article|blogs|forums|news)/[^?#]+',
    loginPattern: null,
    needsLogin: false,
  },
  {
    key: 'hashnode',
    label: 'Hashnode',
    searchUrl: (q) => `https://hashnode.com/search?q=${encodeURIComponent(q)}`,
    // Hashnode posts live on per-user subdomains (`*.hashnode.dev/<slug>`)
    // or under `hashnode.com/@user/<slug>` / `hashnode.com/post/<slug>`.
    // Posts on fully custom domains can't be pattern-matched here — the
    // open-web Brave layer already covers those; this replaces the dead
    // tag-RSS with live, logged-in search coverage of the hosted posts.
    linkPattern:
      '[a-z0-9-]+\\.hashnode\\.dev/[a-z0-9-]+' +
      '|hashnode\\.com/@[^/]+/[a-z0-9-]+' +
      '|hashnode\\.com/post/[a-z0-9-]+',
    loginPattern: null,
    needsLogin: false,
  },
];

// Captcha / Cloudflare / anti-bot interstitial markers. If any are present
// we stop that site (the user must clear it once in the live browser).
const BLOCK_SELECTORS = [
  '#captcha-form',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[title*="captcha" i]',
  '#cf-challenge-running',
  'div#challenge-running',
];

async function dumpDebug(page, outDir, key, term, reason) {
  if (!outDir) return;
  try {
    const safeTerm = String(term || 'noterm').replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(outDir, `debug-${key}-${stamp}-${safeTerm}.html`);
    const main = await page.evaluate(() => (document.querySelector('main') || document.body)?.outerHTML || '');
    fs.writeFileSync(file, `<!-- ${reason} -->\n${main.slice(0, 50000)}`);
    console.warn(`[browser-scan] ${key}: wrote debug snapshot → ${path.basename(file)} (${reason})`);
  } catch { /* swallow */ }
}

export async function openContentSitesLogin(browser) {
  // Only Tech Community needs an authenticated session; open it so the
  // user can sign in once. DZone / C# Corner / Hashnode scrape fine with
  // a plain real browser (no login required).
  const page = await newPage(browser);
  await page.goto('https://techcommunity.microsoft.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
}

export async function scanContentSites(browser, ctx) {
  const { searchTerms, maxPerTerm, outDir } = ctx;
  const items = new Map(); // url -> item, deduped across all sites + terms
  const page = ctx.page || (await newPage(browser));
  const ownsPage = !ctx.page;

  for (const site of SITES) {
    try {
      await scanOneSite(page, site, { searchTerms, maxPerTerm, outDir, items });
    } catch (e) {
      console.warn(`[browser-scan] ${site.key}: site scan error (continuing): ${e.message}`);
    }
    await sleep(4000); // polite gap between sites
  }

  if (ownsPage) await page.close().catch(() => {});
  return [...items.values()];
}

async function scanOneSite(page, site, { searchTerms, maxPerTerm, outDir, items }) {
  let siteCount = 0;
  for (const term of searchTerms) {
    const query = buildSearchQuery(term, 'content-sites');
    if (!query) continue;
    const url = site.searchUrl(query);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      console.warn(`[browser-scan] ${site.key}: navigation failed for "${term}": ${e.message}`);
      continue;
    }
    // Let client-rendered search pages (Hashnode, the new Tech Community)
    // hydrate their result list before we read the DOM.
    await sleep(3000);

    // Sign-in wall detection (Tech Community). Every term would wall the
    // same way, so skip the whole site after the first hit.
    if (site.loginPattern) {
      const finalUrl = page.url();
      if (new RegExp(site.loginPattern, 'i').test(finalUrl)) {
        console.warn(`[browser-scan] ${site.key}: hit a sign-in wall (${finalUrl}). Sign in to ${site.label} in the CDP browser once, then re-run. Skipping ${site.key}.`);
        await dumpDebug(page, outDir, site.key, term, 'login-wall');
        return;
      }
    }

    // Captcha / Cloudflare detection.
    const blocked = await page.evaluate((sels) => sels.some((s) => document.querySelector(s)), BLOCK_SELECTORS);
    if (blocked) {
      console.warn(`[browser-scan] ${site.key}: anti-bot / captcha challenge for "${term}". Solve it once in the CDP browser, then re-run. Skipping ${site.key}.`);
      await dumpDebug(page, outDir, site.key, term, 'blocked');
      return;
    }

    const fresh = await extractLinksOnPage(page, site.linkPattern);
    let collected = 0;
    for (const it of fresh) {
      if (!it.url || items.has(it.url)) continue;
      items.set(it.url, {
        platform: site.key,
        subSource: site.key,
        url: it.url,
        author_handle: null,
        author_display: site.label,
        author_profile: null,
        author_bio: null,
        // Listing/search pages rarely expose a reliable per-item date; the
        // scout-scan pipeline fetches + date-gates each candidate anyway.
        post_date: null,
        title: it.title,
        body: '',
        engagement: { reactions: null, comments: null, reposts: null },
        thread_context: null,
        scraped_at: new Date().toISOString(),
        source: `${site.key}-browser`,
        search_term: term,
      });
      collected++;
      siteCount++;
      if (collected >= maxPerTerm) break;
    }
    if (fresh.length === 0) {
      await dumpDebug(page, outDir, site.key, term, 'no-results');
    }

    await sleep(3500); // polite delay between terms — avoid tripping rate limits
  }
  console.log(`[browser-scan] ${site.key}: collected ${siteCount} item(s) across ${searchTerms.length} term(s)`);
}

// Generic article-link extractor. Given the site's permalink pattern
// (string → RegExp inside the page), collect anchors whose href matches,
// taking the anchor's own text — or the nearest card heading — as the
// title. Skips obvious nav/login chrome and caps per page.
async function extractLinksOnPage(page, patternStr) {
  return page.evaluate((pStr) => {
    let re;
    try { re = new RegExp(pStr, 'i'); } catch { return []; }
    const out = [];
    const seen = new Set();
    const NAV = /^(sign in|log in|login|register|sign up|home|search|menu|next|previous|read more|see all|more|follow)$/i;
    const anchors = document.querySelectorAll('a[href]');
    for (const a of anchors) {
      const href = a.href;
      if (!href || !re.test(href)) continue;
      const url = href.split('#')[0];
      if (seen.has(url)) continue;
      let title = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (title.length < 8) {
        const card = a.closest('article, li, section, div');
        const h = card ? card.querySelector('h1, h2, h3, h4') : null;
        if (h) title = (h.textContent || '').replace(/\s+/g, ' ').trim();
      }
      if (!title || title.length < 8 || NAV.test(title)) continue;
      seen.add(url);
      out.push({ url, title });
      if (out.length >= 60) break; // hard per-page cap
    }
    return out;
  }, patternStr);
}
