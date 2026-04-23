# Content Scout — Hosted Agent
# Scans sources, filters content, generates reports, and drafts social posts.
# Runs as a Foundry hosted agent with both Responses (chat) and Invocations (automated) protocols.

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from azure.identity import DefaultAzureCredential, ManagedIdentityCredential
from dotenv import load_dotenv

from scout.config import load_config, load_all_configs
from scout.scanner import scan_all_sources
from scout.quality import apply_quality_filter
from scout.dedup import load_seen_links, save_seen_links
from scout.report import generate_report
from scout.social import generate_social_posts
from scout.trends import generate_trends_report
from scout.gaps import analyze_gaps
from scout.secrets import load_secrets_from_keyvault

load_dotenv(override=False)

logger = logging.getLogger("content-scout")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

# Pull scanner API keys from Key Vault (no-op in local dev if KV not configured).
# Do this once at import time so scanners see them via os.environ.
load_secrets_from_keyvault()

# ---------------------------------------------------------------------------
# Hosted agent entry point
# ---------------------------------------------------------------------------

def get_credential():
    """Use ManagedIdentityCredential in production, DefaultAzureCredential locally."""
    if os.getenv("AZURE_AI_PROJECT_ENDPOINT"):
        return ManagedIdentityCredential()
    return DefaultAzureCredential()


def create_agent():
    """Create the Content Scout agent using Agent Framework."""
    from agent_framework import BaseAgent

    class ContentScoutAgent(BaseAgent):
        """
        Content Scout hosted agent.

        Supports two interaction modes:
        - Responses protocol: conversational (same as editor-based agent)
        - Invocations protocol: automated commands via JSON payloads
        """

        async def run(self, context):
            user_input = context.get_last_user_message()
            if not user_input:
                return "Hello! I'm Content Scout. Say 'scout scan', 'scout post', 'scout gaps', or 'scout trends' to get started."

            command = parse_command(user_input)
            result = await execute_command(command)
            return result

    return ContentScoutAgent(
        name="content-scout",
        description="Content research agent for the developer ecosystem",
    )


# ---------------------------------------------------------------------------
# Command parsing — works for both natural language and structured JSON
# ---------------------------------------------------------------------------

COMMAND_PATTERNS = {
    "scan": ["scout scan", "scan for content", "find content", "run scan"],
    "post": ["scout post", "generate posts", "create social posts"],
    "calendar": ["scout calendar", "schedule posts", "posting calendar"],
    "gaps": ["scout gaps", "content gaps", "gap analysis"],
    "trends": ["scout trends", "show trends", "compare months"],
    "onboard": ["scout onboard", "set up", "configure"],
}


def parse_command(input_text: str) -> dict:
    """
    Parse user input into a structured command.

    Accepts natural language ("scout scan cosmos-db for March 2026")
    or structured JSON (from Invocations protocol):
    {
        "command": "scan",
        "slug": "cosmos-db",
        "month": "2026-03",
        "options": {}
    }
    """
    # Try JSON first (Invocations protocol)
    try:
        parsed = json.loads(input_text)
        if isinstance(parsed, dict) and "command" in parsed:
            return parsed
    except (json.JSONDecodeError, TypeError):
        pass

    # Natural language parsing
    text = input_text.lower().strip()

    for command, patterns in COMMAND_PATTERNS.items():
        for pattern in patterns:
            if pattern in text:
                return {
                    "command": command,
                    "raw_input": input_text,
                    "slug": extract_slug(text, pattern),
                    "month": extract_month(text),
                }

    return {"command": "unknown", "raw_input": input_text}


def extract_slug(text: str, matched_pattern: str) -> str | None:
    """Extract a product slug from the text after the command pattern."""
    remainder = text.split(matched_pattern, 1)[-1].strip()
    if not remainder:
        return None
    # First word after the command is likely the slug
    words = remainder.split()
    candidate = words[0].strip(".,!?")
    if candidate in ("for", "in", "from", "the", "all", "month", "last"):
        return None
    return candidate


def extract_month(text: str) -> str | None:
    """Extract a month/year reference from the text."""
    import re

    text = text.lower()

    # Match "March 2026", "2026-03", "Jan 2025", etc.
    month_names = {
        "january": "01", "february": "02", "march": "03", "april": "04",
        "may": "05", "june": "06", "july": "07", "august": "08",
        "september": "09", "october": "10", "november": "11", "december": "12",
        "jan": "01", "feb": "02", "mar": "03", "apr": "04",
        "jun": "06", "jul": "07", "aug": "08", "sep": "09",
        "oct": "10", "nov": "11", "dec": "12",
    }

    # ISO format: 2026-03
    iso_match = re.search(r"(\d{4})-(\d{2})", text)
    if iso_match:
        return f"{iso_match.group(1)}-{iso_match.group(2)}"

    # Natural: March 2026
    for name, num in month_names.items():
        pattern = rf"\b{name}\s+(\d{{4}})\b"
        match = re.search(pattern, text)
        if match:
            return f"{match.group(1)}-{num}"

    return None


# ---------------------------------------------------------------------------
# Command execution
# ---------------------------------------------------------------------------

async def execute_command(command: dict) -> str:
    """Execute a parsed command and return the result."""
    cmd = command.get("command", "unknown")
    slug = command.get("slug")
    month = command.get("month")

    config_path = os.getenv("SCOUT_CONFIG_PATH", ".github/prompts/")

    if cmd == "scan":
        return await run_scan(config_path, slug, month)
    elif cmd == "post":
        url = command.get("url") or command.get("raw_input", "")
        return await run_post(config_path, slug, url)
    elif cmd == "calendar":
        return await run_calendar(config_path, slug, month)
    elif cmd == "gaps":
        return await run_gaps(config_path, slug, month)
    elif cmd == "trends":
        return await run_trends(config_path, slug)
    elif cmd == "onboard":
        return "Onboarding is interactive — use Content Scout in your editor (VS Code, Claude Code, Cursor, etc.) and say 'scout onboard'. The hosted agent uses config files generated during onboarding."
    else:
        return (
            "I didn't recognize that command. Available commands:\n"
            "- **scout scan** [slug] [month] — Scan for content\n"
            "- **scout post** [url] — Generate social posts\n"
            "- **scout calendar** [slug] — Create posting schedule\n"
            "- **scout gaps** [slug] — Find content gaps\n"
            "- **scout trends** [slug] — Show month-over-month trends\n"
        )


async def run_scan(config_path: str, slug: str | None, month: str | None) -> str:
    """Execute a content scan."""
    configs = load_all_configs(config_path) if not slug else [load_config(config_path, slug)]

    if not configs:
        return "No config files found. Run 'scout onboard' in your editor first."

    # Determine time window
    if month:
        year, mon = month.split("-")
        start = datetime(int(year), int(mon), 1, tzinfo=timezone.utc)
    else:
        start = datetime.now(timezone.utc).replace(day=1)

    results = []
    seen_links = load_seen_links()

    for config in configs:
        logger.info(f"Scanning sources for {config['name']}...")

        # Scan all enabled sources
        raw_items = await scan_all_sources(config, start)
        logger.info(f"Found {len(raw_items)} raw items for {config['name']}")

        # Apply quality filter
        filtered = apply_quality_filter(raw_items, config, seen_links)
        logger.info(f"{len(filtered)} items passed quality filter for {config['name']}")

        # Generate report
        report_path = generate_report(config, filtered, start)
        logger.info(f"Report saved to {report_path}")

        # Generate social posts if role enables them
        if config.get("social_posts_enabled"):
            posts_path = generate_social_posts(config, filtered, start)
            logger.info(f"Social posts saved to {posts_path}")

        # Update dedup tracker
        new_urls = [item["url"] for item in filtered if "url" in item]
        seen_links.update(new_urls)

        results.append({
            "topic": config["name"],
            "items_found": len(raw_items),
            "items_included": len(filtered),
            "report": str(report_path),
        })

    save_seen_links(seen_links)

    # Format summary
    summary_lines = [f"## Scan Complete\n"]
    for r in results:
        summary_lines.append(
            f"**{r['topic']}:** {r['items_included']} items "
            f"(from {r['items_found']} candidates) → `{r['report']}`"
        )
    return "\n".join(summary_lines)


async def run_post(config_path: str, slug: str | None, url: str) -> str:
    """Generate social posts from a URL."""
    config = _resolve_config(config_path, slug)
    if not config:
        return "No config found."
    # TODO: Fetch URL content, generate posts using LLM
    return f"Social post generation for {url} — not yet implemented in hosted mode."


async def run_calendar(config_path: str, slug: str | None, month: str | None) -> str:
    """Generate a posting calendar."""
    config = _resolve_config(config_path, slug)
    if not config:
        return "No config found."
    # TODO: Read report, generate calendar
    return "Calendar generation — not yet implemented in hosted mode."


async def run_gaps(config_path: str, slug: str | None, month: str | None) -> str:
    """Analyze content gaps."""
    config = _resolve_config(config_path, slug)
    if not config:
        return "No config found."
    report = _find_latest_report(config, month)
    if not report:
        return "No report found. Run 'scout scan' first."
    gaps = analyze_gaps(config, report)
    return gaps


async def run_trends(config_path: str, slug: str | None) -> str:
    """Generate trends analysis."""
    config = _resolve_config(config_path, slug)
    if not config:
        return "No config found."
    trends = generate_trends_report(config)
    return trends


def _resolve_config(config_path: str, slug: str | None):
    """Load a single config, prompting if ambiguous."""
    if slug:
        return load_config(config_path, slug)
    configs = load_all_configs(config_path)
    if len(configs) == 1:
        return configs[0]
    return None


def _find_latest_report(config: dict, month: str | None) -> Path | None:
    """Find the latest report file for a config."""
    reports_dir = Path("reports")
    if not reports_dir.exists():
        return None
    slug = config.get("slug", "")
    if month:
        pattern = f"{month}-{slug}-content.md" if slug else f"{month}-content.md"
    else:
        pattern = f"*-{slug}-content.md" if slug else "*-content.md"
    matches = sorted(reports_dir.glob(pattern), reverse=True)
    return matches[0] if matches else None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    from agent_framework_foundry_hosting import ResponsesHostServer

    agent = create_agent()
    server = ResponsesHostServer(agent)
    server.run()
