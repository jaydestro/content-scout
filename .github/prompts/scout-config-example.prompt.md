---
description: Example configuration -- copy and customize for your product
mode: content-scout
---

# scout-config: {Your Product Name}

Apply this configuration to the Content Scout agent. Copy this file, rename it to `scout-config-{product-slug}.prompt.md`, and fill in all values for your product.

## Role

- **Role:** {Your role(s), comma-separated — e.g., Developer Advocate, Product Marketer. Or "Custom" to cherry-pick features}
- **Social posts:** {on/off — determines if social posts are auto-generated after scans}
- **Posting calendar:** {on/off — determines if posting calendar is generated}
- **Report focus:** {Role-specific focus — e.g., "Community projects, tutorials, conference talks, contributor spotlights"}
- **Report section ordering:** {e.g., "community first", "competitors first", "SDK first"}
- **Engagement scoring:** {on/off — adds 1-5 engagement potential score to each item}
- **Conversation sentiment:** {on/off — classifies conversations as positive/neutral/negative}
- **Feature request flagging:** {on/off — flags feature requests and pain points from forums}
- **Unanswered question tracking:** {on/off — tracks questions with no answers}
- **Rising contributors:** {on/off — tracks new and growing community contributors}
- **SDK/feature adoption tracking:** {on/off — tracks GitHub repos by SDK language and feature mentions}
- **Competitor tracking:** {on/off — tracks competitor content volume and switching signals}
- **Launch coverage tracking:** {on/off — groups content by event during event windows}
- **Doc gap focus:** {on/off — tracks FAQ patterns and doc coverage gaps}

## Product Identity

- **Product:** {Your Product Name}
- **Search terms (text):** "{Full Product Name}", "{Short Name}", "{NoSpaces}"
- **Search hashtags:** #{ProductHashtag1}, #{ProductHashtag2}

## Official Channels to EXCLUDE (already tracked separately)

- **Official blog:** {e.g., devblogs.microsoft.com/your-product/}
- **Official YouTube channel:** {Channel name} (channelId: {ID from YouTube})
- **Official social handles to exclude from conversation tracking:** {e.g., @YourProduct (X), yourproduct (Bluesky)}

## Known Author Watchlist (external community developers whose content always passes quality filter)

These are NOT your product team members. They are community developers, MVPs, and influencers who regularly produce content about your product.

| Name | Affiliation | Handle |
|------|-------------|--------|
| {Name} | {Company/Community} | {@handle} |

## Brand Assets

- **Logo directory:** {path to logo files}
- **Logos available:** {list of logo filenames}
- **Brand colors:**
  - Primary background: {#hex}
  - Accent: {#hex}
  - Highlight: {#hex}
  - Text: {#hex}
- **Thumbnail style:** {e.g., Stars/space theme on dark background}
- **Font:** {e.g., Segoe UI Semibold for headings}
- **LinkedIn thumbnail size:** 1200x627
- **X thumbnail size:** 1200x675

## API Keys
<!-- All optional. Collected during network selection (Group 3) -- paste key or say "skip". -->
<!-- Without YouTube key: YouTube scanning is skipped (community videos won't appear in reports) -->
<!-- Without Bluesky creds: Bluesky scanning is skipped (mentions and hashtag posts won't be tracked) -->
<!-- Without X token: X/Twitter scanning is skipped (conversations and mentions won't be tracked) -->
<!-- All other sources (blogs, GitHub, Stack Overflow, Reddit, Hacker News) work without keys -->
- **YouTube Data API v3:** {key or "none"}
- **Bluesky handle:** {handle or "none"}
- **Bluesky app password:** {password or "none"}
- **X Bearer token:** {token or "none"}

## Content Sources (scan order)

### Standard Sources
1. **YouTube** (excluding official channel) — community tutorials, demos, talks via Data API v3
2. **GitHub** — community repos, SDK releases, samples
3. **Community blogs** — Dev.to, Medium, Hashnode, Blogspot, WordPress, DZone, C# Corner, InfoQ
4. **Conversation tracking (not numbered):**
   - Stack Overflow (public API v2.3, no auth needed)
   - Reddit (public JSON API)
   - Hacker News (public Algolia API)
   - Bluesky (authenticated, multiple search queries)
   - LinkedIn, Substack (best effort)

### Custom Sources
<!-- Vendor-specific blogs, update feeds, docs, and influencer blogs configured during onboarding. -->
<!-- These are product-specific sources that wouldn't apply to every user of Content Scout. -->
| Name | Type | URL |
|------|------|-----|
| {vendor blog} | blog | {url} |
| {product updates feed} | update-feed | {url} |
| {official docs} | docs | {url} |
| {influencer blog} | influencer | {url} |

## Content Quality Filter

**INCLUDE:** tutorials, architecture deep-dives, problem-solving stories, demos, SDK releases, conference talks, performance deep-dives, integration content, success stories, educational content with depth

**EXCLUDE:** "What is {Product}?" intros, getting-started portal walkthroughs, shallow listicles, name-drop posts, AI content farms, job postings, certification guides, YouTube videos with no description

**Scoring:** Product depth (1-3) + practical value (1-3) + originality (1-3) >= 5/9 to include

## Topic Tags (customize for your product)

{List your canonical topic tags here, comma-separated. Example:}
partitioning, data-modeling, query-perf, sdk-dotnet, sdk-java, sdk-python, indexing, throughput, monitoring, security, migration, architecture, integration, release

## Social Post Standards
<!-- Only include if social posts are enabled. Set during onboarding or customize here. -->

- **Tone:** {e.g., "Plainspoken, technically credible, non-marketing" or your org's tone}
- **Always use full product name:** {yes/no}
- **Avoid words/phrases:** {e.g., "check it out", "exciting news", "game-changer" or your list}
- **Emoji policy:** {e.g., "0-2 max"}
- **Hashtag policy:** {e.g., "1-2 at end"}
- **Things to avoid:** {e.g., "em dashes, UTM links, fluff phrases"}
- **LinkedIn targets:** {e.g., "800-1500 chars, hook in first 200"}
- **X targets:** {e.g., "concise but substantive, no shortened links"}
- **Content framing angles:** {e.g., "how this works, what you can build, what problem this solves, what changed and why, real-world example"}
- **Additional rules:** {any org-specific rules or "none"}

## Output Files

- Reports: `reports/{YYYY-MM}-content.md`
- Dedup tracker: `reports/.seen-links.json`
- Social posts: `social-posts/{YYYY-MM}-social-posts.md`
- Thumbnails: `social-posts/images/{YYYY-MM}/{N}-{platform}-{slug}.png`
- Posting calendar: `social-posts/{YYYY-MM}-posting-calendar.md`

Please apply this configuration to the agent definition. If the agent is already configured, confirm the settings match and note any differences.
