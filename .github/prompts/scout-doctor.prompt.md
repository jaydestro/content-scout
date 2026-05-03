# scout-doctor

Validate Content Scout configuration, environment, and persistent state. Run this before onboarding handoff, when something stops working, or as a periodic health check.

Ignore VS Code frontmatter (`tools:`, `${{input:...}}`) — that's editor-specific. Ask the user conversationally for any inputs.

## Inputs

- (optional) Product slug. If omitted, run all checks for every config file under `.github/prompts/scout-config-*.prompt.md`.

## Steps

1. **Workspace layout check** — verify these exist (✅/❌ each):
   - `.github/agents/content-scout.agent.md`
   - `.github/prompts/scout-onboard.prompt.md`, `scout-scan.prompt.md`, `scout-post.prompt.md`, `scout-calendar.prompt.md`, `scout-gaps.prompt.md`, `scout-trends.prompt.md`, `scout-creators.prompt.md`, `scout-doctor.prompt.md`, `scout-replay.prompt.md`
   - At least one `.github/prompts/scout-config-*.prompt.md` (other than `scout-config-example.prompt.md`)
   - `reports/` and `social-posts/` directories
   - `reports/.seen-links.json` (created if missing — that's fine, just note it)
   - `.gitignore` includes `reports/.scout-state/` and `reports/.seen-links.json`

2. **Config completeness** — for each config file checked. Use exact-line regex `^##\s+<heading>` (not substring) so subsections like `### Product Team Members` don't false-match top-level headings.
   - Required sections present (top-level `##`):
     - `## Role`
     - `## Topic Identity`
     - `## Brand Assets`
     - `## Content Sources (scan order)`
     - `## Topic Tags` *(may include trailing parenthetical like `(Canonical)` or `(customize for your product)`)*
     - `## Social Post Standards`
   - Under `## Topic Identity`: `topic_type` field is one of `product | technology | project | tool | saas` (warn only if field is present and value is unrecognized; absence is OK)
   - At least one social network is enabled if the role has social posts on
   - `team_members_file` (if set) resolves to a real file
   - `mode` (if set) is `owner` or `consumer`

3. **`.env` and key check** — read `.env` (or report missing). For each known key, classify:
   - **Present** — key exists, non-empty
   - **Missing** — key not in file
   - **Likely invalid** — present but obviously malformed (wrong prefix, wrong length)

   Known keys: `YOUTUBE_API_KEY`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT`, `GOOGLE_PSE_KEY`, `GOOGLE_PSE_CX`, `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD`, `X_BEARER_TOKEN`, `GITHUB_TOKEN` (optional), `SCOUT_WEBHOOK_URL` (optional).

4. **Source reachability ping** — one cheap call per source with a present key:
   - Dev.to RSS — fetch `https://dev.to/feed`
   - Hacker News — `https://hn.algolia.com/api/v1/search?query=test&hitsPerPage=1`
   - Stack Overflow — `https://api.stackexchange.com/2.3/info?site=stackoverflow`
   - GitHub — `GET /rate_limit` (uses token if present, else unauth)
   - YouTube — `videos.list` with `id=dQw4w9WgXcQ` (smallest possible call)
   - Reddit — OAuth token fetch + `GET /api/v1/me` if creds set; otherwise probe `https://old.reddit.com/r/programming/.rss` (Layer 1 reachability) and report status.
   - Google PSE — if `GOOGLE_PSE_KEY` + `GOOGLE_PSE_CX` set, run a 1-result `customsearch/v1?q=test+site:reddit.com` and report quota status.
   - Bluesky — `createSession` (then revoke)
   - X — `users/me`
   - MS Learn MCP — list tools

   For each: ✅ ok / ⚠️ rate-limited / ❌ failed (with reason). Do NOT retry on failure — the goal is fast diagnosis.

5. **Persistent state integrity** — for each slug with a config:
   - `reports/.scout-state/{slug}/creators.json` parses as JSON (or doesn't exist yet, which is also fine)
   - Schema spot-check: top-level `creators` array, each entry has `handle`, `platform`, `first_seen`
   - `reports/.scout-state/{slug}/runs.jsonl` parses line-by-line
   - `reports/.seen-links.json` parses as JSON

6. **Free-tier viability** — if zero keys are present, confirm a free-tier scan would succeed (Dev.to, Medium, HN, SO, GitHub unauth, MS Learn). Print: "Free-tier mode is viable — `scout scan` will work without keys."

## Output

Print a checklist with green/yellow/red markers. Group by section (Workspace, Configs, Keys, Reachability, State). End with:

- **Overall**: 🟢 healthy / 🟡 degraded ({n} warnings) / 🔴 broken ({n} errors)
- **Top fixes** (ordered): the 3 highest-impact issues to fix first
- **Free-tier**: viable / not viable

Do NOT modify any files except creating `reports/.seen-links.json` if missing (initialize to `{}`).
