# Content Scout — Deduplication tracker
# Manages the set of previously-seen URLs so the same content never shows up
# in two reports. Delegates read/write to `scout.storage`, which transparently
# uses Azure Blob Storage in hosted mode and the local filesystem in dev.

import json
import logging

from scout import storage

logger = logging.getLogger("content-scout.dedup")

SEEN_BLOB = ".seen-links.json"

# Back-compat alias: tests monkeypatch `SEEN_LINKS_PATH` to redirect IO.
# In local mode the storage module maps this to `reports/.seen-links.json`.
from pathlib import Path
SEEN_LINKS_PATH = Path(storage.REPORTS_CONTAINER) / SEEN_BLOB


def load_seen_links() -> set[str]:
    """Load the set of previously seen URLs."""
    # Honor monkeypatched path for tests — if the path differs from the
    # storage module default, read it directly.
    if SEEN_LINKS_PATH != Path(storage.REPORTS_CONTAINER) / SEEN_BLOB:
        if not SEEN_LINKS_PATH.exists():
            return set()
        try:
            data = json.loads(SEEN_LINKS_PATH.read_text(encoding="utf-8"))
            return set(data) if isinstance(data, list) else set()
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"Could not read seen links: {e}")
            return set()

    raw = storage.read_text(storage.REPORTS_CONTAINER, SEEN_BLOB)
    if not raw:
        return set()
    try:
        data = json.loads(raw)
        return set(data) if isinstance(data, list) else set()
    except json.JSONDecodeError as e:
        logger.warning(f"Corrupted seen-links data: {e}")
        return set()


def save_seen_links(links: set[str]) -> None:
    """Save the updated set of seen URLs."""
    content = json.dumps(sorted(links), indent=2, ensure_ascii=False)

    # Honor monkeypatched path for tests.
    if SEEN_LINKS_PATH != Path(storage.REPORTS_CONTAINER) / SEEN_BLOB:
        SEEN_LINKS_PATH.parent.mkdir(parents=True, exist_ok=True)
        SEEN_LINKS_PATH.write_text(content, encoding="utf-8")
    else:
        storage.write_text(storage.REPORTS_CONTAINER, SEEN_BLOB, content)

    logger.info(f"Saved {len(links)} seen links")
