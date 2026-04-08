# Content Scout

A VS Code custom agent that discovers, catalogs, and promotes public content about your product across the developer ecosystem. Designed for Azure product teams and adaptable to any developer-focused product.

**What it does in three sentences:** Content Scout scans public sources (Tech Community, Dev.to, Medium, YouTube, GitHub, Stack Overflow, Reddit, Hacker News, Bluesky, and more) for content about your product, filters it for quality and relevance, and produces a numbered report with topic tags, monthly trends, and content gap analysis. For every item found, it auto-generates LinkedIn and X post options following Microsoft social media standards, with thumbnail specs and copy-ready text. It also tracks community conversations and mentions across forums without promoting them, giving you a single view of what's being published and discussed.

## Quick Start

1. Clone this repo and open in VS Code
2. Switch to the **Content Scout** agent mode in Copilot Chat
3. Run `/scout-onboard` and answer the setup questions for your product
4. Run `/scout-scan` to discover content

## Installation

### Step 1: Clone the repo
```
git clone https://github.com/jagord_microsoft/content-scout.git
cd content-scout
code .
```

### Step 2: Open Copilot Chat
Switch to the **Content Scout** agent mode (the base agent works for any product after onboarding).

### Step 3: Run onboarding
Type `/scout-onboard` and answer the questions. The onboard process will ask you:

1. **Product name and search terms** -- what to search for across all sources
2. **Channels to exclude** -- your official blog, YouTube channel, social handles
3. **Which networks to scan** -- pick from 20 sources or add custom ones:
   - Tech Community, Azure Updates, YouTube, GitHub, Microsoft Learn
   - Dev.to, Medium, Hashnode, DZone, C# Corner, InfoQ
   - Stack Overflow, Reddit, Hacker News, Bluesky, LinkedIn
   - Baeldung, freeCodeCamp, CodeProject, Azure SDK Blog
4. **Known external authors** -- community developers whose content auto-passes quality filter
5. **Influencers to monitor** -- high-signal accounts to watch for product mentions
6. **Social post platforms** -- LinkedIn, X, Bluesky, YouTube
7. **Brand assets** -- logos, colors, thumbnail theme
8. **API keys** -- YouTube (free), Bluesky (free), X (paid)
9. **Topic tags** -- canonical tags for categorizing content
10. **Content filters** -- what to include and exclude

### Step 4: Start scanning
```
/scout-scan
```

Your config is saved to `.github/prompts/scout-config-{product}.prompt.md`. Run it anytime to reapply settings. You never need to re-answer the onboarding questions.

### Example: Setting up for Azure Functions
```
Product: Azure Functions
Search terms: "Azure Functions", "Azure Function", "AzureFunctions"
Hashtags: #AzureFunctions, #Serverless
Exclude blog: devblogs.microsoft.com/azure-functions/
Exclude YouTube: Azure Functions (channel)
Networks: 1,2,3,4,5,6,7,12,13,14,15
Topic tags: triggers, bindings, durable-functions, consumption-plan, flex-consumption,
            deployment, monitoring, cold-start, sdk-dotnet, sdk-python, sdk-javascript, sdk-java
```

---

## How It Works

### Content Sources

| Category | Sources | Auth Required |
|----------|---------|---------------|
| **Microsoft blogs** | Tech Community blog posts (not discussions) | None |
| **Service updates** | Azure Updates, What's New docs | None |
| **YouTube** | All of YouTube excluding your official channel (community only) | YouTube Data API v3 key (free) |
| **GitHub** | Community repos, SDK releases, samples | None |
| **Docs** | Microsoft Learn new/updated pages | MS Learn MCP tools |
| **Community blogs** | Dev.to, Medium, Hashnode, Blogspot, WordPress, DZone, C# Corner, InfoQ | None (RSS) |
| **Influencer blogs** | Baeldung, freeCodeCamp, CodeProject, Towards Data Science, Azure SDK Blog | None |
| **Forums** | Stack Overflow, Reddit | None (public JSON APIs) |
| **Social** | Bluesky (authenticated search) | App password (free) |
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
- Is NOT a fork of an official Microsoft repo or quickstart
- Is NOT a Microsoft-provided quickstart or template
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

---

## Workflows

### 1. Onboarding (`scout-onboard`)

Run once per product. Asks for: product name, search terms, hashtags, channels to exclude, known authors, brand assets, API keys, content preferences. Generates a `scout-config-{product}.prompt.md` that stores everything.

### 2. Content Scan (`scout-scan`)

Scans all sources, applies quality filter, generates:
- Numbered report with topic tags -> `reports/{YYYY-MM}-content.md`
- Social posts (3 LinkedIn + 3 X per item, code-fenced for copy) -> `social-posts/{YYYY-MM}-social-posts.md`
- Monthly trends and content gaps (auto-generated at report end)
- Conversation tracking table (Stack Overflow, Reddit, HN, Bluesky -- tracked but not numbered)
- Dedup tracker update -> `reports/.seen-links.json`

### 3. Social Post Generation (`scout-post`)

Provide a URL and optional context (speakers, key highlights, event info). Generates at least 3 LinkedIn + 3 X options per item. At least one LinkedIn option uses "link in first comment" with thumbnail specs.

All posts follow Microsoft Social Media Standards:
- LinkedIn: 800-1500 chars, hook in first 200, 0-2 emoji, 1-2 hashtags
- X: concise, substantive, developer voice, 1-2 hashtags
- No em dashes, no UTM links, no marketing fluff
- Always use full product name

### 4. Posting Calendar (`scout-calendar`)

Spreads top items across weekdays. Max 2 posts/day, staggered platforms. Announcements first, then tutorials, then community content.

### 5. Content Gap Analysis (`scout-gaps`)

Compares canonical topic tags vs. tags used in report. Lists zero-coverage topics, flags drops from prior month, suggests content creation ideas.

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
    ├── scout-config-example.prompt.md      # Example config template
    ├── scout-scan.prompt.md                # Content scan
    ├── scout-post.prompt.md                # Social post generation
    ├── scout-calendar.prompt.md            # Posting calendar
    └── scout-gaps.prompt.md                # Gap analysis
reports/
├── {YYYY-MM}-content.md                    # Monthly content reports
└── .seen-links.json                        # Dedup tracker
social-posts/
├── {YYYY-MM}-social-posts.md               # Generated social posts (code-fenced)
├── {YYYY-MM}-posting-calendar.md           # Posting schedules
└── images/
    └── {YYYY-MM}/                          # Thumbnail images per month
        └── {N}-{platform}-{slug}.png
```

---

## API Keys Required

| Service | Cost | How to Get |
|---------|------|-----------|
| YouTube Data API v3 | Free | Google Cloud Console -> APIs & Services -> Enable YouTube Data API v3 -> Create API Key |
| Bluesky | Free | bsky.app/settings/app-passwords -> Add App Password |
| X/Twitter | $200/mo (Basic) or free tier (limited) | developer.x.com -> Create app -> Bearer token |
| Hacker News | None | Public Algolia API |
| Reddit | None | Public JSON API (append `.json` to any URL) |
| Stack Overflow | None | Public API v2.3 (300 req/day free) |
