# Contributing to Content Scout

Contributions are welcome. Content Scout is a prompt-based agent — the "code" is the agent definition and prompt files in `.github/`. Adapter files for other tools (`CLAUDE.md`, `.cursor/rules/`, `.windsurfrules`, `.clinerules`) are thin wrappers that point to the same agent definition.

## How to Contribute

1. **Fork the repo** and create a feature branch
2. **Make your changes** to agent or prompt files
3. **Test locally** by running the agent in your preferred AI coding tool with a test product config
4. **Open a PR** with a clear description of what changed and why

## What to Contribute

- **New source integrations** — scanning logic for platforms not yet covered
- **Quality filter improvements** — better scoring heuristics, fewer false positives/negatives
- **Social post templates** — new framing angles, platform-specific formatting
- **Onboarding improvements** — better defaults, smarter suggestions, smoother interview flow
- **Subagent definitions** — standalone agent files for the subagent architecture
- **Tool adapters** — instruction files for AI coding tools not yet supported
- **Bug fixes** — if the agent produces incorrect output, broken reports, or bad dedup behavior

## Guidelines

- Keep agent and prompt files readable — they're specs, not code. Clarity matters.
- The agent definition in `.github/agents/content-scout.agent.md` is the single source of truth. Make core changes there, not in adapter files.
- Adapter files (`CLAUDE.md`, `.cursor/rules/content-scout.mdc`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`) should only contain tool-specific configuration and a reference to the agent definition.
- Test with at least one product config before submitting.
- Don't add integrations requiring external services beyond what's already supported without discussion first.
- Follow the existing file structure and naming conventions.
- PR descriptions should explain the *why*, not just the *what*.

## Don't commit personal info

Content Scout is designed so each user's customization stays on their own machine. Before opening a PR, double-check that none of the following has been added to a tracked file:

- Real names, email addresses, internal handles, or tenant / subscription IDs
- Per-product team-member lists (use `.github/team-members.md` — gitignored — and ship only the `.example` template)
- Anything from `.env` (gitignored), `reports/`, `social-posts/`, `tools/_scratch/`, `tools/one-shot-scan/`, `tools/mindshare-feed/`, `tools/browser-scan/.profile/`, or `tools/browser-scan/.cdp-profile/` — these paths are gitignored on purpose
- Per-product brand assets under `social-posts/images/brand/<slug>/` (also gitignored)

If you see a `.example` file in the repo, that's the shareable template — the un-suffixed version of the same file is local-only by design. Run `git status` and `git check-ignore -v <path>` before any commit that touches `tools/`, `.github/`, or `reports/`.

### Local config survives branch switches and merges

Git only tracks files it knows about. Anything covered by `.gitignore` (your `.env`, `.github/team-members.md`, `.github/prompts/scout-config-<your-slug>.prompt.md`, `reports/*.md`, `social-posts/*.md`, `tools/one-shot-scan/`, `tools/mindshare-feed/`, browser-scan profile dirs, etc.) lives in your working tree but never in any branch. That means:

- `git checkout <other-branch>` leaves your local config files exactly where they are.
- `git merge` / `git rebase` / `git pull` operate only on tracked files — your local files can't be overwritten or removed by them.
- You can freely work on a feature branch, merge it into `main`, and your `.env` + per-product config stay put on every branch.

Two things to avoid so the safety net holds:

- **Don't run `git clean -fX` or `git clean -fx`.** `-X` deletes ignored files; `-x` deletes everything untracked. Plain `git clean -fd` is safe (it only removes untracked, non-ignored files).
- **Don't run `git stash -a`.** It stashes ignored files too. `git stash` and `git stash -u` are fine; neither touches ignored paths.

Sanity check anytime with:

```
git check-ignore -v .env .github/team-members.md tools/one-shot-scan/scan.mjs
```

Every line should print the `.gitignore` rule that excludes it. A blank result means that file is *not* ignored and is at risk of being committed.

## Reporting Issues

Open an issue if:
- A source is consistently unreachable or returns bad data
- The quality filter is too aggressive or too permissive
- Social posts violate the style guidelines
- Onboarding is missing a question that should be there
- The report format needs a new section or column
