"""Tests for scout.dedup — seen links JSON persistence."""

import json

import pytest

from scout.dedup import load_seen_links, save_seen_links, SEEN_LINKS_PATH


@pytest.fixture(autouse=True)
def isolate_dedup(tmp_path, monkeypatch):
    """Redirect SEEN_LINKS_PATH to a temp directory for every test."""
    test_path = tmp_path / "reports" / ".seen-links.json"
    monkeypatch.setattr("scout.dedup.SEEN_LINKS_PATH", test_path)
    return test_path


class TestLoadSeenLinks:
    def test_returns_empty_when_no_file(self):
        result = load_seen_links()
        assert result == set()

    def test_loads_existing_links(self, isolate_dedup):
        isolate_dedup.parent.mkdir(parents=True, exist_ok=True)
        isolate_dedup.write_text(json.dumps(["https://a.com", "https://b.com"]))
        result = load_seen_links()
        assert result == {"https://a.com", "https://b.com"}

    def test_handles_corrupted_json(self, isolate_dedup):
        isolate_dedup.parent.mkdir(parents=True, exist_ok=True)
        isolate_dedup.write_text("not valid json {{{")
        result = load_seen_links()
        assert result == set()

    def test_handles_wrong_type(self, isolate_dedup):
        isolate_dedup.parent.mkdir(parents=True, exist_ok=True)
        isolate_dedup.write_text(json.dumps({"key": "value"}))
        result = load_seen_links()
        assert result == set()


class TestSaveSeenLinks:
    def test_saves_and_reloads(self, isolate_dedup):
        links = {"https://x.com/1", "https://y.com/2", "https://z.com/3"}
        save_seen_links(links)
        reloaded = load_seen_links()
        assert reloaded == links

    def test_creates_parent_dirs(self, isolate_dedup):
        assert not isolate_dedup.parent.exists()
        save_seen_links({"https://example.com"})
        assert isolate_dedup.exists()

    def test_output_is_sorted_json(self, isolate_dedup):
        save_seen_links({"https://c.com", "https://a.com", "https://b.com"})
        data = json.loads(isolate_dedup.read_text())
        assert data == ["https://a.com", "https://b.com", "https://c.com"]

    def test_overwrites_existing(self, isolate_dedup):
        save_seen_links({"https://old.com"})
        save_seen_links({"https://new.com"})
        reloaded = load_seen_links()
        assert reloaded == {"https://new.com"}
