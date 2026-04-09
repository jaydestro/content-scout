# API Keys

All API keys are optional. Without them, the agent skips those sources and scans everything else. Most sources (blogs, GitHub, Stack Overflow, Reddit, Hacker News, LinkedIn, and all custom sources) work without any keys.

---

## Summary

| Service | Cost | Without It |
|---------|------|-----------|
| YouTube Data API v3 | Free | YouTube scanning skipped — community videos won't appear in reports |
| Bluesky | Free | Bluesky scanning skipped — mentions and hashtag posts won't be tracked |
| X/Twitter | $200/mo (Basic) or free tier (limited) | X/Twitter scanning skipped — conversations and mentions won't be tracked |

---

## YouTube Data API v3

**Cost:** Free

### Setup
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or select an existing one)
3. Navigate to **APIs & Services** → **Library**
4. Search for "YouTube Data API v3" and click **Enable**
5. Go to **APIs & Services** → **Credentials**
6. Click **Create Credentials** → **API Key**
7. Copy the key

### Usage Limits
- 10,000 units/day (free)
- A search request costs 100 units
- That's ~100 searches/day — more than enough for monthly scans

### In Content Scout
When you select YouTube during onboarding, the agent asks for this key. Paste it or say "skip". Stored in your config under `## API Keys`.

---

## Bluesky

**Cost:** Free

### Setup
1. Go to [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords)
2. Click **Add App Password**
3. Give it a name (e.g., "Content Scout")
4. Copy the generated password

### In Content Scout
When you select Bluesky during onboarding, the agent asks for your handle and app password. Stored in your config under `## API Keys`.

> **Note:** This is an app-specific password, not your main Bluesky password. You can revoke it anytime from the same settings page.

---

## X/Twitter

**Cost:** Basic plan $200/mo recommended. Free tier exists but is typically too limited.

### Setup
1. Go to [developer.x.com](https://developer.x.com/)
2. Sign up for a developer account
3. Create an app (or use an existing one)
4. Go to your app's **Keys and Tokens** section
5. Generate a **Bearer Token**
6. Copy the token

### Plan Comparison

| Plan | Cost | Search Tweets | Rate Limits |
|------|------|--------------|-------------|
| Free | $0 | 1 app, limited endpoints | Very restricted — typically insufficient for content scanning |
| Basic | $200/mo | Full search, recent tweets | 10,000 reads/mo — sufficient for monthly scans |
| Pro | $5,000/mo | Full archive search | Overkill for Content Scout |

The Basic plan is recommended. The free tier's rate limits usually prevent meaningful scanning of conversations and mentions.

### In Content Scout
When you select X/Twitter during onboarding, the agent asks for your bearer token. Paste it or say "skip". Stored in your config under `## API Keys`.

---

## Security

- Config files containing API keys are **gitignored by default** (`.github/prompts/scout-config-*.prompt.md`, except the example template)
- Never commit API keys to a public repository
- The example config (`scout-config-example.prompt.md`) uses placeholder values and is safe to commit
- Bluesky app passwords can be revoked anytime from your Bluesky settings
- YouTube API keys can be restricted by HTTP referrer or IP in Google Cloud Console
- X bearer tokens can be regenerated from the developer portal

---

## Sources That Don't Need Keys

These all work out of the box:

| Source | API Used |
|--------|----------|
| Dev.to, Medium, Hashnode, DZone, C# Corner, InfoQ | RSS feeds |
| GitHub | Public search API |
| Stack Overflow | Public API v2.3 (300 req/day free) |
| Reddit | Public JSON API (append `.json` to any URL) |
| Hacker News | Public Algolia API |
| LinkedIn | Best-effort public search |
| Custom sources (blogs, feeds, docs) | Direct HTTP/RSS |
