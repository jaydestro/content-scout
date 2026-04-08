---
mode: agent
agent: content-scout
description: "Scan for public content about your product and generate a report with social posts"
---

# Content Scan

Run a content scan using the Content Scout agent.

## Instructions

1. Load the product configuration from the `scout-config-*.prompt.md` file in `.github/prompts/`. If no config exists, tell the user to run `/scout-onboard` first and stop.
2. Determine the **time window**:
   - If the user specified a month/year (e.g., "March 2026"), scan that calendar month.
   - Otherwise, scan the last 30 days from today.
3. Execute **Scan mode** as defined in the Content Scout agent:
   - Search all enabled networks using the configured search terms.
   - Apply the content quality filter (date gate + relevancy gate).
   - Check `reports/.seen-links.json` for duplicates.
   - Tag every item with canonical topic tags.
   - Number items sequentially across all sections.
4. Save the report to `reports/{YYYY-MM}-content.md`.
5. Update `reports/.seen-links.json` with all new URLs.
6. Auto-generate social posts and thumbnail specs for every item. Save to `social-posts/{YYYY-MM}-social-posts.md`.
7. Summarize: item count, top topics, content gaps, and confirm social posts were generated.
