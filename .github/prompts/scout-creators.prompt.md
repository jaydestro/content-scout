---
mode: agent
agent: content-scout
description: "View creator influence trajectories, log outreach interventions, and track sentiment changes over time"
---

# Creator Influence

Run the Content Scout agent in **Creator influence mode**. Operates on `reports/.scout-state/{slug}/creators.json` (see "Persistent Ecosystem State" in the Content Scout agent definition for schema and rules).

## Subcommands

The user invokes this with one of the following intents. Map natural language to a subcommand:

| User says | Subcommand | What to do |
|-----------|-----------|------------|
| "scout creators", "show creators", "influence movers", "who's rising" | `view` | Print Rising / Stable / Fading / Detractor Watch / Sentiment Movers / Advocates / Intervention Outcomes from the current state. |
| "scout creators rising", "who's growing", "rising influencers" | `view rising` | Just the Rising bucket. |
| "scout creators fading", "who's slowing down" | `view fading` | Just the Fading bucket. |
| "scout creators detractors", "show detractors", "who's frustrated" | `view detractors` | Detractor Watch + recent Sentiment Movers that flipped to negative. |
| "scout creators advocates", "show advocates" | `view advocates` | Advocates and recovered detractors. |
| "log intervention", "record outreach", "I reached out to X" | `log-intervention` | Append a new entry to the creator's `interventions[]` array. |
| "record outcome", "X improved after my outreach", "set intervention outcome" | `record-outcome` | Manually set the outcome on a previously-logged intervention. |
| "creator history for X", "show me X's profile", "who is @username" | `profile {handle}` | Print one creator's full record. |

## Instructions

1. **Resolve the topic.** Same rules as `scout-scan` — single config auto-loads; multiple configs require user to specify.
2. **Load state.** Read `reports/.scout-state/{slug}/creators.json`. If missing, tell the user: "No creator state yet for {slug}. Run `scout scan` at least once to build the influence dataset." Then stop.
3. **Run the subcommand.**

### `view` (default)

Render each subsection from the agent's report template (Rising / Stable / Fading / Sentiment Movers / Detractor Watch / Intervention Outcomes / Advocates) directly in chat. Cap at 10 rows per subsection. Sort each by 30d engagement descending unless noted otherwise in the agent definition. Exclude team members.

Do NOT write a new report file — this is an in-chat view only. The full Influence Movers section is regenerated as part of every `scout-scan`.

If the user asked for a specific bucket (`view rising`, `view detractors`, etc.), only render that subsection.

### `log-intervention`

Ask the user (in one message, batched) for any missing fields:
- Creator key — accept `platform:handle` (e.g., `reddit:somedev`) or just a display name and resolve from state. If multiple matches, list them and ask which one.
- `date` (default: today)
- `channel` (one of the values in the agent definition's intervention channel list)
- `url` (optional)
- `owner` (default: workspace user's name if known, else ask)
- `summary` (one line)
- `follow_up` — `wait-1w`, `wait-2w`, `wait-1m`, or `none` (default: `wait-2w`)

Append to `creators[key].interventions[]` with `outcome: null` and `outcome_recorded_at: null`. Save the file. Confirm to the user with the creator's current `sentiment_classification.current` so they know the baseline being measured against.

### `record-outcome`

Ask for:
- Creator key
- Which intervention (if multiple pending — list them by date and summary)
- `outcome` — `improved`, `no-change`, `worsened`, or `unreachable`
- Optional note (append to the intervention's `summary` after a `\n— outcome note: ...`)

Set `outcome` and `outcome_recorded_at` (now, ISO 8601 UTC). Save the file.

### `profile {handle}`

Print the creator's full record as a readable summary:
- Identity (display name, platform, handle, profile URL, first/last seen)
- Current `trajectory` and `sentiment_classification.current`
- Classification history (chronological with triggers)
- Last 5 posts with date / title / sentiment / engagement
- All interventions (date, channel, owner, summary, outcome)
- Totals (30d / 90d / all)

## Output

This command does NOT write report files. It either updates `creators.json` (for `log-intervention` / `record-outcome`) or prints a view to chat.

When the state file is updated, end the message with:
```
State updated: reports/.scout-state/{slug}/creators.json
```

When only viewing, end with a one-line summary like:
```
Showing {N} rising, {M} fading, {K} detractors, {I} pending interventions.
```
