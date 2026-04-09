# Content Scout

A VS Code custom agent that discovers, catalogs, and promotes public content about your product across the developer ecosystem. Adaptable to any developer-focused product and any role that needs to track what the community is saying.

**What it does in three sentences:** Content Scout scans public sources (Dev.to, Medium, YouTube, GitHub, Stack Overflow, Reddit, Hacker News, Bluesky, and more) for content about your product, filters it for quality and relevance, and produces a numbered report with topic tags, monthly trends, and content gap analysis. Based on your role, it can auto-generate social media posts following your organization's social standards, with thumbnail specs and copy-ready text. It also tracks community conversations and mentions across forums without promoting them, giving you a single view of what's being published and discussed.

## Quick Start

1. Clone this repo and open in VS Code
2. Switch to the **Content Scout** agent mode in Copilot Chat
3. Run `/scout-onboard` and answer the setup questions for your product
4. Run `/scout-scan` to discover content

## Installation

### Step 1: Clone the repo
```
git clone https://github.com/jaydestro/content-scout.git
cd content-scout
code .
```

### Step 2: Open Copilot Chat
Switch to the **Content Scout** agent mode (the base agent works for any product after onboarding).

### Step 3: Run onboarding
Type `/scout-onboard` and answer the questions. The onboard process will ask you:

1. **Your role(s)** — pick one or more roles (comma-separated), or choose Custom to cherry-pick individual features. Multi-role configs merge defaults (union). Choose from: Program Manager, Product Manager, Social Media Manager, Product Marketer, Developer Advocate, Community Manager, Technical Writer, or Custom.
2. **Product name and search terms** — what to search for across all sources
3. **Channels to exclude** — your official blog, YouTube channel, social handles, product team members
4. **Which networks to scan** — select all or pick from 14 standard sources. API keys are requested inline only for sources that need them (YouTube, Bluesky, X) — paste the key or say "skip":
   - YouTube, GitHub
   - Dev.to, Medium, Hashnode, DZone, C# Corner, InfoQ
   - Stack Overflow, Reddit, Hacker News, Bluesky, LinkedIn
   - X/Twitter (requires API bearer token — $200/mo Basic plan typically needed)
   - Plus optional **Custom Sources** (vendor blog, product update feed, official docs, influencer blogs)
5. **People to watch** — known external authors, influencers to monitor
6. **Social post configuration** — platforms, brand assets, and social post standards (only if role has social posts enabled)
7. **Topic tags, content filters, competitors, events** — fine-tuning content discovery
8. **Posting preferences** — frequency, timing, approval workflow (only if social posts enabled)
9. **Language and region** — language and geographic focus

### Step 4: Start scanning
```
/scout-scan
```

Your config is saved to `.github/prompts/scout-config-{product}.prompt.md`. Run it anytime to reapply settings. You never need to re-answer the onboarding questions.

> **Note:** Config files (except the example template) are `.gitignore`'d by default since they may contain API keys and product-specific information. Only `scout-config-example.prompt.md` is committed.

### Example: Setting up for Azure Functions
```
Roles: Developer Advocate, Product Marketer
Product: Azure Functions
Search terms: "Azure Functions", "Azure Function", "AzureFunctions"
Hashtags: #AzureFunctions, #Serverless
Exclude blog: devblogs.microsoft.com/azure-functions/
Exclude YouTube: Azure Functions (channel)
Standard networks: 1-13 (all)
Custom sources:
  - Microsoft Tech Community (blog): https://techcommunity.microsoft.com/tag/azure-functions
  - Azure Updates (update-feed): https://azure.microsoft.com/updates/?query=azure+functions
  - Microsoft Learn (docs): https://learn.microsoft.com/azure/azure-functions/
Topic tags: triggers, bindings, durable-functions, consumption-plan, flex-consumption,
            deployment, monitoring, cold-start, sdk-dotnet, sdk-python, sdk-javascript, sdk-java
```

---

## How It Works

### Content Sources

| Category | Sources | Auth Required |
|----------|---------|---------------|
| **Vendor blogs** | Configured during onboarding (Custom Sources of type `blog`) | None |
| **Product updates** | Configured during onboarding (Custom Sources of type `update-feed`) | None |
| **YouTube** | All of YouTube excluding your official channel (community only) | YouTube Data API v3 key (free) |
| **GitHub** | Community repos, SDK releases, samples | None |
| **Docs** | Configured during onboarding (Custom Sources of type `docs`). MS Learn MCP tools used when applicable | None |
| **Community blogs** | Dev.to, Medium, Hashnode, Blogspot, WordPress, DZone, C# Corner, InfoQ | None (RSS) |
| **Influencer blogs** | Configured during onboarding (Custom Sources of type `influencer`) | None |
| **Forums** | Stack Overflow, Reddit | None (public JSON APIs) |
| **Social** | Bluesky (authenticated search) | App password (free) |
| **Social** | X/Twitter (authenticated search) | X API bearer token ($200/mo Basic recommended) |
| **Discussions** | Hacker News | None (Algolia public API) |

### Quality Filter

Every piece of content must pass:
- **Date gate** -- within the specified time window
- **Relevancy gate** -- tutorials, architecture, demos, problem-solving, features, success stories
- **Known author bypass** -- recognized contributors always pass relevancy
- **Dedup check** -- URLs seen in prior months are skipped
- **Scoring** -- depth + practical value + originality >= 5/9

**Always excluded:** "What is [Product]?" intros, portal walkthroughs, shallow listicles, AI content farms, job postings, YouTube videos with no description

### GitHub Quality Filters

Repositories must pass all of these:
- Contains a working application, tool, library, or prompt/agent guidance
- Has a README with setup instructions or usage guidance
- Is a complete, usable project (not a skeleton or stub)
- Has commits within the scan period
- Is NOT a fork of an official product team repo or quickstart
- Is NOT a vendor-provided quickstart or template
- Uses the correct SDK for its language (verified by package references)
- Meaningfully uses the product (not just a mention in a list)

---

## Commands

| Command | What It Does |
|---------|-------------|
| `/scout-onboard` | Set up the agent for a new product (interactive) |
| `/scout-scan` | Scan for content (default: last 30 days, or specify month/year) |
| `/scout-post` | Generate social posts from a URL or report item number |
| `/scout-calendar` | Create a weekly posting schedule |
| `/scout-gaps` | Show topics with no recent coverage |
| `/scout-trends` | Compare trends across months — trajectory, rising/declining topics, contributor patterns |

---

## Workflows

### 1. Onboarding (`scout-onboard`)

Run once per product. Asks for: your role(s), product name, search terms, hashtags, channels to exclude, networks to scan (with API keys collected inline for sources that need them), custom sources (vendor blogs, update feeds, docs), known authors, brand assets, social post standards, and content preferences. Generates a `scout-config-{product}.prompt.md` that stores everything.

### 2. Content Scan (`scout-scan`)

Scans all sources, applies quality filter, generates:
- Numbered report with topic tags, role-specific summary, and engagement scores -> `reports/{YYYY-MM}-content.md`
- Role-specific sections: rising contributors, feature requests, unanswered questions, competitor signals, launch coverage, doc signals, SDK adoption (included based on role config)
- Social posts (3 LinkedIn + 3 X per item, code-fenced for copy) -> `social-posts/{YYYY-MM}-social-posts.md` **(only if role has social posts enabled)**
- Monthly trends with month-over-month deltas and content gaps (auto-generated at report end)
- Conversation tracking with sentiment classification (positive/neutral/negative) and feature-request/pain-point flagging
- Dedup tracker update -> `reports/.seen-links.json`

### 3. Social Post Generation (`scout-post`)

Provide a URL and optional context (speakers, key highlights, event info). Generates at least 3 LinkedIn + 3 X options per item. At least one LinkedIn option uses "link in first comment" with thumbnail specs.

All posts follow the social post standards from your config (set during onboarding):
- Default: plainspoken, technically credible, no fluff
- LinkedIn: 800-1500 chars, hook in first 200, 0-2 emoji, 1-2 hashtags
- X: concise, substantive, developer voice, 1-2 hashtags
- Custom standards are supported — provide your org's style guide during onboarding

### 4. Posting Calendar (`scout-calendar`)

Spreads top items across weekdays. Max 2 posts/day, staggered platforms. Announcements first, then tutorials, then community content.

### 5. Content Gap Analysis (`scout-gaps`)

Compares canonical topic tags vs. tags used in report. Lists zero-coverage topics, flags drops from prior month, suggests content creation ideas.

### 6. Trends Analysis (`scout-trends`)

Compares current month vs. up to 3 prior months. Shows trajectory for item counts, contributor counts, conversation volume, and sentiment. Highlights rising and declining topics, repeat vs. new contributors, and provides a role-specific actionable insight. Saves to `reports/{YYYY-MM}-trends.md`.

---

## Thumbnail Generation

When a post uses "link in first comment" or a URL won't generate a link card, the agent produces thumbnail specs:

- **Brand colors** from your onboarding config
- **Platform sizes:** LinkedIn 1200x627, X 1200x675
- **Logo** from your brand assets directory
- Saved to `social-posts/images/{YYYY-MM}/`

---

## Adapting for Your Product

This agent is designed as a template. To use it for a different product:

1. Clone the repo
2. Run `/scout-onboard` and answer the questions for your product
3. The agent generates a `scout-config-{product}.prompt.md` with your settings
4. All commands (`scout-scan`, `scout-post`, etc.) use your configuration

Things that change per product:
- Search terms and hashtags
- Official channels to exclude
- Known author watchlist
- Topic tags
- Brand assets and colors

Things that stay the same:
- Content quality filter logic
- Social post standards
- Report format and numbering
- Dedup tracking
- Conversation tracking sources

See `scout-config-example.prompt.md` for a template with all fields documented.

---

## File Structure

```
.github/
├── agents/
│   └── content-scout.agent.md              # Agent definition
└── prompts/
    ├── scout-onboard.prompt.md             # Onboarding wizard (interactive)
    ├── scout-config-example.prompt.md      # Example config template (committed)
    ├── scout-config-{product}.prompt.md    # Your product config (gitignored)
    ├── scout-scan.prompt.md                # Content scan
    ├── scout-post.prompt.md                # Social post generation
    ├── scout-calendar.prompt.md            # Posting calendar
    ├── scout-gaps.prompt.md                # Gap analysis
    └── scout-trends.prompt.md              # Trends analysis
reports/
├── {YYYY-MM}-content.md                    # Monthly content reports
├── {YYYY-MM}-trends.md                     # Monthly trends reports
└── .seen-links.json                        # Dedup tracker
social-posts/
├── {YYYY-MM}-social-posts.md               # Generated social posts (code-fenced)
├── {YYYY-MM}-posting-calendar.md           # Posting schedules
└── images/
    └── {YYYY-MM}/                          # Thumbnail images per month
        └── {N}-{platform}-{slug}.png
examples/
├── example-config.md                       # Sample product configuration
├── example-report.md                       # Sample monthly content report
├── example-social-posts.md                 # Sample generated social posts
└── example-posting-calendar.md             # Sample 2-week posting calendar
```

---

## API Keys (Optional)

All API keys are optional. Without them, the agent skips those sources and scans everything else.

| Service | Cost | Without It | How to Get |
|---------|------|-----------|------------|
| YouTube Data API v3 | Free | YouTube scanning skipped -- community videos won't appear in reports | Google Cloud Console -> APIs & Services -> Enable YouTube Data API v3 -> Create API Key |
| Bluesky | Free | Bluesky scanning skipped -- mentions and hashtag posts won't be tracked | bsky.app/settings/app-passwords -> Add App Password |
| X/Twitter | $200/mo (Basic) or free tier (limited) | X/Twitter scanning skipped -- conversations and mentions won't be tracked | developer.x.com -> Create app -> Bearer token. Free tier is typically too limited for meaningful scanning; Basic plan ($200/mo) recommended. |
| Hacker News | None | Always works | Public Algolia API |
| Reddit | None | Always works | Public JSON API (append `.json` to any URL) |
| Stack Overflow | None | Always works | Public API v2.3 (300 req/day free) |

Blogs, GitHub, Stack Overflow, Reddit, Hacker News, and custom sources (vendor blogs, update feeds, docs) all work without any API keys.

---

## Subagent Architecture

Content Scout can dispatch work to specialized subagents during `scout-scan` for parallelism and focus. The main agent orchestrates; subagents handle source-specific scanning.

| Subagent | Responsibility | Sources |
|----------|---------------|---------|
| `scout-scan-blogs` | Blog & article scanning | Vendor blogs (from custom sources), Dev.to, Medium, Hashnode, DZone, C# Corner, InfoQ, influencer blogs |
| `scout-scan-youtube` | YouTube search | YouTube Data API v3 (requires API key) |
| `scout-scan-github` | Community repo discovery | GitHub search API, README validation, SDK detection |
| `scout-scan-conversations` | Conversation tracking | Stack Overflow, Reddit, Hacker News, Bluesky, X/Twitter, LinkedIn |
| `scout-scan-official` | Official updates | Product update feeds and docs (from custom sources) |
| `scout-post-generator` | Social post generation | Processes the merged report into platform-specific posts |

### How It Works

1. Main agent loads config and determines the time window
2. Dispatches subagents in parallel for each source group
3. Collects and merges all results
4. Deduplicates against `.seen-links.json`
5. Applies quality filter, numbers items, tags with canonical topics
6. Saves report, dispatches post generator, updates dedup tracker

If subagents aren't available, the main agent runs everything sequentially. The subagent architecture is an optimization, not a requirement.

---

## Examples

The [`examples/`](examples/) folder contains sample outputs using Azure Cosmos DB as the product:

| File | What It Shows |
|------|--------------|
| [example-config.md](examples/example-config.md) | A completed product configuration with all fields filled in |
| [example-report.md](examples/example-report.md) | A monthly content report with 18 items across all sections |
| [example-social-posts.md](examples/example-social-posts.md) | Generated LinkedIn and X posts with multiple framing angles |
| [example-posting-calendar.md](examples/example-posting-calendar.md) | A 2-week posting schedule with platform-specific timing |

These are illustrative — URLs, authors, and content are fictional but follow the exact format the agent produces.

---

## About

Content Scout is a GitHub Copilot agent that automates content discovery and social media promotion for developer products. It continuously scans the public web — blogs, YouTube, GitHub, forums, social platforms, and documentation — for community-created content about your product, then generates ready-to-post social media content from what it finds. Think of it as a research assistant that reads the internet for you and drafts your social posts.

Built for developer advocacy and product marketing teams who need to:

- **Stay aware** of what the community is saying, building, and publishing about their product
- **Amplify community voices** by sharing the best external content on official channels
- **Maintain posting consistency** without spending hours each week on content research
- **Identify gaps** in community coverage to inform content strategy
- **Track sentiment** across forums and social platforms without manual monitoring

It runs as a GitHub Copilot agent inside VS Code — no infrastructure to deploy, no services to maintain. Configuration lives in your repo as markdown. Reports are human-readable files you can review, edit, and version control. Social posts are copy-paste ready with fenced code blocks.

### Design Principles

- **Quality over quantity** — strict relevancy filtering means every item in a report is worth reading
- **Community-first** — excludes official team content to spotlight external voices
- **No black boxes** — reports are readable markdown with direct links to every source
- **Configurable** — every source, filter, and preference is set in a single config file
- **Incremental** — dedup tracking means you can scan monthly without duplicates accumulating
- **Standards-compliant** — all social posts follow your organization's social media standards (configured during onboarding)

### Who It's For

| Role | What You Get |
|------|-------------|
| **Program Manager** | Adoption metrics, SDK language breakdown, feature mention frequency, ecosystem health, month-over-month trajectory |
| **Product Manager** | Competitor content volume with switching signals, feature request & pain point flagging from forums, customer sentiment, market signals |
| **Social Media Manager** | Engagement potential scoring (1-5) on every item, platform-specific timing suggestions, auto-generated posts with posting calendar, trending topics |
| **Product Marketer** | Launch coverage tracker (grouped by event), analyst mentions, customer success stories, competitive landscape, campaign amplification |
| **Developer Advocate** | Rising contributor tracking, community projects, conference content grouping, tutorials, SDK adoption by language, auto-generated posts |
| **Community Manager** | Sentiment breakdown (positive/neutral/negative), unanswered question tracking, new contributor spotlights, engagement trend, community health |
| **Technical Writer** | FAQ pattern extraction, doc confusion signals, tutorial gap analysis, community vs. official doc coverage ratio, content freshness |

Or define a custom role during onboarding to get exactly what you need. You can also **select multiple roles** (e.g., "Developer Advocate, Product Marketer") to merge their defaults.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute, what to work on, and how to report issues.

---

## License

MIT
