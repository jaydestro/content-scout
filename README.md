<p align="center">
  <img src="docs/assets/content-scout-banner-fancy.svg" alt="Content Scout — Your content hunting dog for the developer ecosystem" width="100%">
</p>

# Content Scout

A content research agent that discovers, catalogs, and promotes public content about your product, technology, open-source project, or tool across the developer ecosystem. Scans 14+ public sources, filters for quality, generates reports with topic tags and trends, and drafts ready-to-post social media content — all configured through a single onboarding conversation.

Run it **interactively in your editor** (VS Code, Claude Code, Cursor, and more) **or from a browser** with the built-in Web UI. The agent handles all standard content work; the web UI adds dashboards, bulk operations, and visual triage. See [docs/SURFACES.md](docs/SURFACES.md) for which surface to use when.

## Quick start

```
git clone https://github.com/jaydestro/content-scout.git
cd content-scout
```

Then pick a path:

### Web UI (browser dashboard)

```
cd tools/web-ui
npm install
npm start
```

Open <http://localhost:4477>. Walks you through a 9-step onboarding wizard, saves your config, and lets you launch scans, view reports, and manage `.env` keys. See [tools/web-ui/README.md](tools/web-ui/README.md) for the full reference.

### Editor / chat

Open the repo in your AI chat tool and run `/scout-onboard` (VS Code) or say "scout onboard" (Claude Code, Cursor, Windsurf, Cline, Copilot terminal chat). See [docs/EDITORS.md](docs/EDITORS.md) for per-tool startup, slash-command list, and troubleshooting.

## Commands

| Command | What it does |
|---------|-------------|
| `/scout-onboard` | Set up the agent for a new product, technology, or project |
| `/scout-scan` | Scan for content — specify a topic slug or scan all |
| `/scout-post` | Generate social posts from a URL or report item |
| `/scout-calendar` | Create a weekly posting schedule |
| `/scout-trends` | Compare trends across months |

Plus `/scout-creators`, `/scout-doctor`, `/scout-keys`, `/scout-seo`, `/scout-reddit-import`, `/scout-alt`, `/scout-vision` — see [docs/EDITORS.md](docs/EDITORS.md).

## What it scans

14 standard sources plus optional custom sources (vendor blogs, update feeds, docs, influencer blogs):

- **No auth needed:** Dev.to, Medium, Hashnode, DZone, C# Corner, InfoQ, GitHub, Stack Overflow, Hacker News, LinkedIn
- **Free auth:** YouTube (API key), Reddit (RSS by default; OAuth optional), Bluesky (app password)
- **Paid auth (optional):** X/Twitter ($200/mo Basic plan)
- **Logged-in browser (recommended for X / LinkedIn / Reddit):** [tools/browser-scan/](tools/browser-scan) attaches to your real browser (Edge / Chrome / Brave / Vivaldi / Arc / Opera — auto-detects your OS default) over the Chrome DevTools Protocol, so logged-in scrapes work with no anti-bot trips. Either click **🌐 Browser scan (Layer 0)** in the [web UI's Run view](#web-ui-browser-dashboard), or run `node tools/browser-scan/launch-edge.mjs` once and `node tools/browser-scan/index.mjs scan --slug {slug}` before each `scout scan`. The resulting JSON sidecars become **Layer 0** for those three platforms.

All API keys are optional — without them, the agent skips those sources. Keys live in `.env` (not in config files). See [docs/API-KEYS.md](docs/API-KEYS.md) and [docs/SOURCES.md](docs/SOURCES.md).

### Humanizer skill (recommended, used by default)

Content Scout vendors the [humanizer](https://github.com/blader/humanizer) skill (MIT) at [.claude/skills/humanizer/SKILL.md](.claude/skills/humanizer/SKILL.md) and runs every generated social post through it before saving. The skill strips the common tells of AI-generated copy — promotional adjectives, AI-vocabulary words ("delve", "underscore", "showcase"), significance inflation, em-dash overuse, negative parallelisms, and chatbot openers like "Excited to share…". Posts read like a practitioner wrote them, not like an LLM autocompleted a marketing brief.

No setup is required — the skill is part of the repo and loads automatically with `/scout-post` and `/scout-scan`. If your editor lists user-level skills separately and prefers them over repo-vendored ones, install the upstream skill from `https://github.com/blader/humanizer` and the same patterns will apply.

## Roles

Pick one role, multiple roles (merged), or a custom role during onboarding. Each role enables different features and report sections — Program Manager, Product Manager, Social Media Manager, Product Marketer, Developer Advocate, Community Manager, Technical Writer. See [docs/WORKFLOW.md](docs/WORKFLOW.md) for the full feature matrix.

## Examples

The [`examples/`](examples/) folder contains sample outputs using Azure Cosmos DB:

- [example-config.md](examples/example-config.md) — completed product configuration
- [example-report.md](examples/example-report.md) — monthly content report
- [example-social-posts.md](examples/example-social-posts.md) — LinkedIn and X posts
- [example-posting-calendar.md](examples/example-posting-calendar.md) — 2-week posting schedule

## Documentation

| Doc | What's in it |
|-----|-------------|
| [Workflow](docs/WORKFLOW.md) | End-to-end guide: onboarding, scanning, posting, analysis |
| [Editors](docs/EDITORS.md) | Per-tool setup, slash commands, troubleshooting |
| [Content Sources](docs/SOURCES.md) | All 14 standard sources, custom sources, scanning order |
| [API Keys](docs/API-KEYS.md) | YouTube, Reddit, Bluesky, X/Twitter setup |
| [Architecture](docs/ARCHITECTURE.md) | Subagents, quality filters, thumbnails, file structure |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
