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
const FREE_TEXT_KEYS = new Set(['headline', 'subtext', 'alt text', 'alt']);

const DEFAULTS = {
  background: '#0b1020',
  accent: '#3b75cf',
  textColor: '#f9f9f9',
  font: 'Segoe UI Semibold, Segoe UI, Arial, sans-serif',
};

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

function buildSvg({ width, height, background, accent, textColor, headline, subtext, hasLogo }) {
  // Reserve a left gutter for the logo if we have one (top-left placement).
  const logoArea = hasLogo ? Math.round(Math.min(width, height) * 0.18) + 80 : 60;
  const headlineSize = Math.round(Math.min(width, height) * 0.085);
  const subSize = Math.round(headlineSize * 0.42);
  const accentBar = Math.round(height * 0.04);

  // Wrap headline at ~18 chars per line.
  const headlineLines = wrapText(headline, 22);
  const lineHeight = Math.round(headlineSize * 1.1);
  const totalTextHeight = headlineLines.length * lineHeight + (subtext ? subSize * 1.6 : 0);
  const startY = Math.round((height - totalTextHeight) / 2 + headlineSize);

  const headlineSvg = headlineLines
    .map(
      (line, idx) =>
        `<text x="${width / 2}" y="${startY + idx * lineHeight}" text-anchor="middle" fill="${textColor}" font-family="${DEFAULTS.font}" font-size="${headlineSize}" font-weight="700">${escapeXml(line)}</text>`,
    )
    .join('\n');

  const subSvg = subtext
    ? `<text x="${width / 2}" y="${startY + headlineLines.length * lineHeight + subSize * 1.4}" text-anchor="middle" fill="${textColor}" opacity="0.78" font-family="${DEFAULTS.font}" font-size="${subSize}" font-weight="400">${escapeXml(subtext)}</text>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${background}"/>
  ${headlineSvg}
  ${subSvg}
  <rect x="0" y="${height - accentBar}" width="${width}" height="${accentBar}" fill="${accent}"/>
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
  const background = parseColor(props['background']) || DEFAULTS.background;
  const accent = parseColor(props['accent']) || DEFAULTS.accent;
  const headline = unquoteHeadline(props['headline'] || '');
  const subtext = unquoteHeadline(props['subtext'] || '');
  const savePath = deriveSavePath(props, sourceFile);
  const logoPath = await resolveLogoPath(props);

  const svg = buildSvg({
    width: platform.size.w,
    height: platform.size.h,
    background,
    accent,
    textColor: DEFAULTS.textColor,
    headline,
    subtext,
    hasLogo: Boolean(logoPath),
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
 * After rendering, ensure each `**Thumbnail spec:**` block in the source
 * markdown is followed by a `**Generated images:**` block listing the PNGs
 * we just produced as `![alt](relative-path)` markdown image embeds. This
 * makes the social-posts file self-displaying when previewed in GitHub or
 * the web UI. Idempotent — if a `**Generated images:**` block already
 * exists in the next ~12 lines after the spec, leave it alone.
 *
 * Paths are written relative to the social-posts directory (so they start
 * with `images/...` not `social-posts/images/...`) which is how GitHub
 * resolves them when rendering the markdown file in-tree.
 */
function injectImageEmbeds(markdown, blocks, perBlockResults, sourceFile) {
  const lines = markdown.split(/\r?\n/);
  const HEADER_RE = /^\*\*Thumbnail(?:\s+spec)?:\*\*/i;
  const EMBED_HEADER_RE = /^\*\*Generated images:\*\*/i;
  const sourceDir = path.dirname(path.resolve(sourceFile));
  // Find each Thumbnail header line index in source order.
  const headerLineIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (HEADER_RE.test(lines[i].trim())) headerLineIdx.push(i);
  }
  if (!headerLineIdx.length) return markdown;
  // Walk in reverse so insertions don't shift earlier indices.
  for (let b = headerLineIdx.length - 1; b >= 0; b--) {
    const blockIdx = b;
    const results = perBlockResults[blockIdx];
    if (!results || !results.length) continue;
    const block = blocks[blockIdx] || {};
    const altText =
      block['alt text'] ||
      block['alt'] ||
      block['headline'] ||
      'Generated social thumbnail.';
    const headerIdx = headerLineIdx[b];
    // Find end of the Thumbnail spec block (re-use parseThumbnails logic
    // simplified: stop at blank line, next heading, or next bold header).
    let endIdx = headerIdx;
    let blankRun = 0;
    for (let j = headerIdx + 1; j < Math.min(headerIdx + 40, lines.length); j++) {
      const raw = lines[j];
      const t = raw.trim();
      if (/^###?\s/.test(raw) || (/^\*\*[^*]+:\*\*/.test(t) && !HEADER_RE.test(t))) break;
      if (/^```/.test(t)) break;
      if (t === '') {
        blankRun++;
        if (blankRun >= 1) {
          endIdx = j;
          break;
        }
      } else {
        blankRun = 0;
        endIdx = j;
      }
    }
    // Already has a Generated images block in the next ~12 lines? skip.
    let already = false;
    for (let j = endIdx; j < Math.min(endIdx + 12, lines.length); j++) {
      if (EMBED_HEADER_RE.test(lines[j].trim())) {
        already = true;
        break;
      }
    }
    if (already) continue;
    const embedLines = ['', '**Generated images:**'];
    for (const r of results) {
      const rel = path.relative(sourceDir, r.savePath).split(path.sep).join('/');
      embedLines.push(`![${escapeMarkdownAlt(altText)}](${rel})`);
    }
    // Insert just after the spec block (after endIdx).
    const insertAt = endIdx + 1;
    lines.splice(insertAt, 0, ...embedLines);
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
        console.log(`Injected **Generated images:** embeds (with alt text) into ${path.relative(REPO_ROOT, sourceFile)}.`);
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
