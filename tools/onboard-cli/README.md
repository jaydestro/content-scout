# Content Scout — onboarding CLI

An **arrow-key TUI** alternative to the chat-based `/scout-onboard` flow. Same output: writes `scout-config-{slug}.prompt.md` and optional `.env` entries at the repo root.

## Install & run

From the repo root:

```bash
cd tools/onboard-cli
npm install
npm start
```

Or run without installing globally:

```bash
npx --prefix tools/onboard-cli scout-onboard
```

## Controls

- **Up / Down** — move between choices
- **Space** — toggle in multi-select lists (networks, custom features)
- **Enter** — confirm
- **Ctrl+C** — cancel at any time

## What it produces

- `.github/prompts/scout-config-{slug}.prompt.md` — the product config the agent reads on every command
- `.env` — updated in place (or created from `.env.example`) with any API keys you entered

Existing configs are never silently overwritten — the CLI asks before replacing.

## What it does not do

This CLI covers the **essentials** for Quick and Standard tiers (role, product identity, networks, API keys, search terms, hashtags). For the full depth of the chat-based onboarding (brand assets, social post standards, conference CFPs, competitor lists, exclusions, team member tracking), edit the generated config file directly or run `/scout-onboard` in chat to pick up where the CLI left off.

## Requirements

- Node.js 18 or later
