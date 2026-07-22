# Changelog

All notable changes to Content Scout are tracked here.

This project uses a product changelog version stream until formal release tags are cut. Minor feature releases use `0.x.0`; major fix bundles also receive their own `0.x.0` entry so every important fix has a durable version number.

## [0.32.0] - 2026-07-20

SQLite becomes the automatic local operational store.

### Versioned Features and Fixes

| Version | Type | Area | Change |
| --- | --- | --- | --- |
| 0.32.0 | Minor feature | Storage / Setup | The web UI now requires Node.js 22.13+ and uses built-in `node:sqlite` with no server, credentials, or native database dependency. First startup creates the gitignored `.local/state/content-scout.db`, enables WAL/foreign keys/busy timeout, applies transactional versioned migrations, and idempotently imports existing subject configs, reports, social drafts, sentiment overrides, generated-image metadata, and browser-capture metadata. SQLite uses FTS5 where the bundled library provides it and automatically falls back to portable literal search where it does not, while storing normalized reports, items, conversations, sentiment/competitor fields, creators, sources, run history, and durable parsed-index snapshots. Report/social listings, reads, search, and dashboard indexes use SQLite after startup reconciliation. Markdown/JSON remain deterministic import/export and archive formats; image/capture binaries stay on disk. Setup shows migration/storage status and recovery details. |
| 0.32.0 | Minor feature | Storage / Recovery | New `node tools/storage.mjs` commands provide `init`, `import`, `status`, `verify`, `backup`, `restore`, `export`, and dry-run-first `retention`. Migrations checkpoint and back up before upgrades; corrupt databases are quarantined and rebuilt from retained files. Retention never silently deletes reports, social drafts, configs, or generated images. |

### Upgrade and rollback

- Upgrade Node.js to 22.13 or later before starting the web UI.
- Existing files are preserved during automatic import. Verify with `node tools/storage.mjs verify`.
- Create a checkpointed backup with `node tools/storage.mjs backup`.
- Restore one with `node tools/storage.mjs restore --input <backup.db>`.
- For rollback to a file-backed release, stop the server and retain or export Markdown/JSON with `node tools/storage.mjs export --output <directory>`; no source files are deleted by migration.

### Validation

- Full Express integration covers automatic setup, reports, search, normalized dashboard endpoints, persisted run history, and restart hydration.
- Schema 1–4 upgrade fixtures verify migration to schema 8 plus pre-migration backup.
- Forced WAL contention verifies concurrent reads and bounded competing writes.
- Measured SQLite search: 85 ms vs. 245 ms file search on the current corpus; 2.4 ms vs. 403 ms at 500 artifacts; 30 ms vs. 1,985 ms at 5,000 artifacts. See `docs/SQLITE-BENCHMARKS.md`.

## [0.31.0] - 2026-07-02

Competitor queries wired into the browser-scan conversations layer.

### Versioned Features and Fixes

| Version | Type | Area | Change |
| --- | --- | --- | --- |
| 0.31.0 | Minor feature | Browser scan / Competitor pass | New shared `tools/lib/competitors.mjs` parses the config's `## Competitors` section (bold name + `Aliases:`) into structured entries and provides query-term building + word-boundary matching/tagging. The browser-scan now runs a **competitor pass** over Reddit + X when competitors are configured: it queries the competitor names/aliases, keeps only items that name a tracked competitor, tags each with the matched `competitor`, and writes a `{stamp}-competitors.json` sidecar (plus a `competitors` block in `{stamp}-meta.json`). Because the browser-scan runs as Step 0 of every `/scout-scan`, the competitor pass happens **automatically alongside the monthly mindshare run** — no separate command. `/scout-scan` + agent docs ingest the sidecar into the `## Competitor & Market Signals` section and add Hacker News / Stack Overflow / Bluesky per-alias API coverage. Flags: `--no-competitors`, `--max-competitor-terms N` (default 12). |

### Validation

- New `tools/web-ui/test/competitors.test.js` (6 tests): parsing, alias handling, query-term building, word-boundary matching (no "Atlas" → "Atlassian" false positive), and item tagging.
- `node --check` on the browser-scan orchestrator + a live `loadConfig` parse of the real config (8 competitors) confirm the wiring.

## [0.30.0] - 2026-07-02

Competitor sentiment & market-signal tracking.

### Versioned Features and Fixes

| Version | Type | Area | Change |
| --- | --- | --- | --- |
| 0.30.0 | Minor feature | Reports / Competitor signals | `/scout-scan` now populates a `## Competitor & Market Signals` section when **Competitor tracking** is on and the config's `## Competitors` section lists products: per-competitor content volume, community sentiment (toward the competitor), switching signals (migrations to/from, scored from our product's perspective), and notable announcements — matched by competitor name + aliases across conversation sources and the competitor's own blog/release-notes, inline in the single content report. The web UI **Reports** view gains a **Competitors** tab that lists standalone `-competitors.md` deep-dive reports and slices the Competitor & Market Signals section out of content reports (mirroring the Mindshare / CFPs & Events tabs). `tools/lib/doc-meta.mjs` classifies `-competitors.md` as kind "Competitors" and detects the section for tab filtering. |

### Validation

- Report classification + section detection verified against a generated `-competitors.md` report and a content report carrying the section.

## [0.29.0] - 2026-07-02

Monthly roundup, content-originality review, responsive navigation, and scan-source hardening (`feature/roundup-techcommunity-scan`).

### Versioned Features and Fixes

| Version | Type | Area | Change |
| --- | --- | --- | --- |
| 0.29.0 | Minor feature | Reports / Monthly roundup | A regenerable per-calendar-month content index (`tools/lib/roundup.mjs`): **one file per month** (`reports/{YYYY-MM}-{slug}-roundup.md`) that overwrites in place, aggregating every in-month content report into official / video / article / repo buckets (social rows dropped) and deduping by canonical URL. Official bylines come from the DevBlogs RSS feed with author backfill from post meta/JSON-LD (now including `azure.microsoft.com` blogs); YouTube creators + channel links resolve via oEmbed. Surfaced as a 4th **Reports** tab (Full Report / Mindshare / CFPs & Events / **Roundup**) with a month picker and **Generate monthly roundup** button; new `GET /api/roundups` + `POST /api/roundup/generate` endpoints. Robust date extraction stops cross-month leakage and the redundant Reports quick-pick dropdown was removed. |
| 0.28.0 | Minor feature | Tools / Originality review | New **Tools → Originality** tab and `/scout-originality` command: paste a URL (plus optional official-doc URLs) and Content Scout scores AI-writing signals **and** runs a verbatim-overlap check against official docs (auto-detected doc links + any supplied). The documentation-derivative detector in `tools/lib/originality.mjs` (`compareTexts` = 8-gram shingle overlap + longest shared run; `reviewAgainstDocs` = worst-case match + attribution check) returns a verdict — `original-wording` / `some-overlap` / `quotes-attributed-docs` / `copied-unattributed` — and saves a dated `-originality.md` report. New `POST /api/analytics/originality` endpoint; the CLI gains a repeatable `--doc <url>` flag plus auto-discovery of doc links in the content. |
| 0.27.0 | Minor feature | Scans / Originality scoring | Optional **Originality scoring** config toggle: when on, `/scout-scan` rates how human-written vs. AI-generated each text-bearing item reads — a deterministic 0-10 score grounded in the humanizer skill's documented signs of AI writing (AI-vocabulary density, em-dash overuse, rule-of-three, negative parallelisms, superficial "-ing" analysis, promotional language, and more) — and adds a `## Originality Review` section plus an at-a-glance line. Framed as a transparent review aid: never a definitive AI verdict, and it never drops or down-ranks an item for a low score. Titles/snippets return `insufficient-text` so it never guesses. |
| 0.26.0 | Minor feature | Web UI / Navigation | The header nav collapses to icon-only at ≤1280px (a clean breakpoint with no clipped labels) and tightens further at ≤720px, so no destination is ever cut off on narrow windows. The agent/runner status pill moves out of the header into the **Operations** drawer; at-a-glance activity stays on the Operations badge. |
| 0.25.0 | Major fix | Bulk runs + scan sources | Bulk social-post runs persist their summary **incrementally** (initial stub + after every item) instead of only when all items close, so an interrupted or restarted run still leaves a file in `social-posts/`; the summary writer is now re-entrant. Scan sources hardened: Google News falls back to RSS when the rendered pass times out (the RSS `when:` window reads `1m` as one minute); Tech Community / content-sites extracts publish dates from result cards and backfills missing ones via a login-free article-page fetch, so the date gate surfaces in-window posts instead of dropping date-less items. Full Report is now month-cumulative (carries forward all in-month items) and LinkedIn `sdui-post` items fall back to `author_profile` instead of being marked unreachable. |

### Validation

- Originality scorer calibrated: human voice 10/10, genuine posts 8-9/10, heavy AI patterns 3/10, short titles n/a. Documentation-overlap check: original prose 0%, identical text 100%.
- Originality endpoint + Tools tab tested end-to-end in the browser.
- Monthly roundup verified for June 2026 (72 items — 20 official / 30 videos / 16 blogs / 6 samples — from 41 source reports).

## [0.24.0] - 2026-06-11

Browser-scan coverage for the four content sources the API/RSS layers can't reach.

### Versioned Features and Fixes

| Version | Type | Area | Change |
| --- | --- | --- | --- |
| 0.24.0 | Minor feature | Browser scan / content sites | New `content-sites` platform scrapes Microsoft Tech Community, DZone, C# Corner, and Hashnode from the logged-in / real browser, fixing the login wall, anti-bot 403, RSS 500, and tag-RSS 404 that made these sources skip on the API/RSS path. Each site's own search page is driven per configured term; results merge into one `*-content-sites.json` Layer 0 sidecar (blog-shaped items, `subSource` per site) that `/scout-scan` ingests into the content sections. `launch-edge.mjs` now opens a Tech Community sign-in tab, and per-site failures (login wall / captcha / no results) skip gracefully with a debug snapshot. |

## [0.23.0] - 2026-06-11

CDP attach reliability fix for the browser-scan sign-in check and scans.

### Versioned Features and Fixes

| Version | Type | Area | Change |
| --- | --- | --- | --- |
| 0.23.0 | Major fix | Browser scan / CDP attach | The launcher now disables tab sleeping, renderer backgrounding, timer throttling, and occlusion freezing so a browser left open between scans keeps its tabs attachable. The UI preflight auto-launch now defaults the dedicated CDP profile to **Microsoft Edge** (override with the `SCOUT_BROWSER` env var; soft-falls back to the OS default if Edge isn't installed) so it never attaches to or wakes the user's everyday default browser — a heavily-loaded default Chrome was the usual trigger for the hang. `attachEdge` is shared by the sign-in check, retries once when the CDP WebSocket connects but tab enumeration times out (the first attach wakes frozen/sleeping renderers, so the retry usually succeeds), accepts a `SCOUT_CDP_TIMEOUT_MS` override for heavily-loaded browsers, and emits an actionable message (relaunch a clean dedicated profile, or close extra tabs) instead of the misleading `cdp-unreachable` "browser not running" hint. |

## [0.22.0] - 2026-06-11

Google browser-sidecar coverage release.

### Versioned Features and Fixes

| Version | Type | Area | Change |
| --- | --- | --- | --- |
| 0.22.0 | Minor feature | Browser scan / Google sidecar | Google Web browser scans now run a broad recent-results fallback using `tbs=qdr:y` after the exact custom date-range search, dedupe by URL, and annotate results with `search_scope` / `google_tbs` so the sidecar catches newly indexed posts like manual Google searches do. |

## [0.21.0] - 2026-06-11

Security fix for browser-run output redaction.

### Versioned Features and Fixes

| Version | Type | Area | Change |
| --- | --- | --- | --- |
| 0.21.0 | Major fix | Web UI / Run logs | Completed run output, SSE replay, and bulk-run summaries now pass through secret redaction before being shown in the browser, and the redactor catches lowercase password/api-key fields, query-string secrets, and natural-language token/password phrases. |

## [0.20.0] - 2026-06-11

Integration release for the local web UI, browser-scan, dashboard freshness, and report-ingestion work merged through PR #15.

### Versioned Features and Fixes

| Version | Type | Area | Change |
| --- | --- | --- | --- |
| 0.20.0 | Major fix | Dashboard / Community signals | Fresh X, LinkedIn, and Reddit browser-scan sidecars are indexed directly into `/api/conversations` when newer than the latest report, so Community signals no longer waits for a later agent-written report to show fresh scan data. |
| 0.19.0 | Major fix | Browser scan ingestion | Standalone browser-scan runs now auto-start a scoped `/scout-scan` ingestion run by default, with `browserScan: skip`, so completed scans fold into reports instead of leaving data stranded in sidecars. |
| 0.18.0 | Major fix | Browser scan reliability | Browser-scan no longer treats late async warnings, such as Google News timeouts after successful social sidecar writes, as failed completed social scans. |
| 0.17.0 | Major fix | Dashboard reliability | Dashboard cold-load behavior is resilient: index builds are shared by a mutex, dashboard card fetches retry cold endpoints, and failed cards no longer blank the whole dashboard. |
| 0.16.0 | Major fix | Community signal links | Definitive 404/410 community-signal links are stripped instead of surfaced as clickable dead links, including on social hosts. Ambiguous bot-wall failures remain protected from false removal. |
| 0.15.0 | Major fix | Test safety | Web UI tests now run through a hermetic runner with a temporary `SCOUT_LOCAL_ROOT`, preventing test runs from overwriting real `.local/state` files. |
| 0.14.0 | Major fix | Runtime config loading | Content Scout runtime config discovery now prefers `.local/configs/scout-config-*.md`, with legacy `.github/prompts/scout-config-*.prompt.md` fallback, so headless scans use the same configs as the web UI. |
| 0.13.0 | Minor feature | Browser scan | Browser-scan supports logged-in Layer 0 sidecars for X, LinkedIn, Reddit, and Google, with canonical `.local/state/browser-scan/{slug}` storage and legacy fallback support. |
| 0.12.0 | Minor feature | Browser-scan UI | The Run view exposes sign-in scan status, per-platform chips, browser launch, force-rescan, and freshness controls for the active scan subject. |
| 0.11.0 | Major fix | Hiring and relevance filtering | Hiring/recruiting posts are hard-filtered at sidecar generation and direct sidecar indexing time, with expanded recruiter-format phrase detection and Cosmos-specific phrase-level relevance filtering. |
| 0.10.0 | Minor feature | Web UI architecture | The `app.js` monolith was split into focused modules: core helpers, config markdown helpers, cache/navigation helpers, document list helpers, dashboard, reports, tools, social, report state, and vision config components. |
| 0.9.0 | Minor feature | Reports view | Reports now have dedicated page-module logic, tab filtering, section navigation, active subject state, and shared document rendering helpers. |
| 0.8.0 | Minor feature | Tools view | SEO and Ask tooling moved into a dedicated page module with tab filtering, analytics actions, and quick prompt chips. |
| 0.7.0 | Minor feature | Social posts view | Social posts rendering moved into a dedicated page module with list filtering, rendered markdown bodies, URL chips, copy buttons, and inline generated-image actions. |
| 0.6.0 | Minor feature | Vision / thumbnails | Vision provider configuration and local service detection moved into a reusable component; social-post thumbnail options and renderer tests are supported in CI. |
| 0.5.0 | Major fix | Dashboard information architecture | The dashboard was simplified to a single-column kickoff flow, removing confusing Pulse/Activity/Intel tabs and stale empty action-item panels. |
| 0.4.0 | Removed | Low-value analytics | Gap analysis (`scout-gaps`) and trends analysis (`scout-trends`) were removed from prompts, APIs, web UI tabs/cards, docs, and CI prompt checks. |
| 0.3.0 | Minor feature | Conversations | Conversations gained better platform canonicalization, team/no-triage filters, muted account handling, sentiment review support, and stale/low-quality filtering. |
| 0.2.0 | Minor feature | Setup and config editing | The web UI supports guided setup, agent selection, editable API key rows, config creation/editing, role presets, tiered onboarding, and product config forms. |
| 0.1.0 | Minor feature | Local web UI foundation | Added the local Content Scout web UI for setup, config editing, report browsing, social posts, run launching, and local server operation. |

### Validation

- Web UI unit tests pass locally and in GitHub Actions.
- CI installs both web UI dependencies and thumbnail renderer dependencies before running tests.
- PR #15 was merged with all required checks green.

### Operational Notes

- Before new feature work, sync from GitHub `main` and create a feature branch:

  ```powershell
  git switch main
  git fetch origin --prune
  git pull --ff-only
  git switch -c feature/<name>
  ```

- Do not accumulate feature work directly on local `main`; if `git pull --ff-only` fails, reconcile before coding.
