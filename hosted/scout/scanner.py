# Content Scout — Source scanner
# Scans all enabled sources for content matching the config's search terms.

import asyncio
import logging
import os
from datetime import datetime, timezone

import httpx

logger = logging.getLogger("content-scout.scanner")

# Timeout for HTTP requests
REQUEST_TIMEOUT = 30.0

# Delay between requests to the same API to avoid rate limiting / bot detection
REQUEST_DELAY = 1.5  # seconds between sequential calls to the same source

# Realistic browser User-Agent — prevents bot detection on Google, Medium, Reddit, etc.
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
}


def _api_headers(**overrides) -> dict:
    """Build request headers with realistic User-Agent plus any overrides."""
    headers = dict(DEFAULT_HEADERS)
    headers.update(overrides)
    return headers


async def _rate_limited_delay():
    """Sleep between requests to avoid triggering bot detection."""
    await asyncio.sleep(REQUEST_DELAY)


async def scan_all_sources(config: dict, start_date: datetime) -> list[dict]:
    """
    Scan all enabled sources in parallel and return raw content items.

    Each item is a dict with: title, url, date, author, source, summary, tags (optional).
    """
    networks = config.get("networks", {})
    search_terms = config.get("search_terms", [])
    hashtags = config.get("hashtags", [])

    if not search_terms:
        logger.warning("No search terms configured — scanning will find nothing.")
        return []

    tasks = []

    # Blog sources
    if networks.get("Dev.to", True):
        tasks.append(scan_devto(search_terms))
    if networks.get("Medium", True):
        tasks.append(scan_medium(search_terms))
    if networks.get("Hashnode", True):
        tasks.append(scan_hashnode(search_terms))

    # GitHub
    if networks.get("GitHub", True):
        tasks.append(scan_github(search_terms, config))

    # YouTube
    if networks.get("YouTube", True):
        api_key = os.getenv("YOUTUBE_API_KEY")
        if api_key:
            tasks.append(scan_youtube(search_terms, api_key, config))
        else:
            logger.info("YouTube API key not set — skipping YouTube.")

    # Conversation sources (Stack Overflow, Reddit, Hacker News)
    if networks.get("Stack Overflow", True):
        tasks.append(scan_stackoverflow(search_terms))
    if networks.get("Reddit", True):
        tasks.append(scan_reddit(search_terms))
    if networks.get("Hacker News", True):
        tasks.append(scan_hackernews(search_terms))

    # Social platforms
    if networks.get("Bluesky", True):
        handle = os.getenv("BLUESKY_HANDLE")
        password = os.getenv("BLUESKY_APP_PASSWORD")
        if handle and password:
            tasks.append(scan_bluesky(search_terms, hashtags, handle, password))
        else:
            logger.info("Bluesky credentials not set — skipping Bluesky.")

    if networks.get("X/Twitter", True):
        bearer = os.getenv("X_BEARER_TOKEN")
        if bearer:
            tasks.append(scan_x_twitter(search_terms, hashtags, bearer))
        else:
            logger.info("X bearer token not set — skipping X/Twitter.")

    # Run all scanners in parallel
    results = await asyncio.gather(*tasks, return_exceptions=True)

    all_items = []
    for result in results:
        if isinstance(result, Exception):
            logger.error(f"Scanner error: {result}")
        elif isinstance(result, list):
            all_items.extend(result)

    logger.info(f"Total raw items from all sources: {len(all_items)}")
    return all_items


# ---------------------------------------------------------------------------
# Individual source scanners
# Each returns a list of dicts: {title, url, date, author, source, summary}
# ---------------------------------------------------------------------------

async def scan_devto(search_terms: list[str]) -> list[dict]:
    """Scan Dev.to via RSS/API."""
    items = []
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, headers=_api_headers()) as client:
        for i, term in enumerate(search_terms):
            if i > 0:
                await _rate_limited_delay()
            tag = term.lower().replace(" ", "").replace("-", "")
            url = f"https://dev.to/api/articles?tag={tag}&top=30"
            try:
                resp = await client.get(url)
                resp.raise_for_status()
                for article in resp.json():
                    items.append({
                        "title": article.get("title", ""),
                        "url": article.get("url", ""),
                        "date": article.get("published_at", ""),
                        "author": article.get("user", {}).get("name", ""),
                        "source": "Dev.to",
                        "summary": article.get("description", ""),
                    })
            except Exception as e:
                logger.warning(f"Dev.to scan failed for '{term}': {e}")
    return items


async def scan_medium(search_terms: list[str]) -> list[dict]:
    """Scan Medium via RSS feed."""
    items = []
    async with httpx.AsyncClient(
        timeout=REQUEST_TIMEOUT, follow_redirects=True, headers=_api_headers()
    ) as client:
        for i, term in enumerate(search_terms):
            if i > 0:
                await _rate_limited_delay()
            tag = term.lower().replace(" ", "-")
            url = f"https://medium.com/feed/tag/{tag}"
            try:
                resp = await client.get(url)
                resp.raise_for_status()
                # Parse RSS XML — simplified extraction
                import xml.etree.ElementTree as ET
                root = ET.fromstring(resp.text)
                for item_el in root.findall(".//item"):
                    items.append({
                        "title": _xml_text(item_el, "title"),
                        "url": _xml_text(item_el, "link"),
                        "date": _xml_text(item_el, "pubDate"),
                        "author": _xml_text(item_el, "dc:creator") or _xml_text(item_el, "author"),
                        "source": "Medium",
                        "summary": "",
                    })
            except Exception as e:
                logger.warning(f"Medium scan failed for '{term}': {e}")
    return items


async def scan_hashnode(search_terms: list[str]) -> list[dict]:
    """Scan Hashnode via search."""
    # TODO: Implement Hashnode GraphQL search
    logger.info("Hashnode scanning — not yet implemented.")
    return []


async def scan_github(search_terms: list[str], config: dict) -> list[dict]:
    """Scan GitHub for community repos."""
    items = []
    excluded_repos = set(config.get("excluded_repos", []))
    async with httpx.AsyncClient(
        timeout=REQUEST_TIMEOUT,
        headers=_api_headers(Accept="application/vnd.github.v3+json"),
    ) as client:
        for i, term in enumerate(search_terms):
            if i > 0:
                await _rate_limited_delay()
            url = f"https://api.github.com/search/repositories?q={term}&sort=updated&order=desc&per_page=30"
            try:
                resp = await client.get(url)
                resp.raise_for_status()
                for repo in resp.json().get("items", []):
                    full_name = repo.get("full_name", "")
                    if full_name in excluded_repos:
                        continue
                    if repo.get("fork"):
                        continue
                    items.append({
                        "title": repo.get("full_name", ""),
                        "url": repo.get("html_url", ""),
                        "date": repo.get("pushed_at", ""),
                        "author": repo.get("owner", {}).get("login", ""),
                        "source": "GitHub",
                        "summary": repo.get("description", "") or "",
                        "stars": repo.get("stargazers_count", 0),
                        "language": repo.get("language", ""),
                    })
            except Exception as e:
                logger.warning(f"GitHub scan failed for '{term}': {e}")
    return items


async def scan_youtube(search_terms: list[str], api_key: str, config: dict) -> list[dict]:
    """Scan YouTube Data API v3 with rate limiting to avoid bot detection."""
    items = []
    excluded_channel = config.get("official_youtube_channel", "")
    async with httpx.AsyncClient(
        timeout=REQUEST_TIMEOUT,
        headers=_api_headers(Referer="https://content-scout.dev"),
    ) as client:
        for i, term in enumerate(search_terms):
            # Rate limit: Google is aggressive about bot detection
            if i > 0:
                await asyncio.sleep(2.0)  # Longer delay for Google APIs
            url = (
                f"https://www.googleapis.com/youtube/v3/search"
                f"?part=snippet&q={term}&type=video&order=date&maxResults=25&key={api_key}"
            )
            try:
                resp = await client.get(url)
                resp.raise_for_status()
                for item_data in resp.json().get("items", []):
                    snippet = item_data.get("snippet", {})
                    channel = snippet.get("channelTitle", "")
                    if excluded_channel and excluded_channel.lower() in channel.lower():
                        continue
                    # Skip videos with no description
                    desc = snippet.get("description", "")
                    if not desc.strip():
                        continue
                    video_id = item_data.get("id", {}).get("videoId", "")
                    items.append({
                        "title": snippet.get("title", ""),
                        "url": f"https://www.youtube.com/watch?v={video_id}",
                        "date": snippet.get("publishedAt", ""),
                        "author": channel,
                        "source": "YouTube",
                        "summary": desc[:200],
                    })
            except Exception as e:
                logger.warning(f"YouTube scan failed for '{term}': {e}")
    return items


async def scan_stackoverflow(search_terms: list[str]) -> list[dict]:
    """Scan Stack Overflow public API v2.3."""
    items = []
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, headers=_api_headers()) as client:
        for i, term in enumerate(search_terms):
            if i > 0:
                await _rate_limited_delay()
            tag = term.lower().replace(" ", "-")
            url = (
                f"https://api.stackexchange.com/2.3/questions"
                f"?order=desc&sort=creation&tagged={tag}&site=stackoverflow&pagesize=30"
                f"&filter=withbody"
            )
            try:
                resp = await client.get(url)
                resp.raise_for_status()
                for q in resp.json().get("items", []):
                    owner = q.get("owner", {})
                    author_name = owner.get("display_name", "")
                    author_profile = owner.get("link", "")
                    reputation = owner.get("reputation", 0)
                    items.append({
                        "title": q.get("title", ""),
                        "url": q.get("link", ""),
                        "date": datetime.fromtimestamp(
                            q.get("creation_date", 0), tz=timezone.utc
                        ).isoformat(),
                        "author": author_name,
                        "author_handle": author_name,
                        "author_profile": author_profile,
                        "author_context": f"Reputation: {reputation:,}" if reputation else "",
                        "source": "Stack Overflow",
                        "summary": "",
                        "answer_count": q.get("answer_count", 0),
                        "score": q.get("score", 0),
                        "view_count": q.get("view_count", 0),
                        "tags": q.get("tags", []),
                        "is_conversation": True,
                    })
            except Exception as e:
                logger.warning(f"Stack Overflow scan failed for '{term}': {e}")
    return items


async def scan_reddit(search_terms: list[str]) -> list[dict]:
    """Scan Reddit via OAuth2 app-only auth."""
    client_id = os.getenv("REDDIT_CLIENT_ID")
    client_secret = os.getenv("REDDIT_CLIENT_SECRET")
    if not client_id or not client_secret:
        logger.info("Reddit credentials not set — skipping Reddit.")
        return []

    items = []
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        # OAuth2 app-only token
        auth_resp = await client.post(
            "https://www.reddit.com/api/v1/access_token",
            data={"grant_type": "client_credentials"},
            auth=(client_id, client_secret),
            headers={"User-Agent": "ContentScout/1.0"},
        )
        if auth_resp.status_code != 200:
            logger.warning(f"Reddit OAuth2 failed: {auth_resp.status_code}")
            return []

        token = auth_resp.json().get("access_token")
        headers = {
            "Authorization": f"Bearer {token}",
            "User-Agent": "ContentScout/1.0",
        }

        for term in search_terms:
            url = f"https://oauth.reddit.com/search?q={term}&sort=new&limit=25&type=link"
            try:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                for post in resp.json().get("data", {}).get("children", []):
                    data = post.get("data", {})
                    permalink = f"https://www.reddit.com{data.get('permalink', '')}"
                    author = data.get("author", "[deleted]")
                    items.append({
                        "title": data.get("title", ""),
                        "url": permalink,
                        "date": datetime.fromtimestamp(
                            data.get("created_utc", 0), tz=timezone.utc
                        ).isoformat(),
                        "author": author,
                        "author_handle": f"u/{author}",
                        "author_profile": f"https://www.reddit.com/user/{author}",
                        "source": "Reddit",
                        "summary": (data.get("selftext", "") or "")[:300],
                        "subreddit": data.get("subreddit_name_prefixed", ""),
                        "score": data.get("score", 0),
                        "num_comments": data.get("num_comments", 0),
                        "upvote_ratio": data.get("upvote_ratio", 0),
                        "is_conversation": True,
                    })
            except Exception as e:
                logger.warning(f"Reddit scan failed for '{term}': {e}")
    return items


async def scan_hackernews(search_terms: list[str]) -> list[dict]:
    """Scan Hacker News via Algolia API."""
    items = []
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, headers=_api_headers()) as client:
        for i, term in enumerate(search_terms):
            if i > 0:
                await _rate_limited_delay()
            url = f"https://hn.algolia.com/api/v1/search_by_date?query={term}&tags=story&hitsPerPage=25"
            try:
                resp = await client.get(url)
                resp.raise_for_status()
                for hit in resp.json().get("hits", []):
                    author = hit.get("author", "")
                    object_id = hit.get("objectID", "")
                    items.append({
                        "title": hit.get("title", ""),
                        "url": hit.get("url") or f"https://news.ycombinator.com/item?id={object_id}",
                        "date": hit.get("created_at", ""),
                        "author": author,
                        "author_handle": author,
                        "author_profile": f"https://news.ycombinator.com/user?id={author}" if author else "",
                        "source": "Hacker News",
                        "summary": "",
                        "points": hit.get("points", 0),
                        "num_comments": hit.get("num_comments", 0),
                        "hn_link": f"https://news.ycombinator.com/item?id={object_id}",
                        "is_conversation": True,
                    })
            except Exception as e:
                logger.warning(f"Hacker News scan failed for '{term}': {e}")
    return items


async def scan_bluesky(
    search_terms: list[str], hashtags: list[str], handle: str, password: str
) -> list[dict]:
    """Scan Bluesky via AT Protocol."""
    # TODO: Implement authenticated Bluesky search
    logger.info("Bluesky scanning — not yet implemented.")
    return []


async def scan_x_twitter(
    search_terms: list[str], hashtags: list[str], bearer_token: str
) -> list[dict]:
    """Scan X/Twitter via API v2."""
    # TODO: Implement X/Twitter search with bearer token
    logger.info("X/Twitter scanning — not yet implemented.")
    return []


def _xml_text(element, tag: str) -> str:
    """Extract text from an XML element."""
    el = element.find(tag)
    if el is not None and el.text:
        return el.text.strip()
    # Try with namespace
    for ns_tag in [f"{{{ns}}}{tag.split(':')[-1]}" for ns in [
        "http://purl.org/dc/elements/1.1/",
        "http://www.w3.org/2005/Atom",
    ]]:
        el = element.find(ns_tag)
        if el is not None and el.text:
            return el.text.strip()
    return ""
