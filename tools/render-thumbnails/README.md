# render-thumbnails

Renders PNG thumbnails from the `**Thumbnail:**` spec blocks in any
Content Scout social-posts markdown file. No headless browser, no AI image
service — pure deterministic Node + [sharp](https://sharp.pixelplumbing.com/)
+ SVG.

## What it does

1. Reads a social-posts markdown file (newest under `social-posts/` by default).
2. Finds every block that looks like:

   ```markdown
   **Thumbnail:**

   | Property | Value |
   |----------|-------|
   | Platform | LinkedIn (1200x1200 square) |
   | Background | Dark (#1a1a2e) |
   | Logo | Cosmos DB logo (top-left) |
   | Headline | "Priority-Based Throttling" |
   | Subtext | "Azure Cosmos DB for NoSQL" |
   | Accent | #0078D4 |
   | Save path | `social-posts/images/2026-03/1-linkedin-priority-throttling.png` |
   ```

3. Composes a PNG at the platform size with:
   - Solid background (from `Background`, dark fallback).
   - Brand logo top-left (only if a real PNG exists in `social-posts/images/brand/<slug>/` or in the spec's `Logo` field — never invented).
   - Headline centered in `Segoe UI Semibold`.
   - Optional subtext below the headline.
   - Accent color bar across the bottom.
4. Writes the file to the `Save path` from the spec, creating directories as needed.

## Install

```pwsh
cd tools\render-thumbnails
npm install
```

`sharp` ships native binaries — no extra setup needed on Windows / macOS / Linux.

## Use

```pwsh
# Auto-pick the newest social-posts/*.md
node index.js

# Specific file
node index.js social-posts/2026-04-30-1425-azure-cosmos-db-social-posts.md

# Parse only, no PNGs written
node index.js --dry-run social-posts/2026-04-30-1425-azure-cosmos-db-social-posts.md
```

## Notes

- Platform sizes are auto-derived from the `Platform` cell. Recognized keywords:
  `linkedin`, `linkedin-square`, `linkedin-landscape`, `x` / `twitter`,
  `bluesky`, `youtube` / `youtube-community`. An explicit `1200x675` in the cell
  overrides the keyword.
- If no logo is found anywhere on disk, the renderer falls back to a text-only
  layout (the agent's brand-fidelity rule: never fabricate a logo).
- Output paths are taken from the spec's `Save path` row. If absent, files land
  in `social-posts/images/<source-basename>/auto.png`.
