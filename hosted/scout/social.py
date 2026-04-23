# Content Scout — Social post generator.
# Uses the Foundry model (via scout.llm) to draft on-brand social posts.
# Falls back to deterministic templates when the LLM isn't configured so
# `scout scan` keeps working on a stock dev machine.

import logging
from datetime import datetime
from pathlib import Path

from scout import llm, storage

logger = logging.getLogger("content-scout.social")


_SYSTEM_PROMPT = (
    "You write concise, on-brand developer-marketing social posts. "
    "Tone: informative, not salesy. No hashtags unless essential. "
    "No emojis. Never invent features or claims."
)


def _draft_post(item: dict, platform: str, brand_voice: str) -> str:
    """Ask the LLM to draft one post. Returns fallback text if LLM unavailable."""
    title = item.get("title", "")
    url = item.get("url", "")
    summary = item.get("summary") or item.get("description") or ""
    max_chars = 280 if platform == "X" else 600

    prompt = (
        f"Write a single {platform} post promoting this content.\n"
        f"Brand voice: {brand_voice}\n"
        f"Title: {title}\n"
        f"Summary: {summary[:400]}\n"
        f"URL: {url}\n"
        f"Constraints: max {max_chars} chars total including URL; end with the URL."
    )

    result = llm.complete(prompt, system=_SYSTEM_PROMPT, temperature=0.7, max_tokens=300)
    if result:
        return result.strip()

    # Fallback — deterministic
    if platform == "X":
        return f"{title} {url}"
    return f"{title} — worth a read.\n\n{url}"


def generate_social_posts(config: dict, items: list[dict], scan_start: datetime) -> Path:
    """Generate social posts for all numbered items. Returns the output file path."""
    slug = config.get("slug", "")
    brand_voice = config.get("brand_voice", "professional, developer-focused")
    month_str = scan_start.strftime("%Y-%m")
    filename = f"{month_str}-{slug}-social-posts.md" if slug else f"{month_str}-social-posts.md"

    numbered = [i for i in items if not i.get("is_conversation")]

    lines = [
        f"# Social Posts — {config.get('name', slug)} — {scan_start.strftime('%B %Y')}\n",
        f"**Report:** [report](../reports/{month_str}-{slug}-content.md)\n",
        f"**Generated:** {datetime.now().strftime('%Y-%m-%d')}",
        f"**LLM:** {'enabled' if llm.is_configured() else 'disabled (fallback templates in use)'}",
        "",
    ]

    for i, item in enumerate(numbered, 1):
        lines.append(f"## #{i} — {item.get('title', 'Untitled')}")
        lines.append(f"**Source:** {item.get('url', '')}\n")

        lines.append("### LinkedIn Option 1")
        lines.append("```text")
        lines.append(_draft_post(item, "LinkedIn", brand_voice))
        lines.append("```")
        lines.append("")

        lines.append("### X Option 1")
        lines.append("```text")
        lines.append(_draft_post(item, "X", brand_voice))
        lines.append("```")
        lines.append("")

    location = storage.write_text(storage.SOCIAL_CONTAINER, filename, "\n".join(lines))
    return Path(location)
