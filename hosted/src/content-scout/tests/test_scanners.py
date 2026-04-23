"""Integration tests for scout.scanner — mocked HTTP responses for each source."""

import json
from datetime import datetime, timezone

import httpx
import pytest
import respx

from scout.scanner import (
    scan_devto,
    scan_github,
    scan_stackoverflow,
    scan_hackernews,
    scan_reddit,
    scan_youtube,
)


class TestDevToScanner:
    @respx.mock
    @pytest.mark.asyncio
    async def test_parses_articles(self):
        respx.get("https://dev.to/api/articles", params__contains={"tag": "cosmosdb"}).mock(
            return_value=httpx.Response(200, json=[
                {
                    "title": "Building with Cosmos DB",
                    "url": "https://dev.to/user/building-cosmos",
                    "published_at": "2026-04-01T10:00:00Z",
                    "user": {"name": "Test Author"},
                    "description": "A tutorial on Cosmos DB partitioning",
                },
                {
                    "title": "Another Post",
                    "url": "https://dev.to/user/another",
                    "published_at": "2026-04-02T12:00:00Z",
                    "user": {"name": "Other Author"},
                    "description": "Something else",
                },
            ])
        )
        items = await scan_devto(["CosmosDB"])
        assert len(items) == 2
        assert items[0]["title"] == "Building with Cosmos DB"
        assert items[0]["source"] == "Dev.to"
        assert items[0]["author"] == "Test Author"
        assert items[0]["url"] == "https://dev.to/user/building-cosmos"

    @respx.mock
    @pytest.mark.asyncio
    async def test_handles_api_error(self):
        respx.get("https://dev.to/api/articles").mock(
            return_value=httpx.Response(500)
        )
        items = await scan_devto(["CosmosDB"])
        assert items == []


class TestGitHubScanner:
    @respx.mock
    @pytest.mark.asyncio
    async def test_parses_repos(self):
        respx.get("https://api.github.com/search/repositories").mock(
            return_value=httpx.Response(200, json={
                "items": [
                    {
                        "full_name": "user/cosmos-tool",
                        "html_url": "https://github.com/user/cosmos-tool",
                        "pushed_at": "2026-04-10T08:00:00Z",
                        "owner": {"login": "user"},
                        "description": "A Cosmos DB management tool",
                        "stargazers_count": 42,
                        "language": "Python",
                        "fork": False,
                    },
                ]
            })
        )
        config = {"excluded_repos": []}
        items = await scan_github(["Cosmos DB"], config)
        assert len(items) == 1
        assert items[0]["title"] == "user/cosmos-tool"
        assert items[0]["stars"] == 42
        assert items[0]["language"] == "Python"

    @respx.mock
    @pytest.mark.asyncio
    async def test_excludes_forks(self):
        respx.get("https://api.github.com/search/repositories").mock(
            return_value=httpx.Response(200, json={
                "items": [
                    {"full_name": "fork/repo", "fork": True, "owner": {"login": "fork"},
                     "html_url": "", "pushed_at": "", "description": "", "stargazers_count": 0, "language": ""},
                ]
            })
        )
        items = await scan_github(["test"], {"excluded_repos": []})
        assert len(items) == 0

    @respx.mock
    @pytest.mark.asyncio
    async def test_excludes_configured_repos(self):
        respx.get("https://api.github.com/search/repositories").mock(
            return_value=httpx.Response(200, json={
                "items": [
                    {"full_name": "official/sdk", "fork": False, "owner": {"login": "official"},
                     "html_url": "", "pushed_at": "", "description": "", "stargazers_count": 0, "language": ""},
                ]
            })
        )
        items = await scan_github(["test"], {"excluded_repos": ["official/sdk"]})
        assert len(items) == 0


class TestStackOverflowScanner:
    @respx.mock
    @pytest.mark.asyncio
    async def test_parses_questions(self):
        respx.get("https://api.stackexchange.com/2.3/questions").mock(
            return_value=httpx.Response(200, json={
                "items": [
                    {
                        "title": "How to partition in Cosmos DB?",
                        "link": "https://stackoverflow.com/q/12345",
                        "creation_date": 1712000000,
                        "owner": {
                            "display_name": "DevUser",
                            "link": "https://stackoverflow.com/users/123/devuser",
                            "reputation": 5000,
                        },
                        "answer_count": 2,
                        "score": 5,
                        "view_count": 150,
                        "tags": ["azure-cosmosdb", "partitioning"],
                    },
                ]
            })
        )
        items = await scan_stackoverflow(["cosmos-db"])
        assert len(items) == 1
        assert items[0]["title"] == "How to partition in Cosmos DB?"
        assert items[0]["author"] == "DevUser"
        assert items[0]["author_profile"] == "https://stackoverflow.com/users/123/devuser"
        assert items[0]["is_conversation"] is True
        assert items[0]["view_count"] == 150


class TestHackerNewsScanner:
    @respx.mock
    @pytest.mark.asyncio
    async def test_parses_stories(self):
        respx.get("https://hn.algolia.com/api/v1/search_by_date").mock(
            return_value=httpx.Response(200, json={
                "hits": [
                    {
                        "title": "Cosmos DB is fast",
                        "url": "https://blog.example.com/cosmos-fast",
                        "created_at": "2026-04-05T14:00:00Z",
                        "author": "hnuser",
                        "objectID": "99999",
                        "points": 120,
                        "num_comments": 45,
                    },
                ]
            })
        )
        items = await scan_hackernews(["Cosmos DB"])
        assert len(items) == 1
        assert items[0]["title"] == "Cosmos DB is fast"
        assert items[0]["author_profile"] == "https://news.ycombinator.com/user?id=hnuser"
        assert items[0]["points"] == 120
        assert items[0]["num_comments"] == 45
        assert items[0]["hn_link"] == "https://news.ycombinator.com/item?id=99999"

    @respx.mock
    @pytest.mark.asyncio
    async def test_falls_back_to_hn_link_when_no_url(self):
        respx.get("https://hn.algolia.com/api/v1/search_by_date").mock(
            return_value=httpx.Response(200, json={
                "hits": [
                    {"title": "Ask HN: Cosmos?", "url": None, "created_at": "2026-04-01",
                     "author": "u", "objectID": "111", "points": 5, "num_comments": 2},
                ]
            })
        )
        items = await scan_hackernews(["test"])
        assert items[0]["url"] == "https://news.ycombinator.com/item?id=111"


class TestRedditScanner:
    @respx.mock
    @pytest.mark.asyncio
    async def test_skips_without_credentials(self, monkeypatch):
        monkeypatch.delenv("REDDIT_CLIENT_ID", raising=False)
        monkeypatch.delenv("REDDIT_CLIENT_SECRET", raising=False)
        items = await scan_reddit(["test"])
        assert items == []

    @respx.mock
    @pytest.mark.asyncio
    async def test_parses_posts_with_auth(self, monkeypatch):
        monkeypatch.setenv("REDDIT_CLIENT_ID", "test-id")
        monkeypatch.setenv("REDDIT_CLIENT_SECRET", "test-secret")

        # Mock OAuth token
        respx.post("https://www.reddit.com/api/v1/access_token").mock(
            return_value=httpx.Response(200, json={"access_token": "fake-token"})
        )

        # Mock search
        respx.get("https://oauth.reddit.com/search").mock(
            return_value=httpx.Response(200, json={
                "data": {
                    "children": [
                        {
                            "data": {
                                "title": "Cosmos DB question",
                                "permalink": "/r/azure/comments/abc123/cosmos_db_question/",
                                "created_utc": 1712000000,
                                "author": "redditor42",
                                "selftext": "How do I do X with Cosmos DB?",
                                "subreddit_name_prefixed": "r/azure",
                                "score": 15,
                                "num_comments": 8,
                                "upvote_ratio": 0.92,
                            }
                        },
                    ]
                }
            })
        )
        items = await scan_reddit(["Cosmos DB"])
        assert len(items) == 1
        assert items[0]["author"] == "redditor42"
        assert items[0]["author_handle"] == "u/redditor42"
        assert items[0]["author_profile"] == "https://www.reddit.com/user/redditor42"
        assert items[0]["subreddit"] == "r/azure"
        assert items[0]["num_comments"] == 8
        assert items[0]["is_conversation"] is True
        assert "/r/azure/comments/" in items[0]["url"]


class TestYouTubeScanner:
    @respx.mock
    @pytest.mark.asyncio
    async def test_parses_videos(self):
        respx.get("https://www.googleapis.com/youtube/v3/search").mock(
            return_value=httpx.Response(200, json={
                "items": [
                    {
                        "id": {"videoId": "abc123"},
                        "snippet": {
                            "title": "Cosmos DB Deep Dive",
                            "channelTitle": "TechChannel",
                            "publishedAt": "2026-04-01T10:00:00Z",
                            "description": "In this video we explore partition strategies...",
                        },
                    },
                ]
            })
        )
        items = await scan_youtube(["Cosmos DB"], "fake-key", {})
        assert len(items) == 1
        assert items[0]["title"] == "Cosmos DB Deep Dive"
        assert items[0]["url"] == "https://www.youtube.com/watch?v=abc123"
        assert items[0]["author"] == "TechChannel"

    @respx.mock
    @pytest.mark.asyncio
    async def test_excludes_official_channel(self):
        respx.get("https://www.googleapis.com/youtube/v3/search").mock(
            return_value=httpx.Response(200, json={
                "items": [
                    {
                        "id": {"videoId": "xyz"},
                        "snippet": {
                            "title": "Official Video",
                            "channelTitle": "Azure Cosmos DB",
                            "publishedAt": "2026-04-01",
                            "description": "Official content",
                        },
                    },
                ]
            })
        )
        items = await scan_youtube(["test"], "key", {"official_youtube_channel": "Azure Cosmos DB"})
        assert len(items) == 0

    @respx.mock
    @pytest.mark.asyncio
    async def test_excludes_no_description(self):
        respx.get("https://www.googleapis.com/youtube/v3/search").mock(
            return_value=httpx.Response(200, json={
                "items": [
                    {
                        "id": {"videoId": "xyz"},
                        "snippet": {
                            "title": "No Desc Video",
                            "channelTitle": "Somebody",
                            "publishedAt": "2026-04-01",
                            "description": "",
                        },
                    },
                ]
            })
        )
        items = await scan_youtube(["test"], "key", {})
        assert len(items) == 0
