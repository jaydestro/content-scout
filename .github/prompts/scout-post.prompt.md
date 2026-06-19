---
description: Generate social media posts for LinkedIn and X from a URL or report item
mode: agent
---

# scout-post

Generate social media posts for LinkedIn and X. Follow all Social Post Standards from the product config. Produce at least 3 LinkedIn options and 3 X options, each with a different framing angle.

> **Sub-flow — accessibility alt text.** If the user asks for alt text for a post image (or invokes `/scout-post --alt <image>`), follow `.github/prompts/scout-alt.prompt.md` end-to-end instead of the post-generation flow below. Output goes to `social-posts/{YYYY-MM-DD-HHmm}-{slug}-alt-{image-slug}.md`.

${{input:URL (optional) -- the CTA link for the posts. Leave blank if the link isn't live yet and you're drafting from raw copy}}

${{input:Item number from report? (optional, e.g., "#3") Leave blank if providing a URL or copy directly}}

${{input:Additional context or source copy? (optional if URL provided, REQUIRED if no URL) -- paste the announcement text, talk abstract, blog draft, key highlights, speakers/authors, event info, video title, etc.}}

${{input:Which report? (optional) Leave blank for the latest, or specify month/year (e.g., "March 2026")}}

${{input:Platform preference? Leave blank for LinkedIn + X, or specify one (LinkedIn, X, YouTube)}}

${{input:Product? (optional) Leave blank if only one product is configured, or specify a product slug}}

## Product Resolution & Config Caching

Load the product config **once at the start** and cache it in memory for all downstream steps.

1. If the user specified a product slug, load `scout-config-{slug}.prompt.md`.
2. If only one `scout-config-*.prompt.md` exists, use it automatically.
3. If multiple configs exist and no product was specified, infer from the URL, report, or supplied copy. If still ambiguous, ask.

**Cache the resolved config (branding rules, social standards, topic tags) throughout variant generation.** Do not re-read `scout-config-*.prompt.md` per variant. Reference the cached rules for brand name, tone defaults, hashtag policy, and platform defaults on every variant block.

## Source resolution

The user must provide **at least one** of: a URL, a report item number, or source copy/context. Resolve the source like this:

## Brand Naming Guardrail (hard requirement)

Before writing any post file, enforce product naming from the loaded product config's **Social Post Standards**.

For Azure Cosmos DB specifically:

- Canonical product name in post copy: **Azure Cosmos DB**
- Never emit these in post body copy: `CosmosDB`, `Azure CosmosDB`, bare `Cosmos` when referring to the product, or `vCore-based Azure Cosmos DB for MongoDB`
- Prefer `Azure Cosmos DB` in headlines and first mention, then keep using `Azure Cosmos DB` (do not shorten to `Cosmos DB` unless the user explicitly asks for shorthand)

Required pre-save QA pass (for every variant block):

1. Scan variant text for forbidden brand forms.
2. Replace forbidden forms with the canonical product name while preserving grammar.
3. Re-read the variant to ensure no malformed phrasing after replacements.
4. Only then write/save the output file.

1. **URL provided, link is live** — use it as the CTA link as-is (never shorten, never add tracking params). If additional context is provided, prioritize it. If only a URL, fetch it and extract key details.
2. **URL provided, but link is NOT live yet** — signaled by phrases like `(link not live yet — use copy below as source of truth, do not fetch the URL)` in the input, or an explicit user note that the URL isn't live. Use the URL **as the CTA in every post** exactly as supplied (this is its eventual home), but do **not** fetch it. Treat the provided copy/context as authoritative. At the very top of the output file, add a one-line callout:
   > ⚠️ Link not yet live. Verify `<url>` resolves before posting.
   File naming: `social-posts/{YYYY-MM-DD-HHmm}-{slug}-solo-{url-slug}.md` (same as live URL — the URL slug is known).
3. **No URL, copy provided ("no-link-yet" mode)** — the link doesn't exist yet at all. Do **not** fetch anything. Treat the provided copy/context as authoritative. In every post, use the literal token `{LINK}` everywhere a CTA URL would normally go (post body, link-in-comments block, Reddit body, etc.). At the very top of the output file, add a one-line callout:
   > ⚠️ Link not yet live. Replace every `{LINK}` placeholder with the public URL before posting.
   File naming: `social-posts/{YYYY-MM-DD-HHmm}-{slug}-solo-draft-{title-slug}.md` (the `solo-draft-` prefix signals no-URL mode; if a working title can be inferred from the copy, slugify a short form, max 40 chars; otherwise fall back to `solo-draft`).
4. **No URL, no copy, no item number** — refuse politely and ask for one.

In modes 2 and 3 the post content rules are unchanged — same tone, length, hashtag, mention-author, and platform tuners apply. The only differences are: no URL fetch, the warning callout at the top of the file, and (mode 3 only) the `{LINK}` placeholder.

## Refine mode (edit an existing post file inline)

### Picker entry point — `/scout-post update` (and synonyms)

When the user invokes any of these without naming a specific file:

- `/scout-post update` (or `/scout-post refine`, `/scout-post tweak`, `/scout-post adjust`)
- A bare chat message like "update the last posts", "refine those posts", "tweak my last social posts", "adjust the previous post file"

…**do not start editing yet.** First list the candidate files so the user can confirm which one to refine:

1. Find the most recent `social-posts/*.md` files (exclude `*-posting-calendar.md` and `*-alt-*.md`). Sort by mtime, descending. Show the top 5.
2. Render each as a numbered, clickable workspace-relative link with the slug, kind (solo / bulk / draft), and a relative timestamp (e.g., "2h ago", "yesterday").
3. If the currently open editor file matches one of those, mark it with "(open)" and recommend it as the default.
4. Ask one question: "Which file do you want to refine? Reply with a number, paste the path, or say 'new' to create a fresh one. Add your refinement notes on the same line or the next one."
5. Once the user picks, proceed with the refine flow below using `[refine: social-posts/<name>]`.

Skip the picker (go straight to refine) only when the user's message already names a specific `social-posts/*.md` file or already includes `[refine: ...]`.

### Refine flow

When the input contains `[refine: <relative-path>]` (e.g., `[refine: social-posts/2026-05-27-1430-azure-documentdb-solo-...md]`) **or** the user's chat message names an existing `social-posts/*.md` file and asks to refine / tweak / adjust / update those posts:

1. **Do not create a new file.** Read the named file, edit it in place, and preserve its existing structure (front matter, headers, variant ordering, file path, timestamp).
2. Treat the user's accompanying free-form text as additional context layered on top of the original tuners + product config. Apply globally across every variant unless the user names a specific platform/option.
3. If the user supplies new tuner values in the same input (any of the `[tone: ...]` / `[length: ...]` / `[platforms: ...]` / etc. tokens), let those override the originals. Tuners not respecified stay as-is.
4. URL is optional in refine mode — keep the original URL/CTA unless the user explicitly supplies a replacement.
5. Re-run the humanizer pass on every edited variant before saving (mandatory, same as initial generation).
6. Skip thumbnail re-rendering unless the user explicitly asks for new thumbnails or changes the `[thumbnails: ...]` tuner.
7. Confirm with a one-line diff summary and the file link. Do not restate full post bodies unless asked.

If the file named in `[refine: ...]` does not exist, fall back to the normal create flow and warn once.

## Output File Naming

- **Bulk (from a report, no specific URL)**: `social-posts/{YYYY-MM-DD-HHmm}-{slug}-social-posts.md`
- **Solo (one-off from a single URL)**: `social-posts/{YYYY-MM-DD-HHmm}-{slug}-solo-{url-slug}.md`
  - `{url-slug}` = lowercased, hyphenated `host` + last meaningful path segment (drop `www.`, drop trailing slashes, strip query/fragment), max 40 chars.
  - Examples:
    - `https://youtube.com/watch?v=AbC123` → `youtube-com-watch-abc123`
    - `https://devblogs.microsoft.com/cosmosdb/announcing-vector-search/` → `devblogs-microsoft-com-announcing-vector-search`
    - `https://github.com/Azure/azure-cosmos-dotnet-v3/releases/tag/v3.50.0` → `github-com-v3-50-0`
  - If the URL slug would be empty, fall back to `solo-link`.
- **Solo, no link yet (drafted from copy)**: `social-posts/{YYYY-MM-DD-HHmm}-{slug}-solo-draft-{title-slug}.md`
  - `{title-slug}` = lowercased, hyphenated short form of a title or topic surfaced from the supplied copy (max 40 chars). If none can be inferred, fall back to `solo-draft`.

When multiple products are configured, always include the product `{slug}`. If only one product is configured, the `{slug}` segment is still included for consistency.

## Tuner Contract

The web UI and chat/headless runner may append a tuner block to the input in this exact form (all fields optional, in any order):

```
[tone: conversational|technical|enthusiastic|professional|playful|matter-of-fact]
[platforms: linkedin,x,bluesky,reddit]
[length: tease|standard|long]
[emoji: off|light|medium]
[hashtags: yes|no]
[mention-authors: yes|no]
[link-in-comments: yes|no]
[variants: 2..5]
[thumbnails: auto|minimal|branded|editorial|generic|off]
[thumbnail-notes: <freeform style notes>]
```

Apply each tuner literally. Defaults if a tuner is absent: tone=conversational, platforms=linkedin,x, length=tease, emoji=light, hashtags=no, mention-authors=no, link-in-comments=no, variants=3, thumbnails=auto.

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

### Thumbnail spec (auto-rendered, placed inline with each variant)

Thumbnails are **opt-in per item**. Only emit a `**Thumbnail spec:**` block
when a custom rendered card actually adds value. Skip the spec entirely when:

- The link already has a strong native image (YouTube videos, GitHub repos
  with custom og:image, Microsoft Learn pages with hero images, blog posts
  whose featured image will preview well in LinkedIn/X cards).
- The post uses an inline link inside a casual sentence (no thumbnail needed).
- You're drafting from copy with no live URL yet AND the user gave no visual
  direction.

DO emit a spec when:

- The post uses **link-in-comments** or **link-first** treatment and would
  otherwise render as a wall of plain text on LinkedIn/X.
- The link target is text-heavy (PDFs, release notes, long blog posts
  without a strong hero image).
- The user explicitly asked for a thumbnail in the input or tuners.

If the user passed `[thumbnails: off]`, DO NOT emit any thumbnail spec
blocks at all. If the user passed `[thumbnails: <preset>]` with a value
other than `auto`, use that preset for every spec you do emit. If
`[thumbnail-notes: <text>]` is supplied, copy the text verbatim into the
`Style notes:` line of every spec.

For every item that does need a thumbnail, include exactly **one**
`**Thumbnail spec:**` block. The renderer at `tools/render-thumbnails/`
automatically produces **both** a LinkedIn (1200×1200) and an X (1600×900)
PNG from that single spec — you do not need to repeat the block per
platform. The web UI runs the renderer automatically after `/scout-post`
finishes (unless the user toggled it off); it can also be invoked manually
with `node tools/render-thumbnails/index.js`.

After the PNGs are rendered, the renderer **places each image inline with
the social-post variant it illustrates** — the LinkedIn PNG is inserted
right under the first `**LinkedIn (...):**` fenced block in that item, the
X PNG under the first `**X (...):**` block. Each embed is preceded by a
small label like `**Suggested thumbnail (LinkedIn 1200×1200):**` so the
post draft and its proposed thumbnail read as a single unit. Do **not**
hand-author a `**Generated images:**` block at the bottom of the item —
the renderer owns embed placement and removes any pre-existing legacy
block on each run.

Use this exact bullet shape for the spec (case-insensitive keys; the parser
also accepts `·`-separated combos like `Platform: LinkedIn · Size: 1200x1200`):

```markdown
**Thumbnail spec:**
- Platform: LinkedIn · Size: 1200x1200
- Style: minimal
- Style notes: warm tones, conference vibe (optional, freeform — drives palette/treatment hints)
- Background: Dark navy (`#0F2540`)
- Accent: `#38B2AC`
- Headline: "Identity-Aware MCP Servers"
- Subtext: "FastMCP + Entra Auth + Azure Cosmos DB"
- Logo: Azure Cosmos DB (from `social-posts/images/brand/azure-cosmos-db/`)
- Alt text: "Dark navy thumbnail with the headline 'Identity-Aware MCP Servers' over a small Azure Cosmos DB logo, accent teal bar."
- Save to: `social-posts/images/{YYYY-MM-DD-HHmm}/{N}-linkedin-{slug}.png`
```

`Style:` accepts one of `minimal` (default — clean text on solid bg with
accent bar), `branded` (logo + gradient + brand rail), `editorial` (large
quote-style headline, no logo), or `generic` (light neutral background, no
logo, no accent). `Style notes:` is freeform and surfaces in the alt text;
the renderer may use keywords to subtly shift the palette.

After the renderer runs, the item will look like this in the markdown
file (LinkedIn variant + LinkedIn thumbnail, then X variant + X thumbnail,
then the spec block stays at the bottom for traceability):

```markdown
**LinkedIn (option 1 — what it is):**

```text
…post body…
```

**Suggested thumbnail (LinkedIn 1200×1200):**
![Dark navy thumbnail … accent teal bar.](images/{YYYY-MM-DD-HHmm}/{N}-linkedin-{slug}.png)

**X (option 1):**

```text
…post body…
```

**Suggested thumbnail (X 1600×900):**
![Dark navy thumbnail … accent teal bar.](images/{YYYY-MM-DD-HHmm}/{N}-x-{slug}.png)

**Thumbnail spec:**
- … (as above) …
```

Recognized keys: `Platform`, `Size`, `Style`, `Style notes`, `Background`,
`Accent`, `Headline`, `Subtext`, `Logo`, `Alt text`, `Save to` (alias
`Save path`). The companion
file path is derived by swapping the `linkedin`/`x` token in the `Save to:`
filename, so the X PNG above lands at `…/{N}-x-{slug}.png` automatically.

**Alt text is required.** Every Thumbnail spec MUST include an `Alt text:`
line that describes the rendered image well enough for a screen-reader
user to understand what's on screen — describe the headline, subtext,
color palette, and logo presence. The renderer reuses that alt text for
every inline `![alt](...)` embed it injects. Image paths are written
**relative to the `social-posts/` directory** (start with `images/…`, not
`social-posts/images/…`) so they render correctly when the markdown file
is previewed in GitHub or the web UI.

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

## Humanizer pass (mandatory final step — do not skip)

Before writing any post body to disk, run every variant (LinkedIn, X, Bluesky, Reddit title + body, OP context comments) through the humanizer checklist below. **Apply the inline checklist directly — do NOT read [`.claude/skills/humanizer/SKILL.md`](../../.claude/skills/humanizer/SKILL.md) as part of the normal flow.** The high-impact tells for social copy are already inlined here, so the common case needs no mid-run file read (saves a tool round-trip and ~7K tokens of skill load per run).

**Fallback only:** read the full `SKILL.md` *only if* a variant still reads like AI after applying the inline checklist twice and you can't pinpoint why — e.g., longer LinkedIn bodies where subtler patterns (passive voice, vague attribution, superficial -ing analysis) survive. For short X/Bluesky/Reddit copy the inline list is sufficient.

**Performance optimization: Batch humanizer pass in parallel.** After drafting all variants:

1. **Collect all variant text blocks** (LinkedIn options 1–N, X options 1–N, Bluesky, Reddit bodies, OP comments) into a single batch.
2. **Run the humanizer checklist on all variants at once** using a parallel pass (submit all variant texts together for review). This avoids serial invocations and cuts latency significantly.
3. **For this pass, use Claude Haiku** (fast) instead of the default generation model. The humanizer task is pattern-matching and lightweight rewriting, not creative brainstorming, so Haiku is well-suited and runs ~2–3× faster than larger models.
4. **After the batch pass returns**, apply the fixes to each variant and preserve the tuner contract: tone, length caps, emoji budget, hashtag policy, and the canonical brand name must survive the pass unchanged.

Inline humanizer checklist (apply directly — this is the full working set for social copy):
   - Promotional / advertisement language ("boasts", "vibrant", "groundbreaking", "seamless", "powerful")
   - AI-vocabulary words ("delve", "underscore", "unlock", "showcase", "leverage", "robust", "empower", "intricate")
   - Significance inflation ("a pivotal moment", "reshaping the landscape", "a testament to")
   - Negative parallelisms ("It's not just X — it's Y")
   - Rule-of-three lists where two would do ("faster, simpler, and more reliable")
   - Em-dash overuse (a single em-dash per post is plenty; replace the rest with commas or periods)
   - Sycophantic / chatbot artifacts ("Excited to share", "Thrilled to announce", "Big news…")
   - Filler openings ("In today's fast-paced world", "Let's dive into…")
   - Passive voice where active is stronger ("was built by the team" → "the team built")
   - Vague attribution ("experts say", "many believe", "it's widely known") — name the source or cut it
   - Superficial -ing wrap-ups ("highlighting the importance of…", "showcasing how…") — state the point plainly

5. After humanizer fixes, ask yourself: **"What makes this so obviously AI-generated?"** Note 1–3 remaining tells per variant if any, then quick second pass if needed.
6. If `tone:` is `enthusiastic` or `playful`, the humanizer still applies — keep the energy but cut the AI tells. Enthusiasm should come from concrete specifics, not from filler intensifiers.

The goal is copy that reads like a real practitioner posted it, not like an LLM autocompleted a marketing brief. If a variant still reads like a press release after humanizer review, drop it and write a different angle from scratch.
