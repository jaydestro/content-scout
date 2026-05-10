#!/usr/bin/env node
/**
 * Content Scout — thumbnail renderer
 *
 * Reads a social-posts markdown file, parses every `**Thumbnail:**` block,
 * and writes a PNG to the `Save path` listed in that block.
 *
 * Composition:
 *   - Solid background fill (Background color, dark fallback).
 *   - Optional logo PNG composited top-left (when the spec lists a real logo path
 *     that exists on disk; never invents a logo).
 *   - Headline text rendered via SVG, centered.
 *   - Optional Subtext below headline.
 *   - Accent bar across the bottom.
 *
 * Usage:
 *   node index.js                              # auto-pick newest social-posts/*.md
 *   node index.js path/to/social-posts.md      # specific file
 *   node index.js --dry-run path/to/file.md    # parse + log, no PNGs written
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
const args = process.argv.slice(2);
const DRY_RUN_CLI = args.includes('--dry-run');
const fileArg = args.find((a) => !a.startsWith('--'));

const PLATFORM_SIZES = {
  linkedin: { w: 1200, h: 1200 },
  'linkedin-square': { w: 1200, h: 1200 },
  'linkedin-landscape': { w: 1200, h: 627 },
  x: { w: 1600, h: 900 },
  twitter: { w: 1600, h: 900 },
  bluesky: { w: 2000, h: 1000 },
  youtube: { w: 1200, h: 675 },
  'youtube-community': { w: 1200, h: 675 },
};

// Keys whose values may legitimately contain `·`/`•`/`|` separators or
// surrounding quotes, so they must be absorbed whole rather than split.
const FREE_TEXT_KEYS = new Set(['headline', 'subtext', 'alt text', 'alt', 'style notes']);

const DEFAULTS = {
  background: '#0b1020',
  accent: '#3b75cf',
  textColor: '#f9f9f9',
  font: 'Segoe UI Semibold, Segoe UI, Arial, sans-serif',
};

// Style presets unlock different visual treatments. Each preset returns a
// partial config that buildSvg merges with the props. The agent picks one
// in the spec block via `Style: <preset>`; default is `minimal` so existing
// specs render exactly as before.
const STYLE_PRESETS = {
  minimal: {
    // Current default look: solid background, centered headline, accent bar
    // along the bottom. Logo placement is honored if a brand asset exists.
    layout: 'centered',
    accentBarPosition: 'bottom',
    accentBarWeight: 0.04,
    headlineScale: 0.085,
    backgroundStyle: 'solid',
    showLogo: true,
  },
  branded: {
    // Bigger logo presence, subtle vertical gradient, brand accent rail on
    // the left edge instead of the bottom bar. Use when the brand identity
    // matters more than typography.
    layout: 'centered',
    accentBarPosition: 'left',
    accentBarWeight: 0.025,
    headlineScale: 0.078,
    backgroundStyle: 'gradient',
    showLogo: true,
    gradientShift: 0.12,
  },
  editorial: {
    // Quote-style: outsized headline, no logo, no accent bar. Lets the
    // headline carry the visual weight (good for talks, opinion pieces).
    layout: 'left',
    accentBarPosition: 'none',
    accentBarWeight: 0,
    headlineScale: 0.105,
    backgroundStyle: 'solid',
    showLogo: false,
  },
  generic: {
    // Light neutral background, dark text, no logo, no accent. Use when the
    // user wants something plain and topic-agnostic (defaults override the
    // dark palette). Background/accent supplied in the spec still win.
    layout: 'centered',
    accentBarPosition: 'none',
    accentBarWeight: 0,
    headlineScale: 0.08,
    backgroundStyle: 'solid',
    showLogo: false,
    defaultBackground: '#f4f5f7',
    defaultText: '#0f172a',
    defaultAccent: '#94a3b8',
  },
};

function resolveStyle(rawStyle) {
  const key = String(rawStyle || '').trim().toLowerCase();
  if (key && STYLE_PRESETS[key]) return { name: key, ...STYLE_PRESETS[key] };
  return { name: 'minimal', ...STYLE_PRESETS.minimal };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseColor(value) {
  if (!value) return null;
  const match = String(value).match(/#[0-9a-fA-F]{3,8}/);
  return match ? match[0] : null;
}

function parsePlatform(value, sizeOverride) {
  // sizeOverride may be a string like "1200x628" pulled from a separate
  // `Size:` row.
  const ovMatch = sizeOverride && String(sizeOverride).match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/);
  if (!value) {
    if (ovMatch) {
      return { key: 'linkedin', size: { w: Number(ovMatch[1]), h: Number(ovMatch[2]) } };
    }
    return { key: 'linkedin', size: PLATFORM_SIZES.linkedin };
  }
  const lower = String(value).toLowerCase();
  // Try size embedded in the platform string e.g. "LinkedIn (1200x1200 square)"
  const sizeMatch = lower.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/);
  if (sizeMatch) {
    return {
      key: lower.split(/\s|\(/)[0],
      size: { w: Number(sizeMatch[1]), h: Number(sizeMatch[2]) },
    };
  }
  for (const key of Object.keys(PLATFORM_SIZES)) {
    if (lower.includes(key)) {
      const size = ovMatch
        ? { w: Number(ovMatch[1]), h: Number(ovMatch[2]) }
        : PLATFORM_SIZES[key];
      return { key, size };
    }
  }
  return {
    key: lower.split(/\s|\(/)[0] || 'linkedin',
    size: ovMatch
      ? { w: Number(ovMatch[1]), h: Number(ovMatch[2]) }
      : PLATFORM_SIZES.linkedin,
  };
}

function stripQuotes(value) {
  if (!value) return '';
  return String(value).replace(/^["']|["']$/g, '').trim();
}

function unquoteHeadline(value) {
  // Headlines often look like: "Priority-Based Throttling"
  // Or wrapped in backticks. Strip surrounding wrappers.
  return stripQuotes(value).replace(/^`|`$/g, '').trim();
}

/**
 * Find every Thumbnail block in the markdown.
 *
 * A block starts at one of:
 *   - `**Thumbnail:**`           (legacy table form)
 *   - `**Thumbnail spec:**`      (bullet-list form the agent currently emits)
 *
 * The body that follows can be EITHER:
 *   (a) a `| Property | Value |` markdown table, OR
 *   (b) a list of `- Key: Value` / `* Key: Value` bullets, OR
 *   (c) a single inline prose line (parsed best-effort for `Size: 1200x627` etc.)
 *
 * Recognized keys (case-insensitive): platform, size, background, accent,
 * headline, subtext, logo, save path / save to / path.
 */
function parseThumbnails(markdown) {
  const blocks = [];
  const lines = markdown.split(/\r?\n/);
  const HEADER_RE = /^\*\*Thumbnail(?:\s+spec)?:\*\*\s*(.*)$/i;
  for (let i = 0; i < lines.length; i++) {
    const headerMatch = lines[i].trim().match(HEADER_RE);
    if (!headerMatch) continue;
    const props = {};
    // If the header line has trailing prose (e.g. "**Thumbnail spec:** Dark
    // navy background, 1200x627px"), salvage what we can from it.
    if (headerMatch[1]) absorbProseLine(props, headerMatch[1]);

    let saw = Object.keys(props).length > 0;
    let blankRun = 0;
    for (let j = i + 1; j < Math.min(i + 40, lines.length); j++) {
      const raw = lines[j];
      const line = raw.trim();
      // End on next heading or next bold-label header.
      if (/^###?\s/.test(raw) || /^\*\*[^*]+:\*\*/.test(line)) break;
      // End on fenced code.
      if (/^```/.test(line)) break;
      if (line === '') {
        blankRun++;
        // Two blanks in a row terminate the block; one blank inside is OK
        // (table or list with a separator).
        if (saw && blankRun >= 1) break;
        continue;
      }
      blankRun = 0;
      // Table row: | key | value |
      const row = line.match(/^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/);
      if (row && !/^[-:|\s]+$/.test(row[1])) {
        const key = row[1].trim().toLowerCase();
        const value = row[2].trim();
        if (key === 'property' && /^value$/i.test(value)) continue;
        props[key] = value;
        saw = true;
        continue;
      }
      // Bullet row: - Key: Value / * Key: Value
      const bullet = line.match(/^[-*]\s+([A-Za-z][\w\s/]*?)\s*[:·]\s*(.+)$/);
      if (bullet) {
        const rawKey = bullet[1].trim().toLowerCase();
        const value = bullet[2].trim();
        // Free-text keys can legitimately contain `·`/`•`/`|` as content,
        // so absorb them whole instead of letting absorbProseLine split.
        if (FREE_TEXT_KEYS.has(rawKey)) {
          if (!props[rawKey]) props[rawKey] = stripQuotes(value);
        } else {
          // A single bullet can pack "Platform: LinkedIn · Size: 1200×628".
          absorbProseLine(props, `${rawKey}: ${value}`);
        }
        saw = true;
        continue;
      }
      // Inline prose continuation (e.g. "Dark navy (#07101E), 1200x627px.").
      if (saw || /\d{3,4}\s*[x×]\s*\d{3,4}|#[0-9a-fA-F]{3,8}/.test(line)) {
        absorbProseLine(props, line);
        saw = true;
      }
    }
    if (Object.keys(props).length) blocks.push(props);
  }
  return blocks;
}

/**
 * Best-effort extraction of thumbnail props from a free-form line. Used for
 * bullet rows like `- Platform: LinkedIn · Size: 1200×628` and for prose
 * lines like `Dark navy (#07101E), 1200x627px, accent cyan (#8ee2fc)`.
 *
 * Only fills properties that aren't already set, so an explicit table or
 * bullet earlier in the block always wins over salvaged prose.
 */
function absorbProseLine(props, line) {
  if (!line) return;
  // Split on `·` first so "Platform: X · Size: 1200×628" becomes two segments.
  const segments = String(line).split(/\s+[·•|]\s+/);
  for (const seg of segments) {
    const m = seg.match(/^\s*([A-Za-z][\w\s/]*?)\s*:\s*(.+?)\s*$/);
    if (m) {
      const key = m[1].trim().toLowerCase();
      const value = m[2].trim();
      if (key === 'save to') {
        if (!props['save path']) props['save path'] = value;
      } else if (FREE_TEXT_KEYS.has(key)) {
        // Don't accept a split fragment for free-text keys — the value was
        // truncated at a `·`. Only accept when there was no split.
        if (segments.length === 1 && !props[key]) {
          props[key] = stripQuotes(value);
        }
      } else if (!props[key]) {
        props[key] = value;
      }
    }
  }
  // Salvage a stray size like "1200x627" or "1600×900".
  const sizeMatch = line.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/);
  if (sizeMatch && !props['size'] && !props['platform']) {
    props['size'] = `${sizeMatch[1]}x${sizeMatch[2]}`;
  }
  // Salvage a hex color labelled like "accent cyan (#8ee2fc)".
  const accentMatch = line.match(/accent[^#]*?(#[0-9a-fA-F]{3,8})/i);
  if (accentMatch && !props['accent']) props['accent'] = accentMatch[1];
  const bgMatch = line.match(/background[^#]*?(#[0-9a-fA-F]{3,8})/i);
  if (bgMatch && !props['background']) props['background'] = bgMatch[1];
}

function deriveSavePath(props, sourceFile) {
  const explicit = props['save path'] || props['path'];
  if (explicit) {
    const cleaned = explicit.replace(/`/g, '').trim();
    if (path.isAbsolute(cleaned)) return cleaned;
    return path.resolve(REPO_ROOT, cleaned);
  }
  // Fallback: alongside the source file, in images/<basename>/auto-N.png
  const base = path.basename(sourceFile, path.extname(sourceFile));
  const dir = path.resolve(REPO_ROOT, 'social-posts', 'images', base);
  return path.join(dir, 'auto.png');
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Lighten or darken a hex color by a fractional amount in [-1, 1].
function shiftColor(hex, amount) {
  const m = String(hex || '').match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const adj = (c) => {
    const target = amount >= 0 ? 255 : 0;
    const v = Math.round(c + (target - c) * Math.abs(amount));
    return Math.max(0, Math.min(255, v));
  };
  return `#${[adj(r), adj(g), adj(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function buildSvg({ width, height, background, accent, textColor, headline, subtext, hasLogo, style }) {
  const s = style || resolveStyle('minimal');
  // Reserve a left gutter for the logo if we have one (top-left placement).
  const headlineSize = Math.round(Math.min(width, height) * (s.headlineScale || 0.085));
  const subSize = Math.round(headlineSize * 0.42);
  const accentBarPx = Math.round(
    (s.accentBarPosition === 'left' ? width : height) * (s.accentBarWeight || 0)
  );

  const headlineLines = wrapText(headline, s.layout === 'left' ? 18 : 22);
  const lineHeight = Math.round(headlineSize * 1.1);
  const totalTextHeight = headlineLines.length * lineHeight + (subtext ? subSize * 1.6 : 0);
  const startY = Math.round((height - totalTextHeight) / 2 + headlineSize);
  const isLeft = s.layout === 'left';
  const xAnchor = isLeft ? Math.round(width * 0.07) : Math.round(width / 2);
  const textAnchor = isLeft ? 'start' : 'middle';

  const headlineSvg = headlineLines
    .map(
      (line, idx) =>
        `<text x="${xAnchor}" y="${startY + idx * lineHeight}" text-anchor="${textAnchor}" fill="${textColor}" font-family="${DEFAULTS.font}" font-size="${headlineSize}" font-weight="700">${escapeXml(line)}</text>`,
    )
    .join('\n');

  const subSvg = subtext
    ? `<text x="${xAnchor}" y="${startY + headlineLines.length * lineHeight + subSize * 1.4}" text-anchor="${textAnchor}" fill="${textColor}" opacity="0.78" font-family="${DEFAULTS.font}" font-size="${subSize}" font-weight="400">${escapeXml(subtext)}</text>`
    : '';

  // Background: solid or vertical gradient (lighter at top, darker at bottom).
  let bgSvg;
  if (s.backgroundStyle === 'gradient') {
    const top = shiftColor(background, s.gradientShift || 0.1);
    const bot = shiftColor(background, -(s.gradientShift || 0.1));
    bgSvg =
      `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0%" stop-color="${top}"/>` +
      `<stop offset="100%" stop-color="${bot}"/>` +
      `</linearGradient></defs>` +
      `<rect width="100%" height="100%" fill="url(#bg)"/>`;
  } else {
    bgSvg = `<rect width="100%" height="100%" fill="${background}"/>`;
  }

  // Accent bar: bottom (default), left edge (branded), or none (editorial/generic).
  let accentSvg = '';
  if (s.accentBarPosition === 'bottom' && accentBarPx > 0) {
    accentSvg = `<rect x="0" y="${height - accentBarPx}" width="${width}" height="${accentBarPx}" fill="${accent}"/>`;
  } else if (s.accentBarPosition === 'left' && accentBarPx > 0) {
    accentSvg = `<rect x="0" y="0" width="${accentBarPx}" height="${height}" fill="${accent}"/>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${bgSvg}
  ${accentSvg}
  ${headlineSvg}
  ${subSvg}
</svg>`;
}

function wrapText(text, maxChars) {
  if (!text) return [''];
  const words = String(text).split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if ((current + ' ' + word).length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current += ' ' + word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [text];
}

async function resolveLogoPath(props) {
  const candidates = [];
  // The agent's spec keeps the logo path implicit ("Cosmos DB logo (top-left)"),
  // so look for an explicit path first, then a brand asset path.
  const logoField = props['logo'] || '';
  const pathMatch = logoField.match(/[\w./\\-]+\.(png|jpg|jpeg|webp)/i);
  if (pathMatch) candidates.push(path.resolve(REPO_ROOT, pathMatch[0]));

  // Brand directory is conventional: social-posts/images/brand/<slug>/
  const brandRoot = path.resolve(REPO_ROOT, 'social-posts', 'images', 'brand');
  if (await fileExists(brandRoot)) {
    const slugDirs = await fs.readdir(brandRoot, { withFileTypes: true });
    for (const entry of slugDirs) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(brandRoot, entry.name);
      const files = await fs.readdir(dir);
      const preferred = files.find((f) => /logo/i.test(f) && /\.(png|jpg|jpeg|webp)$/i.test(f));
      if (preferred) candidates.push(path.join(dir, preferred));
    }
  }
  for (const c of candidates) {
    if (await fileExists(c)) return c;
  }
  return null;
}

async function renderOne(props, sourceFile, index, dryRun = false) {
  const platform = parsePlatform(props['platform'], props['size']);
  const style = resolveStyle(props['style']);
  const background =
    parseColor(props['background']) ||
    style.defaultBackground ||
    DEFAULTS.background;
  const accent =
    parseColor(props['accent']) ||
    style.defaultAccent ||
    DEFAULTS.accent;
  const textColor = style.defaultText || DEFAULTS.textColor;
  const headline = unquoteHeadline(props['headline'] || '');
  const subtext = unquoteHeadline(props['subtext'] || '');
  const savePath = deriveSavePath(props, sourceFile);
  // `Style: editorial` and `Style: generic` opt out of logo composition by
  // default. `branded` and `minimal` honor whatever brand asset is found.
  const logoPath = style.showLogo ? await resolveLogoPath(props) : null;

  const svg = buildSvg({
    width: platform.size.w,
    height: platform.size.h,
    background,
    accent,
    textColor,
    headline,
    subtext,
    hasLogo: Boolean(logoPath),
    style,
  });

  if (dryRun) {
    return { savePath, logoPath, platform: platform.key, width: platform.size.w, height: platform.size.h, skipped: true };
  }

  await fs.mkdir(path.dirname(savePath), { recursive: true });

  let pipeline = sharp(Buffer.from(svg)).png();

  if (logoPath) {
    const logoMax = Math.round(Math.min(platform.size.w, platform.size.h) * 0.18);
    const logoBuf = await sharp(logoPath)
      .resize({ width: logoMax, height: logoMax, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    const margin = Math.round(Math.min(platform.size.w, platform.size.h) * 0.04);
    pipeline = pipeline.composite([{ input: logoBuf, top: margin, left: margin }]);
  }

  await pipeline.toFile(savePath);
  return { savePath, logoPath, platform: platform.key, width: platform.size.w, height: platform.size.h };
}

// Standard "must-have" sizes per platform family. Scout posts target
// LinkedIn + X, so every spec block produces both regardless of which
// platform the agent named in the spec.
const STANDARD_COMPANIONS = [
  { key: 'linkedin', label: 'linkedin', size: { w: 1200, h: 1200 } },
  { key: 'x',        label: 'x',        size: { w: 1600, h: 900  } },
];

function platformFamily(key) {
  if (!key) return null;
  const k = String(key).toLowerCase();
  if (k.startsWith('linkedin')) return 'linkedin';
  if (k === 'x' || k === 'twitter') return 'x';
  return k;
}

/**
 * Build the save path for an auto-companion variant by injecting the
 * platform label. Strategy:
 *   1. If the original path already contains a platform token (e.g.
 *      `1-linkedin-foo.png`), substitute it.
 *   2. Otherwise, insert `-{label}` before the extension.
 */
function companionSavePath(originalPath, label) {
  const dir = path.dirname(originalPath);
  const ext = path.extname(originalPath);
  const base = path.basename(originalPath, ext);
  const PLATFORM_TOKEN = /-(linkedin(?:-square|-landscape)?|x|twitter|bluesky|youtube(?:-community)?)-/i;
  if (PLATFORM_TOKEN.test(base)) {
    const replaced = base.replace(PLATFORM_TOKEN, `-${label}-`);
    return path.join(dir, replaced + ext);
  }
  // Bare leading platform (e.g. `linkedin-foo`).
  const LEAD = /^(linkedin(?:-square|-landscape)?|x|twitter|bluesky|youtube(?:-community)?)-/i;
  if (LEAD.test(base)) {
    return path.join(dir, base.replace(LEAD, `${label}-`) + ext);
  }
  return path.join(dir, `${base}-${label}${ext}`);
}

/**
 * Render every spec block at its declared size AND auto-render any missing
 * standard-platform companion (LinkedIn 1200×1200, X 1600×900). Returns one
 * result entry per produced PNG.
 */
async function renderBlock(props, sourceFile, index, dryRun = false) {
  const results = [];
  const primary = await renderOne(props, sourceFile, index, dryRun);
  results.push({ ok: true, kind: 'declared', ...primary });

  const family = platformFamily(primary.platform);
  for (const companion of STANDARD_COMPANIONS) {
    if (companion.key === family) continue; // already produced above
    const companionPath = companionSavePath(primary.savePath, companion.label);
    const companionProps = {
      ...props,
      platform: companion.label,
      size: `${companion.size.w}x${companion.size.h}`,
      'save path': path.relative(REPO_ROOT, companionPath),
    };
    try {
      const r = await renderOne(companionProps, sourceFile, index, dryRun);
      results.push({ ok: true, kind: 'companion', ...r });
    } catch (err) {
      results.push({ ok: false, kind: 'companion', error: String(err.message || err) });
    }
  }
  return results;
}

/**
 * Render every thumbnail spec in a markdown file. Each spec produces both
 * a LinkedIn (1200×1200) and an X (1600×900) PNG — whichever the agent
 * declared first, plus the missing companion at standard size.
 * Returns an array of { ok, kind, savePath, logoPath, platform, width, height, skipped? } results.
 */
export async function renderFile(sourceFile, { dryRun = false } = {}) {
  const markdown = await fs.readFile(sourceFile, 'utf8');
  const blocks = parseThumbnails(markdown);
  const results = [];
  // Group results per source spec block so we can inject embeds underneath
  // the matching Thumbnail spec.
  const perBlockResults = [];
  for (let i = 0; i < blocks.length; i++) {
    try {
      const rs = await renderBlock(blocks[i], sourceFile, i, dryRun);
      results.push(...rs);
      perBlockResults.push(rs.filter((r) => r.ok && r.savePath));
    } catch (err) {
      results.push({ ok: false, error: String(err.message || err) });
      perBlockResults.push([]);
    }
  }
  if (!dryRun && perBlockResults.some((r) => r.length)) {
    try {
      const updated = injectImageEmbeds(markdown, blocks, perBlockResults, sourceFile);
      if (updated !== markdown) {
        await fs.writeFile(sourceFile, updated, 'utf8');
      }
    } catch (err) {
      results.push({ ok: false, kind: 'embed-injection', error: String(err.message || err) });
    }
  }
  return results;
}

/**
 * After rendering, place each generated PNG as a `![alt](...)` embed
 * immediately under the social-post variant it illustrates — the LinkedIn
 * PNG goes under the first `**LinkedIn (...):**` fenced block in the same
 * item, the X PNG under the first `**X (...):**` block, and so on. Each
 * embed is preceded by a small `**Suggested thumbnail (Platform WxH):**`
 * label so the variant + image read as one unit when previewed in GitHub
 * or the web UI Social view.
 *
 * The Thumbnail spec block stays where the agent put it (usually at the
 * end of the item) for regenerability and traceability — it just no longer
 * carries a separate "Generated images" block underneath. Any pre-existing
 * legacy `**Generated images:**` block right after the spec is removed so
 * re-running the renderer cleans up older files.
 *
 * Idempotent — if a `**Suggested thumbnail (...):**` label already sits
 * immediately under a variant's fence, that variant is left alone.
 *
 * Paths are written relative to the source markdown's directory (so they
 * start with `images/...` not `social-posts/images/...`) which is how
 * GitHub resolves them when rendering the markdown in-tree.
 */
function injectImageEmbeds(markdown, blocks, perBlockResults, sourceFile) {
  const lines = markdown.split(/\r?\n/);
  const sourceDir = path.dirname(path.resolve(sourceFile));
  const HEADER_RE = /^\*\*Thumbnail(?:\s+spec)?:\*\*/i;
  const ITEM_RE = /^###\s/;
  const VARIANT_RE = /^\*\*(LinkedIn|X|Bluesky|Reddit|YouTube)\b[^*]*:\*\*\s*$/i;
  const SUGGESTED_RE = /^\*\*Suggested thumbnail/i;
  const LEGACY_EMBED_RE = /^\*\*Generated images:\*\*/i;

  const platformLabel = (p) => {
    const k = String(p || '').toLowerCase();
    if (k === 'x') return 'X';
    if (k === 'linkedin') return 'LinkedIn';
    if (k === 'youtube') return 'YouTube';
    return k.charAt(0).toUpperCase() + k.slice(1);
  };

  // Find each Thumbnail header line index in source order.
  const headerLineIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (HEADER_RE.test(lines[i].trim())) headerLineIdx.push(i);
  }
  if (!headerLineIdx.length) return markdown;

  // Walk in reverse so insertions/removals don't shift earlier indices.
  for (let b = headerLineIdx.length - 1; b >= 0; b--) {
    const headerIdx = headerLineIdx[b];
    const results = perBlockResults[b];
    if (!results || !results.length) continue;
    const block = blocks[b] || {};
    const altText =
      block['alt text'] ||
      block['alt'] ||
      block['headline'] ||
      'Generated social thumbnail.';

    // 1. Locate the start of the item this spec belongs to (previous `### ` heading).
    let itemStart = 0;
    for (let j = headerIdx - 1; j >= 0; j--) {
      if (ITEM_RE.test(lines[j])) { itemStart = j; break; }
    }

    // 2. Remove any legacy `**Generated images:**` block that sits right
    //    after the Thumbnail spec (older format).
    for (let j = headerIdx + 1; j < Math.min(headerIdx + 30, lines.length); j++) {
      const t = lines[j].trim();
      if (ITEM_RE.test(lines[j]) || t === '---') break;
      if (!LEGACY_EMBED_RE.test(t)) continue;
      // Find end of the legacy block: stop at blank-line + ---, or next heading/bold header.
      let end = j;
      for (let k = j + 1; k < lines.length; k++) {
        const tk = lines[k].trim();
        if (tk === '---' || ITEM_RE.test(lines[k])) { end = k - 1; break; }
        if (/^\*\*[^*]+:\*\*/.test(tk)) { end = k - 1; break; }
        end = k;
      }
      // Trim trailing blank lines inside the removal range.
      while (end > j && lines[end].trim() === '') end--;
      // Also swallow a single blank line immediately above the legacy header.
      let startCut = j;
      if (startCut > 0 && lines[startCut - 1].trim() === '') startCut--;
      lines.splice(startCut, end - startCut + 1);
      break;
    }

    // 3. Recompute item end after legacy removal.
    let itemEnd = lines.length - 1;
    for (let j = itemStart + 1; j < lines.length; j++) {
      if (ITEM_RE.test(lines[j])) { itemEnd = j - 1; break; }
    }

    // 4. Group results by platform; one image per platform per variant.
    const byPlatform = new Map();
    for (const r of results) {
      const key = String(r.platform || '').toLowerCase();
      if (!byPlatform.has(key)) byPlatform.set(key, []);
      byPlatform.get(key).push(r);
    }

    // 5. For each platform, find the FIRST matching variant header in the
    //    item and inject the embed immediately after its fenced code block.
    for (const [platform, rs] of byPlatform.entries()) {
      const r = rs[0];
      if (!r || !r.savePath) continue;
      const rel = path.relative(sourceDir, r.savePath).split(path.sep).join('/');
      const sizeLabel = `${r.width}×${r.height}`;
      const headerText = `**Suggested thumbnail (${platformLabel(platform)} ${sizeLabel}):**`;

      // Find the first matching variant within the item.
      let variantIdx = -1;
      for (let j = itemStart + 1; j <= itemEnd && j < lines.length; j++) {
        const m = lines[j].trim().match(VARIANT_RE);
        if (m && m[1].toLowerCase() === platform) {
          variantIdx = j;
          break;
        }
      }
      if (variantIdx === -1) continue; // no matching variant — skip silently

      // Find the fence start within the next ~6 lines.
      let fenceStart = -1;
      for (let j = variantIdx + 1; j < Math.min(variantIdx + 8, lines.length); j++) {
        if (/^```/.test(lines[j].trim())) { fenceStart = j; break; }
        // a non-blank, non-fence line means the variant has no code block.
        if (lines[j].trim() !== '' && !/^```/.test(lines[j].trim())) break;
      }
      if (fenceStart === -1) continue;
      let fenceEnd = -1;
      for (let j = fenceStart + 1; j < lines.length; j++) {
        if (/^```\s*$/.test(lines[j].trim())) { fenceEnd = j; break; }
      }
      if (fenceEnd === -1) continue;

      // Idempotency: skip if a Suggested thumbnail label already follows.
      let already = false;
      for (let j = fenceEnd + 1; j < Math.min(fenceEnd + 5, lines.length); j++) {
        const t = lines[j].trim();
        if (t === '') continue;
        if (SUGGESTED_RE.test(t)) { already = true; }
        break;
      }
      if (already) continue;

      const insert = ['', headerText, `![${escapeMarkdownAlt(altText)}](${rel})`];
      lines.splice(fenceEnd + 1, 0, ...insert);
      itemEnd += insert.length;
    }
  }
  return lines.join('\n');
}

function escapeMarkdownAlt(s) {
  return String(s).replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
}

export { parseThumbnails, deriveSavePath, injectImageEmbeds };

async function findLatestSocialPostsFile() {
  const dir = path.resolve(REPO_ROOT, 'social-posts');
  if (!(await fileExists(dir))) return null;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const md = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name.includes('social-posts'))
    .map((e) => path.join(dir, e.name));
  if (md.length === 0) return null;
  const stats = await Promise.all(md.map(async (f) => ({ f, t: (await fs.stat(f)).mtimeMs })));
  stats.sort((a, b) => b.t - a.t);
  return stats[0].f;
}

async function main() {
  let sourceFile = fileArg ? path.resolve(process.cwd(), fileArg) : await findLatestSocialPostsFile();
  if (!sourceFile) {
    console.error('No social-posts markdown file found. Provide a path: node index.js path/to/file.md');
    process.exitCode = 1;
    return;
  }
  if (!(await fileExists(sourceFile))) {
    console.error(`File not found: ${sourceFile}`);
    process.exitCode = 1;
    return;
  }

  const markdown = await fs.readFile(sourceFile, 'utf8');
  const blocks = parseThumbnails(markdown);
  if (!blocks.length) {
    console.log(`No **Thumbnail:** spec blocks found in ${path.relative(REPO_ROOT, sourceFile)}`);
    return;
  }

  console.log(`Rendering ${blocks.length} thumbnail spec(s) from ${path.relative(REPO_ROOT, sourceFile)}${DRY_RUN_CLI ? ' [dry-run]' : ''} — each produces LinkedIn (1200x1200) + X (1600x900) PNGs.`);

  let ok = 0;
  let total = 0;
  const perBlockResults = [];
  for (let i = 0; i < blocks.length; i++) {
    try {
      const rs = await renderBlock(blocks[i], sourceFile, i, DRY_RUN_CLI);
      perBlockResults.push(rs.filter((r) => r.ok && r.savePath));
      for (const result of rs) {
        total++;
        if (!result.ok) {
          console.error(`  [${i + 1}/${blocks.length}] (${result.kind || 'extra'}) FAILED:`, result.error);
          continue;
        }
        const tag = result.kind === 'companion' ? ' (companion)' : '';
        if (result.skipped) {
          console.log(`  [dry-run ${i + 1}/${blocks.length}]${tag} ${result.platform} ${result.width}x${result.height} -> ${path.relative(REPO_ROOT, result.savePath)}`);
        } else {
          console.log(`  [${i + 1}/${blocks.length}]${tag} ${result.platform} ${result.width}x${result.height} -> ${path.relative(REPO_ROOT, result.savePath)}${result.logoPath ? ` (logo: ${path.relative(REPO_ROOT, result.logoPath)})` : ' (text-only)'}`);
        }
        ok++;
      }
    } catch (err) {
      console.error(`  [${i + 1}/${blocks.length}] FAILED:`, err.message);
      perBlockResults.push([]);
    }
  }
  if (!DRY_RUN_CLI && perBlockResults.some((r) => r.length)) {
    try {
      const updated = injectImageEmbeds(markdown, blocks, perBlockResults, sourceFile);
      if (updated !== markdown) {
        await fs.writeFile(sourceFile, updated, 'utf8');
        console.log(`Placed thumbnail embeds inline with each platform variant in ${path.relative(REPO_ROOT, sourceFile)}.`);
      }
    } catch (err) {
      console.error('Embed injection failed:', err.message);
    }
  }
  console.log(`Done. ${ok}/${total} PNG(s) succeeded across ${blocks.length} spec block(s).`);
}

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
