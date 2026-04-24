# Content Scout web UI

A local dashboard for Content Scout. Run it alongside your editor to browse configs, view reports, edit feature toggles, and launch scans / custom searches from a browser.

## What it does

- **Dashboard** — configs, recent reports, recent runs, and `.env` key status at a glance
- **Configs** — pick a config (`scout-config-{slug}.prompt.md`) and edit role flags, search terms, excluded channels, topic tags, and social-post toggles; save with one click
- **Run** — launch `/scout-scan`, `/scout-post`, `/scout-calendar`, `/scout-gaps`, `/scout-trends`, or a custom prompt. Output streams live via server-sent events.
- **Reports** — browse and render every file in `reports/`
- **Social posts** — browse and render every file in `social-posts/`

New configs are still created by running `/scout-onboard` in your editor (VS Code Copilot Chat, Claude Code, Cursor, etc.) or the standalone CLI at [`tools/onboard-cli`](../onboard-cli/) — the web UI picks them up as soon as they're saved.

## Install & start

```
cd tools/web-ui
npm install
npm start
```

Then open http://localhost:4477.

Change the port with `PORT=5000 npm start`.

## Connecting it to an AI runner

The web UI can actually execute `/scout-*` commands if you point it at a CLI that talks to a model. Set `SCOUT_RUNNER` to a command line with `{prompt}` as a placeholder:

| Runner | `SCOUT_RUNNER` value |
|---|---|
| Claude Code (default) | `claude -p "{prompt}"` |
| GitHub Copilot CLI | `gh copilot suggest -t shell "{prompt}"` |
| Custom script | `./my-runner.sh "{prompt}"` |

PowerShell:
```powershell
$env:SCOUT_RUNNER = 'claude -p "{prompt}"'; npm start
```

If `SCOUT_RUNNER` is empty, the **Start run** button is disabled and the UI shows a "Copy prompt" button instead — paste the prompt into your editor's chat panel manually.

## Security notes

- Binds to `localhost` only. Do not expose to the network without adding auth.
- `SCOUT_RUNNER` is executed via `spawn(..., { shell: true })` — it runs arbitrary commands. Only use trusted values.
- Config edits overwrite files in `.github/prompts/`. Commit changes you want to keep.
