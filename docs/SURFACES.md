# Surfaces — Agent vs. Web UI

Content Scout has **two surfaces** by design. There is no separate CLI tool.

## Quick rule

- **Standard operations → agent.** If it produces a report, social post, or
  config — use a `/scout-*` slash command in your editor (VS Code, Claude Code,
  Cursor, Windsurf, Cline, Copilot CLI).
- **Advanced / visual operations → web UI.** If it's a dashboard, a bulk
  operation, or needs drag-drop — use `tools/web-ui` at <http://localhost:4477>.

That's it. Pick the surface that fits the task.

## The split

### Agent (standard, single-shot, content-creating)

Every value-creating operation has a slash command:

| Command | Purpose |
|---------|---------|
| `/scout-onboard` | Set up a new product, technology, or project |
| `/scout-scan` | Scan all sources, filter, generate a report |
| `/scout-post` | Generate social posts from a URL or report item |
| `/scout-calendar` | Build a weekly posting schedule |
| `/scout-gaps` | List topics with no recent coverage |
| `/scout-trends` | Compare month-over-month |
| `/scout-creators` | View creator trajectories, log interventions |
| `/scout-seo` | SEO audit + recommendations for a URL |
| `/scout-replay` | Re-apply filters/scoring to a saved scan (no API calls) |
| `/scout-doctor` | Validate config, `.env`, source reachability |
| `/scout-keys` | Add/fix API credentials (sub-flow of `/scout-doctor`) |
| `/scout-vision` | Configure the vision provider for alt text |
| `/scout-alt` | Generate alt text for an image |
| `/scout-reddit-import` | Manual Reddit ingest when automated layers are blocked |

Run them in your AI tool of choice. See [EDITORS.md](EDITORS.md) for per-tool
startup.

### Web UI (advanced, visual, bulk, real-time)

The web UI is **not** "the agent with buttons" — it owns capabilities that
chat can't do well:

- **Dashboards** — sentiment summary, source health, action items, authors
  view, items inventory. Best consumed visually.
- **Bulk operations** — multi-subject scan via CSV upload, bulk
  conversation close/reopen, bulk muted-account import.
- **Live run streaming** — real-time log panel for any `/scout-*` invocation
  (SSE). Useful for long scans where you want progress.
- **Visual triage** — conversations panel with bulk-select close/reopen;
  mentions browser; muted-accounts manager.
- **Drag-drop affordances** — image upload for alt text, CSV upload for
  bulk runs.
- **Guided pickers** — Ollama model browser with one-click pull; `.env`
  editor with per-key reachability tests.
- **Inline rendering** — Markdown reports and social-post bundles with
  embedded images, rendered in-page.
- **In-files search palette** — ⌘/Ctrl-K across `reports/` and
  `social-posts/` with snippet previews.
- **Browser-scan control panel** — Layer 0 launcher, login-status
  indicators per platform, on-demand re-scan.

These exist in the web UI **on purpose**. Don't try to port them to the
agent — they'd be worse there.

## Power-user CLIs (kept narrow)

A small handful of standalone scripts exist for power users and CI. They
are **not** a CLI surface; they're focused tools that the agent and the
web UI both delegate to:

- `node tools/browser-scan/index.mjs ...` — Layer 0 browser scan
- `node tools/conversations-cli.mjs ...` — close/reopen mentions
- `node tools/search.mjs <query>` — full-text grep across reports + posts
- `node tools/probe-sources.mjs` — source health probe
- `node tools/render-thumbnails/index.js` — image rendering for posts

If you find yourself wanting an umbrella CLI, that's a sign you should
either be in the agent (for content work) or the web UI (for triage and
dashboards).

## Decision log

- **2026-05-14** — Removed the `tools/scout-cli/` umbrella experiment.
  The agent already covers every content-creating operation, and the web
  UI owns everything that benefits from a screen. A third surface added
  maintenance cost without solving a real user problem.
