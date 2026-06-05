# Content Scout — Editor & Chat Setup

Content Scout works in any AI coding tool that supports custom instructions. The agent definition lives in [`.github/agents/content-scout.agent.md`](../.github/agents/content-scout.agent.md) — each tool gets a thin adapter file that points to it. Zero duplication.

## Supported tools

| Tool | Instruction file | How it loads |
|------|-----------------|-------------|
| **VS Code Copilot** | `.github/agents/content-scout.agent.md` | Switch to Content Scout agent mode |
| **Claude Code** | `CLAUDE.md` | Auto-loaded when you open the repo |
| **GitHub Copilot terminal chat** | `.github/copilot-instructions.md` | Auto-loaded by the Copilot chat runner |
| **Cursor** | `.cursor/rules/content-scout.mdc` | Auto-loaded as project rules |
| **Windsurf** | `.windsurfrules` | Auto-loaded when you open the repo |
| **Cline** | `.clinerules` | Auto-loaded when you open the repo |

## Commands (slash or natural language)

| VS Code | Other tools |
|---------|-------------|
| `/scout-onboard` | "scout onboard" |
| `/scout-scan` | "scout scan" |
| `/scout-post` | "scout post" |
| `/scout-calendar` | "scout calendar" |
| `/scout-gaps` | "scout gaps" |
| `/scout-trends` | "scout trends" |
| `/scout-creators` | "scout creators" |
| `/scout-doctor` | "scout doctor" |
| `/scout-keys` | "scout keys" |
| `/scout-seo` | "scout seo" |
| `/scout-reddit-import` | "scout reddit-import" |
| `/scout-alt` | "scout alt" |
| `/scout-vision` | "scout vision" |

## Per-tool startup

### VS Code

Prerequisites: GitHub Copilot + Copilot Chat extensions, an active Copilot subscription, VS Code 1.90+.

```
code .
```

The repo ships a `.vscode/settings.json` that enables Copilot prompt files and agent mode for this workspace — VS Code will ask you to **Trust the authors** the first time you open the folder.

1. Open the **Copilot Chat panel** with `Ctrl+Alt+I` (the slash picker only appears here, not in inline `Ctrl+I`)
2. Set the chat mode dropdown to **Agent**
3. Switch the agent picker to **Content Scout**
4. Type `/` — `/scout-onboard`, `/scout-scan`, etc. should appear
5. Run `/scout-onboard`, then `/scout-scan`

### Claude Code

```
claude
```

Run from inside the `content-scout` folder. Say "scout onboard". `CLAUDE.md` loads automatically.

### Cursor / Windsurf / Cline

Open the `content-scout` folder as the workspace root, then say "scout onboard". The matching rules file loads automatically.

### GitHub Copilot terminal chat

```
gh copilot
```

Run from inside the `content-scout` folder. Say "scout onboard".

## Troubleshooting

### VS Code

If `/scout-onboard` doesn't appear when you type `/` in Copilot Chat:

1. **Copilot installed & signed in?** Install the **GitHub Copilot** and **GitHub Copilot Chat** extensions and sign in. The status bar Copilot icon should not show a warning.
2. **Using the Chat panel, not inline chat?** Slash commands only appear in the dedicated Chat panel (`Ctrl+Alt+I`), not in the inline `Ctrl+I` box.
3. **Chat mode set to Agent?** The dropdown at the top of the chat panel must say **Agent** (not Ask or Edit).
4. **Prompt files enabled?** Open settings (`Ctrl+,`), search for `chat.promptFiles`, and make sure it's checked. Also verify `chat.agent.enabled` is on.
5. **Correct folder open?** You must open the `content-scout` folder itself (not a parent or subfolder). Verify from a terminal: `Get-ChildItem .github\prompts` should list `scout-onboard.prompt.md`.
6. **VS Code up to date?** Prompt files and agent mode require VS Code 1.90 or newer.

### Claude Code

- Make sure you ran `claude` from inside the `content-scout` folder. Claude Code only auto-loads `CLAUDE.md` from the current working directory.
- Confirm the file exists: `Get-ChildItem CLAUDE.md`.

### Cursor

- Open the `content-scout` folder as the workspace (File → Open Folder), not a parent directory. Project rules in `.cursor/rules/` only apply when the repo is the workspace root.
- Check **Settings → Rules for AI → Project Rules** — `content-scout.mdc` should be listed.

### Windsurf

- Open the `content-scout` folder as the workspace root. `.windsurfrules` only loads for the top-level workspace.
- Restart Windsurf after opening the folder if rules don't apply on the first message.

### Cline

- `.clinerules` only loads for the workspace root — open `content-scout` itself, not a subfolder.
- In the Cline side panel, verify it shows the rules file as active.

### GitHub Copilot terminal chat

- Sign in: `gh auth status` — if not authenticated, run `gh auth login`.
- Install the extension if needed: `gh extension install github/gh-copilot`.
- Run `gh copilot` from inside the `content-scout` folder.
