// Reddit — logged-in browser scraper.
//
// Strategy:
//   1. Navigate to https://www.reddit.com/search/?q={term}&type=link&sort=new&t=month
//      (multi-word terms get wrapped in "..." for phrase matching by
//      lib/query.mjs; hashtags get the # stripped because reddit doesn't
//      index hashtags.)
//   2. Scroll to load more results
//   3. Each result card is `div[data-testid="search-post-unit"]`. The
//      `<search-telemetry-tracker data-faceplate-tracking-context="...">`
//      element inside each card holds a JSON blob with the post id,
//      title, author, and subreddit — pull from that for clean extraction.
//   4. Date comes from the inner `<time datetime="...">` element (faceplate-timeago).
//   5. Score / comment counts come from sibling spans that match
//      `\d+\s*(vote|comment)s?`.
//   6. De-dupe by permalink across search terms.
//
// Selector notes (verified May 2026):
//   - <shreddit-post> is no longer used on the search results page (it
//     still exists in subreddit feeds). Search uses native HTML cards.
//   - The title text ships inside <faceplate-screen-reader-content>; using
//     the JSON blob avoids HTML decoding issues.

import { newPage, sleep } from '../lib/browser.mjs';
import { buildSearchQuery } from '../lib/query.mjs';

export async function openRedditLogin(browser) {
  const page = await newPage(browser);
  await page.goto('https://www.reddit.com/login/', { waitUntil: 'domcontentloaded' });
}

export async function scanReddit(browser, ctx) {
  const { searchTerms, sinceMs, maxPerTerm } = ctx;
  const items = new Map();
  // Reuse a caller-provided page when present so the whole scan can run
  // inside a single Edge tab (less visible flicker for the user).
  const page = ctx.page || (await newPage(browser));
  const ownsPage = !ctx.page;

  await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  if (/\/login\//.test(page.url())) {
    console.warn('[browser-scan] reddit: session expired — sign in to Reddit in the Edge tab and re-run.');
    if (ownsPage) await page.close();
    return [];
  }

  for (const term of searchTerms) {
    const query = buildSearchQuery(term, 'reddit');
    if (!query) continue;
    const url = `https://www.reddit.com/search/?q=${encodeURIComponent(query)}&type=link&sort=new&t=month`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      console.warn(`[browser-scan] reddit: navigation failed for "${term}": ${e.message}`);
      continue;
    }
    try {
      await page.waitForSelector('div[data-testid="search-post-unit"], a[data-testid="post-title"]', { timeout: 15000 });
    } catch {
      console.warn(`[browser-scan] reddit: no results rendered for "${term}"`);
      await sleep(3500);
      continue;
    }

    let collected = 0;
    let lastHeight = 0;
    for (let scroll = 0; scroll < 6 && collected < maxPerTerm; scroll++) {
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
    await sleep(3000); // polite delay between search terms
  }

  if (ownsPage) await page.close();
  return [...items.values()];
}

async function extractPostsOnPage(page) {
  return page.evaluate(() => {
    const out = [];
    const cards = document.querySelectorAll('div[data-testid="search-post-unit"]');

    for (const card of cards) {
      // Pull the rich JSON blob shipped on the telemetry tracker —
      // contains post.id, post.title, profile.name, subreddit.name in one shot.
      const tracker = card.querySelector('search-telemetry-tracker[data-faceplate-tracking-context]');
      let trackerData = null;
      if (tracker) {
        try { trackerData = JSON.parse(tracker.getAttribute('data-faceplate-tracking-context')); }
        catch { /* fall back to DOM scraping below */ }
      }

      // Permalink — the post-title anchor's href is /r/{sub}/comments/{id}/{slug}/
      const titleAnchor = card.querySelector('a[data-testid="post-title"]');
      if (!titleAnchor) continue;
      const href = titleAnchor.getAttribute('href') || '';
      if (!href.includes('/comments/')) continue;
      const url = new URL(href, 'https://www.reddit.com').href.split('?')[0];

      const title = trackerData?.post?.title
        || titleAnchor.getAttribute('aria-label')
        || titleAnchor.textContent.trim();

      const subreddit = trackerData?.subreddit?.name
        ? `r/${trackerData.subreddit.name}`
        : (href.match(/^\/r\/([^/]+)/)?.[1] ? `r/${href.match(/^\/r\/([^/]+)/)[1]}` : null);

      const author = trackerData?.profile?.name || null;
      const author_handle = author ? `u/${author}` : null;

      // Date — <time datetime="...">
      const timeEl = card.querySelector('time[datetime]');
      const post_date = timeEl ? timeEl.getAttribute('datetime') : null;

      // Score + comments — sibling spans with "N votes" / "N comments" text.
      let score = 0;
      let comment_count = 0;
      for (const span of card.querySelectorAll('span')) {
        const t = (span.textContent || '').trim();
        const voteM = t.match(/^(\d[\d,]*)\s*votes?$/i);
        if (voteM) score = parseInt(voteM[1].replace(/,/g, ''), 10);
        const cmtM = t.match(/^(\d[\d,]*)\s*comments?$/i);
        if (cmtM) comment_count = parseInt(cmtM[1].replace(/,/g, ''), 10);
      }

      out.push({
        platform: 'reddit',
        url,
        author_handle,
        author_display: author,
        author_bio: null,
        post_date,
        title,
        body: '', // search cards don't include body text; agent can fetch if needed
        engagement: {
          score,
          comments: comment_count,
        },
        thread_context: subreddit,
        subreddit,
        scraped_at: new Date().toISOString(),
        source: 'reddit-browser',
      });
    }
    return out;
  });
}
