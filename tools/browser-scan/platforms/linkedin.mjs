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
// Selector notes (verified May 2026 against live linkedin.com):
//   - The `.update-components-actor` wrapper class no longer exists as a
//     stable selector — LinkedIn ships a randomized hash class on it.
//     ALWAYS query the `.update-components-actor__*` child classes
//     directly on the post container.
//   - LinkedIn does not expose absolute timestamps in the DOM. We
//     reconstruct ISO from the relative string (e.g. "19m", "3d", "2w",
//     "1mo") against `now`.

import { newPage, sleep } from '../lib/browser.mjs';
import { buildSearchQuery } from '../lib/query.mjs';

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
  if (/\/login|\/checkpoint|\/uas\/login|\/authwall/.test(page.url())) {
    console.warn('[browser-scan] linkedin: session expired — sign in to LinkedIn in the Edge tab and re-run.');
    if (ownsPage) await page.close();
    return [];
  }

  for (const term of searchTerms) {
    const query = buildSearchQuery(term, 'linkedin');
    if (!query) continue;
    const url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(query)}&datePosted=%22past-month%22&sortBy=%22date_posted%22`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      console.warn(`[browser-scan] linkedin: navigation failed for "${term}": ${e.message}`);
      continue;
    }
    try {
      await page.waitForSelector('div.feed-shared-update-v2[data-urn^="urn:li:activity"]', { timeout: 15000 });
    } catch {
      console.warn(`[browser-scan] linkedin: no results rendered for "${term}"`);
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
    const containers = document.querySelectorAll(
      'div.feed-shared-update-v2[data-urn^="urn:li:activity"]'
    );

    for (const c of containers) {
      // Permalink from URN
      const urn = c.getAttribute('data-urn') || '';
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

    return out;
  });
}
