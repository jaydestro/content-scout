// Reddit — logged-in browser scraper.
// Strategy:
//   1. Navigate to https://www.reddit.com/search/?q={term}&type=link&sort=new&t=month
//      (the new reddit "shreddit" UI exposes posts as <shreddit-post> elements
//      with rich attributes that include score, comment count, and timestamp)
//   2. Scroll to load more results; collect post elements
//   3. Extract permalink, subreddit, author, post date, title, body, engagement
//   4. De-dupe by permalink across search terms
//
// We use new reddit (www.reddit.com) when logged in because it surfaces more
// of the long-tail search results than old.reddit search does, and avoids the
// 403/429 the unauth Layer 1/2 cascade hits. Logged-in HTML is also stable
// because reddit ships post metadata as element attributes for accessibility.

import { newPage, sleep } from '../lib/browser.mjs';

export async function openRedditLogin(browser) {
  const page = await newPage(browser);
  await page.goto('https://www.reddit.com/login/', { waitUntil: 'domcontentloaded' });
}

export async function scanReddit(browser, ctx) {
  const { searchTerms, sinceMs, maxPerTerm } = ctx;
  const items = new Map();
  const page = await newPage(browser);

  await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  // If we get bounced to /login the session is dead.
  if (/\/login\//.test(page.url())) {
    console.warn('[browser-scan] reddit: session expired — run "node index.mjs login --platform reddit"');
    await page.close();
    return [];
  }

  for (const term of searchTerms) {
    const url = `https://www.reddit.com/search/?q=${encodeURIComponent(term)}&type=link&sort=new&t=month`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      console.warn(`[browser-scan] reddit: navigation failed for "${term}": ${e.message}`);
      continue;
    }
    try {
      await page.waitForSelector('shreddit-post, article a[data-testid="post-title"], a[slot="title"]', { timeout: 15000 });
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
    await sleep(3000);
  }

  await page.close();
  return [...items.values()];
}

async function extractPostsOnPage(page) {
  return page.evaluate(() => {
    const out = [];
    // New reddit ships <shreddit-post> with attributes for almost everything.
    const posts = document.querySelectorAll('shreddit-post');
    for (const p of posts) {
      const permalink = p.getAttribute('permalink');
      const url = permalink ? new URL(permalink, 'https://www.reddit.com').href : null;
      const subreddit = p.getAttribute('subreddit-prefixed-name') || p.getAttribute('subreddit-name') || null;
      const author = p.getAttribute('author');
      const author_handle = author ? `u/${author}` : null;
      const post_date = p.getAttribute('created-timestamp') || null;
      const title = p.getAttribute('post-title') || p.querySelector('a[slot="title"]')?.textContent?.trim() || null;
      const score = parseInt(p.getAttribute('score') || '0', 10) || 0;
      const comment_count = parseInt(p.getAttribute('comment-count') || '0', 10) || 0;
      // Body excerpt — try the inline text slot
      const bodyEl = p.querySelector('[slot="text-body"]') || p.querySelector('div[id*="post-rtjson-content"]');
      const body = bodyEl ? bodyEl.innerText.trim().slice(0, 1200) : '';

      if (!url) continue;
      out.push({
        platform: 'reddit',
        url,
        author_handle,
        author_display: author,
        author_bio: null,
        post_date,
        title,
        body,
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
    // Fallback for the legacy "faceplate" search result cards if shreddit-post
    // is absent on a given results page.
    if (out.length === 0) {
      const cards = document.querySelectorAll('faceplate-tracker[data-testid="search-post"], [data-testid="post-container"]');
      for (const c of cards) {
        const a = c.querySelector('a[href*="/comments/"]');
        if (!a) continue;
        const url = a.href.split('?')[0];
        const title = a.textContent?.trim() || null;
        out.push({
          platform: 'reddit',
          url,
          author_handle: null,
          author_display: null,
          author_bio: null,
          post_date: null,
          title,
          body: '',
          engagement: {},
          thread_context: null,
          subreddit: null,
          scraped_at: new Date().toISOString(),
          source: 'reddit-browser',
        });
      }
    }
    return out;
  });
}
