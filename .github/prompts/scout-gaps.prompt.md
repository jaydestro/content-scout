---
description: Show topic areas with no recent content coverage
mode: content-scout
---

# Content Gap Analysis

Analyze the content report and identify topics with no recent coverage.

${{input:Which report? Leave blank for the latest, or specify month/year (e.g., "March 2026")}}

${{input:Product? (optional) Leave blank if only one product is configured, or specify a product slug}}

## Product Resolution
1. If the user specified a product slug, load `scout-config-{slug}.prompt.md`.
2. If only one `scout-config-*.prompt.md` exists, use it automatically.
3. If multiple configs exist and no product was specified, ask which product (or "all" for a cross-product gap analysis).

Read the report, compare against the full topic tag list from your config, and show which areas have zero coverage. Suggest content creation ideas for the biggest gaps.
