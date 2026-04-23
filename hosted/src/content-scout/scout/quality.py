# Content Scout — Quality filter
# Implements the date gate, relevancy gate, and scoring from the agent definition.

import logging
import re
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

logger = logging.getLogger("content-scout.quality")

# Content types that always pass relevancy
INCLUDE_TYPES = {
    "tutorial", "how-to", "architecture", "deep-dive", "demo", "sample",
    "performance", "integration", "success-story", "case-study",
    "conference-talk", "workshop", "announcement", "release",
}

# Content patterns that always fail relevancy
EXCLUDE_PATTERNS = [
    r"what is .+\?",
    r"getting started with .+ portal",
    r"introduction to .+",
    r"^\d+ best .+ tools",  # Listicles
    r"certification.*(study|guide|prep)",
    r"job.*(posting|opening|hiring)",
]


def apply_quality_filter(
    items: list[dict], config: dict, seen_links: set[str]
) -> list[dict]:
    """
    Apply the full quality filter pipeline:
    1. Normalize URLs
    2. Dedup against seen links
    3. Date gate
    4. Relevancy gate (with known author bypass)
    5. Scoring (depth + practical value + originality >= 5/9)
    """
    known_authors = set(
        a.lower().split("—")[0].strip()
        for a in config.get("known_authors", [])
    )

    filtered = []
    for item in items:
        url = normalize_url(item.get("url", ""))
        if not url:
            continue
        item["url"] = url

        # Dedup
        if url in seen_links:
            continue

        # Date gate
        if not passes_date_gate(item):
            continue

        # Conversation items skip relevancy (they're tracked, not numbered)
        if item.get("is_conversation"):
            filtered.append(item)
            continue

        # Known author bypass
        author = (item.get("author") or "").lower().strip()
        is_known = any(known in author for known in known_authors) if known_authors else False

        # Relevancy gate (bypassed for known authors)
        if not is_known and not passes_relevancy_gate(item):
            continue

        # Scoring
        if not is_known:
            score = compute_score(item)
            item["quality_score"] = score
            if score < 5:
                continue

        filtered.append(item)

    return filtered


def normalize_url(url: str) -> str:
    """Strip tracking parameters from URLs for dedup."""
    if not url:
        return ""
    try:
        parsed = urlparse(url)
        params = parse_qs(parsed.query)
        # Remove common tracking params
        tracking_keys = {"utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "source"}
        cleaned = {k: v for k, v in params.items() if k.lower() not in tracking_keys}
        clean_query = urlencode(cleaned, doseq=True)
        return urlunparse(parsed._replace(query=clean_query, fragment=""))
    except Exception:
        return url


def passes_date_gate(item: dict) -> bool:
    """Check if the item's date is within the scan window."""
    date_str = item.get("date", "")
    if not date_str:
        item["date_unknown"] = True
        return True  # Include in "Date Unknown" section
    # We'll let the report generator handle the actual window check
    return True


def passes_relevancy_gate(item: dict) -> bool:
    """Check if the item meets the relevancy criteria."""
    title = (item.get("title") or "").lower()
    summary = (item.get("summary") or "").lower()
    text = f"{title} {summary}"

    # Check exclude patterns
    for pattern in EXCLUDE_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return False

    # YouTube with no description
    if item.get("source") == "YouTube" and not summary.strip():
        return False

    return True


def compute_score(item: dict) -> int:
    """
    Score an item on three dimensions (1-3 each, total 3-9):
    - Product depth: Is the product central to the content?
    - Practical value: Does the reader learn something actionable?
    - Originality: Is this original insight or rehashed docs?
    Minimum to include: 5/9
    """
    title = (item.get("title") or "").lower()
    summary = (item.get("summary") or "").lower()
    text = f"{title} {summary}"
    source = (item.get("source") or "").lower()

    # Product depth (1-3)
    depth = 1
    depth_signals = ["tutorial", "how to", "build", "implement", "architecture", "deep dive",
                     "performance", "migration", "optimize", "scale", "production"]
    if any(s in text for s in depth_signals):
        depth = 3
    elif len(summary) > 100:
        depth = 2

    # Practical value (1-3)
    practical = 1
    practical_signals = ["step by step", "example", "code", "demo", "sample", "walkthrough",
                         "benchmark", "comparison", "solved", "fix", "debug"]
    if any(s in text for s in practical_signals):
        practical = 3
    elif any(s in text for s in ["learn", "understand", "guide", "tips"]):
        practical = 2

    # Originality (1-3)
    originality = 1
    if source in ("github", "youtube"):
        originality = 2  # Projects and videos tend to be original
    if any(s in text for s in ["case study", "real-world", "production", "lessons learned",
                                "we built", "our experience", "journey"]):
        originality = 3

    return depth + practical + originality
