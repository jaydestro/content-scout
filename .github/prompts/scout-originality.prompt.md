---
description: Originality / AI-generated-content review for one or more URLs
mode: agent
---

# scout-originality

Review how AI-generated one or more pieces of content appear, and check whether the prose was scraped near-verbatim from official documentation without attribution or rewording. Present it as a transparent review aid — **never** a definitive "this is AI" verdict or a plagiarism accusation.

${{input:URL(s) (required) -- one URL or a list (one per line, comma-separated, or a path to a .md/.txt file with URLs)}}

${{input:Compare against docs? (optional) -- one or more documentation URLs to check the content against. Doc links inside the content are auto-detected too.}}

${{input:Product? (optional) -- product slug, used for the report filename + canonical topic context.}}

## Flow

1. **Score each URL** with the deterministic scorer:
   ```
   node tools/originality.mjs --json <url>            # add --doc <docUrl> per doc to compare
   ```
   It fetches the page, strips it to prose, and returns:
   - `score` (0–10, higher = more human/original), `rating` + `ratingLabel` (Likely original / Mixed signals / Likely AI-generated)
   - `signals[]` — the strongest signs of AI writing it found (AI-vocabulary density, em-dash overuse, rule-of-three, negative parallelisms, superficial "-ing" analysis, copula avoidance, significance puffery, promotional language, vague attributions, chatbot artifacts, curly quotes, decorative emoji, boldface overuse)
   - `derivative` (when docs are compared) — verbatim-overlap % against each doc, the longest shared run, whether the content **attributes** the doc, and a verdict (`original-wording` / `some-overlap` / `quotes-attributed-docs` / `copied-unattributed`)
   - `insufficient-text` for titles/short snippets — report `n/a`, never guess.
2. **Documentation review.** The scorer auto-detects doc links (learn.microsoft.com, docs.microsoft.com, *.github.io, readthedocs.io, MDN) in the content and compares against them. If the user named docs, pass each with `--doc`. If the content reproduces a doc near-verbatim (≥25% overlap) **and does not link or name the source**, flag it as **"copied from documentation without attribution"**. If it reproduces but cites the doc, note it as quoting an attributed source (acceptable).
3. **Summarize** per URL: the score + read, the 2–3 strongest signals (quote a short offending phrase where helpful), and the docs verdict with the overlap %. Add a one-line at-a-glance tally.
4. **Be fair.** A low score on a routine official announcement is expected and is not a quality judgment. Never down-rank, hide, or refuse to share content solely because of a low originality score — it is informational.

## Output

Write a dated report to `reports/{YYYY-MM-DD-HHmm}-{slug}-originality.md` (use `content` as the slug if no product is tied). One row per URL:

`| # | URL | Score | Read | Top AI-writing signals | Docs check |`

Then a short prose summary highlighting anything notable (a likely-AI piece, or content copied from docs without attribution). Validate every URL before presenting it.

> Note: from the web UI this same review runs one-click under **Tools → Originality** (paste a URL, optionally add doc URLs to compare). The agent command and the Tools tab share the same scorer (`tools/lib/originality.mjs`).
