---
mode: agent
agent: content-scout
description: "Content Scout configuration for Azure Cosmos DB"
---

# Content Scout Configuration: Azure Cosmos DB

## Role
- **Role:** Developer Advocate
- **Social posts:** on
- **Posting calendar:** on
- **Report focus:** Community projects, tutorials, conference talks, contributor spotlights
- **Report section ordering:** community first
- **Engagement scoring:** on
- **Conversation sentiment:** on
- **Feature request flagging:** off
- **Unanswered question tracking:** off
- **Rising contributors:** on
- **SDK/feature adoption tracking:** on
- **Competitor tracking:** off
- **Launch coverage tracking:** off
- **Doc gap focus:** off

## Product
- **Name:** Azure Cosmos DB
- **Slug:** cosmos-db

## Search Terms

### Text Searches
- "Azure Cosmos DB"
- "CosmosDB"
- "Cosmos DB"
- "Azure Cosmos DB for NoSQL"
- "Azure Cosmos DB for MongoDB"
- "Cosmos DB for PostgreSQL"

### Hashtags
- #CosmosDB
- #AzureCosmosDB

## Exclusions

### Official Channels
- **Blog:** https://devblogs.microsoft.com/cosmosdb/
- **YouTube:** Azure Cosmos DB
- **LinkedIn:** @AzureCosmosDB
- **X/Twitter:** @AzureCosmosDB
- **Bluesky:** none

### Excluded GitHub Orgs/Repos
- Azure/azure-cosmos-dotnet-v3
- Azure/azure-cosmos-java
- Azure/azure-cosmos-python
- Azure/azure-cosmos-js
- Azure/azure-cosmos-db-samples
- AzureCosmosDB/*

### Excluded Domains/Authors
- devblogs.microsoft.com/cosmosdb (official blog)

## Networks

### Standard Sources
| Source | Enabled |
|--------|---------|
| Dev.to | yes |
| Medium | yes |
| Hashnode | yes |
| DZone | yes |
| C# Corner | yes |
| InfoQ | yes |
| YouTube | yes |
| GitHub | yes |
| Stack Overflow | yes |
| Reddit | yes |
| Hacker News | yes |
| Bluesky | no |
| LinkedIn | yes |
| X/Twitter | yes |

### Custom Sources
| Name | Type | URL |
|------|------|-----|
| Microsoft Tech Community | blog | https://techcommunity.microsoft.com/tag/azure-cosmos-db |
| Azure Updates | update-feed | https://azure.microsoft.com/updates/?query=cosmos+db |
| Microsoft Learn | docs | https://learn.microsoft.com/azure/cosmos-db/ |
| Baeldung | influencer | https://www.baeldung.com |
| freeCodeCamp | influencer | https://www.freecodecamp.org/news |
| CodeProject | influencer | https://www.codeproject.com |

## Known External Authors
<!-- These authors bypass the relevancy filter (still must pass date gate) -->
- Riccardo Muti — MVP, deep data modeling and partition key content
- Martin Lopez — MVP, Java + Cosmos DB workshops
- Tim Corey — YouTube educator, .NET + Azure
- Nick Chapsas — YouTube educator, .NET deep dives

## Influencers to Monitor
<!-- High-signal accounts — mentions from these are important -->
- Kelvin Lau — X — @kelaboratory
- Mark Brown — LinkedIn — Azure Cosmos DB PM

## Social Post Platforms
| Platform | Enabled | Account |
|----------|---------|----------|
| LinkedIn | yes | @AzureCosmosDB |
| X | yes | @AzureCosmosDB |
| Bluesky | no | none |
| YouTube Community | no | none |

## Brand Assets
<!-- Never generate fake or placeholder logos. Only use the files listed here. -->
- **Logo directory:** assets/
- **Logos available:** cosmos-db-logo.svg, cosmos-db-icon-white.svg
- **Logo usage rules:** Use full logo on dark backgrounds, white icon-only version on accent-colored backgrounds. Minimum 20px clear space around logo.
- **Product name on thumbnails:** Azure Cosmos DB — always use full name, never abbreviate to "Cosmos" alone
- **Brand colors:**
  - Primary background: #0C1A2E
  - Accent: #50E6FF
  - Highlight: #0078D4
  - Text: #FFFFFF
- **Thumbnail style:** Stars/space theme on dark background
- **Background theme:** dark
- **Font:** Segoe UI Semibold for headings
- **Thumbnail composition:** Logo top-left, headline centered, accent bar at bottom
- **Brand guardrails (never do):** Never stretch or recolor the logo, never place logo on busy backgrounds, never use competitor brand colors
- **Additional brand concerns:** Follow Microsoft brand guidelines for Azure sub-brands

## Social Post Standards
- **Target audience:** Backend developers, cloud architects, data engineers, and distributed systems practitioners
- **Tone:** Plainspoken, technically credible, non-marketing
- **Brand name — canonical form:** Azure Cosmos DB
- **Brand name — acceptable short form:** Cosmos DB (only after "Azure Cosmos DB" has appeared in the same post)
- **Brand name — never write:** CosmosDB, Azure CosmosDB, Cosmos (alone), cosmosdb, cosmos
- **Avoid words/phrases:** "check it out", "exciting news", "game-changer", "unleash", "dive in", "excited to announce"
- **Avoid competitor names in posts:** none
- **Emoji policy:** 0-2 max
- **Hashtag policy:** 1-2 at end
- **Things to avoid:** em dashes, UTM links, fluff phrases, speculation about unreleased features
- **LinkedIn targets:** 800-1500 chars, hook in first 200
- **X targets:** concise but substantive, no shortened links
- **Bluesky targets:** up to 300 chars, concise and direct
- **Content framing angles:** how this works, what you can build, what problem this solves, what changed and why, real-world example
- **Additional rules:** Always link to official docs when referencing a feature. Voice: calm, confident, technically grounded.

## API Keys
<!-- All optional. Do not commit secrets to public repos. -->
<!-- Without YouTube key: YouTube scanning is skipped (community videos won't appear in reports) -->
<!-- Without Bluesky creds: Bluesky scanning is skipped (mentions and hashtag posts won't be tracked) -->
<!-- Without X token: X/Twitter scanning is skipped (conversations and mentions won't be tracked) -->
- **YouTube Data API v3:** YOUR_KEY_HERE
- **Bluesky handle:** none
- **Bluesky app password:** none
- **X Bearer token:** none

## Topic Tags (Canonical)
<!-- All content items are tagged with 1-4 of these -->
- getting-started
- performance
- data-modeling
- migration
- security
- monitoring
- sdk
- integrations
- ai
- vector-search
- serverless
- cost-optimization
- best-practices
- change-feed
- throttling
- mongodb
- postgresql

## Content Filters

### SDK Packages to Detect in GitHub Repos
- **NuGet:** Microsoft.Azure.Cosmos
- **npm:** @azure/cosmos
- **PyPI:** azure-cosmos
- **Maven:** com.azure:azure-cosmos

### Additional Include Rules
- Always include content mentioning "hierarchical partition keys"
- Always include content mentioning "vector search" + "Cosmos DB"

### Additional Exclude Rules
- Exclude content about Azure Cosmos DB Emulator bugs/issues (not useful for social)

## Competitor & Adjacent Products
<!-- Tracked for share-of-voice analysis. Appears in a separate report section. -->
- MongoDB Atlas
- Amazon DynamoDB
- Google Cloud Firestore
- CockroachDB
- PlanetScale

## Conferences & Events
<!-- Content from these events gets relevancy boost during the event window -->
| Event | Dates | Notes |
|-------|-------|-------|
| Microsoft Build 2026 | May 19-21, 2026 | Major product announcements expected |
| .NET Conf 2026 | November 2026 | .NET + Cosmos DB sessions |

## Posting Preferences
- **Target frequency:** 3-5 posts per week
- **Days/times to avoid:** none
- **Approval workflow:** none
- **Team members to tag:** none

## Language & Region
- **Languages:** English only
- **Region focus:** Global
