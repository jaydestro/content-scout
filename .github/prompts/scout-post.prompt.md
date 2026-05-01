---
description: Generate social media posts for LinkedIn and X from a URL or report item
mode: content-scout
---

# scout-post

Generate social media posts for LinkedIn and X. Follow all Social Post Standards from the product config. Produce at least 3 LinkedIn options and 3 X options, each with a different framing angle.

${{input:URL (required) -- this is the CTA link for the posts}}

${{input:Item number from report? (optional, e.g., "#3") Leave blank if providing a URL directly}}

${{input:Additional context? (optional) -- speakers, authors, key highlights, event info, video title, anything to emphasize}}

${{input:Which report? (optional) Leave blank for the latest, or specify month/year (e.g., "March 2026")}}

${{input:Platform preference? Leave blank for LinkedIn + X, or specify one (LinkedIn, X, YouTube)}}

${{input:Product? (optional) Leave blank if only one product is configured, or specify a product slug}}

## Product Resolution
1. If the user specified a product slug, load `scout-config-{slug}.prompt.md`.
2. If only one `scout-config-*.prompt.md` exists, use it automatically.
3. If multiple configs exist and no product was specified, infer from the URL or report. If still ambiguous, ask.

Use the URL as the CTA. If additional context is provided, prioritize it. If only a URL is given, fetch it and extract key details.

## Output File Naming

- **Bulk (from a report, no specific URL)**: `social-posts/{YYYY-MM-DD-HHmm}-{slug}-social-posts.md`
- **Solo (one-off from a single URL)**: `social-posts/{YYYY-MM-DD-HHmm}-{slug}-solo-{url-slug}.md`
  - `{url-slug}` = lowercased, hyphenated `host` + last meaningful path segment (drop `www.`, drop trailing slashes, strip query/fragment), max 40 chars.
  - Examples:
    - `https://youtube.com/watch?v=AbC123` → `youtube-com-watch-abc123`
    - `https://devblogs.microsoft.com/cosmosdb/announcing-vector-search/` → `devblogs-microsoft-com-announcing-vector-search`
    - `https://github.com/Azure/azure-cosmos-dotnet-v3/releases/tag/v3.50.0` → `github-com-v3-50-0`
  - If the URL slug would be empty, fall back to `solo-link`.

When multiple products are configured, always include the product `{slug}`. If only one product is configured, the `{slug}` segment is still included for consistency.

## Tuner Contract

The web UI and CLI may append a tuner block to the input in this exact form (all fields optional, in any order):

```
[tone: conversational|technical|enthusiastic|professional|playful|matter-of-fact]
[platforms: linkedin,x,bluesky,reddit]
[length: tease|standard|long]
[emoji: off|light|medium]
[hashtags: yes|no]
[mention-authors: yes|no]
[link-in-comments: yes|no]
[variants: 2..5]
```

Apply each tuner literally. Defaults if a tuner is absent: tone=conversational, platforms=linkedin,x, length=tease, emoji=light, hashtags=no, mention-authors=no, link-in-comments=no, variants=3.

### Length guidance

A social post is **not** a summary of the article — it's a hook that gets people to click. The linked content does the explaining. Do not over-describe.

- **tease** (default, preferred): 1–2 sentences. Convey what's new / what's to learn / why it matters, then hand off to the link. LinkedIn ≤ ~350 chars, X ≤ 220, Bluesky ≤ 240.
- **standard**: 3–5 sentences. One concrete detail or quote, then CTA. LinkedIn ≤ ~700 chars.
- **long**: LinkedIn-only, up to ~1300 chars. Use only when the user explicitly asks. Still avoid recapping the whole article — pick one angle and go deep.
- **Reddit** ignores `length` (see Reddit section below — always uses a self-post body).

A good post conveys **"there's something here to learn / something was just announced"**, not a play-by-play. If you find yourself writing a third paragraph of explanation, stop and trust the link.

### Mention-authors

When `mention-authors: yes`:

1. Identify the human(s) who created the linked content (post byline, video host, GitHub commit/PR author, podcast guest, talk speaker). Fetch the URL to confirm; do not guess.
2. Try to surface their public handle on the target platform (LinkedIn for LinkedIn posts, X handle for X, Bluesky handle for Bluesky). If you cannot confirm a handle, use their full name unmentioned (no fake `@`).
3. Phrase attribution to make clear **they** made the thing and you're amplifying it. Use phrasing like:
   - "via @author"
   - "@author shipped this"
   - "great write-up from @author"
   - "@author walks through …"
4. Never imply you co-authored, co-presented, or co-built the content. Never thank them for "letting us share" — they didn't.
5. If multiple authors, mention up to 2 by handle; for more, use "@author and team" or "@author + co-authors".

### Link-in-comments

When `link-in-comments: yes` (LinkedIn convention):

- Omit the URL from the post body.
- End the post with: `Link in the first comment 👇` (or equivalent — respect emoji setting).
- Add a second fenced block labeled `LinkedIn — first comment:` containing just the URL (and a one-line framing if useful).

### Emoji

- `off`: zero emoji.
- `light` (default): max 1 emoji per post, only if it adds meaning.
- `medium`: max 3 emoji per post. Never decorative-only.

### Hashtags

When `hashtags: no` (default), do not append hashtags. When `yes`, 1–3 relevant tags at end of post for LinkedIn/Bluesky; X gets 0–2 inline.

### Variants

Produce exactly the requested number of variants per platform, each with a distinct framing angle (e.g., problem-led, announcement-led, quote-led, contrarian, behind-the-scenes). Each variant goes in its own fenced ` ``` ` block so the UI can render a Copy button per variant.

### Reddit

Reddit is **not** another link-slap platform — but it's also not LinkedIn. The "link in first comment" pattern is a LinkedIn convention, **not** a Reddit one. On Reddit, link posts are normal in news/article subs (r/programming, r/technology, r/webdev, etc.); the link goes either in the post URL field or inline in a self-post body. Pick the right shape per subreddit:

For each Reddit variant produce these labeled blocks:

1. **Suggested subreddits** — 2–4 subreddits where this content fits, with a one-line reason each. Pick from communities relevant to the product config's topic tags. Flag any sub with strict self-promotion rules (e.g., r/programming, r/webdev, r/javascript) so the user reads the rules first. Note for each whether it leans **link-post** or **self-post**.
2. **Format** — pick one and say why:
   - **Link post** — when the sub welcomes article submissions and the content is the point. The post is just title + URL; discussion happens in comments.
   - **Self-post** — when the sub bans/discourages link posts, when the user has genuine commentary to add, or when the content needs context to land (e.g., long video, dense doc).
3. **Title** — single line, no clickbait, no all-caps, no emoji unless `emoji: medium`. Frame as a curious/informative observation, not a sales line. Avoid leading with the product name unless it's genuinely the news. Keep under ~120 chars.
4. **Body** — required for self-post format; optional "OP context comment" for link-post format.
   - *Self-post body*: 2–6 short paragraphs in first person from the poster. Explain what they found, why it's worth the community's time, and one concrete takeaway or question to invite discussion. **Include the URL inline** (e.g., "Full write-up here: <url>") with a sentence of framing around it.
   - *Link-post OP context comment* (optional, recommended): a separate fenced block labeled `Reddit — OP context comment:` with 1–3 sentences explaining why you're sharing and (if applicable) disclosing affiliation. The link itself is already in the post — this comment is context, not the link.

Reddit-specific rules:
- Do **not** invent a "link in first comment" pattern. That's LinkedIn, not Reddit.
- If `link-in-comments: yes` is set, ignore it on Reddit and add a one-line note in the variant explaining why (Reddit doesn't follow that convention).
- Hashtags are ignored on Reddit; do not add them even if `hashtags: yes`.
- Emoji are rare on Reddit; default to none even at `emoji: light`. Only honor `emoji: medium`, and even then sparingly.
- If the poster is affiliated with the content (works on the product, knows the author personally), say so in the body or OP context comment. Disclosure is a Reddit norm and rule in many subs.
- If `mention-authors: yes`, credit the creator in the body ("@author from <site> wrote this up…") — not in the title.
- Never astroturf. Write as someone genuinely sharing, never as the product team unless the user has said they're the maintainer.
