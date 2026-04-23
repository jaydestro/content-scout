# Content Scout — Report generator
# Generates markdown reports from filtered content items.
# Writes via scout.storage (blob in hosted mode, filesystem in dev).

import logging
from datetime import datetime, timezone
from pathlib import Path

from scout import storage

logger = logging.getLogger("content-scout.report")


def generate_report(config: dict, items: list[dict], scan_start: datetime) -> Path:
    """Generate a markdown content report from filtered items."""
    slug = config.get("slug", "")
    name = config.get("name", slug)
    role = config.get("role", "Custom")
    topic_type = config.get("type", "product")
    month_str = scan_start.strftime("%Y-%m")

    filename = f"{month_str}-{slug}-content.md" if slug else f"{month_str}-content.md"

    # Separate conversations from numbered items
    numbered = [i for i in items if not i.get("is_conversation")]
    conversations = [i for i in items if i.get("is_conversation")]

    # Group by source
    groups = {}
    for item in numbered:
        source = item.get("source", "Other")
        groups.setdefault(source, []).append(item)

    # Build report
    lines = [
        f"# {name} — Content Report: {scan_start.strftime('%B %Y')}\n",
        f"**Generated:** {datetime.now(timezone.utc).strftime('%Y-%m-%d')}",
        f"**Period:** {scan_start.strftime('%Y-%m-%d')} to {(scan_start.replace(month=scan_start.month % 12 + 1, day=1)).strftime('%Y-%m-%d') if scan_start.month < 12 else scan_start.replace(year=scan_start.year + 1, month=1, day=1).strftime('%Y-%m-%d')}",
        f"**Topic type:** {topic_type}",
        f"**Role:** {role}",
        "",
        "## Summary",
        f"Total items: {len(numbered)}",
        f"Conversations tracked: {len(conversations)}",
        "",
    ]

    # Numbered items by source
    item_num = 1
    source_order = _get_source_order(role)

    for source in source_order:
        source_items = groups.pop(source, [])
        if not source_items:
            continue
        lines.append(f"## {source}")
        lines.append(f"| # | Date | Title | Author | Tags | EP | Link |")
        lines.append(f"|---|------|-------|--------|------|----|------|")
        for item in source_items:
            lines.append(
                f"| {item_num} | {_format_date(item.get('date', ''))} "
                f"| {item.get('title', '')} "
                f"| {item.get('author', '')} "
                f"| {', '.join(item.get('tags', []))} "
                f"| {item.get('engagement_potential', '-')} "
                f"| [{source}]({item.get('url', '')}) |"
            )
            item_num += 1
        lines.append("")

    # Any remaining sources not in the ordered list
    for source, source_items in groups.items():
        if not source_items:
            continue
        lines.append(f"## {source}")
        lines.append(f"| # | Date | Title | Author | Link |")
        lines.append(f"|---|------|-------|--------|------|")
        for item in source_items:
            lines.append(
                f"| {item_num} | {_format_date(item.get('date', ''))} "
                f"| {item.get('title', '')} "
                f"| {item.get('author', '')} "
                f"| [{source}]({item.get('url', '')}) |"
            )
            item_num += 1
        lines.append("")

    # Conversations section
    if conversations:
        lines.append("## Conversations & Mentions (tracked, not for social posts)")
        lines.append("| Date | Platform | Summary | Sentiment | Link |")
        lines.append("|------|----------|---------|-----------|------|")
        for item in conversations:
            lines.append(
                f"| {_format_date(item.get('date', ''))} "
                f"| {item.get('source', '')} "
                f"| {item.get('title', '')} "
                f"| 🟡 "
                f"| [link]({item.get('url', '')}) |"
            )
        lines.append("")

    location = storage.write_text(storage.REPORTS_CONTAINER, filename, "\n".join(lines))
    return Path(location)


def _get_source_order(role: str) -> list[str]:
    """Return source display order based on role."""
    role_lower = role.lower()
    if "program manager" in role_lower:
        return ["GitHub", "Dev.to", "Medium", "YouTube", "Hashnode", "DZone"]
    elif "product manager" in role_lower:
        return ["Dev.to", "Medium", "YouTube", "GitHub", "Hashnode"]
    elif "social media" in role_lower:
        return ["Dev.to", "Medium", "YouTube", "GitHub", "Hashnode"]
    elif "developer advocate" in role_lower or "devrel" in role_lower:
        return ["GitHub", "YouTube", "Dev.to", "Medium", "Hashnode", "DZone"]
    else:
        return ["Dev.to", "Medium", "YouTube", "GitHub", "Hashnode", "DZone"]


def _format_date(date_str: str) -> str:
    """Format a date string for display."""
    if not date_str:
        return "Unknown"
    try:
        dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return date_str[:10] if len(date_str) >= 10 else date_str
