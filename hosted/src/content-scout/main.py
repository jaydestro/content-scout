# Content Scout — Hosted Agent entry point
#
# Wraps the existing Scout command handlers (run_scan, run_trends, etc.)
# as Agent Framework tools. The hosting adapter serves the Responses +
# Invocations protocols on port 8088.

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from agent_framework import Agent, tool
from agent_framework.foundry import FoundryChatClient
from agent_framework_foundry_hosting import ResponsesHostServer
from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv

from scout.config import load_all_configs, load_config
from scout.dedup import load_seen_links, save_seen_links
from scout.gaps import analyze_gaps
from scout.quality import apply_quality_filter
from scout.report import generate_report
from scout.scanner import scan_all_sources
from scout.secrets import load_secrets_from_keyvault
from scout.social import generate_social_posts
from scout.trends import generate_trends_report

load_dotenv(override=False)

logger = logging.getLogger("content-scout")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

# Load scanner API keys from Key Vault at startup (no-op locally if unset).
load_secrets_from_keyvault()


def _config_path() -> str:
    return os.getenv("SCOUT_CONFIG_PATH", "/app/.github/prompts/")


def _month_to_start(month: str | None) -> datetime:
    if month:
        year, mon = month.split("-")
        return datetime(int(year), int(mon), 1, tzinfo=timezone.utc)
    return datetime.now(timezone.utc).replace(day=1)


def _resolve_configs(slug: str | None) -> list[dict]:
    if slug:
        c = load_config(_config_path(), slug)
        return [c] if c else []
    return load_all_configs(_config_path())


def _latest_report(config: dict, month: str | None) -> Path | None:
    reports_dir = Path("reports")
    if not reports_dir.exists():
        return None
    slug = config.get("slug", "")
    pattern = (
        f"{month}-{slug}-content.md" if month and slug
        else f"*-{slug}-content.md" if slug
        else "*-content.md"
    )
    matches = sorted(reports_dir.glob(pattern), reverse=True)
    return matches[0] if matches else None


# ---------------------------------------------------------------------------
# Agent tools — each maps to a Scout command
# ---------------------------------------------------------------------------


@tool
async def scout_scan(slug: str | None = None, month: str | None = None) -> str:
    """Scan public sources (Dev.to, GitHub, YouTube, Reddit, Stack Overflow, Hacker News,
    Bluesky, Hashnode, DZone) for content about a product. Returns a summary of items found
    and the path to the saved report.

    Args:
        slug: Optional product slug to scan. Scans all configured products if omitted.
        month: Optional YYYY-MM month to scan. Current month if omitted.
    """
    configs = _resolve_configs(slug)
    if not configs:
        return "No product configs found. Run 'scout onboard' in your editor first."

    start = _month_to_start(month)
    seen_links = load_seen_links()
    results = []

    for config in configs:
        logger.info("Scanning for %s...", config["name"])
        raw = await scan_all_sources(config, start)
        filtered = apply_quality_filter(raw, config, seen_links)
        report_path = generate_report(config, filtered, start)

        if config.get("social_posts_enabled"):
            generate_social_posts(config, filtered, start)

        seen_links.update(i["url"] for i in filtered if "url" in i)
        results.append(
            f"**{config['name']}:** {len(filtered)} items "
            f"(from {len(raw)} candidates) → `{report_path}`"
        )

    save_seen_links(seen_links)
    return "## Scan Complete\n\n" + "\n".join(results)


@tool
async def scout_trends(slug: str | None = None) -> str:
    """Show month-over-month content trends for a product.

    Args:
        slug: Product slug to analyze.
    """
    configs = _resolve_configs(slug)
    if not configs:
        return "No product configs found."
    return generate_trends_report(configs[0])


@tool
async def scout_gaps(slug: str | None = None, month: str | None = None) -> str:
    """Identify topics with no recent content coverage.

    Args:
        slug: Product slug to analyze.
        month: Optional YYYY-MM; uses latest report if omitted.
    """
    configs = _resolve_configs(slug)
    if not configs:
        return "No product configs found."
    config = configs[0]
    report = _latest_report(config, month)
    if not report:
        return "No report found. Run scout_scan first."
    return analyze_gaps(config, report)


# ---------------------------------------------------------------------------
# Hosted agent boot
# ---------------------------------------------------------------------------

INSTRUCTIONS = """You are Content Scout, a research agent that discovers, catalogs, and
promotes public developer content about a product or technology.

You have four tools:
- scout_scan(slug, month): run a content scan across all sources
- scout_trends(slug): show month-over-month trends
- scout_gaps(slug, month): find topics with no recent coverage
- scout_post (not implemented here; direct users to editor mode)

Common phrases:
- "scout scan cosmos-db for March 2026" → scout_scan(slug="cosmos-db", month="2026-03")
- "scout trends" → scout_trends()
- "scout gaps" → scout_gaps()

If the user asks about onboarding or configuration, explain that onboarding is interactive
and should be done in their editor (VS Code, Claude Code, Cursor, etc.) — the hosted agent
consumes the config files generated there.

Keep responses brief and factual. Always include the report path so the user can open it."""


def main() -> None:
    # Endpoint envs are injected by the Foundry hosted runtime after azd up.
    project_endpoint = (
        os.environ.get("FOUNDRY_PROJECT_ENDPOINT")
        or os.environ["AZURE_AI_PROJECT_ENDPOINT"]
    )
    model = os.environ["MODEL_DEPLOYMENT_NAME"]

    client = FoundryChatClient(
        project_endpoint=project_endpoint,
        model=model,
        credential=DefaultAzureCredential(),
    )

    agent = Agent(
        client=client,
        instructions=INSTRUCTIONS,
        tools=[scout_scan, scout_trends, scout_gaps],
        default_options={"store": False},
    )

    server = ResponsesHostServer(agent)
    server.run()


if __name__ == "__main__":
    main()
