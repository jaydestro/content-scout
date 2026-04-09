---
mode: content-scout
description: Compare content trends across months — show trajectory, rising/declining topics, and contributor patterns
---

# Trends Analysis

Compare content reports across months to show trajectory. Read reports from `reports/` for the current month and up to 3 prior months.

## What to Include
- Month-over-month item counts, contributor counts, conversation volume
- Topic tag trends (rising, declining, stable, new)
- Contributor trajectory (repeat, new, inactive)
- Sentiment trend (if conversation sentiment is enabled)
- Role-specific insight based on the trend data

## Usage
```
scout-trends
scout-trends last 3 months
scout-trends January to March 2026
```

Save the trends report to `reports/{YYYY-MM}-trends.md`.
