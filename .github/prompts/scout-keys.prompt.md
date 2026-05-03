---
mode: agent
agent: content-scout
description: "Interactive setup for API credentials in .env (Reddit, Bluesky, X, YouTube, GitHub)"
---

# Content Scout — Credential Setup

Interactively walk the user through obtaining and saving API credentials to `.env`. This prompt is the agent equivalent of "go fill in your `.env`" — it handles validation, safe writes, and post-save reachability verification.

Ignore VS Code frontmatter. Ask the user conversationally.

## Inputs

- (optional) Provider name: `reddit | bluesky | x | youtube | github | all`. If omitted, ask: "Which provider? (reddit / bluesky / x / youtube / github / all)"

## Steps

1. **Read `.env`** at workspace root. If missing, create it with a header comment block. Capture current values (do NOT print secrets — only show length + first/last 2 chars masked, e.g. `AI***xQ (len=39)`).

2. **For each requested provider**, follow the matching sub-flow below. Always:
   - Tell the user where to obtain the credential (URL + click path).
   - Ask them to paste the value(s). For multi-field providers (Reddit), prompt for each field on its own turn so secrets aren't pasted in bulk.
   - **Validate format** before writing. Reject obviously bad values and re-ask.
   - **Write to `.env`** by replacing the existing line if present, or appending to a `# Content Scout — API keys` section if not. Preserve all other lines, comments, and ordering. Never delete or rewrite unrelated keys.
   - After writing, run a single reachability check (the same one `scout-doctor` uses). Report ✅ / ❌ with the response status. On failure, leave the value in `.env` but warn the user.

> **Tip — when the web UI is running:** the same validation + reachability logic is exposed at `POST http://localhost:4477/api/env/test` with body `{ key, value, extras?: { OTHER_KEY: "..." }, liveTest?: true }`. You can call that endpoint instead of hand-rolling each check below; it returns `{ format: {ok,message}, reachability: {reachable,status,message} }`. The hand-rolled curl/HTTP recipes below stay authoritative when the UI isn't running.

### Reddit (script-type OAuth app — OPTIONAL)

> Reddit needs **no credentials** by default. The cascading no-auth scanner (old.reddit RSS → HTML → Google PSE → manual import) handles unauthenticated access. Only collect these creds if the user has been approved for a Reddit OAuth app. If they got a "Responsible Builder Policy" denial, **skip this section** and offer to set up Google PSE (Layer 3) instead.

1. Direct user to https://www.reddit.com/prefs/apps → **create another app...** → choose **script** → name `content-scout` → redirect URI `http://localhost:8080`.
2. Ask for **Client ID** (the short string under the app name, ~14 chars, alphanumeric + dashes/underscores). Validate: 8–30 chars, no spaces.
3. Ask for **Client Secret** (~27 chars). Validate: ≥20 chars, no spaces.
4. Ask for the user's Reddit username (used to build the user agent string per Reddit's API rules).
5. Write:
   ```
   REDDIT_CLIENT_ID=<id>
   REDDIT_CLIENT_SECRET=<secret>
   REDDIT_USER_AGENT=content-scout/1.0 by <username>
   ```
6. Reachability check: POST `https://www.reddit.com/api/v1/access_token` with HTTP Basic auth (`client_id:client_secret`) and form body `grant_type=client_credentials`. Expect 200 + `access_token` field. On 401, the most common cause is a swapped id/secret — offer to re-enter.

### Google Programmable Search Engine (Reddit Layer 3 — OPTIONAL)

> Enables Reddit Layer 3 — catches threads in subreddits the user didn't list. Free tier = 100 queries/day. Skip if the user only wants the no-auth defaults.

1. Direct user to https://console.cloud.google.com/apis/credentials → **Create credentials** → **API key**. Then enable **Custom Search API** at https://console.cloud.google.com/apis/library/customsearch.googleapis.com.
2. Direct user to https://programmablesearchengine.google.com/ → **Add** → set **Sites to search** to `reddit.com/*` → **Create**. Copy the **Search engine ID** (looks like `xxxxxxxxxxxx:yyyyyyyyyyy`).
3. Ask for **GOOGLE_PSE_KEY**. Validate: starts with `AIza`, length 39, alphanumeric + `-_`.
4. Ask for **GOOGLE_PSE_CX**. Validate: 10–40 chars, alphanumeric + `:` + `-` + `_`. Format hint: contains `:` or is purely alphanumeric.
5. Write:
   ```
   GOOGLE_PSE_KEY=<key>
   GOOGLE_PSE_CX=<cx>
   ```
6. Reachability: GET `https://www.googleapis.com/customsearch/v1?key=<key>&cx=<cx>&q=test+site:reddit.com&num=1`. Expect 200 + `items` array (may be empty for an obscure query — only the 200 matters). On 403, either the Custom Search API isn't enabled or the daily quota is exhausted; link them to the library page.

### Bluesky (app password)

1. Direct user to https://bsky.app/settings/app-passwords → **Add App Password** → name `content-scout`.
2. Ask for **handle** (e.g., `you.bsky.social`). Validate: contains a `.`, no `@` prefix, no spaces.
3. Ask for **app password** (format `xxxx-xxxx-xxxx-xxxx`, exactly 19 chars including dashes). Validate strictly — Bluesky app passwords are not the user's main account password and must match this format. If they paste their main password, refuse and re-explain.
4. Write:
   ```
   BLUESKY_HANDLE=<handle>
   BLUESKY_APP_PASSWORD=<app-password>
   ```
5. Reachability: POST `https://bsky.social/xrpc/com.atproto.server.createSession` with `{identifier, password}`. Expect 200 + `accessJwt`. On 401, suggest the password may already be revoked (regenerate at the same URL).

### X (Twitter) — Bearer token

1. Direct user to https://developer.x.com/en/portal/dashboard → create a project + app (Free tier) → **Keys and tokens** tab → generate **Bearer Token**.
2. Warn upfront: X Free tier blocks most read endpoints. If the user can't get a paid tier, recommend they leave `X_BEARER_TOKEN` empty and remove `x` from `## Content Sources (scan order)` in their config instead. Confirm they want to proceed.
3. Ask for **Bearer Token**. Validate: starts with `AAAA`, length ≥ 100 chars, no spaces.
4. Write: `X_BEARER_TOKEN=<token>`.
5. Reachability: GET `https://api.x.com/2/users/me` with `Authorization: Bearer <token>`. Expect 200. On 401 the token is wrong; on 403 the Free tier is blocking the endpoint — note this is **expected** for Free tier and not a failure of the credential itself.

### YouTube — API key

1. Direct user to https://console.cloud.google.com/apis/credentials → **Create credentials** → **API key**. Then enable **YouTube Data API v3** at https://console.cloud.google.com/apis/library/youtube.googleapis.com.
2. Ask for **API key**. Validate: starts with `AIza`, length 39, alphanumeric + `-_`.
3. Write: `YOUTUBE_API_KEY=<key>`.
4. Reachability: GET `https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=<key>`. Expect 200 + `items[0].id == 'dQw4w9WgXcQ'`. On 403, the API isn't enabled on the project — link them to the library page.

### GitHub — Personal access token (optional, raises rate limit 60→5000/hr)

1. Direct user to https://github.com/settings/tokens?type=beta (fine-grained) or https://github.com/settings/tokens (classic). For Content Scout, only **public read** scope is needed: fine-grained → "Public Repositories (read-only)". Classic → no scopes (public-only).
2. Ask for **token**. Validate: starts with `github_pat_` (fine-grained) or `ghp_` (classic), length ≥ 40.
3. Write: `GITHUB_TOKEN=<token>`.
4. Reachability: GET `https://api.github.com/rate_limit` with `Authorization: token <token>`. Expect 200 + `resources.core.limit == 5000`. If `limit == 60`, the token wasn't accepted (treat as ❌).

## Safety rules

- **Never invent or guess credentials.** If the user says "I don't know" or "skip", move on; do not fabricate a placeholder.
- **Never echo a full secret back to the user.** When confirming, mask all but the first 2 and last 2 characters.
- **Never overwrite a non-empty key without confirming.** If the user has a value already and is replacing it, show the masked existing value and ask "Replace this with the new one? (yes/no)".
- **Never commit `.env`.** Verify `.gitignore` contains `.env` (or a pattern matching it) before writing. If not, refuse and tell the user to add it first.
- **Do not write keys to any file other than `.env`.** Reports, social posts, and prompt files must remain credential-free.

## Output

After all requested providers are processed, print a summary table:

| Provider | Status | Reachability |
|---|---|---|
| Reddit | written | ✅ 200 |
| Bluesky | unchanged | (not retested) |
| X | skipped | — |

Then suggest: "Run `scout doctor` to re-verify everything is green."
