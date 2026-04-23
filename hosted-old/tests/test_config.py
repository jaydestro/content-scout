"""Tests for scout.config — markdown config file parsing."""

import textwrap
from pathlib import Path

import pytest

from scout.config import _parse_config, _extract_list_section, _extract_network_table, load_config, load_all_configs


@pytest.fixture
def sample_config(tmp_path):
    """Create a sample config file for testing."""
    content = textwrap.dedent("""\
        ---
        mode: agent
        agent: content-scout
        description: "Content Scout configuration for Test Product"
        ---

        # Content Scout Configuration: Test Product

        ## Role
        - **Role:** Developer Advocate
        - **Social posts:** on
        - **Posting calendar:** on
        - **Report focus:** Community projects, tutorials, conference talks
        - **Conversation sentiment:** on
        - **Feature request flagging:** off

        ## Topic
        - **Name:** Test Product
        - **Slug:** test-product
        - **Type:** product

        ## Search Terms

        ### Text Searches
        - "Test Product"
        - "TestProduct"
        - "TP SDK"

        ### Hashtags
        - #TestProduct
        - #TPDev

        ## Exclusions

        ### Official Channels
        - **Blog:** https://blog.testproduct.dev/

        ### Excluded GitHub Orgs/Repos
        - testorg/test-product-sdk
        - testorg/test-product-docs

        ### Excluded Domains/Authors
        - blog.testproduct.dev (official blog)

        ## Networks

        ### Standard Sources
        | Source | Enabled |
        |--------|---------|
        | Dev.to | yes |
        | Medium | yes |
        | Hashnode | no |
        | YouTube | yes |
        | GitHub | yes |
        | Stack Overflow | yes |
        | Reddit | yes |
        | Hacker News | yes |
        | Bluesky | no |
        | X/Twitter | no |
        | LinkedIn | yes |

        ## Known External Authors
        - Jane Dev — MVP, writes deep perf posts
        - Bob Builder — Community educator

        ## Topic Tags (Canonical)
        - getting-started
        - performance
        - migration
        - security
        - sdk
    """)
    config_path = tmp_path / "scout-config-test-product.prompt.md"
    config_path.write_text(content, encoding="utf-8")
    return config_path


@pytest.fixture
def example_config(tmp_path):
    """Create an example config file that should be skipped."""
    content = "# Example config — should be ignored by load_all_configs\n"
    path = tmp_path / "scout-config-example.prompt.md"
    path.write_text(content, encoding="utf-8")
    return path


class TestParseConfig:
    def test_extracts_name(self, sample_config):
        config = _parse_config(sample_config)
        assert config["name"] == "Test Product"

    def test_extracts_slug(self, sample_config):
        config = _parse_config(sample_config)
        assert config["slug"] == "test-product"

    def test_extracts_type(self, sample_config):
        config = _parse_config(sample_config)
        assert config["type"] == "product"

    def test_extracts_role(self, sample_config):
        config = _parse_config(sample_config)
        assert config["role"] == "Developer Advocate"

    def test_social_posts_enabled(self, sample_config):
        config = _parse_config(sample_config)
        assert config["social_posts_enabled"] is True

    def test_posting_calendar_enabled(self, sample_config):
        config = _parse_config(sample_config)
        assert config["posting_calendar_enabled"] is True

    def test_strips_yaml_frontmatter(self, sample_config):
        config = _parse_config(sample_config)
        assert "mode" not in config or config.get("mode") != "agent"

    def test_extracts_search_terms(self, sample_config):
        config = _parse_config(sample_config)
        assert config["search_terms"] == ["Test Product", "TestProduct", "TP SDK"]

    def test_extracts_hashtags(self, sample_config):
        config = _parse_config(sample_config)
        assert config["hashtags"] == ["#TestProduct", "#TPDev"]

    def test_extracts_excluded_repos(self, sample_config):
        config = _parse_config(sample_config)
        assert "testorg/test-product-sdk" in config["excluded_repos"]
        assert "testorg/test-product-docs" in config["excluded_repos"]

    def test_extracts_excluded_domains(self, sample_config):
        config = _parse_config(sample_config)
        assert any("blog.testproduct.dev" in d for d in config["excluded_domains"])

    def test_extracts_known_authors(self, sample_config):
        config = _parse_config(sample_config)
        assert len(config["known_authors"]) == 2
        assert any("Jane Dev" in a for a in config["known_authors"])

    def test_extracts_topic_tags(self, sample_config):
        config = _parse_config(sample_config)
        assert "performance" in config["topic_tags"]
        assert "migration" in config["topic_tags"]
        assert len(config["topic_tags"]) == 5

    def test_extracts_networks(self, sample_config):
        config = _parse_config(sample_config)
        networks = config["networks"]
        assert networks["Dev.to"] is True
        assert networks["YouTube"] is True
        assert networks["Hashnode"] is False
        assert networks["Bluesky"] is False
        assert networks["X/Twitter"] is False

    def test_source_path_stored(self, sample_config):
        config = _parse_config(sample_config)
        assert config["_source"] == str(sample_config)


class TestExtractListSection:
    def test_extracts_bullet_items(self):
        text = "### My Section\n- item one\n- item two\n- item three\n\n## Next"
        result = _extract_list_section(text, "My Section")
        assert result == ["item one", "item two", "item three"]

    def test_strips_quotes(self):
        text = '### Terms\n- "quoted term"\n- \'single quoted\'\n'
        result = _extract_list_section(text, "Terms")
        assert result == ["quoted term", "single quoted"]

    def test_skips_none_values(self):
        text = "### Items\n- none\n- real item\n- None\n"
        result = _extract_list_section(text, "Items")
        assert result == ["real item"]

    def test_returns_empty_for_missing_section(self):
        text = "### Other Section\n- item\n"
        result = _extract_list_section(text, "Missing Section")
        assert result == []


class TestExtractNetworkTable:
    def test_parses_table(self):
        text = textwrap.dedent("""\
            ### Standard Sources
            | Source | Enabled |
            |--------|---------|
            | Dev.to | yes |
            | Medium | no |
            | GitHub | yes |
        """)
        result = _extract_network_table(text)
        assert result == {"Dev.to": True, "Medium": False, "GitHub": True}

    def test_returns_empty_for_missing_table(self):
        result = _extract_network_table("no table here")
        assert result == {}


class TestLoadConfig:
    def test_loads_by_slug(self, sample_config):
        config = load_config(str(sample_config.parent), "test-product")
        assert config is not None
        assert config["name"] == "Test Product"

    def test_returns_none_for_missing(self, tmp_path):
        result = load_config(str(tmp_path), "nonexistent")
        assert result is None


class TestLoadAllConfigs:
    def test_loads_all_except_example(self, sample_config, example_config):
        configs = load_all_configs(str(sample_config.parent))
        assert len(configs) == 1
        assert configs[0]["name"] == "Test Product"

    def test_returns_empty_for_missing_dir(self):
        result = load_all_configs("/nonexistent/path")
        assert result == []
