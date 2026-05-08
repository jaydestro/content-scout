// X / Twitter — logged-in browser scraper.
// Strategy:
//   1. Navigate to https://x.com/search?q={term}&src=typed_query&f=live
//   2. Scroll to load tweets; collect article elements
//   3. For each article, extract permalink, author handle, text, post time,
//      and engagement counts from the visible UI
//   4. De-dupe by tweet URL across search terms
//
// Pure DOM scraping — no API calls — so X tos for personal/research browsing
// applies. We respect a 3s+ delay between page loads and a hard 25 results
// per term cap by default.

import { newPage, sleep } from '../lib/browser.mjs';

export async function openXLogin(browser) {
  const page = await newPage(browser);
  await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });
}

export async function scanX(browser, ctx) {
  const { searchTerms, sinceMs, maxPerTerm } = ctx;
  const items = new Map(); // url -> item

  const page = await newPage(browser);

  // Quick session probe — if we land on /login, the cookies are gone.
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  if (/\/login|\/i\/flow\/login/.test(page.url())) {
    console.warn('[browser-scan] x: session expired — run "node index.mjs login --platform x"');
    await page.close();
    return [];
  }

  for (const term of searchTerms) {
    const url = `https://x.com/search?q=${encodeURIComponent(term)}&src=typed_query&f=live`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      console.warn(`[browser-scan] x: navigation failed for "${term}": ${e.message}`);
      continue;
    }
    // Wait for at least one article to render, or fail fast on rate-limit page.
    try {
      await page.waitForSelector('article[data-testid="tweet"], div[data-testid="cellInnerDiv"]', { timeout: 15000 });
    } catch {
      console.warn(`[browser-scan] x: no results rendered for "${term}" (rate-limit or empty)`);
      await sleep(3500);
      continue;
    }
    // Scroll a few times to load more tweets
    let collected = 0;
    let lastHeight = 0;
    for (let scroll = 0; scroll < 6 && collected < maxPerTerm; scroll++) {
      const tweets = await extractTweetsOnPage(page);
      for (const t of tweets) {
        if (!t.url || items.has(t.url)) continue;
        if (sinceMs && t.post_date && new Date(t.post_date).getTime() < sinceMs) continue;
        t.search_term = term;
        items.set(t.url, t);
        collected++;
        if (collected >= maxPerTerm) break;
      }
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h === lastHeight) break;
      lastHeight = h;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
      await sleep(1500);
    }
    await sleep(3000); // polite delay between search terms
  }

  await page.close();
  return [...items.values()];
}

async function extractTweetsOnPage(page) {
  return page.evaluate(() => {
    const out = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const a of articles) {
      // Permalink: the <a> wrapping the timestamp
      const timeEl = a.querySelector('time');
      const linkEl = timeEl ? timeEl.closest('a') : null;
      const url = linkEl && linkEl.href ? linkEl.href.split('?')[0] : null;
      const post_date = timeEl ? timeEl.getAttribute('datetime') : null;

      // Author block: data-testid="User-Name" contains display name + @handle
      const userBlock = a.querySelector('[data-testid="User-Name"]');
      let author_handle = null;
      let author_display = null;
      if (userBlock) {
        const spans = userBlock.querySelectorAll('span');
        for (const s of spans) {
          const t = s.textContent || '';
          if (t.startsWith('@') && !author_handle) author_handle = t.trim();
        }
        const displayEl = userBlock.querySelector('span');
        if (displayEl) author_display = (displayEl.textContent || '').trim();
      }

      // Tweet text
      const textEl = a.querySelector('[data-testid="tweetText"]');
      const body = textEl ? textEl.innerText.trim() : '';

      // Engagement counts — buttons with data-testid="reply"|"retweet"|"like"
      const numFromBtn = (sel) => {
        const btn = a.querySelector(`[data-testid="${sel}"]`);
        if (!btn) return null;
        const n = btn.textContent.trim().replace(/[^\d.,KMB]/g, '');
        if (!n) return 0;
        // Convert "1.2K" / "3M" -> integer
        const m = n.match(/^([\d.]+)([KMB])?$/);
        if (!m) return null;
        const base = parseFloat(m[1]);
        const mult = m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : m[2] === 'B' ? 1e9 : 1;
        return Math.round(base * mult);
      };

      out.push({
        platform: 'x',
        url,
        author_handle,
        author_display,
        author_bio: null,
        post_date,
        title: null,
        body,
        engagement: {
          replies: numFromBtn('reply'),
          retweets: numFromBtn('retweet'),
          likes: numFromBtn('like'),
          views: null,
        },
        thread_context: null,
        scraped_at: new Date().toISOString(),
        source: 'x-browser',
      });
    }
    return out.filter((t) => t.url);
  });
}
