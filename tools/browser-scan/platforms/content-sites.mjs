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

// Captcha / Cloudflare / anti-bot interstitial markers. These are only
// treated as a hard block when (a) the page returned ZERO usable results
// AND (b) the matched element is actually VISIBLE — see scanOneSite. A
// hidden/background reCAPTCHA widget (DZone loads one for its login &
// subscribe forms on every page) must NOT count as a block.
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

  // Backfill publish dates for items whose search card didn't expose one
  // (Tech Community search cards in particular omit dates, but the public
  // article page carries a JSON-LD `datePublished`). Without a date the
  // scout-scan date-gate can't place these in-window, so they silently drop.
  const all = [...items.values()];
  await backfillMissingDates(all);
  return all;
}

// Cheap, login-free date backfill: fetch each dateless item's public page and
// pull a publish date from JSON-LD `datePublished`, the OpenGraph
// `article:published_time` meta, or a `<time datetime>` element. Bounded by
// concurrency + a hard cap so a big result set can't stall the scan.
async function fetchPublishedDate(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (ContentScout content-sites date-backfill)' },
    });
    if (!res.ok) return '';
    const h = await res.text();
    const m =
      h.match(/<meta[^>]+(?:property|name)=["']article:published_time["'][^>]+content=["']([^"']+)/i) ||
      h.match(/"datePublished"\s*:\s*"([^"]+)"/i) ||
      h.match(/<time[^>]+datetime=["']([^"']+)/i);
    if (!m) return '';
    const d = new Date(m[1]);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function backfillMissingDates(itemsArr, { concurrency = 4, max = 120 } = {}) {
  const targets = itemsArr.filter((i) => !i.post_date).slice(0, max);
  if (!targets.length) return;
  const queue = [...targets];
  let filled = 0;
  async function worker() {
    while (queue.length) {
      const it = queue.shift();
      const iso = await fetchPublishedDate(it.url);
      if (iso) {
        it.post_date = iso;
        filled++;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`[browser-scan] content-sites: backfilled ${filled}/${targets.length} missing publish date(s)`);
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

    // Extract results FIRST. If the page served real article links it
    // clearly wasn't blocked — several of these sites (notably DZone)
    // embed a hidden/background reCAPTCHA iframe for their login &
    // subscribe widgets on EVERY page, including search results. Checking
    // for a captcha element before reading results would false-positive on
    // that background widget and skip the whole site even though the
    // results rendered fine.
    let fresh = await extractLinksOnPage(page, site.linkPattern);
    if (fresh.length === 0) {
      // Give slow client-rendered search pages (DZone, Hashnode) a second
      // chance to hydrate their result list before deciding it's empty.
      await sleep(2500);
      fresh = await extractLinksOnPage(page, site.linkPattern);
    }

    // Only when we got NOTHING do we consider an anti-bot interstitial —
    // and only a genuinely VISIBLE one. A real Cloudflare / reCAPTCHA
    // challenge renders no results AND shows a visible challenge element;
    // a 0px / display:none background captcha widget does not count.
    if (fresh.length === 0) {
      const blocked = await page.evaluate((sels) => {
        const isVisible = (el) => {
          if (!el) return false;
          const st = getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
          const r = el.getBoundingClientRect();
          return r.width > 40 && r.height > 40; // real challenge UI, not a hidden widget
        };
        return sels.some((s) => Array.from(document.querySelectorAll(s)).some(isVisible));
      }, BLOCK_SELECTORS);
      if (blocked) {
        console.warn(`[browser-scan] ${site.key}: anti-bot / captcha challenge for "${term}". Solve it once in the CDP browser, then re-run. Skipping ${site.key}.`);
        await dumpDebug(page, outDir, site.key, term, 'blocked');
        return;
      }
    }

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
        // Date pulled from the search-result card when the site exposes one
        // (Tech Community / DZone / C# Corner cards carry a <time> or a dated
        // byline). Null when absent — the scout-scan pipeline still fetches +
        // date-gates each candidate as a backstop.
        post_date: it.date || null,
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
// title. Also pulls a publish date from the result card when the site
// exposes one. Skips obvious nav/login chrome and caps per page.
async function extractLinksOnPage(page, patternStr) {
  return page.evaluate((pStr) => {
    let re;
    try { re = new RegExp(pStr, 'i'); } catch { return []; }

    // Convert a card's date text → ISO (YYYY-MM-DD). Handles absolute dates
    // ("Jun 19, 2026", "2026-06-19") and relative ones ("2 weeks ago",
    // "yesterday", "3h"). Returns '' when nothing parseable is found.
    const toIso = (ms) => {
      const d = new Date(ms);
      return Number.isNaN(d.getTime())
        ? ''
        : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const parseDate = (raw) => {
      const s = String(raw || '').trim();
      if (!s) return '';
      // Relative: "2 weeks ago", "3 days ago", "5h", "10m", "yesterday".
      if (/^yesterday/i.test(s)) return toIso(Date.now() - 864e5);
      if (/^(today|just now|moments? ago|now)/i.test(s)) return toIso(Date.now());
      const rel = s.match(/(\d+)\s*(year|yr|month|mo|week|wk|day|d|hour|hr|h|minute|min|m)s?\b\s*(ago)?/i);
      if (rel) {
        const n = parseInt(rel[1], 10);
        const u = rel[2].toLowerCase();
        const mult =
          /year|yr/.test(u) ? 365 * 864e5 :
          /month|mo/.test(u) ? 30 * 864e5 :
          /week|wk/.test(u) ? 7 * 864e5 :
          /day|^d$/.test(u) ? 864e5 :
          /hour|hr|^h$/.test(u) ? 36e5 :
          60e3;
        return toIso(Date.now() - n * mult);
      }
      // Absolute: trust Date.parse for "Jun 19, 2026" / "2026-06-19" etc.
      const t = Date.parse(s);
      return Number.isFinite(t) ? toIso(t) : '';
    };
    const dateFromCard = (card) => {
      if (!card) return '';
      // 1) A <time> element with a machine datetime is the most reliable.
      const timeEl = card.querySelector('time[datetime], time[data-datetime]');
      if (timeEl) {
        const dt = timeEl.getAttribute('datetime') || timeEl.getAttribute('data-datetime');
        const iso = parseDate(dt || timeEl.textContent || '');
        if (iso) return iso;
      }
      // 2) Elements that look like a date/published byline.
      const cand = card.querySelector(
        '[class*="date" i],[class*="published" i],[class*="timestamp" i],[data-testid*="date" i]'
      );
      if (cand) {
        const iso = parseDate(cand.getAttribute('title') || cand.textContent || '');
        if (iso) return iso;
      }
      return '';
    };

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
      const card = a.closest('article, li, [class*="card" i], [class*="result" i], [class*="message" i]')
        || a.closest('section, div');
      if (title.length < 8) {
        const h = card ? card.querySelector('h1, h2, h3, h4') : null;
        if (h) title = (h.textContent || '').replace(/\s+/g, ' ').trim();
      }
      if (!title || title.length < 8 || NAV.test(title)) continue;
      seen.add(url);
      out.push({ url, title, date: dateFromCard(card) });
      if (out.length >= 60) break; // hard per-page cap
    }
    return out;
  }, patternStr);
}
