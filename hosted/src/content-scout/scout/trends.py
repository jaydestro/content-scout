# Content Scout — Trends analysis stub

import logging
from pathlib import Path

logger = logging.getLogger("content-scout.trends")


def generate_trends_report(config: dict) -> str:
    """Compare reports across months and return a trends summary."""
    slug = config.get("slug", "")
    reports_dir = Path("reports")

    if not reports_dir.exists():
        return "No reports found. Run 'scout scan' first to generate data."

    pattern = f"*-{slug}-content.md" if slug else "*-content.md"
    reports = sorted(reports_dir.glob(pattern))

    if len(reports) < 2:
        return (
            f"Found {len(reports)} report(s). Trends analysis requires at least "
            "2 months of data. Run 'scout scan' for another month and try again."
        )

    # TODO: Parse reports, extract item counts per topic tag, contributors,
    # conversation volume, sentiment, and compute deltas

    return f"Trends analysis across {len(reports)} months — not yet fully implemented in hosted mode."
