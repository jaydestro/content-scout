---
mode: agent
description: "Manually import Reddit threads when automated layers are blocked"
---

# scout-reddit-import

Ingest Reddit threads from a list of URLs the user pastes. Use this when Reddit's automated layers (old.reddit RSS, HTML scrape, Google PSE) are blocked, rate-limited, or simply missing the threads you care about.

Ignore VS Code frontmatter and `${{input:...}}` placeholders — ask the user conversationally for inputs.

## Inputs

- **URLs** (required) — newline- or comma-separated list of Reddit thread permalinks. Accepts `https://www.reddit.com/r/...`, `https://old.reddit.com/r/...`, or short `redd.it/...` links.
- **Topic slug** (optional) — which `scout-config-{slug}.prompt.md` to attribute the items to. Default: ask the user, or use the only configured product if one is configured.

## Flow

1. **Read product config** — load the active `scout-config-{slug}.prompt.md`. Confirm the product the URLs apply to.
2. **Normalize URLs** — strip query strings except `?context=`, force `old.reddit.com` host, ensure `.json` suffix support. Reject anything that isn't a Reddit thread or comment permalink.
3. **Dedup against `reports/.seen-links.json`** — drop URLs already ingested in a prior run unless the user passes `--force`.
4. **Fetch each thread** — `GET {permalink}.json` with a realistic browser User-Agent and ≥2s delay between requests, max 1 in-flight. On 429/403/503 retry once with 10s backoff, then skip and report the failure.
5. **Extract fields** — title, author, subreddit, post date, body excerpt (first 280+ chars), upvote count, comment count, top 3 comment authors and excerpts when present.
6. **Apply quality filter** — date gate + relevancy gate + scoring (≥5/9). Items that fail are dropped with a one-line reason logged for the user.
7. **Generate report** — write a normal `reports/{YYYY-MM-DD-HHmm}-{slug}-content.md` with only the imported items, marked `source: "reddit-manual"`. Number sequentially, tag with canonical topic tags, run sentiment classification.
8. **Update seen-links** — append accepted URLs to `reports/.seen-links.json`.
9. **Summarize** — print: total submitted, accepted, dropped (with reasons), and the report path.

## Output

- Report: `reports/{YYYY-MM-DD-HHmm}-{slug}-reddit-manual.md`
- Seen-links updated: `reports/.seen-links.json`

## Rules

- Never fabricate engagement metrics — if Reddit returns no score (e.g., very new post or removed thread), leave the field blank.
- Skip removed/deleted threads gracefully and report them in the dropped list.
- Apply the same Social Source Data Requirements as automated Reddit scans.
