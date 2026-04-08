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

### Group 2 — Exclusions (Official Channels)
We need to exclude your team's own content so we only find community/external content.
- What is the **official blog URL** or blog tag page?
- What is the **official YouTube channel** name or URL?
- What are the **official social handles**? (LinkedIn, X/Twitter, Bluesky)
- Any **GitHub orgs or repos** to exclude? (e.g., "Azure/azure-cosmos-dotnet-v3" — these are team-owned)
- Any **other domains or authors** to exclude?

### Group 3 — Networks to Scan
Which sources should we scan? Default is all. The user can disable any.
- **Blogs:** Microsoft Tech Community, Dev.to, Medium, Hashnode, DZone, C# Corner, InfoQ, Influencer blogs (Baeldung, freeCodeCamp, CodeProject)
- **Service updates:** Azure Updates, Microsoft Learn docs
- **YouTube:** Community channels (requires API key)
- **GitHub:** Community repos and projects
- **Conversations:** Stack Overflow, Reddit, Hacker News, Bluesky, LinkedIn
- Ask: "Which of these should we **disable**? (default: all enabled)"

### Group 4 — People to Watch
- Any **known external authors** whose content should always be included? (MVP bloggers, community champions — they bypass relevancy filter)
- Any **influencers to monitor**? (high-signal accounts whose mentions are important)

### Group 5 — Social Post Configuration
- Which **platforms** should we generate posts for? (LinkedIn, X, Bluesky, YouTube Community)
- What is the **product logo URL or path**? (for thumbnail generation)
- What are the **brand colors**? (primary, accent — hex codes)
- What **background theme** for thumbnails? (dark, light, gradient)

### Group 6 — API Keys (optional, can be added later)
- **YouTube Data API v3 key** (required for YouTube scanning)
- **Bluesky handle and app password** (required for Bluesky scanning)
- **X/Twitter bearer token** (required for X scanning)
- Tell the user: "You can skip these now and add them to the config file later."

### Group 7 — Topic Tags
- What **canonical topic tags** should we use to categorize content? These should cover the major feature areas and use cases.
- Suggest a starter set based on what you know about the product, and let the user refine.
- Example for a database product: `getting-started`, `performance`, `data-modeling`, `migration`, `security`, `monitoring`, `sdk`, `integrations`, `ai`, `serverless`, `cost-optimization`, `best-practices`

### Group 8 — Content Filters (optional)
- Any **additional include rules**? (e.g., "always include content mentioning specific SDK packages")
- Any **additional exclude rules**? (e.g., "exclude content about a legacy version")
- Any **SDK package names** to look for in GitHub repos? (e.g., NuGet: `Microsoft.Azure.Cosmos`, npm: `@azure/cosmos`)

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

### Official Channels
- **Blog:** {url}
- **YouTube:** {channel}
- **LinkedIn:** {handle}
- **X/Twitter:** {handle}
- **Bluesky:** {handle}

### Excluded GitHub Orgs/Repos
- {org/repo}
- ...

### Excluded Domains/Authors
- {domain or author}
- ...

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
<!-- These authors bypass the relevancy filter (still must pass date gate) -->
- {author name} — {context, e.g., "MVP, writes deep perf posts"}
- ...

## Influencers to Monitor
<!-- High-signal accounts — mentions from these are important -->
- {name} — {platform} — {handle or URL}
- ...

## Social Post Platforms
- LinkedIn: {enabled/disabled}
- X: {enabled/disabled}
- Bluesky: {enabled/disabled}
- YouTube Community: {enabled/disabled}

## Brand Assets
- **Logo:** {path or URL}
- **Primary color:** {hex}
- **Accent color:** {hex}
- **Thumbnail theme:** {dark/light/gradient}

## API Keys
<!-- Add keys here when available. Do not commit secrets to public repos. -->
- **YouTube Data API v3:** {key or "not configured"}
- **Bluesky handle:** {handle or "not configured"}
- **Bluesky app password:** {password or "not configured"}
- **X Bearer token:** {token or "not configured"}

## Topic Tags (Canonical)
<!-- All content items are tagged with 1-4 of these -->
- {tag1}
- {tag2}
- ...

## Content Filters

### SDK Packages to Detect in GitHub Repos
- **NuGet:** {package}
- **npm:** {package}
- **PyPI:** {package}
- **Maven:** {groupId:artifactId}

### Additional Include Rules
- {rule}

### Additional Exclude Rules
- {rule}
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
