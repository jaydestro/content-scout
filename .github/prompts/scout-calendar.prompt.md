---
description: Generate a weekly posting calendar from a content report or existing social-post drafts
mode: agent
---

# Create Posting Calendar

Generate a weekly posting schedule that spreads content across platforms and days.

${{input:Which report? Leave blank for the latest, or specify month/year (e.g., "March 2026")}}

${{input:How many weeks to plan? (default: 2)}}

${{input:Product? (optional) Leave blank if only one product is configured, or specify a product slug}}

## Product Resolution
1. If the user specified a product slug, load `scout-config-{slug}.prompt.md`.
2. If only one `scout-config-*.prompt.md` exists, use it automatically.
3. If multiple configs exist and no product was specified, ask which product (or "all" for a combined calendar).

## Source Selection

A calendar can be built from two kinds of source. Pick the one that fits what
the user asked for; when ambiguous, prefer existing drafts (Source B) since
those posts are already written and ready to schedule.

### Source A — Content report (derive new schedule)
Use when the user points at a report, asks to "plan from the latest scan," or
no drafted posts exist for the period. Read the report, select the best items,
and lay them out across days/platforms. The calendar references report items;
the actual post copy is drafted later via `/scout-post`.

### Source B — Existing social-post drafts (schedule what's written)
Use when the user says "based on social posts," "schedule my drafts," "use the
posts I already have," or when ready-to-post drafts exist for the window. These
live in `social-posts/` for the resolved slug:
- `{stamp}-{slug}-social-posts.md` — bulk drafts (one `## Item N — Title` per
  topic, each with `### LinkedIn` and `### X / Bluesky` variants).
- `{stamp}-{slug}-solo-*.md` — one-off drafts from a single URL.

Steps for Source B:
1. Collect the relevant draft files for the slug. Default to the most recent
   batch(es) that cover the requested weeks; if the user named a month, match
   that month's drafts.
2. Parse each `## Item` (and each solo file) into schedulable units, noting
   which platform variants exist (LinkedIn, X, Bluesky, etc.).
3. Spread the drafted posts across the requested weeks, honoring the config's
   posting frequency, platform mix, and days/times to avoid. Do not invent new
   post copy — schedule the drafts that exist. If there are more slots than
   drafts, leave the surplus slots open (or suggest topics) rather than
   fabricating posts.
4. For each scheduled slot, link back to the source draft file and the specific
   item/section so the user can copy the final text.

Create the calendar in `social-posts/` using per-product naming
(`{YYYY-MM-DD-HHmm}-{slug}-posting-calendar.md`) when multiple products are
configured. Note the source kind (report vs. drafts) and the source file(s) in
the calendar header.

