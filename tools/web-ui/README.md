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

## First run

If you have no configs yet, the UI opens on the **Setup** view automatically. From there:

1. **Pick an agent** — choose the AI CLI that should execute Scout commands: Claude Code, GitHub Copilot CLI, OpenAI Codex, a custom command, or *None* (copy prompts manually). Your choice is saved to `tools/web-ui/.scout-web-settings.json` (gitignored).
2. **Create a config** — either run the onboarding wizard inside your editor's chat panel, use the standalone CLI at `tools/onboard-cli`, or click **Run /scout-onboard now** once you've picked an agent.
3. **Add API keys** — optional. Copy `.env.example` to `.env` at the repo root and fill in the sources you want.

## Agent presets

| Agent | Built-in command | Install |
|---|---|---|
| Claude Code | `claude -p "{prompt}"` | https://docs.anthropic.com/en/docs/claude-code/overview |
| GitHub Copilot CLI | `copilot -p "{prompt}"` | https://docs.github.com/en/copilot/github-copilot-in-the-cli |
| OpenAI Codex CLI | `codex exec "{prompt}"` | https://github.com/openai/codex |
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
