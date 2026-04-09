---
mode: agent
agent: content-scout
description: Set up Content Scout for a new product — interactive configuration wizard
---

# Product Onboarding

Walk the user through configuring Content Scout for their product. Gather all required information through a conversational interview, then generate the config file.

## Interview Flow

Ask these questions **one group at a time**. Do not dump all questions at once.

### Group 1 — Your Role

Ask: **"What's your role? This helps me tailor the report, set smart defaults, and focus on what matters most to you."**

| # | Role | What You'll Get |
|---|------|----------------|
| 1 | **Program Manager** | Adoption metrics, SDK usage, feature coverage, community feedback signals |
| 2 | **Product Manager** | Market signals, competitor mentions, customer requests, sentiment analysis |
| 3 | **Social Media Manager** | Post-ready content, engagement opportunities, posting calendar, trending topics |
| 4 | **Product Marketer** | Launch coverage, success stories, analyst mentions, campaign amplification |
| 5 | **Developer Advocate / DevRel** | Community projects, tutorials, rising contributors, conference talks |
| 6 | **Community Manager** | Contributor tracking, sentiment trends, engagement health, unanswered questions |
| 7 | **Technical Writer** | Doc gap analysis, tutorial patterns, FAQ signals, community-written tutorials vs. official docs |
| 8 | **Other** | Custom — tell me what you care about and I'll configure accordingly |

Accept a number or role name.

#### Role Defaults

Each role sets smart defaults for the rest of onboarding. The user can override any default in subsequent groups.

| Setting | PgM | PdM | SMM | PMktg | DevAdv | CM | TW |
|---------|-----|-----|-----|-------|--------|----|----|
| Social posts | off | off | on (all platforms) | on (all platforms) | on (all platforms) | off | off |
| Posting calendar | off | off | on | on | on | off | off |
| Competitor tracking | off | on | off | on | off | off | off |
| Conversation sentiment | on | on | off | off | on | on | off |
| Community health signals | off | off | off | off | on | on | off |
| Rising contributors | off | off | off | off | on | on | off |
| Feature request flagging | off | on | off | off | off | off | off |
| Unanswered question tracking | off | off | off | off | off | on | on |
| Doc gap focus | off | off | off | off | off | off | on |
| SDK/feature adoption tracking | on | off | off | off | on | off | off |
| Engagement potential scoring | off | off | on | on | on | off | off |
| Launch coverage tracking | off | off | off | on | off | off | off |
| Report summary focus | adoption | market | content pipeline | messaging | community | engagement | documentation |
| Report section ordering | SDK first | competitors first | blogs first | launch first | community first | questions first | doc signals first |

When a role has social posts **off**, skip Group 5 (social platforms) and Group 10 (posting preferences) unless the user explicitly asks for them.

#### If "Other" is selected
Interview the user:
- "Describe your role in a sentence or two."
- "What are you trying to accomplish with Content Scout? (e.g., track community projects, monitor competitor content, find content to share, identify customer pain points)"
- "Do you need social media posts generated, or is this primarily for monitoring and analysis?"
- "Which of these signals matter most to you: community projects, blog content, conversations, competitor mentions, documentation gaps, customer feedback, or something else?"

Based on answers, configure defaults and explain: "Here's what I've set up for your role: {summary}. You can adjust any of this in the following steps."

#### Role Refinement
After the role is selected, ask: **"Does this cover what you need, or should I adjust anything?"**
If the user wants changes, interview them about what's missing or different and adjust defaults before proceeding. If the role needs capabilities not currently in the default set (e.g., a PM who also wants social posts), enable those features.

### Group 2 — Product Identity
- What is the **full product name**? (e.g., "Azure Cosmos DB")
- What is a **short slug** for file naming? (e.g., "cosmos-db")
- What **text search terms** should we use? List all name variations, abbreviations, and related terms. (e.g., "Azure Cosmos DB", "CosmosDB", "Cosmos DB")
- What **hashtags** are used on social media? (e.g., #CosmosDB, #AzureCosmosDB)

### Group 3 — Exclusions (optional)
We need to exclude your team's own content so we only find community/external content. **Say "none" to skip any of these.**
- What is the **official blog URL** or blog tag page? *(optional — say "none")*
- What is the **official YouTube channel** name or URL? *(optional — say "none")*
- What are the **official social handles**? (LinkedIn, X/Twitter, Bluesky) *(optional — say "none")*
- Any **GitHub orgs or repos** to exclude? (e.g., "Azure/azure-cosmos-dotnet-v3" — these are team-owned) *(optional — say "none")*
- Any **other domains or authors** to exclude? *(optional — say "none")*
- Are there specific **product team members** whose content should be tracked separately? Their content on any platform will appear in a "Team Member Mentions" section for awareness rather than as numbered community items. Provide names and optionally handles/roles. *(optional — say "none")*

### Group 4 — Networks to Scan
Present the full source list and ask: **"Select all, or pick the ones you want."**

| # | Source | Auth Required |
|---|--------|---------------|
| 1 | Microsoft Tech Community | None |
| 2 | Dev.to | None |
| 3 | Medium | None |
| 4 | Hashnode | None |
| 5 | DZone | None |
| 6 | C# Corner | None |
| 7 | InfoQ | None |
| 8 | Influencer blogs (Baeldung, freeCodeCamp, CodeProject) | None |
| 9 | Azure Updates / What's New | None |
| 10 | Microsoft Learn docs | None |
| 11 | YouTube (community channels) | YouTube Data API v3 key (free) |
| 12 | GitHub (community repos) | None |
| 13 | Stack Overflow | None |
| 14 | Reddit | None |
| 15 | Hacker News | None |
| 16 | Bluesky | App password (free) |
| 17 | LinkedIn | None |

Accept: "all" (default), a comma-separated list of numbers, or "all except {numbers}".

**After selection, ask for API keys ONLY for selected sources that require them.** For each one, explain what the key unlocks, then let the user paste the key or say "skip". Skipped keys can always be added to the config file later.

- If **YouTube** was selected: "YouTube requires a free API key. Without it, YouTube is skipped and community videos won't appear in reports. Paste your YouTube Data API v3 key, or say **skip**."
- If **Bluesky** was selected: "Bluesky requires a free app password for authenticated search. Without it, Bluesky is skipped and mentions/hashtag posts won't be tracked. Paste your Bluesky handle and app password, or say **skip**."
- If **X/Twitter** is selected for conversation tracking: "X requires a bearer token ($200/mo Basic or limited free tier). Without it, X is skipped and conversations/mentions on X won't be tracked. Paste your X bearer token, or say **skip**."

If none of the selected sources require keys, skip the key prompts entirely and tell the user: "All your selected sources work without API keys — no setup needed."

### Group 5 — People to Watch (optional)
Say "none" to skip this group entirely.
- Any **known external authors** whose content should always be included? (MVP bloggers, community champions — they bypass relevancy filter) *(optional — say "none")*
- Any **influencers to monitor**? (high-signal accounts whose mentions are important) *(optional — say "none")*

### Group 6 — Social Post Configuration
**Skip this group if the role has social posts off and the user didn't request them.**

Say "none" to skip any of these. Defaults will be used.
- Which **platforms** should we generate posts for? Select from: **LinkedIn**, **X**, **Bluesky**, **YouTube Community**. *(Pick one or more, or say "none" to skip social post generation entirely.)*
- For each selected platform, what is the **account handle or URL**? *(optional — say "none" if you don't want to link your account)*
- What is the **product logo URL or path**? (for thumbnail generation) *(optional — say "none")*
- What are the **brand colors**? (primary, accent — hex codes) *(optional — say "none" to use defaults)*
- What **background theme** for thumbnails? (dark, light, gradient) *(optional — default: dark)*

#### Social Post Standards
If social posts are enabled, ask:
- "Does your organization have **social media guidelines or a style guide** I should follow? Describe the key rules (tone, emoji policy, hashtag limits, character targets, things to avoid) or say **'use defaults'** and I'll use industry-standard developer account practices."
- "Any **words, phrases, or patterns to always avoid** in posts? (e.g., 'game-changer', em dashes, UTM links)"
- "What **tone** works best for your audience? (e.g., technically grounded, conversational, authoritative, casual)"
- "Should posts always use the **full product name**, or is a short name acceptable?"

If the user says "use defaults", apply these sensible defaults:
- Plainspoken, technically credible, non-marketing
- No fluff phrases ("check it out", "exciting news", "game-changer")
- No em dashes, no UTM links
- LinkedIn: 800-1500 chars, hook in first 200, 0-2 emoji, 1-2 hashtags
- X: concise but substantive, 1-2 hashtags, no shortened links
- Always use full product name
- Vary framing angles across post options

Store whatever the user provides (or the defaults) in the config under `## Social Post Standards`.

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
**This group is shown by default for Product Manager and Product Marketer roles. For other roles, only show if relevant.**
- Any **competitor or adjacent products** to track alongside yours? (e.g., if your product is Azure Cosmos DB, you might track "MongoDB Atlas", "DynamoDB", "CockroachDB")
- These will be tracked in a separate section of the report — useful for understanding market conversation and share of voice.
- This is optional. Skip if not relevant.

### Group 10 — Conferences & Events (optional)
- Any **upcoming conferences or events** where the product will be featured? (e.g., "Microsoft Build 2026", "KubeCon EU 2026")
- Are there **recurring meetups** or community events to watch? (e.g., ".NET Conf", "Azure Cosmos DB Live")
- Event content (talks, workshops, demos) gets boosted in the relevancy filter during and immediately after the event window.

### Group 11 — Posting Preferences (optional)
**Skip this group if the role has posting calendar off and social posts are disabled.**
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

## Role
- **Role:** {selected role or custom role name}
- **Social posts:** {on/off}
- **Posting calendar:** {on/off}
- **Report focus:** {role-specific focus description}
- **Report section ordering:** {role-specific order — e.g., "SDK first", "competitors first", "community first"}
- **Engagement scoring:** {on/off}
- **Conversation sentiment:** {on/off}
- **Feature request flagging:** {on/off}
- **Unanswered question tracking:** {on/off}
- **Rising contributors:** {on/off}
- **SDK/feature adoption tracking:** {on/off}
- **Competitor tracking:** {on/off}
- **Launch coverage tracking:** {on/off}
- **Doc gap focus:** {on/off}

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

### Product Team Members
<!-- Content by these people appears in "Team Member Mentions" section, not as numbered items. Omit section if "none". -->
- {name} — {role or context}

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

## Social Post Standards
<!-- Only include if social posts are enabled. Omit entire section if social posts are off. -->
<!-- If user said "use defaults", include the default standards here explicitly so the agent can reference them. -->
- **Tone:** {e.g., "Plainspoken, technically credible, non-marketing" or custom}
- **Always use full product name:** {yes/no}
- **Avoid words/phrases:** {list or "none"}
- **Emoji policy:** {e.g., "0-2 max" or custom}
- **Hashtag policy:** {e.g., "1-2 at end" or custom}
- **Things to avoid:** {e.g., "em dashes, UTM links, fluff phrases" or custom}
- **LinkedIn targets:** {e.g., "800-1500 chars, hook in first 200" or custom}
- **X targets:** {e.g., "concise but substantive, no shortened links" or custom}
- **Content framing angles:** {e.g., "how this works, what you can build, what problem this solves, what changed and why, real-world example" or custom}
- **Additional rules:** {any org-specific rules or "none"}

## API Keys
<!-- All optional. Add keys here when available. Do not commit secrets to public repos. -->
<!-- Without YouTube key: YouTube scanning is skipped (community videos won't appear in reports) -->
<!-- Without Bluesky creds: Bluesky scanning is skipped (mentions and hashtag posts won't be tracked) -->
<!-- Without X token: X/Twitter scanning is skipped (conversations and mentions won't be tracked) -->
<!-- All other sources (blogs, GitHub, Stack Overflow, Reddit, Hacker News, MS Learn) work without keys -->
- **YouTube Data API v3:** {key or "none"}
- **Bluesky handle:** {handle or "none"}
- **Bluesky app password:** {password or "none"}
- **X Bearer token:** {token or "none"}

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
   - `/scout-trends` — Compare trends across months
4. If any API keys were skipped during Group 3, remind the user which sources are disabled until keys are added to the config file.
