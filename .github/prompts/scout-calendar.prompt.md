---
description: Generate a weekly posting calendar from a content report
mode: content-scout
---

# Create Posting Calendar

Generate a weekly posting schedule that spreads content across platforms and days.

${{input:Which report? Leave blank for the latest, or specify month/year (e.g., "March 2026")}}

${{input:How many weeks to plan? (default: 2)}}

${{input:Product? (optional) Leave blank if only one product is configured, or specify a product slug}}

## Product Resolution
1. If the user specified a product slug, load `scout-config-{slug}.prompt.md`.
2. If only one `scout-config-*.prompt.md` exists, use it automatically.
3. If multiple configs exist and no product was specified, ask which product (or "all" for a combined calendar).

Read the report, select the best items, and create a posting calendar in `social-posts/` using per-product naming (`{YYYY-MM}-{slug}-posting-calendar.md`) when multiple products are configured.
