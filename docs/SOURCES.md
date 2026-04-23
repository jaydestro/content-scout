# Content Sources

Content Scout scans public sources across the developer ecosystem. Sources are organized into standard sources (available to everyone) and custom sources (configured per product during onboarding).

---

## Standard Sources (1-14)

Select all or pick individually during onboarding.

| # | Source | Category | Auth Required | How It's Scanned |
|---|--------|----------|---------------|-----------------|
| 1 | YouTube | Video | YouTube Data API v3 key (free) | Search by product terms, exclude official channel |
| 2 | GitHub | Code | None | Search API for repos, README validation, SDK detection |
| 3 | Dev.to | Blog | None (RSS) | Search by tags and keywords |
| 4 | Medium | Blog | None (RSS) | Search by tags and keywords |
| 5 | Hashnode | Blog | None (RSS) | Search by tags and keywords |
| 6 | DZone | Blog | None (RSS) | Search by keywords |
| 7 | C# Corner | Blog | None (RSS) | Search by keywords |
| 8 | InfoQ | Blog | None (RSS) | Search by keywords |
| 9 | Stack Overflow | Forum | None (public API v2.3, 300 req/day free) | Questions tagged with product terms |
| 10 | Reddit | Forum | OAuth2 app credentials (free) | Posts in relevant subreddits. Register at reddit.com/prefs/apps |
| 11 | Hacker News | Forum | None (public Algolia API) | Submissions and comments mentioning product |
| 12 | Bluesky | Social | App password (free) | Authenticated search by product terms, hashtags, mentions |
| 13 | LinkedIn | Social | None | Best-effort search by product name |
| 14 | X/Twitter | Social | X API bearer token ($200/mo Basic recommended) | Authenticated search by terms, hashtags, mentions. Without a key, best-effort public search is attempted but may be blocked. |

### Community Blog Platforms

In addition to the 6 named blog platforms above, the agent also checks **Blogspot** and **WordPress** blogs when they appear in search results. These aren't separate selectable sources — they're part of the general community blog scanning.

---

## Custom Sources

Configured during onboarding per product. Four types:

| Type | Description | Example |
|------|-------------|---------|
| `blog` | Vendor or team blog | `https://techcommunity.microsoft.com/tag/azure-functions` |
| `update-feed` | Product update or changelog feed | `https://azure.microsoft.com/updates/?query=azure+functions` |
| `docs` | Official documentation site | `https://learn.microsoft.com/azure/azure-functions/` |
| `influencer` | Individual blogger or content creator | `https://devblogs.microsoft.com/cosmosdb/author/mark-brown/` |

Custom sources are scanned alongside standard sources. There's no limit to how many you can add.

---

## What Each Source Produces

### Blog & Article Sources
- Title, author, publication date, URL
- Summary/excerpt
- Topic tags (matched to your canonical set)
- Quality score (depth + practical value + originality)

### YouTube
- Video title, channel name, publish date, URL
- Description excerpt
- View count (when available)
- Only community content — your official channel is excluded

### GitHub
- Repo name, owner, description, URL
- README analysis (what the project does, setup instructions)
- SDK/package detection (NuGet, npm, pip, Maven)
- Star count, last commit date
- Additional quality filters (see [Workflow Guide](WORKFLOW.md#github-specific-filters))

### Forum Sources (Stack Overflow, Reddit, Hacker News)
- Thread title, URL, date
- Answer count, vote count
- Tracked as **conversations** — not promoted in the main report
- Classified by sentiment (positive/neutral/negative)
- Flagged if they contain feature requests or pain points

### Social Sources (Bluesky, X/Twitter, LinkedIn)
- Post text, author, date, URL
- Engagement metrics (when available)
- Tracked as **conversations** — same classification as forums
- Mentions from influencers in your watchlist are flagged

---

## Source Authentication

### No Auth Needed
Dev.to, Medium, Hashnode, DZone, C# Corner, InfoQ, GitHub, Stack Overflow, Reddit, Hacker News, LinkedIn, and all custom sources work without any API keys.

### Free Auth
- **YouTube Data API v3** — free key from Google Cloud Console. Without it, YouTube scanning is skipped entirely.
- **Bluesky** — free app password from bsky.app settings. Without it, Bluesky scanning is skipped.

### Paid Auth
- **X/Twitter** — requires an API bearer token. The free tier is typically too limited for meaningful scanning. The Basic plan ($200/mo) is recommended. Without it, X/Twitter scanning is skipped.

### How Keys Are Collected

API keys are requested **inline during onboarding** only for sources you select. When you pick YouTube, the agent asks for your API key right then — paste it or say "skip". Keys are stored in your config file, which is gitignored by default.

See [API Keys](API-KEYS.md) for setup instructions.

---

## Scanning Order

When running `/scout-scan`, sources are scanned in this order:

1. Official sources (update feeds, docs) — via `scout-scan-official` subagent
2. YouTube — via `scout-scan-youtube` subagent
3. GitHub — via `scout-scan-github` subagent
4. Blogs (standard + custom + influencer) — via `scout-scan-blogs` subagent
5. Conversations (forums + social) — via `scout-scan-conversations` subagent

If subagents aren't available, the main agent processes these sequentially. Results are merged, deduped, scored, and assembled into the final report.
