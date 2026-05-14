---
mode: agent
agent: content-scout
description: "Scan for public content about your product, technology, or project and generate a report with social posts"
---

# Content Scan

Run a content scan using the Content Scout agent.

> **Sub-flow — manual Reddit import.** If the user pastes a list of Reddit URLs and asks to ingest them (or automated Reddit Layers 0–3 are blocked and the user wants the manual fallback), follow `.github/prompts/scout-reddit-import.prompt.md` end-to-end instead of the full multi-source scan below.

> **Do the work in this session.** Only delegate to subagents if you have a
> real dispatch tool that returns the child's results back to you. Otherwise
> scan every source yourself, sequentially, using your own `web/fetch` and
> terminal tools. Never claim a "background subagent" was started, never use
> phrases like "I'll notify you when the report is ready", and never end the
> run before a report file has been written to `reports/` (a stub report is
> required even if zero items qualify).

> **Speed — batch independent calls.** Per-source fetches are independent.
> Inside a single tool turn, issue them in **parallel** (multiple
> `fetch_webpage` / `run_in_terminal` calls in the same response) whenever
> the next step doesn't depend on the previous result. Concretely, you can
> fan out in parallel: Brave search per source, RSS feed pulls, GitHub API
> queries, HN Algolia, DEV/Medium tags, Bluesky `app.bsky.feed.searchPosts`,
> Stack Overflow, YouTube. Sequential is only required when you actually
> need a previous result (e.g., reading a sidecar produced by a terminal
> call). This typically cuts scan wall-clock by 4–8×.

> **Subagent dispatch (if available).** If your runtime exposes a
> `runSubagent`-style tool that returns the child's full output back to
> the caller, you may fan out one subagent per source family (e.g., one
> for "social: Bluesky+X+LinkedIn+Reddit", one for "blogs: DEV+Medium+RSS",
> one for "code: GitHub+HN+Stack Overflow") and merge their findings.
> Never fire-and-forget — only use subagents when their result text comes
> back to you for inclusion in the final report.

## Instructions

1. Load topic configuration(s) from `scout-config-*.prompt.md` files in `.github/prompts/`:
   - If the user specified a topic (e.g., `/scout-scan cosmos-db`, `/scout-scan python`), load only `scout-config-{slug}.prompt.md`.
   - If the user said `/scout-scan` with no topic specified:
     - If only **one** config file exists, use it.
     - If **multiple** config files exist, ask: "You have configs for: {list of topic names}. Scan all of them, or just one? (say 'all' or a name/slug)"
   - If no config exists, tell the user to run `/scout-onboard` first and stop.
2. For each topic being scanned, determine the **time window**:
   - If the user specified a month/year (e.g., "March 2026"), scan that calendar month.
   - If the user said **"today only"** (optionally with a date), scan only items posted on that calendar date (apply the timezone rule below — accept items whose UTC date is the same as, or one day after, the local date).
   - If the user said **"this week so far"** or gave a phrase like `from YYYY-MM-DD to YYYY-MM-DD`, scan that explicit window inclusive of both endpoints.
   - If the user said **"{Month} {Year} so far"** (e.g., "May 2026 so far"), scan from the 1st of that month through *now*.
   - Otherwise, use a **rolling 30-day window** ending at *now* (the moment the scan runs), **not** "the current calendar month". The window must always include items posted earlier today, including ones posted within the last few hours.
   - **Source-specific timezone rule:** Hacker News, Reddit, Bluesky, and X timestamps are UTC. The user's local time is likely behind UTC. When computing "today", treat any item with a UTC timestamp on the same calendar date as the user's local date *or* the next UTC date as in-window. Never reject an item solely because its UTC date is "tomorrow" relative to local time.
   - **Hacker News specifically:** use Algolia `search_by_date` with `numericFilters=created_at_i>{epoch_30_days_ago}` rather than a calendar-month query. Do NOT phrase HN queries as "stories from {Month Year}" — that pattern has historically produced false negatives near month boundaries.
3. Execute **Scan mode** for each topic as defined in the Content Scout agent:
   - **Browser-scan (Layer 0 for X / LinkedIn / Reddit) — MANDATORY Step 0, run it yourself unless it already ran.**
     - First, look at the run log above this prompt. If you see `[browser-scan] Preflight done — starting agent.`, the web UI already ran it for every subject; skip to ingest. If you see `[browser-scan] No browser is running on CDP port 9222 — skipping preflight`, the user hasn't opened the browser; mention the hint once and continue to ingest whatever stale sidecars exist.
     - If you see **neither** line (you were invoked from chat / CLI, not via the web UI's Run view), run the preflight yourself before anything else: for each subject slug being scanned, execute `node tools/browser-scan/index.mjs scan --slug {slug}` in the terminal and wait for it to finish. If the command exits non-zero with a "no browser on CDP port" message, surface the one-time tip below and continue without it. If it succeeds, fresh sidecars now exist on disk for you to ingest.
     - One-time setup tip to surface when CDP isn't up: *"For fuller X / LinkedIn / Reddit coverage, run `node tools/browser-scan/launch-edge.mjs` once and sign in to all three platforms in the window that opens. Subsequent `/scout-scan` runs will refresh sidecars automatically."*
     - Ingest the freshest matching sidecar in `reports/.browser-scan/{slug}/*-{platform}.json` for each platform and tag those items with the `*-browser` provenance — they take priority over Brave/RSS/old.reddit results, which still run for breadth and dedupe by permalink. The browser scan is the first-class entry point for X / LinkedIn / Reddit; the API/HTTP fallback layers are now a breadth supplement, not the primary source.
   - Search all enabled networks using the configured search terms. **Reddit, X/Twitter, LinkedIn, and Bluesky are always attempted** — never skipped just because one credential is missing (see "API Keys" exceptions in the agent definition for which layer/fallback to use when a key is empty). For Bluesky specifically: if both `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD` are set in `.env`, you MUST call `createSession` and run the search; never write "credentials present but API call not completed."
   - Apply the content quality filter (date gate + relevancy gate). **Drop all hiring/recruiting/job-search content from EVERY section** (numbered tables, Conversations, Feature Requests, Influence Movers, social posts) per the "No Hiring Content" hard rule in the agent doc — even when the post mentions the product, even when the author is on the known-author list. Group these drops under a single `hiring/recruiting` counter in the JSON sidecar's `drop_reasons`; do not enumerate them in the user-facing summary.
   - **Hiring-post count line (mandatory when applicable):** The browser-scan tool drops hiring posts at sidecar-write time (see `tools/browser-scan/lib/hiring-filter.mjs`) and records the per-platform count in `reports/.browser-scan/{slug}/{stamp}-meta.json` under `hiringDropped` / `hiringDroppedTotal`. If the freshest meta sidecar has `hiringDroppedTotal > 0`, add **one and only one** line to the report's top-of-file summary section (just under the date/window line) of the form: `*Hiring/recruiting posts filtered: {N} (linkedin: {n}, x: {n}, reddit: {n})*` — omit any platform with 0 drops. **Do not list, link, quote, or paraphrase any individual hiring post anywhere in the report.** Combine this count with any additional hiring posts you yourself filtered from non-browser sources (Brave, RSS, etc.) into the same single line.
   - Check `reports/.seen-links.json` for duplicates. **Apply the re-surface exception** (see "Deduplication Tracker → Re-surface exception" in the agent definition): an item with ≥3× engagement growth or new-community discussion may be republished with a `🔁 Re-surfaced — {growth-summary}` prefix.
   - Tag every item with canonical topic tags.
   - If **Conference CFP tracking** is enabled in config, also scan for open CFPs and recent conference talks (see agent definition for sources and format).
   - Number items sequentially across all sections.
4. Save each topic's report to `reports/{YYYY-MM-DD-HHmm}-{slug}-content.md` (or `reports/{YYYY-MM-DD-HHmm}-content.md` if only one topic). **Exactly one report file per scan.** Every item from every layer (browser-scan sidecars, cascade fallbacks, RSS, APIs, MCP, manual imports) goes into that **one** file — never write a separate "supplemental", "addendum", or "sidecar report" alongside it. If a re-scan happens for the same window, edit the existing report file in place. See "One Scan = One Report" in the agent definition for the full rule.
5. Update `reports/.seen-links.json` with all new URLs.
6. **Update persistent creator state** at `reports/.scout-state/{slug}/creators.json` (see "Persistent Ecosystem State" in the Content Scout agent definition for schema and upsert rules). Recompute `trajectory` for every creator. Populate the report's **Influence Movers** section (Rising / Stable / Fading / Detractor Watch) from this file. If `creators.json` is empty/new, the Influence Movers section may say "First scan — trajectory data will appear after the next run."
7. Auto-generate social posts and thumbnail specs for every item. Save to `social-posts/{YYYY-MM-DD-HHmm}-{slug}-social-posts.md` (or `social-posts/{YYYY-MM-DD-HHmm}-social-posts.md` if only one topic).
8. Summarize: item count per topic, top topics, content gaps, and confirm social posts were generated. If CFP tracking is on, call out any CFPs with deadlines closing within 14 days. Also call out: count of new creators this run, count in Detractor Watch (if any).
9. If scanning multiple topics, provide a brief cross-topic summary at the end (total items, shared topics, comparative volume).
10. **End your final message with the saved file paths**, one per line, prefixed with `Report saved: ` and `Social posts saved: ` (and `Calendar saved: ` if generated). Use workspace-relative paths so they render as clickable links in the UI, e.g.:

   ```
   Report saved: reports/2026-04-30-1530-azure-cosmos-db-content.md
   Social posts saved: social-posts/2026-04-30-1530-azure-cosmos-db-social-posts.md
   ```

   If zero items qualified and you wrote a stub report, still print its path. A run that does not print a saved-file path in its final message is treated as a failed run.
