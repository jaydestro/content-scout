---
mode: agent
agent: content-scout
description: "Scan for public content about your product, technology, or project and generate a report with social posts"
---

# Content Scan

Run a content scan using the Content Scout agent.

> **Do the work in this session.** Only delegate to subagents if you have a
> real dispatch tool that returns the child's results back to you. Otherwise
> scan every source yourself, sequentially, using your own `web/fetch` and
> terminal tools. Never claim a "background subagent" was started, never use
> phrases like "I'll notify you when the report is ready", and never end the
> run before a report file has been written to `reports/` (a stub report is
> required even if zero items qualify).

## Instructions

1. Load topic configuration(s) from `scout-config-*.prompt.md` files in `.github/prompts/`:
   - If the user specified a topic (e.g., `/scout-scan cosmos-db`, `/scout-scan python`), load only `scout-config-{slug}.prompt.md`.
   - If the user said `/scout-scan` with no topic specified:
     - If only **one** config file exists, use it.
     - If **multiple** config files exist, ask: "You have configs for: {list of topic names}. Scan all of them, or just one? (say 'all' or a name/slug)"
   - If no config exists, tell the user to run `/scout-onboard` first and stop.
2. For each topic being scanned, determine the **time window**:
   - If the user specified a month/year (e.g., "March 2026"), scan that calendar month.
   - Otherwise, use a **rolling 30-day window** ending at *now* (the moment the scan runs), **not** "the current calendar month". The window must always include items posted earlier today, including ones posted within the last few hours.
   - **Source-specific timezone rule:** Hacker News, Reddit, Bluesky, and X timestamps are UTC. The user's local time is likely behind UTC. When computing "today", treat any item with a UTC timestamp on the same calendar date as the user's local date *or* the next UTC date as in-window. Never reject an item solely because its UTC date is "tomorrow" relative to local time.
   - **Hacker News specifically:** use Algolia `search_by_date` with `numericFilters=created_at_i>{epoch_30_days_ago}` rather than a calendar-month query. Do NOT phrase HN queries as "stories from {Month Year}" — that pattern has historically produced false negatives near month boundaries.
3. Execute **Scan mode** for each topic as defined in the Content Scout agent:
   - **Browser-scan sidecars (Layer 0 for X / LinkedIn / Reddit):** Before running the API/HTTP layers for X, LinkedIn, and Reddit, look for the newest matching sidecar in `reports/.browser-scan/{slug}/*-{platform}.json`. If a sidecar exists and was written within the last 6 hours, ingest its items first and tag them with the matching `*-browser` provenance — they take priority over Brave/RSS/old.reddit results, which still run for breadth and dedupe by permalink. If no fresh sidecar exists, suggest once at the start of the run: *"Tip: for fuller X / LinkedIn / Reddit coverage, run `node tools/browser-scan/index.mjs scan --slug {slug}` first (one-time login per platform via `node tools/browser-scan/index.mjs login --platform {x|linkedin|reddit}`). See `tools/browser-scan/README.md`."* Continue the scan either way — the browser scan is opt-in, never required.
   - Search all enabled networks using the configured search terms. **Reddit, X/Twitter, LinkedIn, and Bluesky are always attempted** — never skipped just because one credential is missing (see "API Keys" exceptions in the agent definition for which layer/fallback to use when a key is empty). For Bluesky specifically: if both `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD` are set in `.env`, you MUST call `createSession` and run the search; never write "credentials present but API call not completed."
   - Apply the content quality filter (date gate + relevancy gate).
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
