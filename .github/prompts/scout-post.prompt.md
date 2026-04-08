---
description: Generate social media posts for LinkedIn and X from a URL or report item
mode: content-scout
---

# scout-post

Generate social media posts for LinkedIn and X. Follow all Microsoft Social Media Standards defined in the agent instructions. Produce at least 3 LinkedIn options and 3 X options, each with a different framing angle.

${{input:URL (required) -- this is the CTA link for the posts}}

${{input:Item number from report? (optional, e.g., "#3") Leave blank if providing a URL directly}}

${{input:Additional context? (optional) -- speakers, authors, key highlights, event info, video title, anything to emphasize}}

${{input:Which report? (optional) Leave blank for the latest, or specify month/year (e.g., "March 2026")}}

${{input:Platform preference? Leave blank for LinkedIn + X, or specify one (LinkedIn, X, YouTube)}}

Use the URL as the CTA. If additional context is provided, prioritize it. If only a URL is given, fetch it and extract key details. Generate posts and save to `social-posts/`.
