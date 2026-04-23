"""Tests for app.py — command parsing (natural language + JSON)."""

import json
import sys
from pathlib import Path

import pytest

# Add hosted/ to path so we can import app
sys.path.insert(0, str(Path(__file__).parent.parent))

from app import parse_command, extract_slug, extract_month


class TestParseCommandJSON:
    """Test structured JSON command parsing (Invocations protocol)."""

    def test_parses_scan_command(self):
        result = parse_command(json.dumps({"command": "scan", "slug": "cosmos-db", "month": "2026-03"}))
        assert result["command"] == "scan"
        assert result["slug"] == "cosmos-db"
        assert result["month"] == "2026-03"

    def test_parses_post_command(self):
        result = parse_command(json.dumps({"command": "post", "url": "https://example.com"}))
        assert result["command"] == "post"
        assert result["url"] == "https://example.com"

    def test_parses_gaps_command(self):
        result = parse_command(json.dumps({"command": "gaps", "slug": "python"}))
        assert result["command"] == "gaps"

    def test_parses_trends_command(self):
        result = parse_command(json.dumps({"command": "trends"}))
        assert result["command"] == "trends"

    def test_ignores_non_dict_json(self):
        result = parse_command(json.dumps(["not", "a", "dict"]))
        assert result["command"] == "unknown"

    def test_ignores_json_without_command(self):
        result = parse_command(json.dumps({"slug": "test"}))
        assert result["command"] == "unknown"


class TestParseCommandNaturalLanguage:
    """Test natural language command parsing."""

    def test_scout_scan(self):
        result = parse_command("scout scan")
        assert result["command"] == "scan"

    def test_scout_scan_with_slug(self):
        result = parse_command("scout scan cosmos-db")
        assert result["command"] == "scan"
        assert result["slug"] == "cosmos-db"

    def test_scout_scan_with_month(self):
        result = parse_command("scout scan for March 2026")
        assert result["command"] == "scan"
        assert result["month"] == "2026-03"

    def test_scout_scan_slug_and_month(self):
        result = parse_command("scout scan cosmos-db for March 2026")
        assert result["command"] == "scan"
        assert result["slug"] == "cosmos-db"
        assert result["month"] == "2026-03"

    def test_scan_for_content(self):
        result = parse_command("scan for content")
        assert result["command"] == "scan"

    def test_find_content(self):
        result = parse_command("find content")
        assert result["command"] == "scan"

    def test_scout_post(self):
        result = parse_command("scout post")
        assert result["command"] == "post"

    def test_generate_posts(self):
        result = parse_command("generate posts")
        assert result["command"] == "post"

    def test_scout_calendar(self):
        result = parse_command("scout calendar")
        assert result["command"] == "calendar"

    def test_schedule_posts(self):
        result = parse_command("schedule posts")
        assert result["command"] == "calendar"

    def test_scout_gaps(self):
        result = parse_command("scout gaps")
        assert result["command"] == "gaps"

    def test_content_gaps(self):
        result = parse_command("content gaps")
        assert result["command"] == "gaps"

    def test_scout_trends(self):
        result = parse_command("scout trends")
        assert result["command"] == "trends"

    def test_show_trends(self):
        result = parse_command("show trends")
        assert result["command"] == "trends"

    def test_scout_onboard(self):
        result = parse_command("scout onboard")
        assert result["command"] == "onboard"

    def test_unknown_command(self):
        result = parse_command("hello world")
        assert result["command"] == "unknown"

    def test_case_insensitive(self):
        result = parse_command("Scout Scan Cosmos-DB")
        assert result["command"] == "scan"


class TestExtractSlug:
    def test_extracts_first_word(self):
        assert extract_slug("scout scan cosmos-db for march 2026", "scout scan") == "cosmos-db"

    def test_returns_none_for_empty(self):
        assert extract_slug("scout scan", "scout scan") is None

    def test_skips_filler_words(self):
        assert extract_slug("scout scan for march 2026", "scout scan") is None
        assert extract_slug("scout scan the latest", "scout scan") is None
        assert extract_slug("scout scan all", "scout scan") is None

    def test_strips_punctuation(self):
        assert extract_slug("scout scan cosmos-db.", "scout scan") == "cosmos-db"


class TestExtractMonth:
    def test_iso_format(self):
        assert extract_month("scan for 2026-03") == "2026-03"

    def test_full_month_name(self):
        assert extract_month("scan for March 2026") == "2026-03"

    def test_abbreviated_month(self):
        assert extract_month("scan for Jan 2025") == "2025-01"

    def test_december(self):
        assert extract_month("December 2026") == "2026-12"

    def test_returns_none_when_no_month(self):
        assert extract_month("scout scan cosmos-db") is None

    def test_returns_none_for_bare_text(self):
        assert extract_month("hello world") is None

    def test_case_insensitive(self):
        assert extract_month("APRIL 2026") == "2026-04"
