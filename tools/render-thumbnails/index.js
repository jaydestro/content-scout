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

function parsePlatform(value) {
  if (!value) return { key: 'linkedin', size: PLATFORM_SIZES.linkedin };
  const lower = String(value).toLowerCase();
  // Try size embedded in the platform string e.g. "LinkedIn (1200x1200 square)"
  const sizeMatch = lower.match(/(\d{3,4})\s*x\s*(\d{3,4})/);
  if (sizeMatch) {
    return {
      key: lower.split(/\s|\(/)[0],
      size: { w: Number(sizeMatch[1]), h: Number(sizeMatch[2]) },
    };
  }
  for (const key of Object.keys(PLATFORM_SIZES)) {
    if (lower.includes(key)) return { key, size: PLATFORM_SIZES[key] };
  }
  return { key: lower.split(/\s|\(/)[0], size: PLATFORM_SIZES.linkedin };
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
 * A block starts at a `**Thumbnail:**` heading and contains a `| Property | Value |` table.
 */
function parseThumbnails(markdown) {
  const blocks = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\*\*Thumbnail:\*\*\s*$/.test(lines[i].trim())) continue;
    // Look forward for the table.
    const props = {};
    let saw = false;
    for (let j = i + 1; j < Math.min(i + 40, lines.length); j++) {
      const line = lines[j];
      if (/^###?\s/.test(line) || /^\*\*[^*]+:\*\*/.test(line.trim())) break;
      const row = line.match(/^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/);
      if (row && !/^[-:|\s]+$/.test(row[1])) {
        const key = row[1].trim().toLowerCase();
        const value = row[2].trim();
        if (key === 'property' && /^value$/i.test(value)) continue;
        props[key] = value;
        saw = true;
      } else if (saw && line.trim() === '') {
        // blank line after table -> done
        break;
      }
    }
    if (Object.keys(props).length) blocks.push(props);
  }
  return blocks;
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
  const platform = parsePlatform(props['platform']);
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

/**
 * Render every thumbnail spec in a markdown file. Returns an array of
 * { savePath, logoPath, platform, width, height, skipped? } results.
 */
export async function renderFile(sourceFile, { dryRun = false } = {}) {
  const markdown = await fs.readFile(sourceFile, 'utf8');
  const blocks = parseThumbnails(markdown);
  const results = [];
  for (let i = 0; i < blocks.length; i++) {
    try {
      const r = await renderOne(blocks[i], sourceFile, i, dryRun);
      results.push({ ok: true, ...r });
    } catch (err) {
      results.push({ ok: false, error: String(err.message || err) });
    }
  }
  return results;
}

export { parseThumbnails, deriveSavePath };

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

  console.log(`Rendering ${blocks.length} thumbnail(s) from ${path.relative(REPO_ROOT, sourceFile)}${DRY_RUN_CLI ? ' [dry-run]' : ''}`);

  let ok = 0;
  for (let i = 0; i < blocks.length; i++) {
    try {
      const result = await renderOne(blocks[i], sourceFile, i, DRY_RUN_CLI);
      if (result.skipped) {
        console.log(`  [dry-run ${i + 1}/${blocks.length}] ${result.platform} ${result.width}x${result.height} -> ${path.relative(REPO_ROOT, result.savePath)}`);
      } else {
        console.log(`  [${i + 1}/${blocks.length}] -> ${path.relative(REPO_ROOT, result.savePath)}${result.logoPath ? ` (logo: ${path.relative(REPO_ROOT, result.logoPath)})` : ' (text-only)'}`);
      }
      ok++;
    } catch (err) {
      console.error(`  [${i + 1}/${blocks.length}] FAILED:`, err.message);
    }
  }
  console.log(`Done. ${ok}/${blocks.length} succeeded.`);
}

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
