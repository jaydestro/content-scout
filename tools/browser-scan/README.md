# Content Scout — Browser Scan (Edge + Playwright over CDP)

A logged-in, real-browser scanner for **X / Twitter**, **LinkedIn**,
**Reddit**, **Google** (News + Web Search), and **developer content sites**
(Microsoft Tech Community, DZone, C# Corner, Hashnode). The scanner attaches
to **your real Edge window over the Chrome DevTools Protocol** — it does
**not** open its own browser or use a synthetic Playwright profile.

Why CDP attach? X (and increasingly LinkedIn) flags fresh Playwright
profiles as bots and refuses to let you log in — even with stealth flags.
The same real-browser session also unblocks the developer content sites the
API/RSS layers can't reach: Microsoft Tech Community's sign-in wall, DZone's
anti-bot 403, C# Corner's 500-ing RSS, and Hashnode's dead tag-RSS (404).
Attaching to a normal Edge window you launched yourself sidesteps the
detection entirely: you sign in like a human, and the scanner just borrows
the session.

## Install (one-time)

```pwsh
cd tools/browser-scan
npm install
```

You don't need to install Chromium — the tool only attaches to Edge.

## One-time setup

```pwsh
node tools/browser-scan/launch-edge.mjs
```

This auto-detects your **OS default browser** and launches it with
`--remote-debugging-port=9222` and a **dedicated CDP profile** (under
`tools/browser-scan/.cdp-profile/`, gitignored). It opens login / landing
tabs:

- https://x.com/login
- https://www.linkedin.com/login
- https://www.reddit.com/login/
- https://news.google.com/
- https://techcommunity.microsoft.com/

Sign in to each one as you normally would (passkeys, 2FA, anything works —
it's a real browser). Microsoft Tech Community content is behind a sign-in
wall, so signing in there lets the content-sites scanner read it; Google
News, DZone, C# Corner, and Hashnode work without a login. **Leave it
running** between scans; the session sticks. You only need to re-sign-in if
a platform invalidates the session (typically every few weeks).

> Override the auto-detected browser with `--browser "Google Chrome"` (or
> any other Chromium-family name). Run `--list` to see what's installed
> and supported.

> **Prefer Edge for the dedicated profile.** The web UI's auto-launch
> defaults this dedicated CDP profile to Microsoft Edge so scans never
> attach to (or wake) your everyday default browser — a heavily-loaded
> default Chrome is the most common cause of "connected but couldn't read
> tabs" CDP hangs. To force a specific browser everywhere (manual launches
> and the UI auto-launch), set the `SCOUT_BROWSER` env var before starting
> the web UI, e.g. `SCOUT_BROWSER="Microsoft Edge"`. It's a soft preference:
> if that browser isn't installed, the launcher falls back to your OS
> default. An explicit `--browser` flag still wins over `SCOUT_BROWSER`.

> Why a dedicated CDP profile and not your day-to-day Edge?
> Edge will not enable remote debugging on a profile that's already in use
> by another Edge window. Closing your normal browser to free the profile
> is annoying, and you usually want scraping isolated from personal
> browsing anyway. If you really want to share your default profile, pass
> `--use-default-profile` to `launch` and close every other Edge window
> first.

## Run a scan

In a different terminal:

```pwsh
# Scan all three platforms for the cosmos-db config:
node tools/browser-scan/index.mjs scan --slug azure-cosmos-db

# Just LinkedIn:
node tools/browser-scan/index.mjs scan --slug azure-cosmos-db --platforms linkedin

# Custom CDP port:
node tools/browser-scan/index.mjs scan --slug azure-cosmos-db --port 9333
```

The scanner reads search terms from
`.github/prompts/scout-config-{slug}.prompt.md`, opens new tabs in your
running Edge, scrolls each platform's search results, and writes:

```
reports/.browser-scan/{slug}/{YYYY-MM-DD-HHmm}-{platform}.json
```

`scout scan` then automatically picks up the newest sidecar per platform
within the last 6 hours and merges it as Layer 0.

## How queries are built

`lib/query.mjs::buildSearchQuery(term, platform)` shapes each search-term
from the config before sending it to the platform:

| Config term | X / LinkedIn | Reddit | Google |
|---|---|---|---|
| `Azure Cosmos DB` | `"Azure Cosmos DB"` (phrase match) | `"Azure Cosmos DB"` (phrase match) | `"Azure Cosmos DB"` (phrase match) |
| `CosmosDB` | `CosmosDB` | `CosmosDB` | `CosmosDB` |
| `#AzureCosmosDB` | `#AzureCosmosDB` (hashtag match) | `AzureCosmosDB` (Reddit ignores `#`) | `AzureCosmosDB` (Google ignores `#`) |

Multi-word terms always get phrase-quoted so platforms don't OR the
tokens. Single tokens and `#hashtag` terms pass through. Reddit gets the
leading `#` stripped because Reddit's search treats `#` as punctuation.
Each search term runs sequentially per platform; results are deduped by
permalink across all terms before the sidecar is written.

## Helper Command Reference

| Command | Purpose |
|---|---|
| `node launch-edge.mjs` | Spawn the OS default Chromium-family browser with debug port + login tabs (one-time setup, then leave running). Use `--browser "<Name>"` to override or `--list` to see installed browsers. |
| `node index.mjs scan --slug <slug>` | Attach to running browser over CDP (default) and scrape all three platforms. |
| `node index.mjs scan --slug <slug> --platforms x,linkedin` | Restrict to specific platforms. |
| `node index.mjs scan --slug <slug> --mode launch --headed` | **Legacy.** Make Playwright launch its own Edge with a per-platform profile. X usually refuses to log in here. |
| `node index.mjs login --platform x\|linkedin\|reddit` | **Legacy.** One-time login for the launch-mode profile (per platform). Not recommended. |

### Common flags

- `--port 9222` — CDP port (default 9222). Must match what `launch` started.
- `--browser "<Name>"` — (`launch-edge.mjs` only) override the auto-detected default browser. Examples: `"Microsoft Edge"`, `"Google Chrome"`, `"Brave"`.
- `--list` — (`launch-edge.mjs` only) print which Chromium-family browsers are installed on this machine and exit.
- `--days 30` — Time window in days (default 30).
- `--max-per-term 25` — Max items per search term per platform.
- `--headed` — Force-show the browser when in `--mode launch`.
- `--use-default-profile` — (`launch` only) Use your real browser profile instead of the dedicated CDP profile. Close all other windows of that browser first.

## Web UI integration

The Content Scout web UI surfaces browser-scan controls automatically:

- **Run view** — a "Browser scan (Layer 0)" fieldset inside the /scout-scan form. One place for everything: sign-in status chips for X / LinkedIn / Reddit, a browser dropdown, **Open browser & sign in** and **Force-rescan active subject** buttons, and three preflight modes (**Auto** / **Force** / **Skip**) that fire automatically when you click Start run. The preflight always honors the date range you pick above, so a "this week" scan limits the browser scrape to the last 7 days.
- **Dashboard** — a small "Browser scan" card showing whether the browser is currently running on the CDP port and how many subjects have sidecars on disk.

No command-line use is required after the first launch.

## Output schema

Each JSON sidecar is an array of items shaped like:

```json
{
  "platform": "x",
  "url": "https://x.com/Azure/status/...",
  "author_handle": "@Azure",
  "author_display": "Microsoft Azure",
  "author_bio": null,
  "post_date": "2026-05-07T14:21:00Z",
  "title": null,
  "body": "Vector search in Azure Cosmos DB just shipped...",
  "engagement": { "likes": 123, "retweets": 45, "replies": 12, "views": 18000 },
  "thread_context": null,
  "scraped_at": "2026-05-08T18:02:00Z",
  "source": "x-browser",
  "search_term": "azure cosmos db"
}
```

LinkedIn items use `linkedin-browser`, Reddit items use `reddit-browser`.

### Google (two passes per scan)

The Google scanner runs **two passes** over the same logged-in browser
context, and merges results into a single `*-google.json` sidecar with
natural URL-dedup:

1. **Google News** (`news.google.com/search?q=…+when:…`) — surfaces
   editorial / press coverage. Items carry `platform: "google-news"`,
   `source: "google-news-browser"`, `subSource: "google-news"`, and a
   structured `post_date`.
2. **Google Web Search** (`www.google.com/search`) — surfaces blog posts,
  docs, repo READMEs, and anything else the organic SERP indexes. Runs a
  **general** (non-`site:`-restricted) web search of each configured search
  term. Items carry `platform: "google-web"`, `source:
  "google-web-browser"`, `subSource: "google-web"`. The scanner runs two
  web passes and dedupes by URL:
  - exact scan window: `tbs=cdr:1,cd_min:M/D/YYYY,cd_max:M/D/YYYY`
  - broad recent fallback: `tbs=qdr:y`, matching the manual browser search
    pattern like `https://www.google.com/search?q=%22cosmos+db+agent+kit%22&tbs=qdr:y`

  The SERP rarely exposes per-result dates, so `post_date` is usually
  `null`; the report pipeline still fetches/date-gates candidates before
  accepting them. Each web item includes `search_scope` (`custom-range` or
  `recent-year`) and `google_tbs` so downstream diagnostics can tell which
  pass surfaced it.

A CAPTCHA in one pass only stops that pass; items already collected
(from either pass) are still written to the sidecar.

### Developer content sites (one sidecar, four sub-sources)

The `content-sites` platform scrapes four developer-content sources the
normal API/RSS scan layers can't reach, driving each site's own search page
for every configured search term. Results merge into a single
`*-content-sites.json` sidecar, deduped by URL, with blog-shaped items
(no engagement, empty `body` — title + publisher + permalink only). Each
item carries `platform` / `subSource` / `source` naming its origin:

| Sub-source | `platform` / `subSource` | `source` | Why the browser is needed |
|---|---|---|---|
| Microsoft Tech Community | `techcommunity` | `techcommunity-browser` | Sign-in wall blocks anonymous content |
| DZone | `dzone` | `dzone-browser` | Anti-bot 403 on anonymous requests |
| C# Corner | `csharpcorner` | `csharpcorner-browser` | RSS feeds return 500 |
| Hashnode | `hashnode` | `hashnode-browser` | Tag-RSS endpoints return 404 |

`post_date` is usually `null` (listing/search pages rarely expose reliable
per-item dates); the report pipeline fetches and date-gates each candidate
before accepting it. Per-site failure is graceful — a sign-in wall (Tech
Community), captcha, or zero results writes a `debug-{site}-*.html`
snapshot and skips that site without sinking the rest of the scan. Tech
Community needs you signed in (see setup); the other three need only a real
browser. Hashnode posts on fully custom domains can't be pattern-matched
here — the open-web Brave layer already covers those.

## Rate-limit hygiene

- One in-flight tab per platform; ≥3s between page loads.
- Search terms run sequentially, never in parallel.
- If a platform shows a captcha or rate-limit screen, the scanner stops for
  that platform and the JSON output records the partial result. Re-run
  later, or solve the captcha in the Edge window directly.

## Troubleshooting

**"Could not connect to Edge over CDP at http://127.0.0.1:9222"**
Edge isn't running with the debug port enabled. Run `node index.mjs launch`
first and leave Edge open while you scan.

**Sign-in check / scan logs show `<ws connected>` then "Timeout 30000ms exceeded" (`cdp-unreachable`)**
The CDP WebSocket connected fine, but Playwright then timed out *reading the
browser's tabs*. That happens when the browser has put the idle login tabs
to sleep (Edge "sleeping tabs" / renderer backgrounding) or you have too
many heavy tabs open, so a tab's debugging target stops answering. Fix it
by clicking the CDP browser window to bring it to the foreground (which
wakes sleeping tabs), closing extra tabs so only the login tabs remain, or
relaunching with `node tools/browser-scan/launch-edge.mjs` — the launcher
now starts the browser with tab-sleep, renderer-backgrounding, and
occlusion freezing disabled, so a window left open between scans stays
attachable.

**"Edge is reachable but exposes no browser contexts"**
The Edge window has zero tabs open. Open any tab and re-run.

**X redirects me to login mid-scan**
Your X session expired. Switch to the X tab in Edge, sign in again, leave
Edge running, re-run the scan.

**LinkedIn shows "Authentication wall" overlay**
Your LinkedIn session expired or you got rate-limited. Sign in again in
the Edge tab; if it persists, wait 10–15 minutes before retrying.

**Reddit shows the "We need your help" captcha**
Solve it in the Edge tab once. Reddit usually drops the challenge for the
session afterward.

## Safety

- **Never commit** `tools/browser-scan/.cdp-profile/` or `.profile/` —
  they contain live session cookies. Both are in `.gitignore`.
- The scanner only **reads** public content visible to your account. It
  does not like, follow, post, or send DMs.
- Each platform's TOS allows logged-in browsing of public content for
  personal/research use; respect rate limits and don't share scraped data
  publicly.
