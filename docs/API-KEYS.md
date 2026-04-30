# API Keys

All API keys are optional. Without them, the agent skips those sources and scans everything else. Most sources (blogs, GitHub, Stack Overflow, Hacker News, LinkedIn, and all custom sources) work without any keys.

**Keys are stored in `.env` at the workspace root** — not in config files. This means your config can be safely committed and shared. Copy `.env.example` to `.env` and fill in your keys. The `.env` file is gitignored.

---

## Summary

| Service | Cost | Without It |
|---------|------|-----------|
| [YouTube Data API v3](#youtube-data-api-v3) | Free | YouTube scanning skipped — community videos won't appear in reports |
| [Reddit OAuth2](#reddit) | Free (optional) | Falls back to public `.json` endpoint with browser User-Agent + ≥2s delays. Lower volume, more 429 skips, but Reddit still scans. |
| [Bluesky](#bluesky) | Free | Bluesky scanning skipped — mentions and hashtag posts won't be tracked |
| [X/Twitter](#xtwitter) | $200/mo (Basic) or free tier (limited) | X/Twitter scanning skipped — conversations and mentions won't be tracked |
| [GitHub Token](#github-token) | Free | GitHub still works, but unauthenticated requests are capped at 60/hr (vs 5000/hr authenticated) |

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
When you select YouTube during onboarding, the agent asks for this key. Paste it or say "skip". Stored in `.env` as `YOUTUBE_API_KEY`.

---

## Reddit

**Cost:** Free (and **optional** — Content Scout falls back to the public `.json` endpoint when creds are missing).

Reddit OAuth2 app-only (client credentials) auth gives higher rate limits and more reliable scanning, but it's no longer required — Content Scout falls back to the public `.json` endpoint when `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` aren't set. The fallback is lower-volume and 429-prone, but Reddit is never silently dropped.

### Setup
1. Log in to Reddit, then go to [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps/) (or [old.reddit.com/prefs/apps](https://old.reddit.com/prefs/apps/) if the new flow is gated by Reddit's Responsible Builder Policy)
2. Scroll to the bottom and click **are you a developer? create an app...**
3. Fill in the form:
   - **name** — anything (e.g., `content-scout`)
   - **type** — select **script** (this is critical — `web app` and `installed app` use different auth flows)
   - **description** — optional
   - **about url** — leave blank
   - **redirect uri** — `http://localhost:8080` (required field but unused for script apps)
4. Click **create app**
5. Copy two values from the app card that appears:
   - **client ID** — the short string directly under the app name (looks like `aB3xY-zQ12wPqR`)
   - **client secret** — labeled `secret` in the app details

### Usage Limits
- 100 queries per minute per OAuth client (more than enough)
- Free forever for personal/script use

### In Content Scout
When you select Reddit during onboarding, the agent offers to collect a client ID and client secret. Paste them or say "skip" — if skipped, the agent uses the unauthenticated `.json` fallback automatically. Stored in `.env` as `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, and `REDDIT_USER_AGENT` (format: `content-scout/1.0 by <reddit-username>`).

> **Note:** Script apps don't require a username/password for the app-only client-credentials flow Content Scout uses — the client ID + secret is enough to read public content.

---

## Bluesky

**Cost:** Free

### Setup
1. Go to [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords)
2. Click **Add App Password**
3. Give it a name (e.g., "Content Scout")
4. Copy the generated password

### In Content Scout
When you select Bluesky during onboarding, the agent asks for your handle and app password. Stored in `.env` as `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD`.

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
When you select X/Twitter during onboarding, the agent asks for your bearer token. Paste it or say "skip". Stored in `.env` as `X_BEARER_TOKEN`.

---

## GitHub Token

**Cost:** Free

GitHub works without a token, but unauthenticated requests are limited to 60/hour. Adding a personal access token raises that to 5,000/hour — which matters for any meaningful community-repo scan.

### Setup
1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click **Generate new token** → **Generate new token (classic)**
3. Give it a name (e.g., `content-scout`) and an expiration
4. **No scopes needed** — Content Scout only reads public data, so leave every scope unchecked. Public read access works without scopes.
5. Click **Generate token**
6. Copy the token (it's shown only once)

> **Fine-grained tokens** also work. If you prefer those, generate a fine-grained token with **Public repositories (read-only)** access — no other permissions needed.

### In Content Scout
Stored in `.env` as `GITHUB_TOKEN`. The agent uses it automatically if present; otherwise it falls back to unauthenticated requests with a lower rate limit.

---

## Security

- API keys are stored in `.env` at the workspace root, which is **gitignored by default**
- Config files no longer contain API keys — they can be safely committed and shared
- `.env.example` is committed as a template with placeholder values
- Never commit `.env` to a public repository
- Bluesky app passwords can be revoked anytime from your Bluesky settings
- YouTube API keys can be restricted by HTTP referrer or IP in Google Cloud Console
- X bearer tokens can be regenerated from the developer portal

---

## Sources That Don't Need Keys

These all work out of the box:

| Source | API Used |
|--------|----------|
| Dev.to, Medium, Hashnode, DZone, C# Corner, InfoQ | RSS feeds |
| GitHub | Public search API (60 req/hr unauthenticated; set `GITHUB_TOKEN` for 5000/hr) |
| Stack Overflow | Public API v2.3 (300 req/day free) |
| Hacker News | Public Algolia API |
| LinkedIn | Best-effort public search |
| Custom sources (blogs, feeds, docs) | Direct HTTP/RSS |

## Sources That Need Free Auth

| Source | How to Get Credentials | Cost |
|--------|----------------------|------|
| Reddit | **Optional.** Register a "script" app at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps/) (or `old.reddit.com/prefs/apps`) and set `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` / `REDDIT_USER_AGENT` in `.env` for higher limits. Without creds, Content Scout uses the public `.json` fallback. | Free |
| YouTube | Get an API key at [console.cloud.google.com](https://console.cloud.google.com/apis/credentials). Set `YOUTUBE_API_KEY` in `.env`. | Free |
| Bluesky | Create an app password at [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords). Set `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD` in `.env`. | Free |
