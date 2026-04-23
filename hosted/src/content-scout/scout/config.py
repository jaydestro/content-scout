# Content Scout — Configuration loader
# Reads scout-config-*.prompt.md files and parses them into structured dicts.

import logging
import re
from pathlib import Path

logger = logging.getLogger("content-scout.config")


def load_config(config_dir: str, slug: str) -> dict | None:
    """Load a single config file by slug."""
    path = Path(config_dir) / f"scout-config-{slug}.prompt.md"
    if not path.exists():
        logger.warning(f"Config not found: {path}")
        return None
    return _parse_config(path)


def load_all_configs(config_dir: str) -> list[dict]:
    """Load all scout-config-*.prompt.md files (excluding the example)."""
    config_path = Path(config_dir)
    if not config_path.exists():
        return []
    configs = []
    for f in sorted(config_path.glob("scout-config-*.prompt.md")):
        if "example" in f.name:
            continue
        parsed = _parse_config(f)
        if parsed:
            configs.append(parsed)
    return configs


def _parse_config(path: Path) -> dict:
    """
    Parse a scout-config markdown file into a structured dict.

    Extracts key fields from the markdown structure:
    - Role settings (role name, feature toggles)
    - Topic identity (name, slug, type, search terms, hashtags)
    - Exclusions (official channels, GitHub orgs, domains)
    - Networks (enabled sources)
    - Social post settings
    - Topic tags
    - Content filters
    """
    text = path.read_text(encoding="utf-8")

    # Strip YAML frontmatter
    text = re.sub(r"^---\n.*?\n---\n", "", text, flags=re.DOTALL)

    config = {"_source": str(path)}

    # Extract key-value pairs from "- **Key:** Value" patterns
    kv_pattern = re.compile(r"-\s+\*\*(.+?):\*\*\s+(.+)")
    for match in kv_pattern.finditer(text):
        key = match.group(1).strip().lower().replace(" ", "_").replace("/", "_")
        value = match.group(2).strip()
        config[key] = value

    # Extract name and slug from Topic section
    config["name"] = config.get("name", path.stem.replace("scout-config-", ""))
    config["slug"] = config.get("slug", config["name"].lower().replace(" ", "-"))
    config["type"] = config.get("type", "product")

    # Parse feature toggles
    config["social_posts_enabled"] = config.get("social_posts", "off").lower() == "on"
    config["posting_calendar_enabled"] = config.get("posting_calendar", "off").lower() == "on"

    # Extract search terms
    config["search_terms"] = _extract_list_section(text, "Text Searches")
    config["hashtags"] = _extract_list_section(text, "Hashtags")

    # Extract topic tags
    config["topic_tags"] = _extract_list_section(text, "Topic Tags (Canonical)")

    # Extract enabled networks from table
    config["networks"] = _extract_network_table(text)

    # Extract exclusions
    config["excluded_repos"] = _extract_list_section(text, "Excluded GitHub Orgs/Repos")
    config["excluded_domains"] = _extract_list_section(text, "Excluded Domains/Authors")

    # Extract known authors
    config["known_authors"] = _extract_list_section(text, "Known External Authors")

    return config


def _extract_list_section(text: str, heading: str) -> list[str]:
    """Extract bullet-point items from a section with the given heading."""
    pattern = rf"###?\s+{re.escape(heading)}\s*\n((?:- .+\n?)+)"
    match = re.search(pattern, text)
    if not match:
        return []
    items = []
    for line in match.group(1).strip().split("\n"):
        line = line.strip()
        if line.startswith("- "):
            item = line[2:].strip().strip('"').strip("'")
            if item and item.lower() != "none":
                items.append(item)
    return items


def _extract_network_table(text: str) -> dict[str, bool]:
    """Extract enabled/disabled sources from the Standard Sources table."""
    networks = {}
    table_match = re.search(
        r"### Standard Sources\s*\n\|.*\n\|[-\s|]+\n((?:\|.*\n?)+)", text
    )
    if not table_match:
        return networks
    for row in table_match.group(1).strip().split("\n"):
        cells = [c.strip() for c in row.split("|") if c.strip()]
        if len(cells) >= 2:
            source = cells[0].strip()
            enabled = cells[1].strip().lower() == "yes"
            networks[source] = enabled
    return networks
