---
name: Content Scout
description: Discover, catalog, and promote public content about a product, technology, OSS project, or tool. Use when the user says "scout scan", "scout onboard", "scout post", "scout calendar", "scout trends", or asks to find/track/share content about their product.
---

# Content Scout (skill shim)

This skill is a thin pointer at the full Content Scout agent definition.
The single source of truth is [.github/agents/content-scout.agent.md](../../../.github/agents/content-scout.agent.md).

## How to use

1. Read [.github/agents/content-scout.agent.md](../../../.github/agents/content-scout.agent.md) for full operating instructions (sources, quality filters, report templates, social post standards, subagent architecture). Ignore its YAML frontmatter — that's for VS Code agent mode.
2. Read the active product config from `.github/prompts/scout-config-*.prompt.md`. If none exists, run onboarding first.
3. Check `.env` at the repo root for API keys before scanning. Skip sources whose keys are missing.

## Commands

| User says | Prompt file | What to do |
|-----------|-------------|------------|
| scout onboard | `.github/prompts/scout-onboard.prompt.md` | Interactive setup wizard |
| scout scan | `.github/prompts/scout-scan.prompt.md` | Search sources, filter, generate report |
| scout post | `.github/prompts/scout-post.prompt.md` | Generate social posts from URL or report item |
| scout calendar | `.github/prompts/scout-calendar.prompt.md` | Weekly posting schedule |
| scout trends | `.github/prompts/scout-trends.prompt.md` | Month-over-month comparison |

Ignore VS Code frontmatter and `${{input:...}}` placeholders in those prompt files — gather inputs conversationally.

## Output locations

- Reports: `reports/{YYYY-MM-DD-HHmm}-{slug}-content.md`
- Social posts (bulk from report): `social-posts/{YYYY-MM-DD-HHmm}-{slug}-social-posts.md`
- Social posts (solo / one-off from a single URL): `social-posts/{YYYY-MM-DD-HHmm}-{slug}-solo-{url-slug}.md` where `{url-slug}` = host + last path segment, lowercased, hyphenated, max 40 chars (fallback `solo-link`)
- Calendars: `social-posts/{YYYY-MM-DD-HHmm}-{slug}-posting-calendar.md`
- Trends: `reports/{YYYY-MM-DD-HHmm}-{slug}-trends.md`
- Dedup tracker: `reports/.seen-links.json`

## Key rules

1. Always read the active product config before any operation.
2. Always check `.env` for API keys before scanning.
3. Apply the content quality filter strictly (date gate + relevancy gate + score ≥ 5/9).
4. Deduplicate against `reports/.seen-links.json`.
5. Number items sequentially; tag with canonical topic tags from config.
6. Update `.seen-links.json` after saving a report.
7. Auto-generate social posts only if the active role has them enabled.
