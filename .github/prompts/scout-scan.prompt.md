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
   - Otherwise, scan the last 30 days from today.
3. Execute **Scan mode** for each topic as defined in the Content Scout agent:
   - Search all enabled networks using the configured search terms.
   - Apply the content quality filter (date gate + relevancy gate).
   - Check `reports/.seen-links.json` for duplicates.
   - Tag every item with canonical topic tags.
   - If **Conference CFP tracking** is enabled in config, also scan for open CFPs and recent conference talks (see agent definition for sources and format).
   - Number items sequentially across all sections.
4. Save each topic's report to `reports/{YYYY-MM-DD-HHmm}-{slug}-content.md` (or `reports/{YYYY-MM-DD-HHmm}-content.md` if only one topic).
5. Update `reports/.seen-links.json` with all new URLs.
6. Auto-generate social posts and thumbnail specs for every item. Save to `social-posts/{YYYY-MM-DD-HHmm}-{slug}-social-posts.md` (or `social-posts/{YYYY-MM-DD-HHmm}-social-posts.md` if only one topic).
7. Summarize: item count per topic, top topics, content gaps, and confirm social posts were generated. If CFP tracking is on, call out any CFPs with deadlines closing within 14 days.
8. If scanning multiple topics, provide a brief cross-topic summary at the end (total items, shared topics, comparative volume).
9. **End your final message with the saved file paths**, one per line, prefixed with `Report saved: ` and `Social posts saved: ` (and `Calendar saved: ` if generated). Use workspace-relative paths so they render as clickable links in the UI, e.g.:

   ```
   Report saved: reports/2026-04-30-1530-azure-cosmos-db-content.md
   Social posts saved: social-posts/2026-04-30-1530-azure-cosmos-db-social-posts.md
   ```

   If zero items qualified and you wrote a stub report, still print its path. A run that does not print a saved-file path in its final message is treated as a failed run.
