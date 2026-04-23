# Content Scout — Gap analysis stub

import logging
from pathlib import Path

logger = logging.getLogger("content-scout.gaps")


def analyze_gaps(config: dict, report_path: Path) -> str:
    """Compare canonical topic tags against tags found in the report."""
    canonical_tags = set(config.get("topic_tags", []))
    if not canonical_tags:
        return "No canonical topic tags configured. Add tags to your config to enable gap analysis."

    # TODO: Parse the report, extract used tags, compute coverage

    return f"Gap analysis for {config.get('name', '')} — not yet fully implemented in hosted mode."
