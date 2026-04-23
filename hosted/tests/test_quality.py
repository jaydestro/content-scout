"""Tests for scout.quality — quality filter, scoring, URL normalization."""

import pytest

from scout.quality import (
    normalize_url,
    passes_relevancy_gate,
    compute_score,
    apply_quality_filter,
)


class TestNormalizeUrl:
    def test_strips_utm_params(self):
        url = "https://example.com/post?utm_source=twitter&utm_medium=social&id=42"
        result = normalize_url(url)
        assert "utm_source" not in result
        assert "utm_medium" not in result
        assert "id=42" in result

    def test_strips_ref_param(self):
        url = "https://dev.to/article?ref=sidebar"
        result = normalize_url(url)
        assert "ref=" not in result

    def test_strips_fragment(self):
        url = "https://example.com/page#section"
        result = normalize_url(url)
        assert "#section" not in result

    def test_preserves_meaningful_params(self):
        url = "https://example.com/search?q=cosmos+db&page=2"
        result = normalize_url(url)
        assert "q=" in result
        assert "page=2" in result

    def test_returns_empty_for_empty(self):
        assert normalize_url("") == ""
        assert normalize_url(None) == ""

    def test_handles_malformed_url(self):
        result = normalize_url("not-a-url")
        assert result == "not-a-url"

    def test_strips_utm_campaign(self):
        url = "https://blog.example.com/post?utm_campaign=launch2026"
        result = normalize_url(url)
        assert "utm_campaign" not in result


class TestPassesRelevancyGate:
    def test_accepts_tutorial(self):
        item = {"title": "Tutorial: Building with Cosmos DB", "summary": "Step by step guide", "source": "Dev.to"}
        assert passes_relevancy_gate(item) is True

    def test_rejects_what_is_post(self):
        item = {"title": "What is Azure Cosmos DB?", "summary": "An introduction", "source": "Medium"}
        assert passes_relevancy_gate(item) is False

    def test_rejects_getting_started_portal(self):
        item = {"title": "Getting started with Azure Cosmos DB portal", "summary": "", "source": "Medium"}
        assert passes_relevancy_gate(item) is False

    def test_rejects_certification_guide(self):
        item = {"title": "AZ-204 Certification Study Guide", "summary": "prep for the exam", "source": "Dev.to"}
        assert passes_relevancy_gate(item) is False

    def test_rejects_job_posting(self):
        item = {"title": "Senior Backend Engineer — Job Opening", "summary": "hiring now", "source": "LinkedIn"}
        assert passes_relevancy_gate(item) is False

    def test_rejects_youtube_no_description(self):
        item = {"title": "Cosmos DB Video", "summary": "", "source": "YouTube"}
        assert passes_relevancy_gate(item) is False

    def test_accepts_youtube_with_description(self):
        item = {"title": "Cosmos DB Video", "summary": "Deep dive into partition keys", "source": "YouTube"}
        assert passes_relevancy_gate(item) is True

    def test_accepts_deep_dive(self):
        item = {"title": "Deep dive into change feed", "summary": "Architecture patterns", "source": "Dev.to"}
        assert passes_relevancy_gate(item) is True

    def test_rejects_listicle(self):
        item = {"title": "10 best database tools for 2026", "summary": "a list", "source": "Medium"}
        assert passes_relevancy_gate(item) is False


class TestComputeScore:
    def test_tutorial_scores_high(self):
        item = {
            "title": "How to build a real-world app with Cosmos DB",
            "summary": "Step by step tutorial with code examples and benchmarks",
            "source": "Dev.to",
        }
        score = compute_score(item)
        assert score >= 5, f"Tutorial should score >= 5, got {score}"

    def test_shallow_mention_scores_low(self):
        item = {
            "title": "My tech stack",
            "summary": "I use React",
            "source": "Medium",
        }
        score = compute_score(item)
        assert score < 5, f"Shallow content should score < 5, got {score}"

    def test_github_gets_originality_bonus(self):
        item = {
            "title": "cosmos-db-toolkit",
            "summary": "A toolkit",
            "source": "GitHub",
        }
        score = compute_score(item)
        # GitHub source gets originality = 2 minimum
        assert score >= 4

    def test_case_study_scores_high(self):
        item = {
            "title": "Our production journey with Cosmos DB",
            "summary": "Real-world case study with lessons learned and benchmarks",
            "source": "Dev.to",
        }
        score = compute_score(item)
        assert score >= 7, f"Case study should score >= 7, got {score}"

    def test_score_range(self):
        item = {"title": "x", "summary": "y", "source": "Other"}
        score = compute_score(item)
        assert 3 <= score <= 9, f"Score must be 3-9, got {score}"


class TestApplyQualityFilter:
    @pytest.fixture
    def base_config(self):
        return {
            "known_authors": ["Jane Dev — MVP"],
            "search_terms": ["Test Product"],
        }

    def test_deduplicates_seen_links(self, base_config):
        items = [
            {"title": "Tutorial on building apps", "url": "https://example.com/1", "date": "2026-04-01", "summary": "A deep tutorial with code examples and step by step walkthrough", "source": "Dev.to"},
            {"title": "Another tutorial", "url": "https://example.com/2", "date": "2026-04-02", "summary": "Another deep tutorial with benchmarks and real-world examples", "source": "Dev.to"},
        ]
        seen = {"https://example.com/1"}
        result = apply_quality_filter(items, base_config, seen)
        urls = [i["url"] for i in result]
        assert "https://example.com/1" not in urls

    def test_skips_empty_urls(self, base_config):
        items = [{"title": "No URL", "url": "", "date": "2026-04-01", "summary": "content"}]
        result = apply_quality_filter(items, base_config, set())
        assert len(result) == 0

    def test_known_author_bypasses_relevancy(self, base_config):
        items = [
            {
                "title": "What is Test Product?",  # Would normally be excluded
                "url": "https://example.com/jane",
                "date": "2026-04-01",
                "author": "Jane Dev",
                "summary": "overview",
                "source": "Dev.to",
            }
        ]
        result = apply_quality_filter(items, base_config, set())
        assert len(result) == 1

    def test_conversation_items_skip_relevancy(self, base_config):
        items = [
            {
                "title": "What is Test Product?",
                "url": "https://reddit.com/r/test/123",
                "date": "2026-04-01",
                "summary": "Just curious",
                "source": "Reddit",
                "is_conversation": True,
            }
        ]
        result = apply_quality_filter(items, base_config, set())
        assert len(result) == 1

    def test_normalizes_urls_for_dedup(self, base_config):
        items = [
            {"title": "Tutorial", "url": "https://example.com/post?utm_source=twitter", "date": "2026-04-01", "summary": "A detailed deep dive tutorial with code examples", "source": "Dev.to"},
        ]
        seen = {"https://example.com/post?"}
        result = apply_quality_filter(items, base_config, seen)
        # The normalized URL (without utm) should match the seen link
        for item in result:
            assert "utm_source" not in item["url"]
