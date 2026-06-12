// Google — logged-in browser scraper for two surfaces:
//   1. Google News (`news.google.com/search`) — structured publication /
//      date metadata; emits items with `platform: "google-news"`.
//   2. Google Web Search (`www.google.com/search`) — classic SERP,
//      parsed snippet-style; emits items with `platform: "google-web"`.
//      We run both an exact custom date-range pass (`tbs=cdr:…`) and a
//      broad recent-results fallback (`tbs=qdr:y`) so the sidecar still
//      catches newly indexed posts when Google's custom range returns a
//      sparse / oddly personalized result set.
//
// Both passes share the same logged-in CDP browser context (same page
// when possible) so the user's session keeps Google's anti-bot
// heuristics calm. Items are merged into the same sidecar and
// deduplicated by URL.
//
// Output items are shaped like a "blog" hit (no engagement counts,
// body empty — title + publisher + permalink only) so the existing
// scout-scan dedup / filter / scoring pipeline can pick them up as
// Layer 0 without special-case handling. Each item also carries a
// `subSource` field (`"google-news"` or `"google-web"`) so downstream
// reports can attribute origin.
//
// CAPTCHA handling: if Google swaps results for a reCAPTCHA, we write
// a debug snapshot and stop that pass (News or Web independently)
// rather than throw. Same pattern as linkedin.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { newPage, sleep } from '../lib/browser.mjs';
import { buildSearchQuery } from '../lib/query.mjs';

// Map a `--days N` lookback to Google News' `when:` parameter. Google
// News only supports h / d / w / m / y buckets; we pick the smallest
// bucket that still covers the requested window so we never UNDER-fetch.
function whenFor(days) {
  if (!days || days <= 0) return '7d';
  if (days <= 1) return '1d';
  if (days <= 7) return '7d';
  if (days <= 31) return '1m';
  if (days <= 365) return '1y';
  return '1y';
}

// Map a `--days N` lookback to Google Web's `tbs=qdr:…` parameter.
// Buckets: h (hour), d (day), w (week), m (month), y (year). Same
// "smallest bucket that still covers" rule as whenFor — never under-fetch.
// Kept as a fallback for when an explicit custom range can't be built.
function qdrFor(days) {
  if (!days || days <= 0) return 'w';
  if (days <= 1) return 'd';
  if (days <= 7) return 'w';
  if (days <= 31) return 'm';
  if (days <= 365) return 'y';
  return 'y';
}

// Format a timestamp as Google's custom-date-range token: M/D/YYYY with
// NO leading zeros (e.g. 5/1/2026), which is what the SERP's
// `tbs=cdr:1,cd_min:…,cd_max:…` parameter expects.
function gDate(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// Build Google Web's custom date-range `tbs` value from the exact scan
// window. This is precise to the day — unlike the coarse qdr buckets —
// so it matches "the range we asked for" (e.g. a specific calendar
// month) instead of rounding a 31-day request up to a full year.
// Produces e.g. `cdr:1,cd_min:5/1/2026,cd_max:5/31/2026`.
function cdrFor(sinceMs, untilMs) {
  const min = gDate(sinceMs);
  const max = gDate(untilMs || Date.now());
  return `cdr:1,cd_min:${min},cd_max:${max}`;
}

const ARTICLE_SELECTORS = [
  'article',                       // primary — Google News wraps every result in <article>
  'div[data-n-au]',                // fallback for some result layouts
];

// Classic SERP organic-result containers. Google rotates class names
// frequently, so we lean on stable attributes / IDs (#search, #rso,
// div.g) and the always-present <h3> inside each result.
const WEB_RESULT_SELECTORS = [
  '#search div.g',
  '#rso div.g',
  '#search h3',
  'div[data-hveid] h3',
];

const GOOGLE_WEB_RECENT_TBS = 'qdr:y';

const CAPTCHA_SELECTORS = [
  '#captcha-form',
  'form#captcha-form',
  'iframe[src*="recaptcha"]',
  'div#recaptcha',
];

async function dumpDebug(page, outDir, term, reason) {
  if (!outDir) return;
  try {
    const safeTerm = String(term || 'noterm').replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(outDir, `debug-google-${stamp}-${safeTerm}.html`);
    const main = await page.evaluate(() => (document.querySelector('main') || document.body)?.outerHTML || '');
    fs.writeFileSync(file, `<!-- ${reason} -->\n${main.slice(0, 50000)}`);
    console.warn(`[browser-scan] google: wrote debug snapshot → ${path.basename(file)} (${reason})`);
  } catch {/* swallow */}
}

async function waitForResultsOrCaptcha(page, resultSelectors, timeoutMs = 15000) {
  const combined = [...resultSelectors, ...CAPTCHA_SELECTORS].join(', ');
  try {
    await page.waitForSelector(combined, { timeout: timeoutMs });
  } catch {
    return 'timeout';
  }
  const isCaptcha = await page.evaluate((sels) => {
    return sels.some((s) => document.querySelector(s));
  }, CAPTCHA_SELECTORS);
  if (isCaptcha) return 'captcha';
  return 'results';
}

export async function openGoogleLogin(browser) {
  // Google News doesn't require a sign-in to scan, but we still open a
  // tab here for parity with the other platforms and so the user can
  // sign in to get personalization if they want it.
  const page = await newPage(browser);
  await page.goto('https://news.google.com/', { waitUntil: 'domcontentloaded' });
}

export async function scanGoogle(browser, ctx) {
  const { searchTerms, sinceMs, untilMs, maxPerTerm, outDir } = ctx;
  const items = new Map(); // url -> item (shared across News + Web passes; dedup by URL)

  const page = ctx.page || (await newPage(browser));
  const ownsPage = !ctx.page;

  // Compute lookback once from the original days window. We get
  // `sinceMs`, not days, so back-calc.
  const days = sinceMs ? Math.max(1, Math.round((Date.now() - sinceMs) / (24 * 60 * 60 * 1000))) : 30;
  const when = whenFor(days);
  // Precise custom date range for the Web SERP — bounded by the exact
  // window the caller asked for (sinceMs … untilMs, default now).
  const cdr = cdrFor(sinceMs || Date.now() - days * 24 * 60 * 60 * 1000, untilMs);

  // ---- Pass 1: Google News ----
  await scanGoogleNewsPass(page, { searchTerms, sinceMs, maxPerTerm, outDir, when, items });

  // Polite transition delay between the two passes — News and Web hit
  // different subdomains but Google still rate-limits on the session.
  await sleep(5000);

  // ---- Pass 2: Google Web Search, exact scan window ----
  await scanGoogleWebPass(page, {
    searchTerms,
    sinceMs,
    untilMs,
    maxPerTerm,
    outDir,
    tbs: cdr,
    scope: 'custom-range',
    items,
  });

  // ---- Pass 3: Google Web Search, broad recent fallback ----
  // This mirrors the manual browser query users naturally run, e.g.
  // https://www.google.com/search?q=%22cosmos+db+agent+kit%22&tbs=qdr:y
  // It is deliberately broader than the scan window. The sidecar dedupes by
  // URL, and the normal report pipeline still fetches/date-gates candidates.
  await scanGoogleWebPass(page, {
    searchTerms,
    sinceMs: null,
    untilMs: null,
    maxPerTerm,
    outDir,
    tbs: GOOGLE_WEB_RECENT_TBS,
    scope: 'recent-year',
    items,
  });

  if (ownsPage) await page.close();
  return [...items.values()];
}

async function scanGoogleNewsPass(page, { searchTerms, sinceMs, maxPerTerm, outDir, when, items }) {
  for (const term of searchTerms) {
    const query = buildSearchQuery(term, 'google-news');
    if (!query) continue;
    const url = `https://news.google.com/search?q=${encodeURIComponent(query)}+when:${when}&hl=en-US&gl=US&ceid=US:en`;

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      console.warn(`[browser-scan] google-news: navigation failed for "${term}": ${e.message}`);
      continue;
    }

    const state = await waitForResultsOrCaptcha(page, ARTICLE_SELECTORS, 15000);
    if (state === 'captcha') {
      console.warn(`[browser-scan] google-news: CAPTCHA challenge for "${term}" — stopping news pass (sign in to news.google.com once, then retry).`);
      await dumpDebug(page, outDir, term, 'captcha-news');
      break;
    }
    if (state === 'timeout') {
      console.warn(`[browser-scan] google-news: no results rendered for "${term}" (timeout)`);
      await dumpDebug(page, outDir, term, 'timeout-news');
      await sleep(3000);
      continue;
    }

    const fresh = await extractArticlesOnPage(page);
    let collected = 0;
    for (const item of fresh) {
      if (!item.url || items.has(item.url)) continue;
      if (sinceMs && item.post_date && new Date(item.post_date).getTime() < sinceMs) continue;
      item.search_term = term;
      items.set(item.url, item);
      collected++;
      if (collected >= maxPerTerm) break;
    }

    await sleep(3500); // polite delay between search terms — Google flags fast iteration
  }
}

async function scanGoogleWebPass(page, { searchTerms, sinceMs, untilMs, maxPerTerm, outDir, tbs, scope, items }) {
  for (const term of searchTerms) {
    const query = buildSearchQuery(term, 'google-news'); // same shaping rules apply
    if (!query) continue;
    // Use either Google's custom date range (`tbs=cdr:1,cd_min:…,cd_max:…`)
    // or its broad recent-results shortcut (`tbs=qdr:y`). Both are real
    // browser SERPs, not an API call.
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbs=${encodeURIComponent(tbs)}&hl=en-US&gl=US&num=20`;

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      console.warn(`[browser-scan] google-web/${scope}: navigation failed for "${term}": ${e.message}`);
      continue;
    }

    const state = await waitForResultsOrCaptcha(page, WEB_RESULT_SELECTORS, 15000);
    if (state === 'captcha') {
      console.warn(`[browser-scan] google-web/${scope}: CAPTCHA challenge for "${term}" — stopping web pass (sign in to google.com once, then retry).`);
      await dumpDebug(page, outDir, term, `captcha-web-${scope}`);
      break;
    }
    if (state === 'timeout') {
      console.warn(`[browser-scan] google-web/${scope}: no results rendered for "${term}" (timeout)`);
      await dumpDebug(page, outDir, term, `timeout-web-${scope}`);
      await sleep(3000);
      continue;
    }

    const fresh = await extractWebResultsOnPage(page);
    let collected = 0;
    for (const item of fresh) {
      if (!item.url || items.has(item.url)) continue;
      // Web SERP rarely surfaces structured dates per result. We trust
      // `tbs=cdr:` to have bounded results to the requested window
      // server-side. When a result DOES expose a date, enforce the same
      // [sinceMs, untilMs] bounds client-side as a backstop.
      if (item.post_date) {
        const t = new Date(item.post_date).getTime();
        if (!Number.isNaN(t)) {
          if (sinceMs && t < sinceMs) continue;
          if (untilMs && t > untilMs) continue;
        }
      }
      item.search_term = term;
      item.search_scope = scope;
      item.google_tbs = tbs;
      items.set(item.url, item);
      collected++;
      if (collected >= maxPerTerm) break;
    }

    await sleep(3500);
  }
}

async function extractArticlesOnPage(page) {
  return page.evaluate(() => {
    function abs(href) {
      if (!href) return null;
      if (/^https?:/i.test(href)) return href;
      if (href.startsWith('./')) return `https://news.google.com${href.slice(1)}`;
      if (href.startsWith('/')) return `https://news.google.com${href}`;
      return href;
    }
    function pubRoot(u) {
      try {
        const { origin } = new URL(u);
        return origin;
      } catch { return null; }
    }

    const out = [];
    const seen = new Set();
    const articles = document.querySelectorAll('article');
    for (const art of articles) {
      // Title link — Google News uses a few different anchor classes
      // across layouts; the only stable thing is "anchor whose href
      // starts with ./read/ or ./articles/ and that contains visible
      // text".
      const links = art.querySelectorAll('a[href^="./read/"], a[href^="./articles/"], a[href^="/read/"], a[href^="/articles/"]');
      let titleLink = null;
      for (const a of links) {
        const txt = (a.textContent || '').trim();
        if (txt.length > 10) { titleLink = a; break; }
      }
      if (!titleLink) continue;
      const title = (titleLink.textContent || '').trim();
      const url = abs(titleLink.getAttribute('href'));
      if (!url || seen.has(url)) continue;

      // Publisher name — usually the first `a[data-n-tid]` or a `div`
      // adjacent to a small publisher logo.
      let publisher = null;
      let publisherHref = null;
      const pubA = art.querySelector('a[data-n-tid], a[aria-label*="More from"]');
      if (pubA) {
        publisher = (pubA.textContent || '').trim() || null;
        publisherHref = abs(pubA.getAttribute('href'));
      }
      if (!publisher) {
        // Fallback: a <div> whose text is short and not the title.
        const divs = art.querySelectorAll('div');
        for (const d of divs) {
          const t = (d.textContent || '').trim();
          if (t && t.length < 50 && t !== title && !/^\d+[mhd]/.test(t)) {
            publisher = t;
            break;
          }
        }
      }

      // Date — <time datetime="...">
      let post_date = null;
      const timeEl = art.querySelector('time');
      if (timeEl) {
        const dt = timeEl.getAttribute('datetime');
        if (dt) post_date = dt;
      }

      seen.add(url);
      out.push({
        platform: 'google-news',
        subSource: 'google-news',
        url,
        author_handle: null,
        author_display: publisher,
        author_profile: publisherHref ? pubRoot(publisherHref) : null,
        author_bio: null,
        post_date,
        title,
        body: '',
        engagement: { reactions: null, comments: null, reposts: null },
        thread_context: null,
        scraped_at: new Date().toISOString(),
        source: 'google-news-browser',
      });
    }
    return out;
  });
}

// Extract organic Web SERP results from www.google.com/search. The
// SERP layout shifts often, so we lean on the long-stable structure:
// each organic hit sits inside a `div.g` (or any container with
// `data-hveid`), contains an `<h3>` title, an outbound `<a href>`, a
// `<cite>` showing the site, and a snippet `<div>` flagged with
// `data-sncf` or class `VwiC3b`.
async function extractWebResultsOnPage(page) {
  return page.evaluate(() => {
    function siteFromCite(text) {
      if (!text) return null;
      // <cite> usually looks like "https://example.com › path › here"
      // or "example.com › path". Strip the chevron / arrow chain and
      // return just the host.
      const head = String(text).split('›')[0].trim();
      try {
        const u = new URL(head.startsWith('http') ? head : `https://${head}`);
        return u.hostname.replace(/^www\./, '');
      } catch {
        return head || null;
      }
    }

    const out = [];
    const seen = new Set();

    // Collect candidate result containers. Prefer `div.g` (still the
    // most common organic-result wrapper); fall back to any container
    // that has both an `<h3>` and an outbound link.
    const candidates = new Set();
    document.querySelectorAll('#search div.g, #rso div.g').forEach((el) => candidates.add(el));
    document.querySelectorAll('#search div[data-hveid]').forEach((el) => {
      if (el.querySelector('h3') && el.querySelector('a[href^="http"]')) candidates.add(el);
    });

    for (const node of candidates) {
      const h3 = node.querySelector('h3');
      if (!h3) continue;
      const title = (h3.textContent || '').trim();
      if (!title) continue;

      // The title's outbound link is usually the closest ancestor <a>,
      // OR a sibling <a> whose href is external.
      let anchor = h3.closest('a');
      if (!anchor || !anchor.href || !/^https?:/i.test(anchor.href)) {
        anchor = node.querySelector('a[href^="http"]');
      }
      if (!anchor) continue;
      let url = anchor.href;
      // Strip Google's `/url?q=…&sa=…` redirect wrapper if present.
      try {
        const u = new URL(url);
        if (u.hostname.endsWith('google.com') && u.pathname === '/url') {
          const real = u.searchParams.get('q') || u.searchParams.get('url');
          if (real) url = real;
        }
      } catch {/* ignore */}
      if (!url || seen.has(url)) continue;
      // Skip Google-internal links (image search, maps, etc.)
      try {
        const host = new URL(url).hostname;
        if (host.endsWith('google.com') || host === 'webcache.googleusercontent.com') continue;
      } catch { continue; }

      const cite = node.querySelector('cite');
      const publisher = siteFromCite(cite ? cite.textContent : null);

      const snippetEl = node.querySelector('div[data-sncf], .VwiC3b, span.VwiC3b');
      const body = snippetEl ? (snippetEl.textContent || '').trim() : '';

      seen.add(url);
      out.push({
        platform: 'google-web',
        subSource: 'google-web',
        url,
        author_handle: null,
        author_display: publisher,
        author_profile: publisher ? `https://${publisher}` : null,
        author_bio: null,
        post_date: null, // SERP rarely exposes structured per-result dates
        title,
        body,
        engagement: { reactions: null, comments: null, reposts: null },
        thread_context: null,
        scraped_at: new Date().toISOString(),
        source: 'google-web-browser',
      });
    }
    return out;
  });
}
