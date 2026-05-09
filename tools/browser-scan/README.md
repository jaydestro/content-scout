# Content Scout — Browser Scan (Edge + Playwright over CDP)

A logged-in, real-browser scanner for **X / Twitter**, **LinkedIn**, and
**Reddit**. The scanner attaches to **your real Edge window over the Chrome
DevTools Protocol** — it does **not** open its own browser or use a
synthetic Playwright profile.

Why CDP attach? X (and increasingly LinkedIn) flags fresh Playwright
profiles as bots and refuses to let you log in — even with stealth flags.
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
node tools/browser-scan/index.mjs launch
```

This launches Microsoft Edge with `--remote-debugging-port=9222` and a
**dedicated CDP profile** (under `tools/browser-scan/.cdp-profile/`,
gitignored), and opens three login tabs:

- https://x.com/login
- https://www.linkedin.com/login
- https://www.reddit.com/login/

Sign in to each one as you normally would (passkeys, 2FA, anything works —
it's a real Edge browser). **Leave Edge running** between scans; the
session sticks. You only need to re-sign-in if a platform invalidates the
session (typically every few weeks).

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

| Config term | X / LinkedIn | Reddit |
|---|---|---|
| `Azure Cosmos DB` | `"Azure Cosmos DB"` (phrase match) | `"Azure Cosmos DB"` (phrase match) |
| `CosmosDB` | `CosmosDB` | `CosmosDB` |
| `#AzureCosmosDB` | `#AzureCosmosDB` (hashtag match) | `AzureCosmosDB` (Reddit ignores `#`) |

Multi-word terms always get phrase-quoted so platforms don't OR the
tokens. Single tokens and `#hashtag` terms pass through. Reddit gets the
leading `#` stripped because Reddit's search treats `#` as punctuation.
Each search term runs sequentially per platform; results are deduped by
permalink across all terms before the sidecar is written.

## CLI reference

| Command | Purpose |
|---|---|
| `node index.mjs launch` | Spawn Edge with debug port + login tabs (one-time setup, then leave running). Wraps `launch-edge.mjs`. |
| `node index.mjs scan --slug <slug>` | Attach to running Edge over CDP (default) and scrape all three platforms. |
| `node index.mjs scan --slug <slug> --platforms x,linkedin` | Restrict to specific platforms. |
| `node index.mjs scan --slug <slug> --mode launch --headed` | **Legacy.** Make Playwright launch its own Edge with a per-platform profile. X usually refuses to log in here. |
| `node index.mjs login --platform x\|linkedin\|reddit` | **Legacy.** One-time login for the launch-mode profile (per platform). Not recommended. |

### Common flags

- `--port 9222` — CDP port (default 9222). Must match what `launch` started.
- `--days 30` — Time window in days (default 30).
- `--max-per-term 25` — Max items per search term per platform.
- `--headed` — Force-show the browser when in `--mode launch`.
- `--use-default-profile` — (`launch` only) Use your real Edge profile
  instead of the dedicated CDP profile. Close all other Edge windows first.

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
