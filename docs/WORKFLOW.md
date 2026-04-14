# Content Scout — Workflow Guide

This document walks through the end-to-end workflow for Content Scout, from initial setup through monthly content operations.

---

## Overview

Content Scout follows a repeatable cycle:

```
Onboard (once) → Scan (monthly) → Post (ongoing) → Analyze (monthly)
```

1. **Onboard** — configure the agent for your product, technology, project, or tool and role
2. **Scan** — discover and catalog community content
3. **Post** — generate social media posts from discovered content
4. **Analyze** — identify gaps, track trends, plan content strategy

---

## Step 1: Onboarding (`/scout-onboard`)

Run once per topic. The onboarding wizard offers two modes:

- **Quick setup** — 3 questions (topic name, role, networks). Everything else uses smart defaults. Best for tracking many topics or getting started fast.
- **Full setup** — Walk through all 9 groups for maximum customization.

**Multiple topics:** The first question asks whether you're tracking one topic or several. If you choose multiple, onboarding collects shared settings (role, brand, networks) once, then loops topic-specific details (search terms, exclusions, topic tags) for each topic. Each topic gets its own config file. Run `/scout-onboard` again later to add more topics without re-entering shared settings.

**Topic types:** Content Scout supports products (Azure Cosmos DB), technologies (Python), open-source projects (Ollama), and tools (Copilot CLI). The topic type shapes report sections and search strategy automatically.

### What It Asks

| Group | Questions | Required |
|-------|-----------|----------|
| 1. Role | Your role(s) — determines which features are enabled and which report sections appear | Yes |
| 2. Topic | Topic name, type (product/technology/project/tool), search terms, hashtags | Yes |
| 3. Networks | Which of the 14 standard sources to scan, plus custom sources. API keys saved to `.env` (not config) | Yes (at least 1 source) |
| 4. Exclusions | Your official blog, YouTube channel, social handles, team members to filter out | Recommended |
| 5. People | Known external authors (bypass quality filter), influencers to monitor | Optional |
| 6. Social Posts | Platforms, brand identity, target audience, brand name rules, tone, post standards | Only if role includes social posts |
| 7. Topics | Canonical topic tags for categorizing content | Optional (auto-generated if skipped) |
| 8. Filters | Include/exclude rules, SDK package names, competitors, events | Optional |
| 9. Preferences | Posting frequency, timing, approval workflow, language, region | Optional |

### Role Selection

Choose one or more roles (comma-separated). Multi-role configs merge features as a union.

| Role | Social Posts | Posting Calendar | Key Report Sections |
|------|-------------|-----------------|---------------------|
| Program Manager | Off | Off | Adoption metrics, SDK breakdown, feature frequency, ecosystem health |
| Product Manager | Off | Off | Competitor signals, feature requests, pain points, customer sentiment |
| Social Media Manager | On | On | Engagement scoring, timing suggestions, trending topics |
| Product Marketer | On | On | Launch coverage, analyst mentions, success stories, competitive landscape |
| Developer Advocate | On | On | Rising contributors, community projects, conference content, SDK adoption |
| Community Manager | Off | Off | Sentiment breakdown, unanswered questions, new contributors, engagement trend |
| Technical Writer | Off | Off | FAQ patterns, doc confusion signals, tutorial gaps, content freshness |
| Custom | Choose | Choose | Cherry-pick from 12 individual features |

### Brand Identity (Group 6)

When social posts are enabled, onboarding collects comprehensive brand information:

- **Logo files** — directory path or URLs to actual logo files. The agent never generates fake logos. If none provided, thumbnails use text-only layouts.
- **Logo usage rules** — which version to use when (e.g., "icon-only on dark backgrounds, full wordmark on light")
- **Brand name rules** — canonical form (e.g., "Azure Cosmos DB"), acceptable short form (e.g., "Cosmos DB" after first mention), and forms to never use (e.g., "CosmosDB", "Azure CosmosDB")
- **Colors** — primary background, accent, highlight, text (hex codes)
- **Visual style** — description of thumbnail aesthetic (e.g., "stars/space theme on dark background")
- **Font, composition, guardrails** — layout preferences and things to never do

### Social Post Standards (Group 6)

- **Target audience** — who the posts are for (shapes tone and technical depth)
- **Tone** — e.g., technically grounded, conversational, authoritative
- **Length limits** — per-platform targets (LinkedIn, X, Bluesky, YouTube Community)
- **Words to avoid** — banned phrases, competitor names, fluff terms
- **Emoji and hashtag policies**
- **Content framing angles** — how to approach each post (e.g., "how this works", "what problem this solves")

### What It Produces

A config file saved to `.github/prompts/scout-config-{product}.prompt.md` containing all your settings. This file is gitignored by default (may contain API keys). Run the config anytime to reapply settings without re-answering questions.

---

## Step 2: Content Scan (`/scout-scan`)

The core operation. Run monthly (or any time window you specify).

### How Scanning Works

```
Load config → Scan sources → Filter → Deduplicate → Score → Generate report
```

1. **Load config** — reads your product config for search terms, sources, exclusions
2. **Scan sources** — searches all configured networks (blogs, YouTube, GitHub, forums, social platforms, docs)
3. **Filter** — applies date gate, relevancy gate, known-author bypass
4. **Deduplicate** — checks URLs against `.seen-links.json` from prior months
5. **Score** — rates each item on depth + practical value + originality (must score ≥ 5/9)
6. **Generate report** — numbers items, applies topic tags, generates role-specific sections

### Quality Gates

Every piece of content must pass:

| Gate | What It Checks |
|------|---------------|
| Date | Within the specified time window |
| Relevancy | Is it a tutorial, architecture post, demo, problem-solving guide, feature deep-dive, or success story? |
| Known Author | Recognized contributors bypass the relevancy gate (still must pass date) |
| Dedup | URL not seen in any prior month's report |
| Scoring | depth + practical value + originality ≥ 5/9 |

**Always excluded:** "What is [Product]?" intros, portal walkthroughs, shallow listicles, AI content farms, job postings, YouTube videos with no description.

### GitHub-Specific Filters

Repositories have additional requirements:
- Contains a working application, tool, or library (not a skeleton)
- Has a README with setup instructions
- Has commits within the scan period
- Not a fork of an official repo or quickstart
- Uses the correct SDK (verified by package references)
- Meaningfully uses the product (not just a mention in a list)

### What It Produces

| Output | Path | Description |
|--------|------|-------------|
| Content report | `reports/{YYYY-MM}-{slug}-content.md` | Numbered items with topic tags, summaries, engagement scores, role-specific sections |
| Social posts | `social-posts/{YYYY-MM}-{slug}-social-posts.md` | 3 LinkedIn + 3 X options per item, code-fenced for copy (only if social posts enabled) |
| Dedup tracker | `reports/.seen-links.json` | Updated with all URLs from this scan (shared across products) |
| Open CFPs | Included in report | Open calls for papers sorted by deadline (if Conference CFP tracking is on) |
| Trends | Appended to report | Month-over-month deltas, content gaps (auto-generated at report end) |

When only one product is configured, the slug is optional in filenames for backward compatibility.

### Conversation Tracking

Forums and social platforms are scanned separately from blog/article content. Conversations are tracked but not promoted as report items:
- **Stack Overflow** — questions, answers, comments mentioning the product
- **Reddit** — posts and discussions in relevant subreddits
- **Hacker News** — submissions and comment threads
- **Bluesky** — mentions, hashtag posts, threads
- **X/Twitter** — mentions, hashtag posts, conversations
- **LinkedIn** — best-effort search by product name

Each conversation is classified by sentiment (positive/neutral/negative) and flagged if it contains a feature request or pain point.

### Conference CFP & Talk Discovery

When **Conference CFP tracking** is enabled (on by default for Developer Advocate and Product Marketer roles), the scan also finds:

- **Open CFPs** — conferences with open calls for papers relevant to the product's user communities. Each entry includes the conference name, CFP deadline, conference dates, location, site URL, CFP URL, a short description, and which audience segment it targets. CFPs closing within 14 days are highlighted.
- **Recent conference talks** — presentations at conferences that featured the product. These populate the Conference Content section of the report.

The agent determines relevant conference communities from the product itself (e.g., a database product maps to database, cloud, data engineering, and developer conferences) and uses CFP aggregator sites (sessionize.com, papercall.io, confs.tech) plus search queries to find opportunities.

### Subagent Parallelism

If subagents are available, the scan dispatches work in parallel:

| Subagent | Sources |
|----------|---------|
| `scout-scan-blogs` | Vendor blogs, Dev.to, Medium, Hashnode, DZone, C# Corner, InfoQ, influencer blogs |
| `scout-scan-youtube` | YouTube (requires API key) |
| `scout-scan-github` | GitHub repos, README validation, SDK detection |
| `scout-scan-conversations` | Stack Overflow, Reddit, Hacker News, Bluesky, X/Twitter, LinkedIn |
| `scout-scan-official` | Product update feeds and docs |
| `scout-scan-cfp` | CFP aggregators, conference archives, speaker decks (if Conference CFP tracking is on) |

If subagents aren't available, the main agent runs everything sequentially. Same results, just slower.

---

## Step 3: Social Post Generation (`/scout-post`)

Generate posts on demand from any URL or report item number.

### Input

- A URL to the content piece, **or** a report item number (e.g., `#7`)
- Optional context: speakers, key highlights, event info

### Output

For each item:
- **3 LinkedIn options** — varied framing angles, 800-1500 chars, hook in first 200 chars
- **3 X options** — concise, substantive, developer voice
- At least one LinkedIn option uses **"link in first comment"** format with a thumbnail spec

All posts follow your configured Social Post Standards:
- Brand name enforcement (canonical form on first mention, short form after, banned forms never used)
- Tone and technical depth matched to your target audience
- Platform-specific length and formatting rules
- Emoji, hashtag, and content policies from your config

### Thumbnail Specs

When a "link in first comment" option is generated:
- Platform-specific sizes (LinkedIn 1200x1200, X 1600x900, Bluesky 2000x1000, YouTube 1200x675)
- Brand colors and visual style from your config
- Logo from your brand assets (never fabricated — text-only if none provided)
- Product name in canonical form
- Saved to `social-posts/images/{YYYY-MM}/{N}-{platform}-{slug}.png`

### Post Format

Each post option is wrapped in a fenced code block for one-click copy. "Link in first comment" options have the post body and the comment in **separate** code blocks so each gets its own copy button.

---

## Step 4: Posting Calendar (`/scout-calendar`)

Spreads your top content items across a posting schedule.

### Rules

- Maximum 2 posts per day
- Staggered across platforms (don't post LinkedIn and X at the same time)
- Priority order: announcements first, then tutorials, then community content
- Respects your configured posting preferences (frequency, days to avoid, timing)

### Output

Saved to `social-posts/{YYYY-MM}-{slug}-posting-calendar.md` with a day-by-day schedule showing which item to post on which platform.

---

## Step 5: Gap Analysis (`/scout-gaps`)

Compares your canonical topic tags against what actually appeared in the report.

### What It Shows

- **Zero-coverage topics** — tags with no content this month
- **Declining topics** — tags that had coverage last month but dropped
- **Content creation ideas** — suggested topics to fill gaps
- **Coverage distribution** — which topics are over/under-represented

Use this to inform your content strategy: if "migration" has zero community coverage, that's an opportunity for an official tutorial or a community workshop.

---

## Step 6: Trends Analysis (`/scout-trends`)

Compares the current month against up to 3 prior months.

### What It Shows

- **Trajectory** — item count, contributor count, conversation volume, sentiment direction
- **Rising topics** — topics gaining momentum
- **Declining topics** — topics losing community interest
- **Repeat vs. new contributors** — is the same group writing, or is the community growing?
- **Role-specific insight** — actionable recommendation based on your role

### Output

Saved to `reports/{YYYY-MM}-{slug}-trends.md`.

---

## Monthly Workflow (Recommended)

Here's how the pieces fit together for a typical monthly cycle:

### Week 1: Scan and Review
```
/scout-scan month:March year:2026
/scout-scan cosmos-db month:March year:2026   # specific product
/scout-scan all                                # all products
```
Review the generated report. Check the conversation tracking section for sentiment shifts or emerging pain points.

### Week 1-2: Generate Posts
```
/scout-post #3
/scout-post #7
/scout-post https://example.com/some-great-article
```
Generate posts for the highest-value items. Review and edit the generated text.

### Week 2: Schedule
```
/scout-calendar
```
Spread the posts across the month. Adjust timing for any known events or holidays.

### End of Month: Analyze
```
/scout-gaps
/scout-trends
```
Identify content gaps for next month's strategy. Review trends to understand where the community is heading.

### Ongoing
- Run `/scout-post` anytime you find content worth amplifying
- Re-run `/scout-scan` mid-month if you need a fresher view
- Update your config if search terms, competitors, or team members change

---

## Tips

- **Start narrow, expand later.** Begin with a few sources and add more once you're comfortable with the quality filter output.
- **Tune your topic tags.** The auto-generated set is a starting point. Refine based on what actually shows up in reports.
- **Use known authors.** Adding prolific community authors to your watchlist ensures their content always surfaces, even if it doesn't score highly on the generic filter.
- **Review before posting.** Generated posts are drafts. Always review for accuracy, especially when content discusses unreleased features or makes performance claims.
- **Track competitors selectively.** Only add competitors if you actually plan to act on the intelligence. Extra sections add noise if unused.
- **Commit your reports.** Reports and social posts are plain markdown — version control them to track how community coverage evolves over time.
