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

## Reporting Issues

Open an issue if:
- A source is consistently unreachable or returns bad data
- The quality filter is too aggressive or too permissive
- Social posts violate the style guidelines
- Onboarding is missing a question that should be there
- The report format needs a new section or column
