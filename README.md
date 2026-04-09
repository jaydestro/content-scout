<p align="center">
  <img src="docs/assets/content-scout-banner-fancy.svg" alt="Content Scout — Your content hunting dog for the developer ecosystem" width="100%">
</p>

# Content Scout

A VS Code custom agent that discovers, catalogs, and promotes public content about your product across the developer ecosystem. It scans 14+ public sources, filters for quality, generates reports with topic tags and trends, and drafts ready-to-post social media content — all configured through a single onboarding conversation. Track one product or many from the same workspace.

## Who It's For

| Role | What You Get |
|------|-------------|
| **Program Manager** | Adoption metrics, SDK language breakdown, feature mention frequency, ecosystem health, month-over-month trajectory |
| **Product Manager** | Competitor signals, feature request & pain point flagging, customer sentiment, market signals |
| **Social Media Manager** | Engagement scoring, platform-specific timing, auto-generated posts with posting calendar, trending topics |
| **Product Marketer** | Launch coverage tracker, analyst mentions, customer success stories, competitive landscape, campaign amplification |
| **Developer Advocate** | Rising contributor tracking, community projects, conference content, tutorials, SDK adoption, auto-generated posts |
| **Community Manager** | Sentiment breakdown, unanswered question tracking, new contributor spotlights, engagement trends, community health |
| **Technical Writer** | FAQ pattern extraction, doc confusion signals, tutorial gap analysis, community vs. official doc coverage ratio |

Select one role, multiple roles (merged), or define a custom role during onboarding.

## Quick Start

```
git clone https://github.com/jaydestro/content-scout.git
cd content-scout
code .
```

1. Switch to the **Content Scout** agent mode in Copilot Chat
2. Run `/scout-onboard` — answer the setup questions (role, product, sources, brand)
3. Run `/scout-scan` to discover content

Your config saves to `.github/prompts/scout-config-{product}.prompt.md` (gitignored). See the [workflow guide](docs/WORKFLOW.md) for the full onboarding walkthrough.

## Commands

| Command | What It Does |
|---------|-------------|
| `/scout-onboard` | Set up the agent for a new product (interactive, supports multiple products) |
| `/scout-scan` | Scan for content — specify a product slug or scan all |
| `/scout-post` | Generate social posts from a URL or report item number |
| `/scout-calendar` | Create a weekly posting schedule |
| `/scout-gaps` | Show topics with no recent coverage |
| `/scout-trends` | Compare trends across months — trajectory, rising/declining topics, contributor patterns |

## What It Scans

14 standard sources plus optional custom sources (vendor blogs, update feeds, docs, influencer blogs):

**No auth needed:** Dev.to, Medium, Hashnode, DZone, C# Corner, InfoQ, GitHub, Stack Overflow, Reddit, Hacker News, LinkedIn
**Free auth:** YouTube (API key), Bluesky (app password)
**Paid auth:** X/Twitter ($200/mo Basic plan recommended)

All API keys are optional — without them, the agent skips those sources and scans everything else. See [API Keys](docs/API-KEYS.md) for setup details and [Content Sources](docs/SOURCES.md) for the full source reference.

## How It Works

1. **Onboard** — configure your product, role(s), sources, brand identity, and social post standards
2. **Scan** — the agent searches all sources, applies quality filters (relevancy, dedup, scoring), and produces a numbered report
3. **Post** — generates platform-specific social posts with brand name enforcement and thumbnail specs
4. **Analyze** — content gap analysis, monthly trends, sentiment tracking, contributor patterns

Reports save to `reports/`, social posts to `social-posts/`. Everything is markdown you can review, edit, and version control.

See [Workflow](docs/WORKFLOW.md) for the detailed end-to-end guide and [Architecture](docs/ARCHITECTURE.md) for quality filters, subagent dispatch, and thumbnail generation.

## Adapting for Your Product

This agent is a template. Clone it, run `/scout-onboard`, and answer the questions for your product. The agent generates a config file with your search terms, excluded channels, brand assets, topic tags, and social post standards. All commands use that config automatically.

**Multiple products:** Run `/scout-onboard` again to add another product. Each gets its own config file (`scout-config-{slug}.prompt.md`) and separate reports. Shared settings (role, brand, networks) can be reused. Pass a product slug to any command (e.g., `/scout-scan cosmos-db`) or scan all at once.

See [example-config.md](examples/example-config.md) for a completed configuration using Azure Cosmos DB.

## File Structure

```
.github/
├── agents/
│   └── content-scout.agent.md          # Agent definition
└── prompts/
    ├── scout-onboard.prompt.md         # Onboarding wizard
    ├── scout-config-example.prompt.md  # Example config template (committed)
    ├── scout-config-{product}.prompt.md # Your config (gitignored)
    ├── scout-scan.prompt.md            # Content scan
    ├── scout-post.prompt.md            # Social post generation
    ├── scout-calendar.prompt.md        # Posting calendar
    ├── scout-gaps.prompt.md            # Gap analysis
    └── scout-trends.prompt.md          # Trends analysis
docs/
├── WORKFLOW.md                         # End-to-end workflow guide
├── SOURCES.md                          # Content sources reference
├── API-KEYS.md                         # API key setup instructions
├── ARCHITECTURE.md                     # Subagents, quality filters, thumbnails
└── assets/                             # Banner images
reports/                                # Monthly content & trends reports
social-posts/                           # Generated posts, calendars, thumbnails
examples/                               # Sample outputs (config, report, posts, calendar)
```

## Examples

The [`examples/`](examples/) folder contains sample outputs using Azure Cosmos DB:

| File | What It Shows |
|------|--------------|
| [example-config.md](examples/example-config.md) | Completed product configuration |
| [example-report.md](examples/example-report.md) | Monthly content report (18 items) |
| [example-social-posts.md](examples/example-social-posts.md) | LinkedIn and X posts with multiple angles |
| [example-posting-calendar.md](examples/example-posting-calendar.md) | 2-week posting schedule |

## Documentation

| Doc | What's In It |
|-----|-------------|
| [Workflow](docs/WORKFLOW.md) | End-to-end guide: onboarding, scanning, posting, analysis, monthly ops |
| [Content Sources](docs/SOURCES.md) | All 14 standard sources, custom sources, scanning order |
| [API Keys](docs/API-KEYS.md) | YouTube, Bluesky, X/Twitter setup instructions and costs |
| [Architecture](docs/ARCHITECTURE.md) | Subagent dispatch, quality filters, GitHub filters, thumbnail generation |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT
