---
mode: agent
agent: content-scout
description: "Scan for public content about your product and generate a report with social posts"
---

# Content Scan

Run a content scan using the Content Scout agent.

## Instructions

1. Load product configuration(s) from `scout-config-*.prompt.md` files in `.github/prompts/`:
   - If the user specified a product (e.g., `/scout-scan cosmos-db`), load only `scout-config-{slug}.prompt.md`.
   - If the user said `/scout-scan` with no product specified:
     - If only **one** config file exists, use it.
     - If **multiple** config files exist, ask: "You have configs for: {list of product names}. Scan all of them, or just one? (say 'all' or a product name/slug)"
   - If no config exists, tell the user to run `/scout-onboard` first and stop.
2. For each product being scanned, determine the **time window**:
   - If the user specified a month/year (e.g., "March 2026"), scan that calendar month.
   - Otherwise, scan the last 30 days from today.
3. Execute **Scan mode** for each product as defined in the Content Scout agent:
   - Search all enabled networks using the configured search terms.
   - Apply the content quality filter (date gate + relevancy gate).
   - Check `reports/.seen-links.json` for duplicates.
   - Tag every item with canonical topic tags.
   - If **Conference CFP tracking** is enabled in config, also scan for open CFPs and recent conference talks (see agent definition for sources and format).
   - Number items sequentially across all sections.
4. Save each product's report to `reports/{YYYY-MM}-{slug}-content.md` (or `reports/{YYYY-MM}-content.md` if only one product).
5. Update `reports/.seen-links.json` with all new URLs.
6. Auto-generate social posts and thumbnail specs for every item. Save to `social-posts/{YYYY-MM}-{slug}-social-posts.md` (or `social-posts/{YYYY-MM}-social-posts.md` if only one product).
7. Summarize: item count per product, top topics, content gaps, and confirm social posts were generated. If CFP tracking is on, call out any CFPs with deadlines closing within 14 days.
8. If scanning multiple products, provide a brief cross-product summary at the end (total items, shared topics, comparative volume).
