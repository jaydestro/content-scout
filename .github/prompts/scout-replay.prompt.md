# scout-replay

Re-apply Content Scout's filters, scoring, sentiment classification, and trajectory math against a previously-saved scan **without making any API calls**. Use to tune thresholds, reproduce historic runs, or test agent rule changes against a known input.

Ignore VS Code frontmatter and `${{input:...}}` placeholders — ask the user conversationally for inputs.

## Inputs

- **Report file** (required) — path to a previously-generated `reports/{YYYY-MM-DD-HHmm}-{slug}-content.md` OR its JSON sidecar.
- (optional) **Override flags**: `min_score`, `min_engagement_potential`, `relevancy_threshold`, `date_window_days`. If omitted, use the values currently in the config.

## Steps

1. **Load raw scan**:
   - Prefer the JSON sidecar (`*.json` next to the `.md`). It contains every item with full provenance.
   - If only the Markdown exists, parse the report tables back into items (best effort — note in output that some fields like raw_hash are unavailable).

2. **Re-apply quality filter** — date gate + relevancy gate + scoring rubric. Use the override flags if provided, else the config's current values.

3. **Re-classify sentiment** for conversation items using current rules and confidence thresholds.

4. **Recompute creator trajectories** as if the input scan were the most recent run, but write nothing to `reports/.scout-state/`. Replay is read-only.

5. **Diff vs. original** — produce a side-by-side comparison:

   | Metric | Original | Replay | Delta |
   |--------|---------|-------|------|
   | Items kept | … | … | … |
   | Items filtered out | … | … | … |
   | Avg engagement potential | … | … | … |
   | Sentiment positive / neutral / negative | … | … | … |
   | Creators classified `advocate` / `at-risk` / `detractor` | … | … | … |

6. **List items where the verdict changed**: items kept by original but dropped by replay (and vice versa), with the reason.

## Output

Save the replay diff to `reports/{YYYY-MM-DD-HHmm}-{slug}-replay.md` (and `.json` sidecar). Do **not** write to `.scout-state/` or `.seen-links.json`. Do **not** call any external API. If the input has no JSON sidecar and re-derivation is impossible, refuse and explain why.

## Anti-hallucination

Replay MUST NOT invent items that weren't in the input. If an item is missing key fields (e.g., raw body needed for sentiment re-classification), mark its replay verdict as `unknown` and explain — never guess.
