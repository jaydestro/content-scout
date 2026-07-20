# Content Scout web UI

A local dashboard for Content Scout. Run it alongside your editor to onboard new
subjects, browse configs, view reports, edit feature toggles, manage `.env` API
keys, and launch scans / custom searches from a browser.

## What it does

- **Setup / onboarding wizard** — a 9-step in-browser wizard that creates a
  `scout-config-{slug}.prompt.md` directly. Steps:
  1. **Agent** — pick which AI chat/headless runner executes Scout prompts
     (Claude Code, Copilot, Codex, custom, or *None* / copy-paste).
  2. **Setup tier** — Quick (3 questions), Standard, or Full.
  3. **Subject** — name, slug, type (product / technology / project / tool).
     Existing subjects show at the top so you can add another or remove one.
     ✨ Suggest fills brand / SPS / posting / language defaults from a curated
     map of well-known subjects (Azure Cosmos DB, Azure Functions, Lambda,
     Kubernetes, .NET, etc.).
  4. **Roles** — single role or merge several.
  5. **Search** *(Standard + Full)* — terms, excluded channels, topic tags.
  6. **Networks** *(Standard + Full)* — which social networks the subject
     posts to.
  7. **Advanced** *(Full)* — competitors, conferences, watchlist topics,
     influencers (with affiliation/handle), team members, custom sources,
     posting cadence and approval workflow.
  8. **API keys** — edit `.env` directly. Starts empty; click **+ Add custom
     key** to add one. Existing keys load for editing.
  9. **Review & save** — summary view; **Save config** writes the file and
     auto-redirects to the dashboard.
- **Dashboard** — configs, recent reports, recent runs, and `.env` key status
  at a glance.
- **Configs** — pick a config and edit role flags, search terms, excluded
  channels, topic tags, and social-post toggles; save with one click. Chips
  for selected/suggested options have a × to remove them inline.
- **Run** — launch `/scout-scan`, `/scout-post`, `/scout-calendar`,
  or a custom prompt against **All subjects**
  or any individual subject. Output streams live via server-sent events.
- **Reports** — browse and render every file in `reports/`, split across
  **Full Report / Mindshare / CFPs & Events / Roundup** tabs. The Roundup tab
  regenerates a monthly content index in place (month picker + **Generate
  monthly roundup** button).
- **Tools** — **SEO** audits, an **Originality** review (AI-writing signals +
  a verbatim-overlap check against official docs), and a free-form **Ask** box.
  Dated outputs land in a browsable list.
- **Social posts** — browse and render every file in `social-posts/`.

You can still run `/scout-onboard` inside your editor's chat — both paths
produce the same `scout-config-{slug}.prompt.md` file and the UI picks it up
either way.

## Install & start

Requires Node.js 22.13 or later. Content Scout uses the built-in `node:sqlite`
module, so no database server, credentials, or native database package is
required.

```
cd tools/web-ui
npm install
npm start
```

Then open http://localhost:4477.

On first start, the server creates `.local/state/content-scout.db`, applies
schema migrations, and imports existing `reports/` and `social-posts/`
Markdown files. Import is idempotent and never deletes the source files.

Storage recovery and portability commands run from the repository root:

```powershell
node tools/storage.mjs status
node tools/storage.mjs import
node tools/storage.mjs verify
node tools/storage.mjs backup
node tools/storage.mjs restore --input .local/state/backups/content-scout-<timestamp>.db
node tools/storage.mjs export --output .local/exports/latest
node tools/storage.mjs retention
```

Retention is a dry run unless `--apply` is passed. It may prune old run history,
backups, and aged raw browser captures according to explicit limits; reports,
social drafts, configs, and generated images are always protected.

Change the port with `PORT=5000 npm start`.

The server sends `Cache-Control: no-store` for HTML/JS/CSS so a normal
browser reload always shows the latest UI — no hard reload needed.

## First run

If you have no configs yet, the UI opens on the **Setup** view automatically.
You have two paths:

- **In-browser wizard** *(recommended)* — Click through the 9-step wizard
  above. Save creates the config and drops you on the dashboard.
- **Editor wizard** — Run `/scout-onboard` in your editor's chat panel; the
  web UI picks the new config up as soon as it's saved.

Either way, API keys can be added on Step 8 of the wizard or by editing
`.env` at the repo root directly.

## Agent presets

| Agent runner | Built-in command | Install |
|---|---|---|
| Claude Code | `claude -p "{prompt}"` | https://docs.anthropic.com/en/docs/claude-code/overview |
| GitHub Copilot runner | `copilot -p "{prompt}"` | https://docs.github.com/en/copilot/github-copilot-in-the-cli |
| OpenAI Codex runner | `codex exec "{prompt}"` | https://github.com/openai/codex |
| Custom | any shell command with `{prompt}` placeholder | — |
| None | (disabled — copy prompt manually) | — |

### Override with an env var

`SCOUT_RUNNER` takes precedence over the saved choice. Useful for one-off sessions or CI:

```powershell
$env:SCOUT_RUNNER = 'claude -p "{prompt}"'; npm start
```

When `SCOUT_RUNNER` is set, the Setup view shows the locked value and disables the picker.

## Security notes

- Binds to `localhost` only. Do not expose to the network without adding auth.
- The runner command is executed via `spawn(..., { shell: true })` — it runs arbitrary commands. Only use trusted values.
- Config edits overwrite files in `.github/prompts/`. Commit changes you want to keep.
