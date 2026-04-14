---
mode: agent
agent: content-scout
description: Set up Content Scout for a new product — interactive configuration wizard
---

# Product Onboarding

Walk the user through configuring Content Scout for their product, technology, or project. Gather all required information through a conversational interview, then generate the config file.

## Interview Flow

Ask these questions **one group at a time**. Do not dump all questions at once.

### Quick Start vs. Full Setup

Before diving into groups, ask: **"Would you like a quick setup or full setup?"**

- **Quick setup** — 3 questions: product/tech name, your role, and which networks to scan. Everything else uses smart defaults. Best for people who track many products or want to get started fast.
- **Full setup** — Walk through all groups for maximum customization. Best for dedicated product owners who want fine-tuned control.

If the user doesn't express a preference, default to **full setup**.

#### Quick Setup Flow

If the user chooses quick setup:

1. Ask: **"What product, technology, or project are you tracking?"** (e.g., "Azure Cosmos DB", "Python", "Ollama", "Copilot CLI")
2. Ask: **"What's your role?"** Show the role table from Group 1.
3. Ask: **"Which networks should I scan? Say 'all' for everything, or pick specific ones."** Show the network table from Group 4.
4. Auto-generate:
   - **Search terms** from the product/tech name (full name, common abbreviations, no-space version)
   - **Hashtags** from the name (#ProductName)
   - **Slug** from the name (lowercase, hyphenated)
   - **Role defaults** for all feature toggles
   - **Content filters**, **topic tags**, and **social post standards** using sensible defaults
   - Skip: exclusions (none), people to watch (none), brand assets (text-only thumbnails), competitors (none), conferences (none), posting preferences (defaults)
5. Save the config file and `.env` (if keys were provided).
6. Tell the user: "Quick setup complete! You can customize further anytime by editing the config file or running `/scout-onboard` again."

### Group 0 — Product Scope

Ask: **"Are you setting up Content Scout for one product or multiple products? If multiple, I'll walk you through each one."**

- If **one product**: proceed to Group 1 as normal. Standard single-product flow.
- If **multiple products**: note the count. The user will go through Groups 1-6 once (shared role, networks, brand), then loop through Group 2 (Product Identity) and Group 3 (Exclusions) for each product. Each product gets its own config file.
- The user can also add more products later by running `/scout-onboard` again — it will detect existing configs and offer to add a new product.

If multiple products are requested, explain: "Great — I'll collect your role, network preferences, and brand settings once (they'll be shared), then walk through product-specific details for each product."

### Group 1 — Your Role

Ask: **"What's your role? Pick one, or combine multiple roles to get a blended report. This helps me tailor the report, set smart defaults, and focus on what matters most to you."**

| # | Role | What You'll Get |
|---|------|----------------|
| 1 | **Program Manager** | Adoption metrics, SDK usage, feature coverage, community feedback signals |
| 2 | **Product Manager** | Market signals, competitor mentions, customer requests, sentiment analysis |
| 3 | **Social Media Manager** | Post-ready content, engagement opportunities, posting calendar, trending topics |
| 4 | **Product Marketer** | Launch coverage, success stories, analyst mentions, campaign amplification |
| 5 | **Developer Advocate / DevRel** | Community projects, tutorials, rising contributors, conference talks |
| 6 | **Community Manager** | Contributor tracking, sentiment trends, engagement health, unanswered questions |
| 7 | **Technical Writer** | Doc gap analysis, tutorial patterns, FAQ signals, community-written tutorials vs. official docs |
| 8 | **Custom** | Cherry-pick exactly the features you want — I'll walk you through each toggle |

Accept a single number/name, a comma-separated list (e.g., "1, 4" or "Program Manager, Product Marketer"), or "Custom".

#### Role Defaults

Each role sets smart defaults for the rest of onboarding. When **multiple roles** are selected, defaults are **merged** — if any selected role enables a feature, it's on. The user can override any default in subsequent groups.

| Setting | PgM | PdM | SMM | PMktg | DevAdv | CM | TW |
|---------|-----|-----|-----|-------|--------|----|----|
| Social posts | off | off | on (all platforms) | on (all platforms) | on (all platforms) | off | off |
| Posting calendar | off | off | on | on | on | off | off |
| Competitor tracking | off | on | off | on | off | off | off |
| Conference CFP tracking | off | off | off | on | on | off | off |
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

When a role has social posts **off** (and no other selected role turns them on), skip Group 6 (social platforms) and Group 11 (posting preferences) unless the user explicitly asks for them.

#### Multi-Role Merging
When the user selects multiple roles:
1. Merge feature toggles using **union** — if any selected role has a feature on, it's on
2. For **report summary**, combine the relevant role summaries into one section (e.g., "Program Manager + Product Marketer" gets both adoption metrics and launch coverage)
3. For **report section ordering**, use the first role's ordering as the base and insert sections from other roles that aren't already included
4. Show the merged defaults table and ask: "Here's what's enabled based on your roles. Want to adjust anything?"

#### If "Custom" is selected
Show the full feature toggle list and let the user enable/disable each one:

| # | Feature | Default | Description |
|---|---------|---------|-------------|
| 1 | Social posts | off | Auto-generate social posts from scan results |
| 2 | Posting calendar | off | Weekly posting schedule |
| 3 | Competitor tracking | off | Monitor competitor content volume and switching signals |
| 4 | Conference CFP tracking | off | Find open calls for papers and recent conference talks about your product |
| 5 | Conversation sentiment | off | Classify forum/social conversations as positive/neutral/negative |
| 6 | Community health signals | off | Track community engagement trends |
| 7 | Rising contributors | off | Spotlight new or increasingly active authors |
| 8 | Feature request flagging | off | Flag feature requests and pain points from forums |
| 9 | Unanswered question tracking | off | Track unanswered questions on Stack Overflow, Reddit, forums |
| 10 | Doc gap focus | off | Identify documentation gaps and confusion signals |
| 11 | SDK/feature adoption tracking | off | Track SDK language breakdown and feature mention frequency |
| 12 | Engagement potential scoring | off | Score every item 1-5 for shareability |
| 13 | Launch coverage tracking | off | Group content by event during launch windows |

Ask: "Which features do you want? Give me the numbers, or say 'all' to enable everything."

Then ask:
- "Describe your role in a sentence or two."
- "What are you trying to accomplish with Content Scout? (e.g., track community projects, monitor competitor content, find content to share, identify customer pain points)"

Based on answers, configure defaults and explain: "Here's what I've set up for your role: {summary}. You can adjust any of this in the following steps."

#### Role Refinement
After the role is selected (single, multi, or custom), ask: **"Does this cover what you need, or should I adjust anything?"**
If the user wants changes, show the feature toggle table and let them flip individual settings. Any feature can be added or removed regardless of role.

### Group 2 — Product Identity
- What is the **full name** of the product, technology, project, or tool you want to track? (e.g., "Azure Cosmos DB", "Python", "Ollama", "GitHub Copilot CLI")
- What **type** is this? (product, technology/language, open-source project, tool/CLI) — this shapes report sections and search strategy.
- What is a **short slug** for file naming? (e.g., "cosmos-db", "python", "ollama", "copilot-cli")
- What **text search terms** should we use? List all name variations, abbreviations, and related terms. (e.g., "Azure Cosmos DB", "CosmosDB", "Cosmos DB")
- What **hashtags** are used on social media? (e.g., #CosmosDB, #AzureCosmosDB, #Python, #OllamaAI)

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
| 1 | Dev.to | None |
| 2 | Medium | None |
| 3 | Hashnode | None |
| 4 | DZone | None |
| 5 | C# Corner | None |
| 6 | InfoQ | None |
| 7 | YouTube (community channels) | YouTube Data API v3 key (free) |
| 8 | GitHub (community repos) | None |
| 9 | Stack Overflow | None |
| 10 | Reddit | None |
| 11 | Hacker News | None |
| 12 | Bluesky | App password (free) |
| 13 | LinkedIn | None |
| 14 | X/Twitter | X API bearer token ($200/mo Basic — free tier typically insufficient) |

Accept: "all" (default), a comma-separated list of numbers, or "all except {numbers}".

#### Custom Sources (vendor-specific)
After the standard network selection, ask:

**"Does your product have any of these? Add as many as you need, or say 'none' to skip."**

| Source Type | Description | Example |
|-------------|-------------|---------|
| **Vendor blog** | Official blog or community blog platform | `https://techcommunity.microsoft.com/tag/azure-cosmos-db`, `https://stripe.com/blog` |
| **Product updates feed** | Release notes, changelog, or update feed | `https://azure.microsoft.com/updates/`, `https://github.com/orgs/twilio/discussions/categories/changelog` |
| **Official docs site** | Documentation platform to monitor for new/updated pages | `https://learn.microsoft.com/azure/cosmos-db/`, `https://docs.stripe.com` |
| **Influencer blogs** | Known high-quality external blogs relevant to your product | `https://baeldung.com`, `https://freecodecamp.org` |

For each custom source, collect: **name**, **URL or search pattern**, and **type** (blog, update feed, docs, influencer).

**After selection, ask for API keys ONLY for selected sources that require them.** For each one, explain what the key unlocks, then let the user paste the key or say "skip". Keys are saved to `.env` at the workspace root (not in the config file), so the config can be safely committed or shared.

- If **YouTube** was selected: "YouTube requires a free API key. Without it, YouTube is skipped and community videos won't appear in reports. Paste your YouTube Data API v3 key, or say **skip**."
- If **Bluesky** was selected: "Bluesky requires a free app password for authenticated search. Without it, Bluesky is skipped and mentions/hashtag posts won't be tracked. Paste your Bluesky handle and app password, or say **skip**."
- If **X/Twitter** was selected: "X requires a bearer token. The $200/mo Basic plan is typically needed — the free tier is usually too limited for meaningful scanning. Without it, X is skipped and conversations/mentions on X won't be tracked. Paste your X bearer token, or say **skip**."

**Saving keys:** When the user provides keys, save them to `.env` at the workspace root. If `.env` doesn't exist, create it from `.env.example`. Never store keys in the config file.

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

#### Brand & Thumbnail Identity
Collect brand identity details so thumbnails accurately represent the product. Say "none" to skip any item.

- **Logo files:** Where are your logo files? Provide a **directory path or URLs** to the actual logo files. List each logo filename if multiple versions exist (e.g., full-color, white, icon-only). *(If none provided, thumbnails will use text-only layouts — logos are never fabricated.)*
- **Logo usage rules:** Any rules for when to use which logo version? (e.g., "Use icon-only on dark backgrounds, full wordmark on light", "Minimum clear space of 20px around logo", "Never place logo on busy backgrounds")
- **Product name on thumbnails:** How should the product name appear? (e.g., exact casing like "Azure Cosmos DB", never abbreviated, or short forms allowed)
- **Brand colors** — provide hex codes for each:
  - Primary background: (e.g., #0C1A2E)
  - Accent / highlight: (e.g., #50E6FF)
  - Text color: (e.g., #FFFFFF)
  - Any additional palette colors and where each is used
- **Background theme:** dark, light, or gradient? *(default: dark)*
- **Visual style / look and feel:** Describe the general aesthetic for thumbnails. (e.g., "Stars/space theme on dark background", "Clean and minimal with bold typography", "Gradient backgrounds with geometric accents")
- **Font preferences:** Any specific fonts for headlines or body text? (e.g., "Segoe UI Semibold for headings", "Use brand typeface only")
- **Thumbnail composition:** Any preferences for layout? (e.g., "Logo top-left, headline centered", "Always include a subtle pattern overlay", "Text should never overlap the logo")
- **Things to NEVER do on thumbnails:** List any brand guardrails. (e.g., "Never stretch or recolor the logo", "Never use gradients on the logo", "Never use competitor colors", "Never add drop shadows to the logo")
- **Other brand concerns:** Anything a marketing team would flag? (e.g., "All thumbnails must match our brand kit at {URL}", "Follow accessibility contrast ratios", "Include legal disclaimer for preview features")

#### Social Post Standards
If social posts are enabled, ask these questions. Say "use defaults" to skip to sensible defaults.

**Audience:**
- "Who is the **target audience** for your social posts? (e.g., backend developers, cloud architects, data engineers, DevOps practitioners, engineering managers, startup CTOs) — knowing the audience shapes tone, technical depth, and framing."

**Tone & Voice:**
- "What **tone** works best for your audience? (e.g., technically grounded, conversational, authoritative, casual, witty)"
- "Does your organization have **social media guidelines or a style guide** I should follow? Describe the key rules (tone, emoji policy, hashtag limits, things to avoid) or say **'use defaults'**."

**Brand Name Usage:**
- "What is the **correct way to refer to your product** in social posts? Provide the full canonical name and any rules for short forms."
  - Example: *"The brand is 'Azure Cosmos DB'. Never write 'CosmosDB' or 'Azure CosmosDB'. After the full name has appeared once in a post, 'Cosmos DB' is acceptable for subsequent mentions."*
- "Are there **other names, abbreviations, or misspellings** that must never appear?" (e.g., incorrect casing, missing spaces, old product names)

**Length & Format Limits:**
- "Any **length constraints** beyond platform defaults?" Platform defaults are:
  - LinkedIn: 800-1500 chars, hook in first 200 chars
  - X: concise but substantive (aim for full tweet, not threads)
  - Bluesky: up to 300 chars
  - YouTube Community: concise, conversational
- "Any rules about **emoji usage**? (default: 0-2 max)"
- "Any rules about **hashtag usage**? (default: 1-2 at end)"

**Words & Patterns to Avoid:**
- "Any **words, phrases, or patterns to always avoid** in posts? (e.g., 'game-changer', 'excited to announce', em dashes, UTM links, clickbait hooks)"
- "Any **competitor names** that should never appear in your posts?"

**Content Framing:**
- "What **framing angles** work best for your content?" Default angles: how this works, what you can build, what problem this solves, what changed and why, real-world example. Add or remove as needed.

**Additional Rules:**
- "Any other **org-specific rules**? (e.g., 'always link to official docs', 'never speculate about unreleased features', 'include legal disclaimer for preview features')"

If the user says "use defaults", apply these sensible defaults:
- Target audience: developers and technical practitioners
- Plainspoken, technically credible, non-marketing
- No fluff phrases ("check it out", "exciting news", "game-changer")
- No em dashes, no UTM links
- Always use full product name on first mention; acceptable short form on subsequent mentions only if defined
- LinkedIn: 800-1500 chars, hook in first 200, 0-2 emoji, 1-2 hashtags
- X: concise but substantive, 1-2 hashtags, no shortened links
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
**Show this group by default for Developer Advocate and Product Marketer roles, or any role with Conference CFP tracking on. For other roles, only show if the user requests it.**

- Any **upcoming conferences or events** where the product will be featured? (e.g., "Microsoft Build 2026", "KubeCon EU 2026")
- Are there **recurring meetups** or community events to watch? (e.g., ".NET Conf", "Azure Cosmos DB Live")
- Event content (talks, workshops, demos) gets boosted in the relevancy filter during and immediately after the event window.

#### Conference CFP Discovery (if Conference CFP tracking is on)
If CFP tracking is enabled for this role, also ask:

- "What **types of conferences** are relevant to your product's users? I'll use these to find open CFPs." Suggest categories based on the product (e.g., for a database product: cloud/infrastructure, database/data engineering, developer, DevOps, AI/ML, language-specific like .NET or Java). Let the user add or remove categories.
- "Any **specific conferences** you always want checked for open CFPs?" (e.g., "NDC", "re:Invent", "KubeCon", "QCon") These will be checked every scan even if they don't appear in aggregator searches.
- "What **regions** matter for in-person events? Or are you only interested in virtual conferences?" (default: same as Language & Region setting)

Store the conference categories, must-check conferences, and event region preferences in the config under `## Conferences & Events`.

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

**One config file per product.** If the user is onboarding multiple products, generate a separate config file for each. Shared settings (role, networks, brand assets, social post standards) are duplicated into each config so every config is self-contained.

After gathering all answers, generate each config file at:
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
- **Role:** {selected role(s), comma-separated, or "Custom"}
- **Social posts:** {on/off}
- **Posting calendar:** {on/off}
- **Report focus:** {role-specific focus description, or combined if multi-role}
- **Report section ordering:** {role-specific order — e.g., "SDK first", "competitors first", "community first"}
- **Engagement scoring:** {on/off}
- **Conversation sentiment:** {on/off}
- **Feature request flagging:** {on/off}
- **Unanswered question tracking:** {on/off}
- **Rising contributors:** {on/off}
- **SDK/feature adoption tracking:** {on/off}
- **Competitor tracking:** {on/off}
- **Conference CFP tracking:** {on/off}
- **Launch coverage tracking:** {on/off}
- **Doc gap focus:** {on/off}

## Topic
- **Name:** {Product/Technology/Project Name}
- **Slug:** {slug}
- **Type:** {product | technology | project | tool}
<!-- Type shapes report sections: products get SDK adoption + launch tracking; technologies get ecosystem/library tracking; projects get contributor + release tracking; tools get integration + tutorial tracking -->

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

### Standard Sources
| Source | Enabled |
|--------|---------|
| Dev.to | {yes/no} |
| Medium | {yes/no} |
| Hashnode | {yes/no} |
| DZone | {yes/no} |
| C# Corner | {yes/no} |
| InfoQ | {yes/no} |
| YouTube | {yes/no} |
| GitHub | {yes/no} |
| Stack Overflow | {yes/no} |
| Reddit | {yes/no} |
| Hacker News | {yes/no} |
| Bluesky | {yes/no} |
| LinkedIn | {yes/no} |
| X/Twitter | {yes/no} |

### Custom Sources
<!-- Vendor-specific blogs, update feeds, docs, and influencer blogs. Omit section if "none". -->
| Name | Type | URL |
|------|------|-----|
| {source name} | {blog/update-feed/docs/influencer} | {url} |

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
<!-- Omit any field where the user said "none". CRITICAL: Never generate fake or placeholder logos. -->
<!-- If no logo files are provided, thumbnails use text-only layouts. -->
- **Logo directory:** {path to logo files or "none"}
- **Logos available:** {list of logo filenames or "none"}
- **Logo usage rules:** {when to use which version, clear space rules, or "none"}
- **Product name on thumbnails:** {exact casing and usage rules, e.g., "Azure Cosmos DB — never abbreviate"}
- **Brand colors:**
  - Primary background: {#hex or "none"}
  - Accent: {#hex or "none"}
  - Highlight: {#hex or "none"}
  - Text: {#hex or "none"}
- **Thumbnail style:** {visual style description, e.g., "Stars/space theme on dark background"}
- **Background theme:** {dark/light/gradient or "dark"}
- **Font:** {e.g., "Segoe UI Semibold for headings" or "none"}
- **Thumbnail composition:** {layout preferences, e.g., "Logo top-left, headline centered" or "none"}
- **Brand guardrails (never do):** {list of things to never do, e.g., "Never stretch logo, never use competitor colors" or "none"}
- **Additional brand concerns:** {marketing team requirements or "none"}
- **Thumbnail sizes:**
  - LinkedIn: 1200x1200 (square) or 1200x628 (landscape)
  - X: 1600x900
  - Bluesky: 2000x1000
  - YouTube Community: 1200x675

## Social Post Standards
<!-- Only include if social posts are enabled. Omit entire section if social posts are off. -->
<!-- If user said "use defaults", include the default standards here explicitly so the agent can reference them. -->
- **Target audience:** {e.g., "Backend developers, cloud architects, data engineers" or custom}
- **Tone:** {e.g., "Plainspoken, technically credible, non-marketing" or custom}
- **Brand name — canonical form:** {e.g., "Azure Cosmos DB"}
- **Brand name — acceptable short form:** {e.g., "Cosmos DB (only after full name has appeared in the same post)" or "none — always use full name"}
- **Brand name — never write:** {e.g., "CosmosDB, Azure CosmosDB, Cosmos" or "none"}
- **Avoid words/phrases:** {list or "none"}
- **Avoid competitor names in posts:** {list or "none"}
- **Emoji policy:** {e.g., "0-2 max" or custom}
- **Hashtag policy:** {e.g., "1-2 at end" or custom}
- **Things to avoid:** {e.g., "em dashes, UTM links, fluff phrases" or custom}
- **LinkedIn targets:** {e.g., "800-1500 chars, hook in first 200" or custom}
- **X targets:** {e.g., "concise but substantive, no shortened links" or custom}
- **Bluesky targets:** {e.g., "up to 300 chars" or custom}
- **Content framing angles:** {e.g., "how this works, what you can build, what problem this solves, what changed and why, real-world example" or custom}
- **Additional rules:** {any org-specific rules or "none"}

## API Keys
<!-- API keys are stored in .env at the workspace root, NOT in this config file. -->
<!-- This keeps secrets out of config so the config can be safely committed/shared. -->
<!-- See .env.example for the expected format. Copy it to .env and fill in your keys. -->
<!-- Without YouTube key: YouTube scanning is skipped (community videos won't appear in reports) -->
<!-- Without Bluesky creds: Bluesky scanning is skipped (mentions and hashtag posts won't be tracked) -->
<!-- Without X token: X/Twitter scanning is skipped (conversations and mentions won't be tracked) -->
<!-- All other sources (blogs, GitHub, Stack Overflow, Reddit, Hacker News) work without keys -->
_Keys are stored in `.env` — see `.env.example` for setup._

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

### CFP Discovery Settings
<!-- Only include if Conference CFP tracking is on. Omit entire subsection if off. -->
- **Conference categories:** {e.g., "cloud/infrastructure, database, developer, DevOps, .NET, Java, AI/ML"}
- **Must-check conferences:** {e.g., "NDC, KubeCon, QCon, re:Invent" or "none"}
- **Event regions:** {e.g., "Global" or "North America, Europe" or "Virtual only"}

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

1. Save the config file(s).
2. If the user provided API keys, save them to `.env` at the workspace root. If `.env` already exists, update only the keys that changed. Never overwrite existing keys without confirming.
3. Confirm to the user: "Configuration saved to `.github/prompts/scout-config-{slug}.prompt.md`." If multiple products, list all generated config files. If keys were saved, confirm: "API keys saved to `.env`."
4. Remind them of available commands:
   - `/scout-scan` — Run a content scan (scans all products, or specify one: `/scout-scan cosmos-db`)
   - `/scout-post` — Generate social posts from a URL
   - `/scout-calendar` — Generate a posting calendar
   - `/scout-gaps` — Analyze content gaps
   - `/scout-trends` — Compare trends across months
5. If multiple products were configured, explain: "You can scan all products at once with `/scout-scan`, or target one with `/scout-scan {slug}`. The same applies to other commands."
6. If any API keys were skipped during Group 4, remind the user which sources are disabled until keys are added to `.env`.
