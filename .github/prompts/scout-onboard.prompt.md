---
mode: agent
agent: content-scout
description: Set up Content Scout for a new product — interactive configuration wizard
---

# Product Onboarding

Walk the user through configuring Content Scout for their product. Gather all required information through a conversational interview, then generate the config file.

## Interview Flow

Ask these questions **one group at a time**. Do not dump all questions at once.

### Group 1 — Product Identity
- What is the **full product name**? (e.g., "Azure Cosmos DB")
- What is a **short slug** for file naming? (e.g., "cosmos-db")
- What **text search terms** should we use? List all name variations, abbreviations, and related terms. (e.g., "Azure Cosmos DB", "CosmosDB", "Cosmos DB")
- What **hashtags** are used on social media? (e.g., #CosmosDB, #AzureCosmosDB)

### Group 2 — Exclusions (optional)
We need to exclude your team's own content so we only find community/external content. **Say "none" to skip any of these.**
- What is the **official blog URL** or blog tag page? *(optional — say "none")*
- What is the **official YouTube channel** name or URL? *(optional — say "none")*
- What are the **official social handles**? (LinkedIn, X/Twitter, Bluesky) *(optional — say "none")*
- Any **GitHub orgs or repos** to exclude? (e.g., "Azure/azure-cosmos-dotnet-v3" — these are team-owned) *(optional — say "none")*
- Any **other domains or authors** to exclude? *(optional — say "none")*

### Group 3 — Networks to Scan
Which sources should we scan? Default is all. The user can disable any.
- **Blogs:** Microsoft Tech Community, Dev.to, Medium, Hashnode, DZone, C# Corner, InfoQ, Influencer blogs (Baeldung, freeCodeCamp, CodeProject)
- **Service updates:** Azure Updates, Microsoft Learn docs
- **YouTube:** Community channels (requires API key)
- **GitHub:** Community repos and projects
- **Conversations:** Stack Overflow, Reddit, Hacker News, Bluesky, LinkedIn
- Ask: "Which of these should we **disable**? (default: all enabled)"

### Group 4 — People to Watch (optional)
Say "none" to skip this group entirely.
- Any **known external authors** whose content should always be included? (MVP bloggers, community champions — they bypass relevancy filter) *(optional — say "none")*
- Any **influencers to monitor**? (high-signal accounts whose mentions are important) *(optional — say "none")*

### Group 5 — Social Post Configuration (optional)
Say "none" to skip any of these. Defaults will be used.
- Which **platforms** should we generate posts for? Select from: **LinkedIn**, **X**, **Bluesky**, **YouTube Community**. *(Pick one or more, or say "none" to skip social post generation entirely.)*
- For each selected platform, what is the **account handle or URL**? *(optional — say "none" if you don't want to link your account)*
- What is the **product logo URL or path**? (for thumbnail generation) *(optional — say "none")*
- What are the **brand colors**? (primary, accent — hex codes) *(optional — say "none" to use defaults)*
- What **background theme** for thumbnails? (dark, light, gradient) *(optional — default: dark)*

### Group 6 — API Keys (optional, can be added later)
- **YouTube Data API v3 key** (required for YouTube scanning)
- **Bluesky handle and app password** (required for Bluesky scanning)
- **X/Twitter bearer token** (required for X scanning)
- Tell the user: "You can skip these now and add them to the config file later."

### Group 7 — Topic Tags (optional)
- What **canonical topic tags** should we use to categorize content? These should cover the major feature areas and use cases. *(optional — say "none" and a starter set will be generated automatically)*
- Suggest a starter set based on what you know about the product, and let the user refine.
- Example for a database product: `getting-started`, `performance`, `data-modeling`, `migration`, `security`, `monitoring`, `sdk`, `integrations`, `ai`, `serverless`, `cost-optimization`, `best-practices`

### Group 8 — Content Filters (optional)
Say "none" to skip this group entirely.
- Any **additional include rules**? (e.g., "always include content mentioning specific SDK packages") *(optional — say "none")*
- Any **additional exclude rules**? (e.g., "exclude content about a legacy version") *(optional — say "none")*
- Any **SDK package names** to look for in GitHub repos? (e.g., NuGet: `Microsoft.Azure.Cosmos`, npm: `@azure/cosmos`) *(optional — say "none")*

### Group 9 — Competitor & Adjacent Products (optional)
- Any **competitor or adjacent products** to track alongside yours? (e.g., if your product is Azure Cosmos DB, you might track "MongoDB Atlas", "DynamoDB", "CockroachDB")
- These will be tracked in a separate section of the report — useful for understanding market conversation and share of voice.
- This is optional. Skip if not relevant.

### Group 10 — Conferences & Events (optional)
- Any **upcoming conferences or events** where the product will be featured? (e.g., "Microsoft Build 2026", "KubeCon EU 2026")
- Are there **recurring meetups** or community events to watch? (e.g., ".NET Conf", "Azure Cosmos DB Live")
- Event content (talks, workshops, demos) gets boosted in the relevancy filter during and immediately after the event window.

### Group 11 — Posting Preferences (optional)
- What is your **target posting frequency**? (e.g., "3-5 posts per week", "daily", "when we have content")
- Any **days or times to avoid**? (e.g., "no posts on Fridays", "avoid holiday weeks")
- Do you need an **approval workflow**? (e.g., "posts go to a review doc before publishing")
- Any **team members** who should be tagged or mentioned in posts?

### Group 12 — Language & Region (optional)
- **Language**: English only, or also track content in other languages? (e.g., Japanese, Portuguese, Spanish)
- **Region focus**: Global, or prioritize specific regions? (This affects which blog platforms and communities to emphasize.)

## Config File Generation

After gathering all answers, generate the config file at:
`.github/prompts/scout-config-{slug}.prompt.md`

Use this exact template:

````markdown
---
mode: agent
agent: content-scout
description: "Content Scout configuration for {Product Name}"
---

# Content Scout Configuration: {Product Name}

## Product
- **Name:** {Product Name}
- **Slug:** {slug}

## Search Terms

### Text Searches
- "{term1}"
- "{term2}"
- ...

### Hashtags
- #{hashtag1}
- #{hashtag2}
- ...

## Exclusions
<!-- Omit any section where the user said "none" -->

### Official Channels
- **Blog:** {url or "none"}
- **YouTube:** {channel or "none"}
- **LinkedIn:** {handle or "none"}
- **X/Twitter:** {handle or "none"}
- **Bluesky:** {handle or "none"}

### Excluded GitHub Orgs/Repos
- {org/repo or "none"}

### Excluded Domains/Authors
- {domain or author or "none"}

## Networks

| Source | Enabled |
|--------|---------|
| Microsoft Tech Community | {yes/no} |
| Dev.to | {yes/no} |
| Medium | {yes/no} |
| Hashnode | {yes/no} |
| DZone | {yes/no} |
| C# Corner | {yes/no} |
| InfoQ | {yes/no} |
| Influencer blogs | {yes/no} |
| Azure Updates | {yes/no} |
| Microsoft Learn | {yes/no} |
| YouTube | {yes/no} |
| GitHub | {yes/no} |
| Stack Overflow | {yes/no} |
| Reddit | {yes/no} |
| Hacker News | {yes/no} |
| Bluesky | {yes/no} |
| LinkedIn | {yes/no} |

## Known External Authors
<!-- These authors bypass the relevancy filter (still must pass date gate). Omit section if "none". -->
- {author name} — {context, e.g., "MVP, writes deep perf posts"}

## Influencers to Monitor
<!-- High-signal accounts — mentions from these are important. Omit section if "none". -->
- {name} — {platform} — {handle or URL}

## Social Post Platforms
<!-- Only include platforms the user selected. Omit section entirely if "none". -->
| Platform | Enabled | Account |
|----------|---------|----------|
| LinkedIn | {yes/no} | {handle or "none"} |
| X | {yes/no} | {handle or "none"} |
| Bluesky | {yes/no} | {handle or "none"} |
| YouTube Community | {yes/no} | {channel or "none"} |

## Brand Assets
<!-- Omit any field where the user said "none" -->
- **Logo:** {path or URL or "none"}
- **Primary color:** {hex or "none"}
- **Accent color:** {hex or "none"}
- **Thumbnail theme:** {dark/light/gradient or "dark"}

## API Keys
<!-- Add keys here when available. Do not commit secrets to public repos. -->
- **YouTube Data API v3:** {key or "not configured"}
- **Bluesky handle:** {handle or "not configured"}
- **Bluesky app password:** {password or "not configured"}
- **X Bearer token:** {token or "not configured"}

## Topic Tags (Canonical)
<!-- All content items are tagged with 1-4 of these. If user said "none", auto-generate a starter set. -->
- {tag1}
- {tag2}

## Content Filters
<!-- Omit any sub-section where user said "none" -->

### SDK Packages to Detect in GitHub Repos
- **NuGet:** {package or "none"}
- **npm:** {package or "none"}
- **PyPI:** {package or "none"}
- **Maven:** {groupId:artifactId or "none"}

### Additional Include Rules
- {rule or "none"}

### Additional Exclude Rules
- {rule or "none"}

## Competitor & Adjacent Products
<!-- Tracked for share-of-voice analysis. Omit section if "none". -->
- {product name}

## Conferences & Events
<!-- Content from these events gets relevancy boost. Omit section if "none". -->
| Event | Dates | Notes |
|-------|-------|-------|
| {event name} | {dates or "recurring"} | {notes} |

## Posting Preferences
- **Target frequency:** {e.g., "3-5 posts per week"}
- **Days/times to avoid:** {e.g., "none" or "no Fridays"}
- **Approval workflow:** {yes/no — if yes, describe}
- **Team members to tag:** {names or handles}

## Language & Region
- **Languages:** {e.g., "English only" or "English, Japanese, Portuguese"}
- **Region focus:** {e.g., "Global" or "North America, Europe"}
````

## After Generating

1. Save the config file.
2. Confirm to the user: "Configuration saved to `.github/prompts/scout-config-{slug}.prompt.md`."
3. Remind them of available commands:
   - `/scout-scan` — Run a content scan
   - `/scout-post` — Generate social posts from a URL
   - `/scout-calendar` — Generate a posting calendar
   - `/scout-gaps` — Analyze content gaps
4. If any API keys were skipped, remind them to add those before scanning YouTube/Bluesky/X.
