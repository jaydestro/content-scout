---
description: Example configuration -- copy and customize for your product
mode: content-scout
---

# scout-config: {Your Product Name}

Apply this configuration to the Content Scout agent. Copy this file, rename it to `scout-config-{product-slug}.prompt.md`, and fill in all values for your product.

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

- **YouTube Data API v3:** {your key from Google Cloud Console}
- **Bluesky:** handle: {your.handle.bsky.social} | app-password: {xxxx-xxxx-xxxx-xxxx}
- **X/Twitter:** {Bearer token, or note if skipped}

## Content Sources (scan order)

1. **Tech Community blog posts** (not discussions) -- community/MVP/partner authors
2. **Azure Updates / What's New** -- GA releases, preview features
3. **YouTube** (excluding official channel) -- community tutorials, demos, talks via Data API v3
4. **GitHub** -- community repos, SDK releases, samples
5. **Microsoft Learn docs** -- new/updated documentation via MS Learn MCP tools
6. **Community blogs** -- Dev.to, Medium, Hashnode, Blogspot, WordPress, DZone, C# Corner, InfoQ
7. **Influencer blogs** -- Baeldung, freeCodeCamp, CodeProject, Towards Data Science, Azure SDK Blog, Microsoft Open Source Blog, Azure Architecture Center
8. **Conversation tracking (not numbered):**
   - Stack Overflow (public API v2.3, no auth needed)
   - Reddit (public JSON API)
   - Hacker News (public Algolia API)
   - Bluesky (authenticated, multiple search queries)
   - LinkedIn, Substack (best effort)

## Content Quality Filter

**INCLUDE:** tutorials, architecture deep-dives, problem-solving stories, demos, SDK releases, conference talks, performance deep-dives, integration content, success stories, educational content with depth

**EXCLUDE:** "What is {Product}?" intros, getting-started portal walkthroughs, shallow listicles, name-drop posts, AI content farms, job postings, certification guides, YouTube videos with no description

**Scoring:** Product depth (1-3) + practical value (1-3) + originality (1-3) >= 5/9 to include

## Topic Tags (customize for your product)

{List your canonical topic tags here, comma-separated. Example:}
partitioning, data-modeling, query-perf, sdk-dotnet, sdk-java, sdk-python, indexing, throughput, monitoring, security, migration, architecture, integration, release

## Social Post Standards

- Follow Microsoft Social Media Standards for developer accounts
- Always use the full product name (e.g., "Azure Cosmos DB", not "Cosmos DB")
- LinkedIn: 800-1500 chars, hook in first 200 chars, 0-2 emoji, 1-2 hashtags
- X: concise, substantive, developer voice, 1-2 hashtags
- At least 3 options per platform per item, each with different framing angle
- At least 1 LinkedIn option must be "link in first comment" with thumbnail spec
- No em dashes, no UTM links, no marketing fluff
- Content framing angles: "how this works", "what you can build", "what problem this solves", "what changed and why it matters", "real-world example"

## Output Files

- Reports: `reports/{YYYY-MM}-content.md`
- Dedup tracker: `reports/.seen-links.json`
- Social posts: `social-posts/{YYYY-MM}-social-posts.md`
- Thumbnails: `social-posts/images/{YYYY-MM}/{N}-{platform}-{slug}.png`
- Posting calendar: `social-posts/{YYYY-MM}-posting-calendar.md`

Please apply this configuration to the agent definition. If the agent is already configured, confirm the settings match and note any differences.
