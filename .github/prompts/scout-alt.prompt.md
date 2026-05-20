---
description: Generate accessibility-quality alt text for images attached to social posts
mode: agent
---

# scout-alt

Generate alt text (image descriptions for screen readers and image-blocked clients) for an image the user is attaching to a social post. Output only the alt-text variants — no commentary, no headings beyond what is specified below.

${{input:Image URL or local path (optional) — if a public URL, you may fetch it; if a local file path under the workspace, you may read it. If neither is available, rely on the description}}

${{input:Image description / context (OPTIONAL) — only needed if you do not have vision/file-read capability for the supplied image. If both image and description are missing, refuse}}

${{input:Platform (optional) — linkedin, x, bluesky, mastodon, reddit, generic. Drives the character cap and tone}}

${{input:Variants (optional) — how many alt-text options to produce, default 3}}

${{input:Product (optional) — leave blank if only one product is configured}}

## Source resolution

The whole point of alt text is that the user does NOT need to describe the image. Try in this order:

1. **Vision report supplied** — if the input contains a block starting with `[vision report from <provider>/<model>]`, treat that block as authoritative inspection results from a server-side vision provider (Ollama or OpenAI). Use the `Subject`, `On-image text`, `Chart`, `People`, `UI`, and `Notes` lines as your ground truth. You still apply the alt-text rules, length caps, and platform tuning — the report is raw observations, not finished alt text. Reproduce on-image text verbatim from the report.
2. **Image supplied (no vision report)** — fetch (URL) or read (workspace-relative path) and **actually inspect the bytes** if you have any vision/multimodal/OCR tools available. Extract: subject, on-image text verbatim, chart structure (axes, trend, headline), people count + activity (without naming), screenshot UI elements, etc.
3. **Image supplied but you have NO vision tool and no vision report** — say so explicitly. Output a single block:

   ```
   I can read the file path but I don't have an image-vision tool available, so I can't see what's in {path}. Either:
   (a) configure a vision provider (run `scout onboard` and pick ollama or openai), or
   (b) re-run and paste a short description into the form so I can shape it into proper alt text.
   ```

   Do NOT fabricate alt text from a filename or guess from context.
4. **No image, only description** — produce alt text shaped from the description (this is acceptable; the user has explicitly opted into description-only mode).
5. **Neither image nor description nor vision report** — refuse and ask for one of them.

When you have a vision report or directly inspected the image, your alt text must reflect what was actually seen, not generic boilerplate. If on-image text is unreadable (low resolution, glare), say so in Notes rather than guessing.

## Alt-text rules (non-negotiable)

These are accessibility requirements, not stylistic preferences. Apply to every variant.

1. **Describe content and function**, not aesthetics. Decorative-only images get `alt=""` (and you should say so).
2. **Do not start with** "Image of", "Picture of", "Photo of", "Graphic showing", "A screenshot of". Screen readers already announce the image role. Exceptions: when the medium is itself meaningful — e.g., "Painting of...", "Diagram showing...", "Screenshot of the Azure portal..." (only when "screenshot" or "diagram" carries information the user needs).
3. **Lead with the most important information.** First 80 characters should stand alone if truncated.
4. **Reproduce text in the image verbatim** when it carries meaning (chart titles, button labels, quote cards, slide headlines). Use quotes around verbatim text.
5. **Be specific, not generic.** "Three engineers at a whiteboard sketching a partition-key strategy" beats "people working".
6. **Names only when verifiable** from the user's description or visible captioning. Do not guess identities.
7. **No hashtags, no emojis, no marketing copy.** Alt text is not promotion.
8. **No SEO keyword stuffing.** One natural mention of the topic at most.
9. **Length caps by platform** (hard limits — exceeding them gets the alt text truncated by the platform):
   - **X / Twitter**: 1000 chars max, target ≤ 200 for clarity
   - **LinkedIn**: 300 chars max
   - **Bluesky**: 2000 chars max, target ≤ 300
   - **Mastodon**: 1500 chars max, target ≤ 500
   - **Reddit**: no native alt text; emit a "describe in body" caption ≤ 300 chars
   - **generic / unspecified**: target ≤ 200 chars
10. **End with a period** unless the alt text is a single noun phrase or fragment where one would read awkwardly.
11. **Do not describe color** unless color carries meaning (e.g., a red error state, a brand color in a logo).
12. **Charts and data visualizations**: describe the chart type, axes, the trend or comparison being shown, and the headline takeaway. Do not list every data point unless the user asked for a long description.
13. **Multiple subjects**: order by importance, not by spatial position.

## Output File Naming

Every generated alt-text set is saved to:

`social-posts/{YYYY-MM-DD-HHmm}-{slug}-alt-{image-slug}.md`

Where:

- `{slug}` is the product slug from config.
- `{image-slug}` is derived from the image URL last path segment, or from the local filename, or from the first 5 words of the description, lowercased and hyphenated, max 40 chars. Fallback: `alt-image`.

## Output Format

```markdown
# Alt text — {short topic from description}

- **Image**: {URL or path or "(description only)"}
- **Platform**: {platform}
- **Source**: {fetched | local read | description-only}
- **Confidence**: {high | moderate | low — explain in one clause if not high}
- **Decorative?**: {yes — recommend `alt=""` | no}

## Variants

### 1. {char count}
{variant 1}

### 2. {char count}
{variant 2}

### 3. {char count}
{variant 3}

## Notes
- {any caveats: text in image was unreadable, names not verified, chart trend assumed from description, etc.}
```

If the image is decorative, output ONE block:

```markdown
# Alt text — decorative

This image is decorative. Use `alt=""` (an empty alt attribute) so screen readers skip it.

## Notes
- {why it's decorative — e.g., "purely ornamental gradient with no informational content"}
```

## Tuner Contract

The web UI may append a tuner block in this exact form:

```
[platform: linkedin|x|bluesky|mastodon|reddit|generic] [variants: N] [decorative-allowed: yes|no]
```

- `decorative-allowed: no` forces a content alt-text answer even if the image looks ornamental — useful when the user has already decided the image carries meaning.

## Refusal Triggers

- No description AND no fetchable image → ask for a description.
- The user supplies a description so vague it cannot anchor any verifiable claim ("a cool image about cosmos db") → ask one focused follow-up question (subject, on-image text, chart vs. photo vs. screenshot) before producing variants.
