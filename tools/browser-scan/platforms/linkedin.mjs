// LinkedIn — logged-in browser scraper.
//
// Strategy:
//   1. Navigate to https://www.linkedin.com/search/results/content/?keywords={term}&datePosted=past-month&sortBy=date_posted
//   2. Scroll to load more posts in the infinite feed
//   3. Each post container is `div.feed-shared-update-v2[data-urn^="urn:li:activity"]`
//   4. Extract permalink (from data-urn), author display + handle (from
//      `.update-components-actor__title` and `a.update-components-actor__meta-link`),
//      author headline (`.update-components-actor__description`), relative
//      time (`.update-components-actor__sub-description`), body
//      (`.update-components-text`), and reaction/comment counts
//   5. De-dupe by post URL across search terms
//
// Selector notes (verified Nov 2026 against live linkedin.com):
//   - LinkedIn migrated `/search/results/content/` to a Server-Driven UI
//     (SDUI) LazyColumn. Legacy markers — `feed-shared-update-v2`,
//     `data-urn^="urn:li:activity"`, `.search-reusables__no-results-message`,
//     `.update-components-actor__*` — are entirely absent on the new
//     search surface. We now walk
//     `div[role="listitem"][componentkey*="FeedType_FLAGSHIP_SEARCH"]`
//     and pull the body from `[data-testid="expandable-text-box"]`.
//   - Legacy selectors are kept as a fallback for surfaces that may not
//     have migrated yet (e.g. hashtag or profile activity feeds).
//   - SDUI posts do NOT expose a per-post permalink in the DOM —
//     LinkedIn lazy-loads it only when the user opens the "..." menu.
//     We synthesize a stable URL from the componentkey hash so the
//     downstream dedup/reporter pipeline works; the URL is not
//     navigable but the author profile is included separately.
//   - LinkedIn does not expose absolute timestamps in the DOM. We
//     reconstruct ISO from the relative string (e.g. "19m", "3d", "2w",
//     "1mo") against `now`.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { newPage, sleep } from '../lib/browser.mjs';
import { buildSearchQuery } from '../lib/query.mjs';

// Selectors that, when present, indicate the search-results feed has rendered
// at least one post container. We race several variants because LinkedIn
// renames feed wrappers a few times a year — and because the search-results
// page uses different containers from the home feed.
const POST_SELECTORS = [
  // SDUI search-results (Nov 2026+) — primary path for /search/results/content/
  'div[role="listitem"][componentkey*="FeedType_FLAGSHIP_SEARCH"]',
  '[data-component-type="LazyColumn"] [data-testid="expandable-text-box"]',
  // Legacy fallback — kept for hashtag/profile feeds that may still use old DOM
  'div.feed-shared-update-v2[data-urn^="urn:li:activity"]',
  '[data-urn^="urn:li:activity:"]',
  '[data-id^="urn:li:activity:"]',
  'div.search-results-container [data-urn]',
  'li.artdeco-card[data-urn]',
];
// Selectors that indicate LinkedIn explicitly rendered a "no results" state.
// Hitting one of these means our scrape is correct and the answer really is
// zero — not selector drift.
const EMPTY_STATE_SELECTORS = [
  // SDUI no-results variants (best-effort — we have no verified empty
  // snapshot yet; the legacy ones are kept as belt-and-braces)
  '[data-sdui-screen*="SearchResultsContent"] [data-testid*="empty"]',
  '[data-sdui-screen*="SearchResultsContent"] [data-testid*="no-results"]',
  '.search-reusables__no-results-message',
  '[data-test-search-no-results]',
  '.search-results-container .search-no-results__container',
];

async function waitForResultsOrEmpty(page, timeoutMs = 15000) {
  const combined = [...POST_SELECTORS, ...EMPTY_STATE_SELECTORS].join(', ');
  try {
    await page.waitForSelector(combined, { timeout: timeoutMs });
  } catch {
    return 'timeout';
  }
  for (const sel of POST_SELECTORS) {
    if (await page.locator(sel).first().count() > 0) return 'posts';
  }
  return 'empty';
}

async function dumpDebug(page, ctx, term, reason) {
  if (!ctx.outDir) return;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTerm = term.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40);
    const file = path.join(ctx.outDir, `debug-linkedin-${stamp}-${safeTerm}.html`);
    const html = await page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      return [
        `<!-- url: ${location.href} -->`,
        `<!-- title: ${document.title} -->`,
        main ? main.outerHTML.slice(0, 50000) : '<!-- no main element -->',
      ].join('\n');
    });
    await fsp.writeFile(file, `<!-- reason: ${reason} -->\n${html}`, 'utf8');
    console.warn(`[browser-scan] linkedin: debug snapshot saved → ${path.relative(process.cwd(), file)}`);
  } catch (e) {
    console.warn(`[browser-scan] linkedin: failed to write debug snapshot: ${e.message}`);
  }
}

export async function openLinkedInLogin(browser) {
  const page = await newPage(browser);
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
}

export async function scanLinkedIn(browser, ctx) {
  const { searchTerms, sinceMs, maxPerTerm } = ctx;
  const items = new Map();
  // Reuse a caller-provided page when present so the whole scan can run
  // inside a single Edge tab (less visible flicker for the user).
  const page = ctx.page || (await newPage(browser));
  const ownsPage = !ctx.page;

  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  const finalUrl = page.url();
  // Truly signed-out states (cookies missing/invalid).
  if (/\/(?:login|uas\/login|authwall)(?:[/?#]|$)/.test(finalUrl)) {
    console.warn('[browser-scan] linkedin: session expired — sign in to LinkedIn in the Edge tab and re-run.');
    if (ownsPage) await page.close();
    return [];
  }
  // Signed-in-but-blocked state: LinkedIn is challenging the device /
  // 2FA and won't let scans through until the human completes it. Treat
  // it as a soft skip with a distinct message so the user knows the fix
  // is "complete the prompt", not "log in again".
  if (/\/checkpoint(?:[/?#]|$)/.test(finalUrl)) {
    console.warn('[browser-scan] linkedin: device/2FA verification required — open the LinkedIn tab in the CDP browser, complete the prompt, and re-run.');
    if (ownsPage) await page.close();
    return [];
  }
  // Fallback: if we're somewhere unexpected but the signed-in nav
  // element is present, treat the session as valid and keep going.
  if (!/linkedin\.com\/feed/.test(finalUrl)) {
    let domSignedIn = false;
    try {
      domSignedIn = await page.locator('.global-nav__me, [data-control-name="identity_welcome_message"]').first().isVisible({ timeout: 1500 });
    } catch { /* stays false */ }
    if (!domSignedIn) {
      console.warn(`[browser-scan] linkedin: unexpected landing URL (${finalUrl}) and no signed-in nav element — skipping.`);
      if (ownsPage) await page.close();
      return [];
    }
  }

  for (const term of searchTerms) {
    const query = buildSearchQuery(term, 'linkedin');
    if (!query) continue;
    const keywords = encodeURIComponent(query);
    // Primary URL uses LinkedIn's quoted-filter form (current as of May
    // 2026). Fallback strips the filters in case LinkedIn changes the
    // syntax again — we'd rather have unfiltered recent results than
    // none.
    const primaryUrl = `https://www.linkedin.com/search/results/content/?keywords=${keywords}&datePosted=%22past-month%22&sortBy=%22date_posted%22`;
    const fallbackUrl = `https://www.linkedin.com/search/results/content/?keywords=${keywords}`;

    let outcome = 'timeout';
    for (const [attempt, url] of [['primary', primaryUrl], ['fallback', fallbackUrl]]) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
      } catch (e) {
        console.warn(`[browser-scan] linkedin: navigation failed for "${term}" (${attempt}): ${e.message}`);
        outcome = 'navfail';
        continue;
      }
      outcome = await waitForResultsOrEmpty(page, 15000);
      if (outcome === 'posts') break;
      if (outcome === 'empty' && attempt === 'primary') {
        // Date filter may have hidden everything — try unfiltered.
        continue;
      }
      if (outcome === 'empty') break;
      // timeout — only retry once with fallback URL
      if (attempt === 'primary') continue;
    }

    if (outcome === 'empty') {
      console.warn(`[browser-scan] linkedin: 0 results for "${term}" (LinkedIn rendered empty-state)`);
      await sleep(2500);
      continue;
    }
    if (outcome !== 'posts') {
      console.warn(`[browser-scan] linkedin: no results rendered for "${term}" (selector timeout — saving debug snapshot)`);
      await dumpDebug(page, ctx, term, outcome);
      await sleep(3500);
      continue;
    }

    let collected = 0;
    let lastHeight = 0;
    for (let scroll = 0; scroll < 8 && collected < maxPerTerm; scroll++) {
      const posts = await extractPostsOnPage(page);
      for (const p of posts) {
        if (!p.url || items.has(p.url)) continue;
        if (sinceMs && p.post_date && new Date(p.post_date).getTime() < sinceMs) continue;
        p.search_term = term;
        items.set(p.url, p);
        collected++;
        if (collected >= maxPerTerm) break;
      }
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h === lastHeight) break;
      lastHeight = h;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
      await sleep(2000);
    }
    await sleep(3500); // polite delay between search terms
  }

  if (ownsPage) await page.close();
  return [...items.values()];
}

async function extractPostsOnPage(page) {
  return page.evaluate(() => {
    const now = Date.now();

    // Convert LinkedIn's relative timestamp ("19m", "3d", "2w", "1mo", "1y")
    // to an ISO string, anchored to `now`.
    function relToIso(s) {
      if (!s) return null;
      // sub-description text often looks like "19m • " or "3d • Edited •"
      const m = s.match(/(\d+)\s*(s|m|h|d|w|mo|y)\b/i);
      if (!m) return null;
      const n = parseInt(m[1], 10);
      const unit = m[2].toLowerCase();
      const ms =
        unit === 's' ? n * 1000 :
        unit === 'm' ? n * 60_000 :
        unit === 'h' ? n * 3_600_000 :
        unit === 'd' ? n * 86_400_000 :
        unit === 'w' ? n * 7 * 86_400_000 :
        unit === 'mo' ? n * 30 * 86_400_000 :
        unit === 'y' ? n * 365 * 86_400_000 :
        0;
      return new Date(now - ms).toISOString();
    }

    function toNum(s) {
      if (!s) return null;
      // CRITICAL: require a word boundary after the K/M/B suffix so we
      // don't match the "M" in "Mihail" or the "B" in "Bob" when the
      // textContent leaks names from a sibling node (e.g. LinkedIn's
      // "15  Mihail Mateev and 14 others" social-proof string).
      const cleaned = String(s).replace(/,/g, '').trim();
      // Try suffixed form first (1.5K, 2M, 3B), with a hard word boundary.
      const mSuf = cleaned.match(/([\d.]+)\s*([KMB])\b/i);
      if (mSuf) {
        const base = parseFloat(mSuf[1]);
        const u = mSuf[2].toUpperCase();
        const mult = u === 'K' ? 1e3 : u === 'M' ? 1e6 : u === 'B' ? 1e9 : 1;
        return Math.round(base * mult);
      }
      // Plain integer (the most common case for LinkedIn small counts).
      const mPlain = cleaned.match(/(\d+)/);
      return mPlain ? parseInt(mPlain[1], 10) : null;
    }

    const out = [];
    // Broadened container query — match either the legacy
    // .feed-shared-update-v2 wrapper or any element carrying the
    // urn:li:activity URN on data-urn / data-id. We then de-dupe by
    // activity ID below so wrapper changes don't double-count posts.
    const seenIds = new Set();
    const containers = [
      ...document.querySelectorAll('div.feed-shared-update-v2[data-urn^="urn:li:activity"]'),
      ...document.querySelectorAll('[data-urn^="urn:li:activity:"]'),
      ...document.querySelectorAll('[data-id^="urn:li:activity:"]'),
    ].filter((el) => {
      const urn = el.getAttribute('data-urn') || el.getAttribute('data-id') || '';
      const m = urn.match(/urn:li:activity:(\d+)/);
      if (!m) return false;
      if (seenIds.has(m[1])) return false;
      seenIds.add(m[1]);
      return true;
    });

    for (const c of containers) {
      // Permalink from URN — check data-urn first, fall back to data-id.
      const urn = c.getAttribute('data-urn') || c.getAttribute('data-id') || '';
      const idMatch = urn.match(/urn:li:activity:(\d+)/);
      if (!idMatch) continue;
      const url = `https://www.linkedin.com/feed/update/urn:li:activity:${idMatch[1]}/`;

      // Author display name
      const author_display =
        c.querySelector('.update-components-actor__title span[aria-hidden="true"]')?.textContent?.trim() ||
        c.querySelector('.update-components-actor__title')?.textContent?.trim() ||
        null;

      // Author profile link → handle
      const profileAnchor = c.querySelector('a.update-components-actor__meta-link, a.update-components-actor__container-link');
      let author_handle = null;
      let author_profile = null;
      if (profileAnchor) {
        const href = profileAnchor.getAttribute('href') || '';
        author_profile = href.split('?')[0] || null;
        const m = href.match(/\/in\/([^/?#]+)|\/company\/([^/?#]+)|\/school\/([^/?#]+)/);
        if (m) author_handle = `@${(m[1] || m[2] || m[3]).toLowerCase()}`;
      }

      // Author bio / headline
      const author_bio =
        c.querySelector('.update-components-actor__description span[aria-hidden="true"]')?.textContent?.trim() ||
        c.querySelector('.update-components-actor__description')?.textContent?.trim() ||
        null;

      // Relative timestamp → ISO
      const subDescText =
        c.querySelector('.update-components-actor__sub-description span[aria-hidden="true"]')?.textContent?.trim() ||
        c.querySelector('.update-components-actor__sub-description')?.textContent?.trim() ||
        null;
      const post_date = relToIso(subDescText);

      // Body — try several known wrappers in priority order.
      const bodyEl =
        c.querySelector('.update-components-text') ||
        c.querySelector('.feed-shared-update-v2__description') ||
        c.querySelector('.update-components-update-v2__commentary') ||
        c.querySelector('.feed-shared-text');
      const body = bodyEl ? bodyEl.innerText.trim() : '';

      // Engagement — reactions. The fallback-number element is just the
      // numeric count ("15"). The other selectors leak sibling names like
      // "15  Mihail Mateev and 14 others", so try the clean one first.
      const reactionsText =
        c.querySelector('.social-details-social-counts__social-proof-fallback-number')?.textContent?.trim() ||
        c.querySelector('.social-details-social-counts__reactions-count')?.textContent?.trim() ||
        c.querySelector('.social-details-social-counts__count-value')?.textContent?.trim() ||
        null;

      // Engagement — comments. The button label includes "12 comments" etc.
      let commentsText = null;
      const commentsBtn = c.querySelector('button[aria-label*="comment"], button[aria-label*="Comment"]');
      if (commentsBtn) {
        const labelMatch = (commentsBtn.getAttribute('aria-label') || '').match(/(\d[\d,]*)\s*comments?/i);
        if (labelMatch) commentsText = labelMatch[1];
      }
      if (!commentsText) {
        commentsText = c.querySelector('.social-details-social-counts__comments')?.textContent?.trim() || null;
      }

      // Engagement — reposts
      let repostsText = null;
      const repostsBtn = c.querySelector('button[aria-label*="repost" i]');
      if (repostsBtn) {
        const m = (repostsBtn.getAttribute('aria-label') || '').match(/(\d[\d,]*)\s*reposts?/i);
        if (m) repostsText = m[1];
      }

      // Some posts (job promos, polls) have no body text. Keep them only
      // if there's at least an author + URL — drop totally empty ones.
      if (!author_display && !body) continue;

      out.push({
        platform: 'linkedin',
        url,
        author_handle,
        author_display,
        author_profile,
        author_bio,
        post_date,
        title: null,
        body,
        engagement: {
          reactions: toNum(reactionsText),
          comments: toNum(commentsText),
          reposts: toNum(repostsText),
        },
        thread_context: null,
        scraped_at: new Date().toISOString(),
        source: 'linkedin-browser',
      });
    }

    // --- SDUI (Server-Driven UI) extraction path ---------------------
    // The /search/results/content/ surface migrated to an SDUI LazyColumn
    // (Nov 2026+). Posts have NO data-urn, NO .feed-shared-update-v2
    // wrapper, and NO in-DOM permalink — only a stable per-post hash on
    // the listitem's componentkey. We walk those listitems and synthesize
    // a non-navigable URL keyed off the hash so dedup works.
    const sduiNodes = document.querySelectorAll(
      'div[role="listitem"][componentkey*="FeedType_FLAGSHIP_SEARCH"]'
    );
    for (const node of sduiNodes) {
      const ck = node.getAttribute('componentkey') || '';
      const hashMatch = ck.match(/^expanded([A-Za-z0-9_-]+)FeedType_FLAGSHIP_SEARCH$/);
      const postHash = hashMatch ? hashMatch[1] : ck;
      if (!postHash) continue;

      // Prefer a real permalink if LinkedIn happens to emit one inline
      // (rare on search SDUI, common on quoted reshares — but the
      // reshare anchor points at the SOURCE post, not the outer post,
      // so we ignore it and synthesize off the outer hash).
      const url = `https://www.linkedin.com/feed/sdui-post/${postHash}/`;
      if (seenIds.has(`sdui:${postHash}`)) continue;
      seenIds.add(`sdui:${postHash}`);

      // Body: first commentary block belonging to THIS post (descendant
      // expandable-text-box whose ancestor <p> has feed-commentary_*
      // componentkey).
      let body = '';
      const commentaryP = node.querySelector('p[componentkey^="feed-commentary_"]');
      if (commentaryP) {
        const box = commentaryP.querySelector('[data-testid="expandable-text-box"]');
        body = (box || commentaryP).innerText.trim();
      } else {
        const anyBox = node.querySelector('[data-testid="expandable-text-box"]');
        if (anyBox) body = anyBox.innerText.trim();
      }
      // Strip the trailing "…more" expansion button text if present.
      body = body.replace(/\s*…\s*more\s*$/i, '').trim();

      // Author: control-menu aria-label is the most reliable signal
      // ("Open control menu for post by {Name}").
      let author_display = null;
      const menuBtn = node.querySelector('button[aria-label^="Open control menu for post by "]');
      if (menuBtn) {
        author_display = (menuBtn.getAttribute('aria-label') || '')
          .replace(/^Open control menu for post by\s+/i, '')
          .trim() || null;
      }

      // Author profile / handle from the avatar anchor (first /in/ or /company/ link).
      let author_handle = null;
      let author_profile = null;
      const avatar = node.querySelector(
        'a[href*="linkedin.com/in/"], a[href*="linkedin.com/company/"], a[href^="/in/"], a[href^="/company/"]'
      );
      if (avatar) {
        let href = avatar.getAttribute('href') || '';
        if (href.startsWith('/')) href = `https://www.linkedin.com${href}`;
        author_profile = href.split('?')[0] || null;
        const m = href.match(/\/in\/([^/?#]+)|\/company\/([^/?#]+)/);
        if (m) author_handle = `@${(m[1] || m[2]).toLowerCase()}`;
      }

      // Author headline: nearest <p> with non-trivial text that isn't
      // the name or the "• 1st" connection badge or the timestamp.
      let author_bio = null;
      const headlinePs = node.querySelectorAll('p');
      for (const p of headlinePs) {
        const t = (p.textContent || '').trim();
        if (!t) continue;
        if (author_display && t === author_display) continue;
        if (/^•?\s*1st$/i.test(t)) continue;
        if (/^\d+[smhdwy](o)?\b/.test(t)) continue;
        if (/^Feed post$/i.test(t)) continue;
        if (t.length < 8 || t.length > 220) continue;
        author_bio = t;
        break;
      }

      // Relative timestamp → ISO. Look for the <p> that contains the
      // visibility-globe icon (every SDUI post has one next to the
      // relative time).
      let post_date = null;
      const tsP = [...node.querySelectorAll('p')].find(
        (p) => p.querySelector('svg#globe-americas-small')
      );
      if (tsP) post_date = relToIso(tsP.textContent || '');

      if (!author_display && !body) continue;

      out.push({
        platform: 'linkedin',
        url,
        author_handle,
        author_display,
        author_profile,
        author_bio,
        post_date,
        title: null,
        body,
        engagement: {
          // SDUI defers reaction/comment/repost counts to a sub-component
          // fetch; counts are not present on the initial DOM.
          reactions: null,
          comments: null,
          reposts: null,
        },
        thread_context: null,
        scraped_at: new Date().toISOString(),
        source: 'linkedin-browser-sdui',
      });
    }

    return out;
  });
}
