# Design System — production-grade direction

This branch (`production-grade-ux`) moves Content Scout away from "demo polish"
(big indigo→pink gradients, oversized hero cards, decorative shadows) toward a
**calm, dense, signal-first** UX inspired by Datadog and other operational
tools that real people use all day without fatigue.

## North-star principles

1. **Calm by default, color = signal.** The interface is mostly neutral
   slate/gray surfaces with near-black text. Color appears only when it
   means something: a primary action, a status (ok / warn / err), or an
   active selection. No decorative gradients.
2. **Information density.** Tighter line-heights, smaller paddings, real
   tables when data is tabular. The user came here to see information,
   not to be wowed by hero cards.
3. **One accent.** A single brand blue (`--accent`) is the only "brand"
   color, used for primary buttons, focus rings, active nav, and links.
   Status (green/amber/red) is independent and reserved for state.
4. **Typography does the work.** Weight + size hierarchy replaces
   gradients and shadows. Mono font for numbers, IDs, and timestamps so
   they line up and read as data.
5. **Predictable surfaces.** Two surface levels (page bg, panel) plus
   one elevated state (hover/menu). No more than two border radii.
6. **Keyboard first.** Cmd-K palette is already the spine; every view
   exposes its actions through it. Hotkeys: `?` help, `g d` go
   dashboard, `g c` conversations, `g r` reports, `g s` social,
   `[` / `]` prev/next, `Esc` close drawers.

## Color tokens (light)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#f7f8fa` | Page background |
| `--panel` | `#ffffff` | Card / panel |
| `--panel-2` | `#f1f3f7` | Subtle inset, table stripe |
| `--border` | `#e3e6ec` | Default border |
| `--border-strong` | `#c8cdd6` | Emphasized border |
| `--text` | `#1a1f2c` | Primary text |
| `--muted` | `#5b6472` | Secondary text |
| `--accent` | `#3263d6` | Primary, links, focus, active |
| `--accent-strong` | `#1f47a3` | Hover / pressed |
| `--ok` | `#16a34a` | Success / green |
| `--warn` | `#b45309` | Warning / amber |
| `--err` | `#b91c1c` | Error / red |

## Color tokens (dark)

| Token | Value |
|---|---|
| `--bg` | `#0b0e14` |
| `--panel` | `#11151d` |
| `--panel-2` | `#161b25` |
| `--border` | `#222a39` |
| `--text` | `#e5e9f0` |
| `--muted` | `#8a93a4` |
| `--accent` | `#6e8fe6` |

## What's getting killed

- Indigo→pink decorative gradient (hero h2, stat numbers, banner title,
  KPIs, empty banners, primary buttons).
- Oversized hero card with radial glow. Replaced by a single-line
  context bar.
- Multiple competing shadow depths. One subtle shadow only.
- Pill-shaped chunky buttons. Smaller, square-cornered, 32px height.
- Decorative blur/glass on the header.

## What stays

- Sidebar/top-nav structure (incremental work for later).
- All current commands and flows.
- Cmd-K palette.
- `#run-output` and `.markdown pre` keep a dark terminal look in both
  themes — that's signal, not decoration.

## Implementation

A new layer `theme-datadog.css` loads **last** in the cascade and is the
single source of truth for the new visual direction. It overrides
`theme-presentation.css` rules where needed without modifying the older
demo layer — keeps the diff legible and revertible.

Future phases will fold the demo layers into the new system and delete
them.

## Chat / agent tone

The agent (CLAUDE.md, copilot-instructions.md) keeps its existing rules
but tightens output:
- Default to 1–3 sentence answers.
- No section headers for short responses.
- No emoji.
- File links use the workspace-relative markdown link format already
  required by the instructions.
