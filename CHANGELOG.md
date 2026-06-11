# Changelog

All notable changes to Content Scout are tracked here.

This project uses a product changelog version stream until formal release tags are cut. Minor feature releases use `0.x.0`; major fix bundles also receive their own `0.x.0` entry so every important fix has a durable version number.

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
