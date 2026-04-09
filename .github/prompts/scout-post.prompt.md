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

Use the URL as the CTA. If additional context is provided, prioritize it. If only a URL is given, fetch it and extract key details. Save posts to `social-posts/` using per-product naming (`{YYYY-MM}-{slug}-social-posts.md`) when multiple products are configured.
