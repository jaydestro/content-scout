# Subagent Architecture

Content Scout can dispatch work to specialized subagents during `scout-scan` for parallelism and focus. The main agent orchestrates; subagents handle source-specific scanning. Works for any topic type — products, technologies, open-source projects, and tools.

## Subagents

| Subagent | Responsibility | Sources |
|----------|---------------|---------|
| `scout-scan-blogs` | Blog & article scanning | Vendor blogs (from custom sources), Dev.to, Medium, Hashnode, DZone, C# Corner, InfoQ, influencer blogs |
| `scout-scan-youtube` | YouTube search | YouTube Data API v3 (requires API key) |
| `scout-scan-github` | Community repo discovery | GitHub search API, README validation, SDK detection |
| `scout-scan-conversations` | Conversation tracking | Stack Overflow, Reddit, Hacker News, Bluesky, X/Twitter, LinkedIn |
| `scout-scan-official` | Official updates | Product update feeds and docs (from custom sources) |
| `scout-scan-cfp` | Conference CFP & talk discovery | CFP aggregators (sessionize.com, papercall.io, confs.tech), conference archives, speaker decks. Only dispatched when Conference CFP tracking is enabled. |
| `scout-post-generator` | Social post generation | Processes the merged report into platform-specific posts |

## How It Works

1. Main agent loads config and determines the time window
2. Dispatches subagents in parallel for each source group
3. Collects and merges all results
4. Deduplicates against `.seen-links.json`
5. Applies quality filter, numbers items, tags with canonical topics
6. Saves report, dispatches post generator, updates dedup tracker

If subagents aren't available, the main agent runs everything sequentially. The subagent architecture is an optimization, not a requirement.

## Quality Filter

Every piece of content must pass:
- **Date gate** — within the specified time window
- **Relevancy gate** — tutorials, architecture, demos, problem-solving, features, success stories
- **Known author bypass** — recognized contributors always pass relevancy
- **Dedup check** — URLs seen in prior months are skipped
- **Scoring** — depth + practical value + originality >= 5/9

**Always excluded:** "What is [Product]?" intros, portal walkthroughs, shallow listicles, AI content farms, job postings, YouTube videos with no description

## GitHub Quality Filters

Repositories must pass all of these:
- Contains a working application, tool, library, or prompt/agent guidance
- Has a README with setup instructions or usage guidance
- Is a complete, usable project (not a skeleton or stub)
- Has commits within the scan period
- Is NOT a fork of an official product team repo or quickstart
- Is NOT a vendor-provided quickstart or template
- Uses the correct SDK for its language (verified by package references)
- Meaningfully uses the product (not just a mention in a list)

## Thumbnail Generation

When a post uses "link in first comment" or a URL won't generate a link card, the agent produces thumbnail specs:

- **Brand colors** from your onboarding config
- **Platform sizes:**
  - LinkedIn: 1200x1200 (square, best engagement) or 1200x628 (landscape)
  - X: 1600x900 (16:9)
  - Bluesky: 2000x1000 (2:1)
  - YouTube Community: 1200x675 (16:9)
- **Logo** from your brand assets directory (never generated or fabricated — only actual logos you provide are used; text-only layout if none configured)
- **Product name** uses your brand naming rules (canonical form, correct casing)
- Saved to `social-posts/images/{YYYY-MM}/`
