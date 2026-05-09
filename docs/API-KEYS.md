# API Keys

All API keys are optional. Without them, the agent skips those sources and scans everything else. Most sources (blogs, GitHub, Stack Overflow, Hacker News, and all custom sources) work without any keys.

**Keys are stored in `.env` at the workspace root** — not in config files. This means your config can be safely committed and shared. Copy `.env.example` to `.env` and fill in your keys. The `.env` file is gitignored.

---

## Summary

| Service | Cost | Without It |
|---------|------|-----------|
| [YouTube Data API v3](#youtube-data-api-v3) | Free | YouTube scanning skipped — community videos won't appear in reports |
| [Reddit OAuth2](#reddit) | Free (optional) | Layered no-auth scanner takes over: browser-scan Layer 0 (opt-in) → `old.reddit.com` RSS → HTML scrape → [Brave Search API](#brave-search-api) → manual import via `/scout-reddit-import`. Reddit is never silently dropped. |
| [Brave Search API](#brave-search-api) | Free (2,000 queries/month) | Reddit Layer 3 / LinkedIn Layer 1 / X Layer 2 fall through — you keep browser-scan Layer 0 + RSS + cascade fallbacks. |
| [Google PSE](#google-pse-legacy) | Legacy (closed to new GCP projects since early 2026) | No effect on new setups — use Brave Search instead. Pre-2026 PSE projects still work as a fallback. |
| [Bluesky](#bluesky) | Free | Bluesky scanning skipped — mentions and hashtag posts won't be tracked |
| [X/Twitter](#xtwitter) | $200/mo (Basic) or free tier (limited) | X Layer 1 (authenticated API) skipped. Layer 0 (browser-scan) still works for free if you've signed in to X via [tools/browser-scan/](../tools/browser-scan); Brave Search Layer 2 still works if `BRAVE_SEARCH_API_KEY` is set. |
| [GitHub Token](#github-token) | Free | GitHub still works, but unauthenticated requests are capped at 60/hr (vs 5000/hr authenticated) |

> **Best free coverage for X / LinkedIn / Reddit:** sign in once via [tools/browser-scan/](../tools/browser-scan) — attaches to your real browser (Edge / Chrome / Brave / Vivaldi / Arc / Opera — auto-detects your OS default) over CDP, no Playwright fingerprint, works with passkeys + 2FA. Either click **🌐 Browser scan (Layer 0)** in the web UI's Run view, or use the CLI in `tools/browser-scan/README.md`. Each `scout scan` then auto-ingests the resulting JSON sidecar as **Layer 0**.

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

Reddit OAuth2 app-only (client credentials) auth gives higher rate limits, but it's NOT required — and Reddit's "Responsible Builder Policy" denies most new app registrations anyway. Content Scout uses a layered no-auth scanner by default: Layer 1 = `old.reddit.com` RSS, Layer 2 = `old.reddit.com` HTML scrape, Layer 3 = [Google Programmable Search Engine](#google-pse) (opt-in), Layer 4 = manual import via `/scout-reddit-import`. Reddit is never silently dropped.

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
When you select Reddit during onboarding, the agent offers to collect a client ID and client secret. Paste them or say "skip" — if skipped, the agent uses the no-auth layered scanner automatically. Stored in `.env` as `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, and `REDDIT_USER_AGENT` (format: `content-scout/1.0 by <reddit-username>`).

---

## Brave Search API

**Cost:** Free — 2,000 queries/month, 1 query/second, no credit card required on the **Free AI** / **Data for Search** plan.

**What it enables:** A single Brave Search API key unlocks free public-web discovery for **three login-walled or paid-only platforms**:

- **Reddit Layer 3** — catches threads in subreddits the user didn't list explicitly (after RSS Layer 1 and HTML Layer 2).
- **LinkedIn Layer 1** — the *primary* free path for LinkedIn. LinkedIn has no public content-search API, but Brave indexes public posts (`linkedin.com/posts/*`) and Pulse articles (`linkedin.com/pulse/*`).
- **X/Twitter Layer 2** — the *primary* free fallback for X. Lets Content Scout discover public tweets without paying $200/mo for the Basic API tier.

All three share the same monthly quota.

### Why Brave instead of Google PSE?

Google's Programmable Search / Custom Search JSON API was **closed to new customers in early 2026** (existing pre-2026 customers supported through Jan 1, 2027). New GCP projects get a permanent 403 *"This project does not have the access to Custom Search JSON API"* regardless of how the project is configured. Brave Search API is the recommended replacement and accepts new customers.

If you already have a working PSE key from a pre-2026 GCP project, you can keep using it (see [Google PSE (legacy)](#google-pse-legacy) below) — Content Scout uses Brave first and falls back to PSE if Brave isn't configured.

### Setup

1. Sign up at https://brave.com/search/api/ — click **Get Started** and pick the **Free AI** plan (2,000 queries/month at $0). No card required for the free tier.
2. Create an API key at https://api.search.brave.com/app/keys — click **Add API Key** and pick the **Free** subscription. Copy the token.
3. Add to `.env`:
   ```
   BRAVE_SEARCH_API_KEY=<token>
   ```
4. Verify with `scout doctor` (or click **Test** next to the key in the web UI).

### Notes

- Free tier rate limit is **1 query per second**. Content Scout enforces a 1.1s sleep between Brave calls to stay under it.
- Free tier monthly limit is **2,000 queries**. A typical daily scan with 3–5 search terms across Reddit + LinkedIn + X uses ~30–60 queries — plenty of headroom.
- If you exceed the monthly quota, Brave returns 429; the affected layer is skipped and the run summary notes it. Other layers continue.
- Brave indexes the open web independently of Google — you'll get different (sometimes better) coverage of `linkedin.com/pulse` and Reddit for niche subreddits.

---

## Google PSE (legacy)

> **Closed to new customers since early 2026.** Existing pre-2026 PSE projects keep working until Jan 1, 2027 (Google's hard sunset date). If you don't already have a working PSE on a pre-2026 GCP project, **skip this section** — use [Brave Search API](#brave-search-api) above instead. Setting `GOOGLE_PSE_KEY` on a new GCP project will return permanent 403 errors no matter how you configure it.

If you have a pre-2026 PSE that still works, Content Scout will use it as a fallback when `BRAVE_SEARCH_API_KEY` is empty. Setup steps:

1. Use your existing API key at https://console.cloud.google.com/apis/credentials, or attempt to enable **Custom Search API** at https://console.cloud.google.com/apis/library/customsearch.googleapis.com (will fail on new projects).
2. Create a Programmable Search Engine at https://programmablesearchengine.google.com/. Under **Sites to search**, add any subset of:
   ```
   reddit.com/*
   linkedin.com/posts/*
   linkedin.com/pulse/*
   x.com/*
   twitter.com/*
   ```
   Copy the **Search engine ID** (the `cx`).
3. Add to `.env`:
   ```
   GOOGLE_PSE_KEY=AIza...
   GOOGLE_PSE_CX=xxxxxxxxxxxx:yyyyyyyy
   ```
4. Verify with `scout doctor`. If you see *"This project does not have the access to Custom Search JSON API"*, your project is on the post-cutoff side — there is no fix; switch to Brave Search.

### Notes (legacy)

- Free tier was 100 queries/day, shared across Reddit, LinkedIn, and X.
- Brave is preferred even for pre-2026 projects because of the higher monthly quota and independent web index.

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

**Cost:** Free — if you set up [Brave Search API](#brave-search-api) (Layer 2) and/or RSSHub feeds (Layer 3). The Bearer Token (Layer 1) requires the **$200/mo Basic plan** for reliable scanning; the Free tier blocks most read endpoints.

Content Scout uses a layered scanner for X. You don't need any single layer to be working — the scanner uses whatever is available and skips the rest.

### Free paths (recommended)

**Layer 2 — Brave Search API (the easiest free path):**

1. Follow the [Brave Search API setup](#brave-search-api) above. The same `BRAVE_SEARCH_API_KEY` covers Reddit, LinkedIn, and X automatically — no per-platform configuration required.
2. That's it.

**Layer 3 — RSSHub (for tracking specific accounts):**

RSSHub (https://rsshub.app) is a community-run free relay that produces RSS feeds for X user timelines. To track a specific high-signal account, add this entry to your config under `## Custom RSS Feeds`:

```
Jane Smith on X | https://rsshub.app/twitter/user/janesmith
```

Notes:

- The public `rsshub.app` host is rate-limited under load — self-hosting RSSHub via Docker (`docker run --name rsshub -d -p 1200:1200 diygod/rsshub`) is more reliable if you scan many accounts.
- RSSHub is best for *known* accounts. Use Brave Search Layer 2 for *discovery* of mentions.

### Paid path (Layer 1)

If you have a Bearer Token from the [$200/mo Basic plan](https://developer.x.com/en/portal/dashboard), Content Scout will use it for authenticated API access (the highest-quality path).

#### Setup
1. Go to [developer.x.com](https://developer.x.com/)
2. Sign up for a developer account and pick the **Basic** plan ($200/mo).
3. Create an app, go to **Keys and Tokens**, generate a **Bearer Token**.
4. Add to `.env`: `X_BEARER_TOKEN=AAAA...`

#### Plan Comparison

| Plan | Cost | Search Tweets | Rate Limits |
|------|------|--------------|-------------|
| Free | $0 | 1 app, limited endpoints | Very restricted — typically 403s on `tweets/search/recent`. **Use Google PSE / RSSHub instead.** |
| Basic | $200/mo | Full search, recent tweets | 10,000 reads/mo — sufficient for monthly scans |
| Pro | $5,000/mo | Full archive search | Overkill for Content Scout |

### In Content Scout
When you select X/Twitter during onboarding, the agent first nudges you toward the free Brave Search path. If you also have a paid Bearer Token, paste it; otherwise say "skip" and rely on Brave + RSSHub. Stored in `.env` as `X_BEARER_TOKEN` (optional).

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
| LinkedIn | Free layered scanner: Brave Search API → RSSHub feeds → web/fetch on referenced permalinks. See [#brave-search-api](#brave-search-api) for the primary free path. |
| X/Twitter | Free layered scanner: Brave Search API → RSSHub feeds → web/fetch on referenced permalinks. Authenticated API ($200/mo Basic plan) used only if `X_BEARER_TOKEN` is set. See [#brave-search-api](#brave-search-api). |
| Custom sources (blogs, feeds, docs) | Direct HTTP/RSS |

## Sources That Need Free Auth

| Source | How to Get Credentials | Cost |
|--------|----------------------|------|
| Reddit | **Optional.** Register a "script" app at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps/) (or `old.reddit.com/prefs/apps`) and set `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` / `REDDIT_USER_AGENT` in `.env` for higher limits. Without creds, Content Scout uses the layered no-auth scanner (RSS → HTML → PSE → manual). | Free |
| Brave Search | **Recommended.** Free 2,000 queries/month. Enables free Reddit Layer 3 + LinkedIn Layer 1 + X/Twitter Layer 2. Set `BRAVE_SEARCH_API_KEY` in `.env`. See [#brave-search-api](#brave-search-api). | Free (2,000/month) |
| Google PSE | **Legacy / pre-2026 GCP projects only.** Closed to new customers since early 2026. Use Brave Search above for new setups. See [#google-pse-legacy](#google-pse-legacy). | Free (100/day) until Jan 1, 2027 |
| YouTube | Get an API key at [console.cloud.google.com](https://console.cloud.google.com/apis/credentials). Set `YOUTUBE_API_KEY` in `.env`. | Free |
| Bluesky | Create an app password at [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords). Set `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD` in `.env`. | Free |
