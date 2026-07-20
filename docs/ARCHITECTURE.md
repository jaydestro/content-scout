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

## Local Storage

Content Scout uses SQLite as its default local operational store. The web UI
creates `.local/state/content-scout.db` on first start, applies versioned schema
migrations, and idempotently imports existing reports, social-post drafts, and
subject configs. SQLite runs in WAL mode with foreign keys and a busy timeout;
it requires no server, connection string, or credentials.

The database stores artifact metadata and content, subject references, FTS5
search data, and durable parsed-index snapshots. Generated images and large raw
browser captures remain files; SQLite stores their metadata rather than binary
blobs. Markdown and JSON remain portable import/export and archive formats,
not the normal dashboard/search query path.

Storage operations are available from the repository root:

```powershell
node tools/storage.mjs status
node tools/storage.mjs import
node tools/storage.mjs verify
node tools/storage.mjs backup
node tools/storage.mjs restore --input .local/state/backups/content-scout-<timestamp>.db
node tools/storage.mjs export --output .local/exports/latest
node tools/storage.mjs retention
```

Retention defaults to a non-destructive dry run. Applying a plan can remove old
run history, excess backups, and aged raw browser captures; reports, social
drafts, configs, and generated images are protected from automatic deletion.
Measured current and synthetic-corpus results are documented in
[SQLite Storage Benchmarks](SQLITE-BENCHMARKS.md).

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

## File Structure

```
.github/
├── agents/
│   └── content-scout.agent.md             # Agent definition (single source of truth)
├── copilot-instructions.md                # GitHub Copilot chat adapter
└── prompts/
    ├── scout-onboard.prompt.md            # Onboarding wizard
    ├── scout-config-{slug}.prompt.md      # Your config (gitignored)
    ├── scout-scan.prompt.md
    ├── scout-post.prompt.md
    └── scout-calendar.prompt.md
CLAUDE.md                                  # Claude Code adapter
.clinerules                                # Cline adapter
.windsurfrules                             # Windsurf adapter
.cursor/rules/content-scout.mdc            # Cursor adapter
docs/                                      # WORKFLOW, SOURCES, API-KEYS, EDITORS, ARCHITECTURE
examples/                                  # Sample outputs
reports/                                   # Generated content reports (.md/.json gitignored)
reports/.closed-conversations.json         # Dismissed Conversations & mentions rows (shared by web UI + helper scripts)
social-posts/                              # Generated posts, calendars, thumbnails (.md/.json gitignored)
tools/web-ui/                              # Local browser dashboard (Express server on :4477)
tools/web-ui/lib/closed-conversations.js   # Storage layer for dismissed conversation rows
tools/conversations-cli.mjs                # Helper script for closing/listing conversations from the terminal
tools/lib/roundup.mjs                      # Monthly roundup generator (one regenerable index per calendar month)
tools/lib/originality.mjs                  # Originality scorer + documentation-overlap detector (compareTexts / reviewAgainstDocs)
tools/originality.mjs                      # Originality CLI (--json, repeatable --doc <url>)
tools/browser-scan/                        # Logged-in browser scraper (Edge/Chrome/Brave/etc. via CDP) for X / LinkedIn / Reddit Layer 0
.github/team-members.md.example            # Template for team-member exclusion list (copy to team-members.md, gitignored)
.env.example                               # API key template (copy to .env)
```

## Web UI surface

`tools/web-ui/server.js` (Express, default `http://127.0.0.1:4477`) exposes:

- `/api/env` (GET / POST) — read/write `.env`. The GET handler **filters out vision provider keys** (`VISION_PROVIDER`, `OLLAMA_HOST`, `OLLAMA_VISION_MODEL`, `OPENAI_VISION_MODEL`, `CUSTOM_VISION_*`) so the API Keys editor never shows or overwrites them.
- `/api/vision-config` — read/write the same vision keys; backs the dedicated **Vision** card on the Configs page (and `/scout-vision`).
- `/api/closed-conversations` — list/add/remove dismissed Conversations & mentions rows. State lives in `reports/.closed-conversations.json` and is shared with `tools/conversations-cli.mjs`.
- `/api/runs/scan` — Step 0 runs `node tools/browser-scan/index.mjs scan --slug {slug}` (Auto / Force / Skip modes from the Run-view "Browser scan (Layer 0)" fieldset) before invoking the agent.
- `/api/roundups` (GET) + `/api/roundup/generate` (POST) — list available monthly roundups and (re)generate one in place for a `{slug, month?}`. Backs the **Reports → Roundup** tab; the roundup doc itself is served by the existing `GET /api/reports/:name`.
- `/api/analytics/originality` (POST) — score a URL's AI-writing signals and run a verbatim-overlap check against official docs (auto-detected + supplied). Backs the **Tools → Originality** tab; saves a dated `-originality.md` report into the Tools browse list.
- The dashboard's **At-a-glance** tiles are click-through and route to the relevant detail view.

