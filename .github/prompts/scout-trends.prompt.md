---
mode: content-scout
description: Compare content trends across months — show trajectory, rising/declining topics, and contributor patterns
---

# Trends Analysis

Compare content reports across months to show trajectory. Read reports from `reports/` for the current month and up to 3 prior months.

${{input:Product? (optional) Leave blank if only one product is configured, or specify a product slug}}

## Product Resolution
1. If the user specified a product slug, load `scout-config-{slug}.prompt.md` and read only that product's reports.
2. If only one `scout-config-*.prompt.md` exists, use it automatically.
3. If multiple configs exist and no product was specified, ask which product (or "all" for a cross-product comparison).

## What to Include
- Month-over-month item counts, contributor counts, conversation volume
- Topic tag trends (rising, declining, stable, new)
- Contributor trajectory (repeat, new, inactive)
- Sentiment trend (if conversation sentiment is enabled)
- Role-specific insight based on the trend data

## Usage
```
scout-trends
scout-trends cosmos-db
scout-trends last 3 months
scout-trends January to March 2026
```

Save the trends report to `reports/` using per-product naming (`{YYYY-MM}-{slug}-trends.md`) when multiple products are configured.
