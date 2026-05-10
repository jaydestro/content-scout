import express from 'express';
import { marked } from 'marked';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync as fsExistsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateFormat, testReachability, listSupportedKeys } from './lib/key-checks.js';
import { isValidSlug, isValidFilename, safeJoin, redactSecrets } from './lib/security.js';
import { validateRawConfig } from './lib/config-validator.js';
import createSuggestionsRouter from './routes/suggestions.js';
import { ROLE_PRESETS, renderConfigTemplate } from './lib/config-template.js';
import { findMissingPrompts, findUnreferencedPrompts } from './lib/prompt-health.js';
import { describeImage, formatVisionReport, probeVision, getVisionProvider } from './lib/vision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Render single newlines as <br> so report front-matter (consecutive
// `**Generated:** ...` lines) doesn't collapse into one paragraph.
marked.setOptions({ breaks: true, gfm: true });

// Repo root = tools/web-ui/../..
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROMPTS_DIR = path.join(REPO_ROOT, '.github', 'prompts');
const REPORTS_DIR = path.join(REPO_ROOT, 'reports');
const SOCIAL_DIR = path.join(REPO_ROOT, 'social-posts');
const ENV_FILE = path.join(REPO_ROOT, '.env');
const ENV_EXAMPLE = path.join(REPO_ROOT, '.env.example');
const SETTINGS_FILE = path.join(__dirname, '.scout-web-settings.json');

const PORT = Number(process.env.PORT || 4477);
// Bind to loopback by default. Set SCOUT_HOST=0.0.0.0 to expose on the LAN
// (NOT recommended — this server can spawn shell commands and read repo files).
const HOST = process.env.SCOUT_HOST || '127.0.0.1';

// Slug + filename validation and safe-path join helpers live in ./lib/security.js
// so they can be unit-tested. Used by every route that builds a filesystem path
// from a request param.

// Built-in agent presets. `{prompt}` is replaced with the slash-style command.
const AGENT_PRESETS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    runner: 'claude -p "{prompt}"',
    install: 'https://docs.anthropic.com/en/docs/claude-code/overview',
    note: 'Runs /scout-* commands non-interactively via the Claude Code CLI.',
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    runner: 'copilot --allow-all-tools --allow-all-paths --allow-all-urls -p "{prompt}"',
    install: 'https://docs.github.com/en/copilot/github-copilot-in-the-cli',
    note: 'Requires the newer `copilot` CLI (not `gh copilot`). Runs with --allow-all-tools/paths/urls so the agent can fetch web content and execute shell commands without an interactive permission prompt (there is no TTY when spawned by the server). Tighten the runner string in Settings if you want to scope it.',
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    runner: 'codex exec "{prompt}"',
    install: 'https://github.com/openai/codex',
    note: 'Non-interactive exec mode. Reads repo context automatically.',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor Agent CLI',
    runner: 'cursor-agent -p "{prompt}"',
    install: 'https://docs.cursor.com/en/cli/overview',
    note: 'Headless Cursor agent. Reads `.cursor/rules/content-scout.mdc` automatically.',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    runner: 'gemini -p "{prompt}"',
    install: 'https://github.com/google-gemini/gemini-cli',
    note: 'Google Gemini CLI in non-interactive prompt mode.',
  },
  none: {
    id: 'none',
    label: 'In-editor only (VS Code Copilot / Windsurf / Cline) — copy prompts manually',
    runner: '',
    note: 'For editor-embedded agents without a headless CLI. The Run view will show the prompt text so you can paste it into your editor\'s chat panel.',
  },
};

// --- Settings persistence -----------------------------------------
async function loadSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      agent: typeof data.agent === 'string' ? data.agent : null,
      runner: typeof data.runner === 'string' ? data.runner : '',
    };
  } catch {
    return { agent: null, runner: '' };
  }
}

async function saveSettings(settings) {
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

// Effective runner: env var wins, then saved settings.
async function getRunner() {
  if (typeof process.env.SCOUT_RUNNER === 'string' && process.env.SCOUT_RUNNER.length > 0) {
    return { runner: process.env.SCOUT_RUNNER, source: 'env' };
  }
  const s = await loadSettings();
  return { runner: s.runner || '', source: s.runner ? 'settings' : 'none' };
}

const app = express();
// Global JSON parser (2 MB cap). Skip routes that mount their own body parser
// with a different limit (e.g. /api/alt/upload uses 25 MB).
const LARGE_BODY_ROUTES = new Set(['/api/alt/upload']);
app.use((req, res, next) => {
  if (LARGE_BODY_ROUTES.has(req.path)) return next();
  return express.json({ limit: '2mb' })(req, res, next);
});
// JSON-format any body-parser errors so the client doesn't get HTML
app.use((err, req, res, next) => {
  if (err && err.type && /entity\.(too\.large|parse\.failed)/.test(err.type)) {
    return res.status(err.status || 400).json({ error: err.message || 'bad request body' });
  }
  return next(err);
});
// Disable browser caching for the SPA assets so iterative dev changes are picked up.
app.use((req, res, next) => {
  if (/\.(html|js|css)$/.test(req.path) || req.path === '/') {
    res.set('Cache-Control', 'no-store, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
// Expose the repo's docs/assets (banner, logos, screenshots) to the UI.
app.use('/assets', express.static(path.join(REPO_ROOT, 'docs', 'assets')));
// Expose the repo's docs folder so the UI can deep-link to setup walkthroughs
// (docs/API-KEYS.md, docs/SOURCES.md, etc.).
app.use('/docs', express.static(path.join(REPO_ROOT, 'docs')));
// Expose uploaded brand logos under social-posts/images/ so the UI can preview them.
app.use('/brand-assets', express.static(path.join(REPO_ROOT, 'social-posts', 'images')));

// --- in-memory run log ---------------------------------------------
const runs = new Map();
// Bulk-run tracking. Each bulkId points at a record describing the original
// command + slug, every URL submitted, and its per-URL outcome (the run id,
// final status, and any produced social-posts/*.md file). When the last
// queued run closes, we write a manifest file to social-posts/ so the user
// can see at a glance which URLs got posts and which did NOT.
const bulkRuns = new Map();

// Scan a run's accumulated stdout/stderr for any path pointing into the
// social-posts/ folder (e.g. "Wrote social-posts/2026-05-06-...-solo-foo.md").
// Returns the unique paths in the order they were first mentioned.
function extractSocialPostPaths(output) {
  if (!output) return [];
  const re = /social-posts[\\/][^\s)\]'"`<>]+\.md/gi;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(output)) !== null) {
    const p = m[0].replace(/\\/g, '/');
    if (!seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
}

function pad2(n) { return n < 10 ? `0${n}` : `${n}`; }
function bulkTimestamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

// Write a Markdown summary of a bulk run to social-posts/. The summary
// is fully self-contained: every generated post is inlined into this one
// file. We do NOT link to per-URL `social-posts/*.md` files because (a)
// those files aren't always written by every variant of `/scout-post`
// and (b) cross-file relative links don't resolve cleanly in every
// markdown viewer the user might use. One file in, one file out.
async function writeBulkSummary(bulkId) {
  const bulk = bulkRuns.get(bulkId);
  if (!bulk || bulk.summaryWritten) return;
  bulk.summaryWritten = true;
  const ts = bulkTimestamp(new Date(bulk.startedAt));
  const slug = bulk.slug || 'unscoped';
  const fname = `${ts}-${slug}-bulk-${bulk.command}-summary.md`;
  const fpath = path.join(SOCIAL_DIR, fname);
  // Pre-resolve the post body for every item so we can compute accurate
  // success / missing counts up front (success now means "we have post
  // body to show", regardless of where it came from).
  const resolved = await Promise.all(bulk.items.map((item) => resolveItemPostBody(item)));
  const successCount = resolved.filter((r) => r.body).length;
  const missingCount = bulk.items.length - successCount;
  const lines = [];
  lines.push(`# Bulk \`/${bulk.command}\` — all posts`);
  lines.push('');
  lines.push(`- **Bulk id:** \`${bulkId}\``);
  lines.push(`- **Subject:** ${slug}`);
  lines.push(`- **Started:** ${bulk.startedAt}`);
  lines.push(`- **Finished:** ${new Date().toISOString()}`);
  lines.push(`- **URLs submitted:** ${bulk.items.length}`);
  lines.push(`- **Posts generated:** ${successCount}`);
  lines.push(`- **URLs without a post:** ${missingCount}`);
  lines.push('');

  // Quick index — links use intra-document anchors (#1-url) so they always
  // work regardless of where the file is opened from.
  lines.push('## Index');
  lines.push('');
  bulk.items.forEach((item, i) => {
    const r = resolved[i];
    const flag = r.body ? '✅' : '⚠️';
    const anchor = `${i + 1}-${slugifyForAnchor(item.url)}`;
    lines.push(`${i + 1}. ${flag} [${item.url}](#${anchor}) — ${item.status}`);
  });
  lines.push('');

  if (missingCount > 0) {
    lines.push('## URLs that did NOT produce a post');
    lines.push('');
    lines.push('| # | URL | Notes | Status | Reason |');
    lines.push('| - | --- | ----- | ------ | ------ |');
    bulk.items.forEach((item, i) => {
      if (resolved[i].body) return;
      const reason = item.status === 'success'
        ? 'Run finished but no post content was detected in the output.'
        : (item.error || `Run ended with status: ${item.status}.`);
      const notes = (item.notes || '').replace(/\|/g, '\\|') || '_(none)_';
      lines.push(`| ${i + 1} | <${item.url}> | ${notes} | ${item.status} | ${reason.replace(/\|/g, '\\|')} |`);
    });
    lines.push('');
  }

  // Inline every post into the same file. Headings inside the post body
  // are demoted so they nest under each ### URL section without breaking
  // the document outline.
  lines.push('## Posts');
  lines.push('');
  for (let i = 0; i < bulk.items.length; i++) {
    const item = bulk.items[i];
    const r = resolved[i];
    const anchor = `${i + 1}-${slugifyForAnchor(item.url)}`;
    lines.push(`<a id="${anchor}"></a>`);
    lines.push('');
    lines.push(`### ${i + 1}. ${item.url}`);
    lines.push('');
    if (item.notes) {
      lines.push(`> **Notes:** ${item.notes}`);
      lines.push('');
    }
    if (!r.body) {
      lines.push(`_(No post generated — status: ${item.status}${item.error ? `; ${item.error}` : ''}.)_`);
      lines.push('');
      lines.push('---');
      lines.push('');
      continue;
    }
    const demoted = r.body.replace(/^(#{1,4})\s/gm, (_m, hashes) => `${hashes}##`.slice(0, 6) + ' ');
    lines.push(demoted.trimEnd());
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  try {
    await fs.mkdir(SOCIAL_DIR, { recursive: true });
    await fs.writeFile(fpath, lines.join('\n'), 'utf8');
    bulk.summaryFile = `social-posts/${fname}`;
  } catch (err) {
    bulk.summaryError = err.message;
  }
}

// Resolve the post body for a bulk item. Preference order:
//   1. Read the per-URL `social-posts/*.md` file referenced in run output.
//   2. Fall back to the largest markdown-shaped block in the run's stdout.
//   3. Return an empty body, which the caller renders as "no post".
async function resolveItemPostBody(item) {
  // Try every captured file path in order; first one that reads wins.
  for (const rel of item.posts || []) {
    try {
      const abs = path.join(REPO_ROOT, rel);
      const body = await fs.readFile(abs, 'utf8');
      if (body && body.trim()) return { body: body.trim(), source: 'file' };
    } catch {
      // fall through to next path / fallback
    }
  }
  const fromOutput = extractPostFromOutput(item.output || '');
  if (fromOutput) return { body: fromOutput, source: 'output' };
  return { body: '', source: 'none' };
}

// Heuristic: pull a post-shaped markdown block out of raw run output so the
// bulk summary still shows post copy even when the agent didn't write a
// file. Looks for the section between the last "## " heading and the end
// of output, falling back to a fenced markdown block if present.
function extractPostFromOutput(output) {
  if (!output || typeof output !== 'string') return '';
  // Prefer the largest fenced ```markdown / ```md block.
  const fenceRe = /```(?:markdown|md)?\s*\n([\s\S]*?)\n```/gi;
  let bestFence = '';
  let m;
  while ((m = fenceRe.exec(output)) !== null) {
    if (m[1] && m[1].length > bestFence.length) bestFence = m[1];
  }
  if (bestFence && bestFence.trim().length > 80) return bestFence.trim();
  // Otherwise, grab from the first "## " heading onward, capped to keep
  // the summary readable (post copy is rarely > 8 KB even with thumbnails).
  const headingIdx = output.indexOf('\n## ');
  if (headingIdx >= 0) {
    const tail = output.slice(headingIdx + 1).trim();
    if (tail.length > 80) return tail.slice(0, 8000);
  }
  return '';
}

// Lowercased, hyphenated, alphanumeric-only anchor slug for in-document
// links in the bulk summary. Capped at 60 chars so anchors stay readable.
function slugifyForAnchor(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item';
}

function pushRunOutput(run, chunk) {
  // Always run terminal output through the secret redactor before storing
  // or streaming. Defense-in-depth: even if a CLI prints a key, the UI and
  // the persisted in-memory log will only ever see [REDACTED:KEY].
  const safe = redactSecrets(chunk);
  run.output += safe;
  for (const listener of run.listeners) {
    try {
      listener.write(`data: ${JSON.stringify({ chunk: safe })}\n\n`);
    } catch {}
  }
}

function closeRun(run, status) {
  run.status = status;
  run.finishedAt = new Date().toISOString();
  for (const listener of run.listeners) {
    try {
      listener.write(`event: done\ndata: ${JSON.stringify({ status })}\n\n`);
      listener.end();
    } catch {}
  }
  run.listeners.clear();
  // Auto-render thumbnails for any run that produces a social-posts/*.md
  // (scout-post bulk + solo, plus scout-scan when posts are auto-generated).
  // Fire-and-forget so the SSE close above isn't delayed.
  if (status === 'success' && (run.cmdName === 'scout-post' || run.cmdName === 'scout-scan')) {
    autoRenderThumbnails(run).catch(() => {});
  }
}

// Spawn `node tools/render-thumbnails/index.js` to produce LinkedIn (1200x1200)
// + X (1600x900) PNGs for every `**Thumbnail spec:**` block in the newest
// social-posts markdown file. Output is appended to the originating run log
// so the user sees it in the Operations drawer / Run view.
async function autoRenderThumbnails(run) {
  const renderer = path.join(REPO_ROOT, 'tools', 'render-thumbnails', 'index.js');
  try {
    await fs.access(renderer);
  } catch {
    return; // renderer not installed — silently skip
  }
  pushRunOutput(run, `\n[scout-web] Auto-rendering thumbnails (LinkedIn 1200x1200 + X 1600x900) from the newest social-posts/*.md…\n`);
  const child = spawn(process.execPath, [renderer], {
    cwd: REPO_ROOT,
    env: process.env,
  });
  child.stdout.on('data', (d) => pushRunOutput(run, `[thumbnails] ${d.toString()}`));
  child.stderr.on('data', (d) => pushRunOutput(run, `[thumbnails] ${d.toString()}`));
  await new Promise((resolve) => {
    child.on('close', (code) => {
      pushRunOutput(run, `[scout-web] Thumbnail render exited ${code}\n`);
      resolve();
    });
    child.on('error', (err) => {
      pushRunOutput(run, `[scout-web] Thumbnail render failed: ${err.message}\n`);
      resolve();
    });
  });
}

// --- helpers -------------------------------------------------------
async function listConfigs() {
  try {
    const files = await fs.readdir(PROMPTS_DIR);
    const entries = files.filter(
      (f) =>
        f.startsWith('scout-config-') &&
        f.endsWith('.prompt.md') &&
        f !== 'scout-config-example.prompt.md' &&
        !f.startsWith('scout-config-example-')
    );
    const configs = await Promise.all(
      entries.map(async (f) => {
        const slug = f.replace(/^scout-config-/, '').replace(/\.prompt\.md$/, '');
        let name = '';
        let type = '';
        try {
          const raw = await fs.readFile(path.join(PROMPTS_DIR, f), 'utf8');
          const nameM = raw.match(/^\s*-\s*\*\*Name:\*\*\s*(.+)$/m);
          const typeM = raw.match(/^\s*-\s*\*\*Type:\*\*\s*(.+)$/m);
          if (nameM) name = nameM[1].trim();
          if (typeM) type = typeM[1].trim();
        } catch {}
        return { slug, file: f, name, type };
      })
    );
    return configs;
  } catch {
    return [];
  }
}

async function readConfig(slug) {
  if (!isValidSlug(slug)) throw new Error('invalid slug');
  const file = safeJoin(PROMPTS_DIR, `scout-config-${slug}.prompt.md`);
  const raw = await fs.readFile(file, 'utf8');
  return { slug, file: `scout-config-${slug}.prompt.md`, raw };
}

async function writeConfig(slug, raw) {
  if (!isValidSlug(slug)) throw new Error('invalid slug');
  const file = safeJoin(PROMPTS_DIR, `scout-config-${slug}.prompt.md`);
  await fs.writeFile(file, raw, 'utf8');
}

app.get('/api/role-presets', (_req, res) => {
  const presets = Object.entries(ROLE_PRESETS).map(([id, p]) => ({
    id,
    label: p.label,
    focus: p.focus,
    ordering: p.ordering,
    flags: p.flags,
  }));
  res.json({ presets });
});

// Suggestion endpoints (topic tags, identity, channels, related, authors,
// brand defaults, extras) and brand-logo upload/list routes are extracted
// into routes/suggestions.js to keep server.js readable.
app.use(createSuggestionsRouter({ repoRoot: REPO_ROOT }));

// renderConfigTemplate + ROLE_PRESETS are imported from ./lib/config-template.js
// (see top-of-file imports). Users can enrich the resulting markdown via the
// Configs editor or by running /scout-onboard in a chat agent.

async function listMarkdownFiles(dir) {
  try {
    const files = await fs.readdir(dir);
    const result = [];
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const stat = await fs.stat(path.join(dir, f));
      result.push({ name: f, mtime: stat.mtime.toISOString(), size: stat.size });
    }
    return result.sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {
    return [];
  }
}

async function readMarkdown(dir, name) {
  if (!isValidFilename(name) || !name.endsWith('.md')) {
    throw new Error('invalid filename');
  }
  const file = safeJoin(dir, name);
  const raw = await fs.readFile(file, 'utf8');
  return { name, raw, html: marked.parse(raw) };
}

// Parse a .env-style string into { key, value } entries. Preserves insertion order.
// Values may be unquoted, "double", or 'single' quoted. Comments/blank lines are ignored for the key list.
function parseEnv(raw) {
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(idx + 1).trim();
    // strip inline comments only when value is unquoted
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    entries.push({ key, value });
  }
  return entries;
}

async function readEnvRaw() {
  let raw = '';
  let source = 'missing';
  try {
    raw = await fs.readFile(ENV_FILE, 'utf8');
    source = 'env';
  } catch {
    try {
      raw = await fs.readFile(ENV_EXAMPLE, 'utf8');
      source = 'example';
    } catch {
      raw = '';
    }
  }
  return { raw, source };
}

async function readEnv() {
  const { raw, source } = await readEnvRaw();
  const entries = parseEnv(raw);
  return {
    exists: source === 'env',
    keys: entries.map((e) => ({ key: e.key, hasValue: e.value.length > 0 })),
  };
}

// Serialize values back to .env, double-quoting anything that contains whitespace or # or quotes.
function serializeEnv(entries) {
  const lines = entries.map(({ key, value }) => {
    const v = value ?? '';
    const needsQuote = /[\s#"'\\]/.test(v) || v === '';
    const escaped = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `${key}=${needsQuote ? `"${escaped}"` : v}`;
  });
  return lines.join('\n') + '\n';
}

// --- API -----------------------------------------------------------
app.get('/api/status', async (_req, res) => {
  const [env, configs, settings, runnerInfo] = await Promise.all([
    readEnv(),
    listConfigs(),
    loadSettings(),
    getRunner(),
  ]);
  res.json({
    repoRoot: REPO_ROOT,
    runner: runnerInfo.runner || null,
    runnerSource: runnerInfo.source,
    runnerConfigured: !!runnerInfo.runner,
    runnerLocked: runnerInfo.source === 'env',
    agent: settings.agent,
    hasConfigs: configs.length > 0,
    configCount: configs.length,
    env,
  });
});

app.get('/api/agents', (_req, res) => {
  res.json({
    agents: Object.values(AGENT_PRESETS).map(({ id, label, runner, install, note }) => ({
      id, label, runner, install, note,
    })),
  });
});

app.get('/api/settings', async (_req, res) => {
  res.json(await loadSettings());
});

app.post('/api/settings', async (req, res) => {
  const { agent, runner } = req.body || {};
  if (typeof agent !== 'string') {
    return res.status(400).json({ error: 'agent required' });
  }
  let effectiveRunner = '';
  if (agent === 'custom') {
    if (typeof runner !== 'string') {
      return res.status(400).json({ error: 'runner required for custom agent' });
    }
    effectiveRunner = runner.trim();
  } else if (AGENT_PRESETS[agent]) {
    effectiveRunner = AGENT_PRESETS[agent].runner;
  } else {
    return res.status(400).json({ error: `unknown agent: ${agent}` });
  }
  try {
    await saveSettings({ agent, runner: effectiveRunner });
    res.json({ ok: true, agent, runner: effectiveRunner });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Read .env values merged with the key superset from .env.example so preset keys
// always appear in the form even if the user's .env is missing some of them.
app.get('/api/env', async (_req, res) => {
  const { raw, source } = await readEnvRaw();
  const envEntries = parseEnv(raw);
  let templateKeys = [];
  if (source === 'example') {
    templateKeys = envEntries.map((e) => e.key);
  } else {
    try {
      const exampleRaw = await fs.readFile(ENV_EXAMPLE, 'utf8');
      templateKeys = parseEnv(exampleRaw).map((e) => e.key);
    } catch {
      templateKeys = [];
    }
  }
  const byKey = new Map(envEntries.map((e) => [e.key, e.value]));
  const orderedKeys = [];
  const seen = new Set();
  for (const k of templateKeys) {
    if (!seen.has(k)) { orderedKeys.push(k); seen.add(k); }
  }
  for (const e of envEntries) {
    if (!seen.has(e.key)) { orderedKeys.push(e.key); seen.add(e.key); }
  }
  const entries = orderedKeys.map((key) => ({
    key,
    value: byKey.get(key) || '',
    preset: templateKeys.includes(key),
  }));
  res.json({ exists: source === 'env', source, entries });
});

app.post('/api/env', async (req, res) => {
  const incoming = req.body?.entries;
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: 'entries must be an array of {key,value}' });
  }
  const cleaned = [];
  for (const e of incoming) {
    if (!e || typeof e.key !== 'string') continue;
    const key = e.key.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return res.status(400).json({ error: `invalid key: ${key}` });
    }
    const value = typeof e.value === 'string' ? e.value : '';
    // Disallow newlines in values; .env can't represent them safely here.
    if (/\r|\n/.test(value)) {
      return res.status(400).json({ error: `value for ${key} contains a newline` });
    }
    cleaned.push({ key, value });
  }
  try {
    await fs.writeFile(ENV_FILE, serializeEnv(cleaned), 'utf8');
    res.json({ ok: true, count: cleaned.length });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Validate and (optionally) live-test a single env key. The UI calls this from
// the per-row Test button; scout-keys uses the same endpoint so both paths
// share one source of truth.
//
// Body: { key: "YOUTUBE_API_KEY", value: "...", liveTest?: boolean,
//         extras?: { OTHER_KEY: "..." } }
// Returns: { key, supported, format: {ok,message}, reachability: {reachable,status,message}? }
app.post('/api/env/test', express.json(), async (req, res) => {
  const key = String(req.body?.key || '').trim();
  const value = typeof req.body?.value === 'string' ? req.body.value : '';
  const liveTest = req.body?.liveTest !== false; // default true
  const extras = (req.body?.extras && typeof req.body.extras === 'object') ? req.body.extras : {};
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return res.status(400).json({ error: 'invalid key name' });
  }
  const supported = listSupportedKeys().includes(key.toUpperCase());
  const format = validateFormat(key, value);
  let reachability = null;
  if (liveTest && format.ok && supported) {
    // Merge persisted .env values so multi-key sources (Reddit, Bluesky)
    // can read sibling fields. The supplied {key,value,extras} override .env.
    let persisted = {};
    try {
      const { raw } = await readEnvRaw();
      persisted = Object.fromEntries(parseEnv(raw).map((e) => [e.key, e.value]));
    } catch { /* ignore — fall back to provided values only */ }
    const envBag = { ...persisted, ...extras, [key]: value };
    reachability = await testReachability(key, envBag);
  }
  res.json({ key, supported, format, reachability });
});

app.get('/api/configs', async (_req, res) => {
  res.json({ configs: await listConfigs() });
});

// Create a new config from form input. Generates a Quick-tier scout-config file
// with sensible defaults; users can refine details in the Configs editor or via /scout-onboard.
app.post('/api/configs', async (req, res) => {
  try {
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name is required' });
    const slug = (typeof body.slug === 'string' && body.slug.trim())
      ? body.slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
      : name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      return res.status(400).json({ error: 'invalid slug (derived from name)' });
    }
    const existing = await listConfigs();
    const existsAlready = existing.some((c) => c.slug === slug);
    if (existsAlready && !body.overwrite) {
      return res.status(409).json({ error: `config already exists for slug "${slug}"`, slug, exists: true });
    }
    const type = ['product', 'technology', 'project', 'tool'].includes(body.type) ? body.type : 'product';
    const searchTerms = Array.isArray(body.searchTerms)
      ? body.searchTerms.map((s) => String(s).trim()).filter(Boolean)
      : [name];
    const hashtags = Array.isArray(body.hashtags)
      ? body.hashtags.map((s) => String(s).trim().replace(/^#/, '')).filter(Boolean)
      : [];
    const topicTags = Array.isArray(body.topicTags)
      ? body.topicTags.map((s) => String(s).trim()).filter(Boolean)
      : [];

    // Roles: accept an array of role ids. Fall back to legacy `role` string for back-compat.
    let roleIds = Array.isArray(body.roleIds) ? body.roleIds.filter((r) => typeof r === 'string') : [];
    let customRoleLabel = typeof body.customRoleLabel === 'string' ? body.customRoleLabel.trim() : '';
    if (!roleIds.length && typeof body.role === 'string') {
      // Legacy shape — try to match by label.
      const match = Object.entries(ROLE_PRESETS).find(([, p]) => p.label.toLowerCase() === body.role.trim().toLowerCase());
      if (match) roleIds = [match[0]];
      else customRoleLabel = body.role.trim();
    }

    // Build flags — start from defaults (handled in renderConfigTemplate by merging presets),
    // then apply any explicit flag overrides from the form.
    const flagKeys = [
      'socialPosts', 'postingCalendar', 'competitorTracking', 'conferenceCfp',
      'launchCoverage', 'risingContributors', 'communityHealth', 'docGapFocus',
      'sdkAdoption', 'featureRequests', 'unansweredQuestions',
    ];
    const flags = {};
    for (const k of flagKeys) {
      if (k in (body.flags || {})) flags[k] = !!body.flags[k];
      else if (k in body) flags[k] = body[k] === true || body[k] === 'on';
    }

    const toStringList = (v) => {
      if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
      if (typeof v === 'string' && v.trim()) {
        return v.split(',').map((s) => s.trim()).filter(Boolean);
      }
      return [];
    };
    const exclusions = {
      blog: toStringList(body.exclusions?.blog),
      youtube: toStringList(body.exclusions?.youtube),
      handles: toStringList(body.exclusions?.handles),
      repos: Array.isArray(body.exclusions?.repos) ? body.exclusions.repos.map((r) => String(r).trim()).filter(Boolean) : [],
      domains: Array.isArray(body.exclusions?.domains) ? body.exclusions.domains.map((d) => String(d).trim()).filter(Boolean) : [],
    };
    const watchlist = Array.isArray(body.watchlist)
      ? body.watchlist.filter((w) => w && (w.name || w.handle)).map((w) => ({
          name: String(w.name || '').trim(),
          affiliation: String(w.affiliation || '').trim(),
          handle: String(w.handle || '').trim(),
        }))
      : [];
    const influencers = Array.isArray(body.influencers)
      ? body.influencers.filter((i) => i && (i.name || i.handle)).map((i) => ({
          name: String(i.name || '').trim(),
          platform: String(i.platform || '').trim(),
          handle: String(i.handle || '').trim(),
        }))
      : [];
    const teamMembers = Array.isArray(body.teamMembers)
      ? body.teamMembers.filter((t) => t && t.name).map((t) => ({
          name: String(t.name || '').trim(),
          context: String(t.context || '').trim(),
        }))
      : [];
    const brand = {
      logoDir: body.brand?.logoDir || '',
      thumbnailStyle: body.brand?.thumbnailStyle || '',
      theme: body.brand?.theme || '',
      productName: String(body.brand?.productName || '').trim(),
      logoRules: String(body.brand?.logoRules || '').trim(),
      colors: {
        bg: String(body.brand?.colors?.bg || '').trim(),
        accent: String(body.brand?.colors?.accent || '').trim(),
        highlight: String(body.brand?.colors?.highlight || '').trim(),
        text: String(body.brand?.colors?.text || '').trim(),
      },
      font: String(body.brand?.font || '').trim(),
      composition: String(body.brand?.composition || '').trim(),
      guardrails: String(body.brand?.guardrails || '').trim(),
    };
    const socialAccounts = {
      linkedin: String(body.socialAccounts?.linkedin || '').trim(),
      x: String(body.socialAccounts?.x || '').trim(),
      bluesky: String(body.socialAccounts?.bluesky || '').trim(),
      youtube: String(body.socialAccounts?.youtube || '').trim(),
    };
    const socialStandards = {
      audience: String(body.socialStandards?.audience || '').trim(),
      tone: String(body.socialStandards?.tone || '').trim(),
      shortName: String(body.socialStandards?.shortName || '').trim(),
      neverWrite: String(body.socialStandards?.neverWrite || '').trim(),
      avoidWords: String(body.socialStandards?.avoidWords || '').trim(),
      emoji: String(body.socialStandards?.emoji || '').trim(),
      hashtag: String(body.socialStandards?.hashtag || '').trim(),
      thingsAvoid: String(body.socialStandards?.thingsAvoid || '').trim(),
      additional: String(body.socialStandards?.additional || '').trim(),
    };
    const postingPrefs = {
      frequency: String(body.postingPrefs?.frequency || '').trim(),
      avoid: String(body.postingPrefs?.avoid || '').trim(),
      approval: String(body.postingPrefs?.approval || '').trim(),
      tagTeam: String(body.postingPrefs?.tagTeam || '').trim(),
    };
    const language = {
      langs: String(body.language?.langs || '').trim(),
      regions: String(body.language?.regions || '').trim(),
    };
    const competitors = Array.isArray(body.competitors)
      ? body.competitors.map((c) => String(c).trim()).filter(Boolean)
      : [];
    const conferences = Array.isArray(body.conferences)
      ? body.conferences.map((c) => String(c).trim()).filter(Boolean)
      : [];
    const customSources = Array.isArray(body.customSources)
      ? body.customSources.filter((s) => s && (s.name || s.url)).map((s) => ({
          name: String(s.name || '').trim(),
          type: String(s.type || '').trim(),
          url: String(s.url || '').trim(),
        }))
      : [];

    // Optional: override standard sources. For now the form sends a list of network ids
    // and we render the default table for anything selected.
    let standardSources = null;
    if (Array.isArray(body.networks) && body.networks.length) {
      const lines = [];
      let n = 1;
      const convoBits = [];
      if (body.networks.includes('github')) lines.push(`${n++}. **GitHub** — community repos, SDK releases, samples`);
      if (body.networks.includes('youtube')) lines.push(`${n++}. **YouTube** (excluding official channel) — community tutorials, demos, talks via Data API v3`);
      if (body.networks.includes('blogs')) lines.push(`${n++}. **Community blogs** — Dev.to, Medium, Hashnode, Blogspot, WordPress, DZone, C# Corner, InfoQ`);
      if (body.networks.includes('stackoverflow')) convoBits.push('Stack Overflow');
      if (body.networks.includes('reddit')) convoBits.push('Reddit');
      if (body.networks.includes('hackernews')) convoBits.push('Hacker News');
      if (body.networks.includes('bluesky')) convoBits.push('Bluesky');
      if (body.networks.includes('x')) convoBits.push('X/Twitter');
      if (body.networks.includes('linkedin')) convoBits.push('LinkedIn');
      if (convoBits.length) lines.push(`${n}. **Conversation tracking (not numbered):** ${convoBits.join(', ')}`);
      standardSources = lines;
    }

    const raw = renderConfigTemplate({
      name, slug, type,
      roleIds, customRoleLabel, flags,
      focusOverride: typeof body.focus === 'string' ? body.focus.trim() : '',
      orderingOverride: typeof body.ordering === 'string' ? body.ordering.trim() : '',
      searchTerms, hashtags, topicTags,
      exclusions, watchlist, influencers, teamMembers, brand,
      socialAccounts, socialStandards, postingPrefs, language,
      competitors, conferences, customSources, standardSources,
    });
    await writeConfig(slug, raw);
    res.json({ ok: true, slug, file: `scout-config-${slug}.prompt.md` });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/configs/:slug', async (req, res) => {
  try {
    res.json(await readConfig(req.params.slug));
  } catch (err) {
    res.status(404).json({ error: String(err.message || err) });
  }
});

app.put('/api/configs/:slug', async (req, res) => {
  try {
    const v = validateRawConfig(req.body?.raw);
    if (!v.ok) {
      return res.status(400).json({ error: v.error, code: v.code });
    }
    await writeConfig(req.params.slug, req.body.raw);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Delete a config by slug. The config file is removed from .github/prompts/.
// Reports and social posts produced for this slug are kept on disk.
app.delete('/api/configs/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!isValidSlug(slug)) {
      return res.status(400).json({ error: 'invalid slug' });
    }
    const file = safeJoin(PROMPTS_DIR, `scout-config-${slug}.prompt.md`);
    try {
      await fs.unlink(file);
    } catch (err) {
      if (err && err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
      throw err;
    }
    res.json({ ok: true, slug });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/reports', async (_req, res) => {
  res.json({
    reports: await listMarkdownFiles(REPORTS_DIR),
    social: await listMarkdownFiles(SOCIAL_DIR),
  });
});

// Convenience alias: just the social-posts/ markdown files.
// (The dashboard previously fetched this directly and silently 404'd, which
// was why the "Social posts" stat was always 0.)
app.get('/api/social', async (_req, res) => {
  res.json({ posts: await listMarkdownFiles(SOCIAL_DIR) });
});

// Count rendered thumbnail PNGs grouped by their YYYY-MM-DD-HHmm batch
// directory. Skips the brand/logo asset folder. Used by /api/activity so
// the dashboard can show "thumbnails generated" alongside reports + posts.
async function listThumbnailBatches() {
  const root = path.join(SOCIAL_DIR, 'images');
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === 'brand') continue;
    const dir = path.join(root, ent.name);
    let pngs = [];
    try {
      pngs = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.png'));
    } catch { continue; }
    if (!pngs.length) continue;
    let mtime = null;
    try {
      const st = await fs.stat(dir);
      mtime = st.mtime.toISOString();
    } catch {}
    out.push({ batch: ent.name, count: pngs.length, mtime });
  }
  return out.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
}

// Unified dashboard feed: real totals + a single time-sorted activity stream
// that mixes reports, social posts, posting calendars, thumbnail batches, and
// recent runs. The "doesn't truly represent what's been done" complaint is
// solved here — no more cards-of-counts that ignore half the work.
app.get('/api/activity', async (_req, res) => {
  const [reportFiles, socialFiles, thumbBatches] = await Promise.all([
    listMarkdownFiles(REPORTS_DIR),
    listMarkdownFiles(SOCIAL_DIR),
    listThumbnailBatches(),
  ]);

  const reports = reportFiles.filter((f) => /-content\.md$/.test(f.name));
  const calendars = socialFiles.filter((f) => /-posting-calendar\.md$/.test(f.name));
  const trends = reportFiles.filter((f) => /-trends\.md$/.test(f.name));
  const altText = socialFiles.filter((f) => /-alt-/.test(f.name));
  const soloPosts = socialFiles.filter((f) => /-solo[-.]/.test(f.name));
  const bulkPosts = socialFiles.filter(
    (f) =>
      /-social-posts\.md$/.test(f.name) &&
      !/-posting-calendar\.md$/.test(f.name)
  );
  const otherSocial = socialFiles.filter(
    (f) =>
      !calendars.some((c) => c.name === f.name) &&
      !altText.some((a) => a.name === f.name) &&
      !soloPosts.some((s) => s.name === f.name) &&
      !bulkPosts.some((b) => b.name === f.name)
  );

  const totals = {
    reports: reports.length,
    socialBulk: bulkPosts.length,
    socialSolo: soloPosts.length,
    calendars: calendars.length,
    trends: trends.length,
    altText: altText.length,
    thumbnailBatches: thumbBatches.length,
    thumbnailImages: thumbBatches.reduce((n, b) => n + b.count, 0),
    runs: runs.size,
  };

  const lastByName = (arr) => (arr[0] && arr[0].mtime) || null;
  const last = {
    scan: lastByName(reports),
    socialBulk: lastByName(bulkPosts),
    socialSolo: lastByName(soloPosts),
    calendar: lastByName(calendars),
    thumbnails: thumbBatches[0]?.mtime || null,
    altText: lastByName(altText),
    trends: lastByName(trends),
  };

  // Build the unified activity stream.
  const slugFromFile = (name) => {
    // Pattern: YYYY-MM-DD-HHmm-{slug}-{kind}.md  or  …-{slug}-solo-…
    const m = name.match(/^\d{4}-\d{2}-\d{2}-\d{4}-(.+?)-(content|social-posts|posting-calendar|trends|solo|alt)/);
    return m ? m[1] : '';
  };
  const stream = [];
  const push = (kind, label, item, extra = {}) =>
    stream.push({
      kind,
      label,
      name: item.name || extra.name || '',
      mtime: item.mtime,
      slug: extra.slug ?? slugFromFile(item.name || ''),
      href: extra.href || null,
      ...extra,
    });

  for (const r of reports) push('report', 'Scan report', r, { href: `/view/reports/${encodeURIComponent(r.name)}` });
  for (const s of bulkPosts) push('social-bulk', 'Social posts (bulk)', s, { href: `/view/social/${encodeURIComponent(s.name)}` });
  for (const s of soloPosts) push('social-solo', 'Social posts (solo)', s, { href: `/view/social/${encodeURIComponent(s.name)}` });
  for (const c of calendars) push('calendar', 'Posting calendar', c, { href: `/view/social/${encodeURIComponent(c.name)}` });
  for (const t of trends) push('trends', 'Trends report', t, { href: `/view/reports/${encodeURIComponent(t.name)}` });
  for (const a of altText) push('alt', 'Alt text', a, { href: `/view/social/${encodeURIComponent(a.name)}` });
  for (const o of otherSocial) push('social-other', 'Social file', o, { href: `/view/social/${encodeURIComponent(o.name)}` });
  for (const b of thumbBatches) {
    stream.push({
      kind: 'thumbnails',
      label: 'Thumbnails rendered',
      name: b.batch,
      mtime: b.mtime,
      slug: '',
      href: null,
      count: b.count,
    });
  }
  for (const r of [...runs.values()]) {
    stream.push({
      kind: 'run',
      label: r.cmdName ? `/${r.cmdName} run` : 'Run',
      name: r.cmdName || r.command,
      mtime: r.finishedAt || r.startedAt,
      slug: '',
      href: null,
      status: r.status,
      runId: r.id,
    });
  }

  stream.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));

  // Cap the rendered timeline. The full counts still surface in the meta line
  // and stat cards; the card itself stays a digestible glance, not a feed.
  res.json({ totals, last, activity: stream.slice(0, 10) });
});

// --- Action items: parse the latest content report per subject ----
// Surfaces high-EP items (good social-post candidates), open CFPs, and
// items lacking companion social posts. Read-only; no writes to disk.
app.get('/api/action-items', async (_req, res) => {
  try {
    const [reports, social, configs] = await Promise.all([
      listMarkdownFiles(REPORTS_DIR),
      listMarkdownFiles(SOCIAL_DIR),
      listConfigs(),
    ]);
    const socialNames = (social || []).map((s) => s.name);
    const slugs = (configs || []).map((c) => c.slug);
    const groups = [];

    for (const slug of slugs) {
      // Latest content report for this subject.
      const latest = reports
        .filter(
          (r) =>
            /-content\.md$/.test(r.name) &&
            (r.name.includes(`-${slug}-`) || r.name.includes(`-${slug}.`))
        )
        .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''))[0];
      if (!latest) continue;

      let raw = '';
      try {
        raw = await fs.readFile(path.join(REPORTS_DIR, latest.name), 'utf8');
      } catch {
        continue;
      }

      const stem = latest.name.replace(/-content\.md$/, '');
      const hasSocial = socialNames.some((n) => n.startsWith(stem));
      const items = parseActionItems(raw);

      groups.push({
        slug,
        report: latest.name,
        reportMtime: latest.mtime,
        hasSocial,
        topItems: items.topItems,
        cfps: items.cfps,
      });
    }

    res.json({ groups });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Parse markdown content report into action-item buckets.
// - topItems: rows in any pipe-table whose `EP` column is >= 4, with title + link.
// - cfps:     bullets / blockquote lines under "## Open Calls for Papers".
function parseActionItems(raw) {
  const lines = raw.split(/\r?\n/);
  const topItems = [];
  const cfps = [];
  const seenLinks = new Set();

  // --- Pipe tables ---
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*\|/.test(line)) continue;
    // Header row + separator row pattern: |...|  /  |---|---|...
    const next = lines[i + 1] || '';
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(next)) continue;
    const headers = line
      .split('|')
      .slice(1, -1)
      .map((s) => s.trim().toLowerCase());
    const epIdx = headers.findIndex((h) => h === 'ep' || h === 'score');
    const titleIdx = headers.findIndex((h) => h === 'title' || h === 'topic' || h === 'session');
    const linkIdx = headers.findIndex((h) => h === 'link' || h === 'url');
    const dateIdx = headers.findIndex((h) => h === 'date');
    if (epIdx < 0 || titleIdx < 0) continue;

    // Walk body rows until a non-table line.
    let j = i + 2;
    while (j < lines.length && /^\s*\|/.test(lines[j])) {
      const cells = lines[j]
        .split('|')
        .slice(1, -1)
        .map((s) => s.trim());
      const epRaw = cells[epIdx] || '';
      const ep = parseInt(epRaw, 10);
      if (Number.isFinite(ep) && ep >= 4) {
        const titleCell = cells[titleIdx] || '';
        const linkCell = linkIdx >= 0 ? cells[linkIdx] || '' : '';
        const dateCell = dateIdx >= 0 ? cells[dateIdx] || '' : '';
        const linkMatch = linkCell.match(/\((https?:\/\/[^\s)]+)\)/);
        const url = linkMatch ? linkMatch[1] : '';
        const title = titleCell
          .replace(/\\\|/g, '|')
          .replace(/\s+/g, ' ')
          .trim();
        const key = url || title;
        if (title && !seenLinks.has(key)) {
          seenLinks.add(key);
          topItems.push({ title, url, date: dateCell, ep });
        }
      }
      j++;
    }
    i = j - 1;
  }

  // --- Open Calls for Papers section ---
  const cfpStart = lines.findIndex((l) => /^##\s+Open Calls for Papers/i.test(l));
  if (cfpStart >= 0) {
    for (let k = cfpStart + 1; k < lines.length; k++) {
      const l = lines[k];
      if (/^##\s+/.test(l)) break; // next section
      // Match list bullets or blockquoted bullets, ignore plain prose.
      const m = l.match(/^\s*(?:>\s*)?[-*]\s+(.+)$/);
      if (!m) continue;
      const text = m[1].trim();
      if (!text || text.length < 4) continue;
      cfps.push(enrichCfp(text));
      if (cfps.length >= 6) break;
    }
  }

  // Sort topItems by EP desc, cap at 6.
  topItems.sort((a, b) => b.ep - a.ep);
  return { topItems: topItems.slice(0, 6), cfps };
}

// Known conference homepages and CFP/registration URLs. Keyed by lowercased
// name fragments matched against the conference name extracted from the
// CFP bullet. Add entries as the agent picks up new events.
const CONFERENCE_LINKS = [
  { match: /microsoft build/i, site: 'https://build.microsoft.com/', cfp: 'https://sessionize.com/microsoft-build/' },
  { match: /open source summit (us|north america)|oss\s*us/i, site: 'https://events.linuxfoundation.org/open-source-summit-north-america/', cfp: 'https://events.linuxfoundation.org/open-source-summit-north-america/program/cfp/' },
  { match: /open source summit (eu|europe)/i, site: 'https://events.linuxfoundation.org/open-source-summit-europe/', cfp: 'https://events.linuxfoundation.org/open-source-summit-europe/program/cfp/' },
  { match: /open source summit japan/i, site: 'https://events.linuxfoundation.org/open-source-summit-japan/', cfp: 'https://events.linuxfoundation.org/open-source-summit-japan/program/cfp/' },
  { match: /europython/i, site: 'https://ep2026.europython.eu/', cfp: 'https://ep2026.europython.eu/cfp/' },
  { match: /gophercon us/i, site: 'https://www.gophercon.com/', cfp: 'https://www.papercall.io/gophercon-2026' },
  { match: /gophercon uk/i, site: 'https://www.gophercon.co.uk/', cfp: 'https://www.gophercon.co.uk/' },
  { match: /kubecon.*(north america|us)/i, site: 'https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america/', cfp: 'https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america/program/cfp/' },
  { match: /kubecon.*(europe|eu)/i, site: 'https://events.linuxfoundation.org/kubecon-cloudnativecon-europe/', cfp: 'https://events.linuxfoundation.org/kubecon-cloudnativecon-europe/program/cfp/' },
  { match: /pycon austria/i, site: 'https://www.pycon.at/', cfp: 'https://www.pycon.at/' },
  { match: /pycon india/i, site: 'https://in.pycon.org/', cfp: 'https://in.pycon.org/cfp/' },
  { match: /rustconf/i, site: 'https://rustconf.com/', cfp: 'https://rustconf.com/' },
  { match: /all things open/i, site: 'https://allthingsopen.org/', cfp: 'https://allthingsopen.org/call-for-papers' },
  { match: /ndc oslo/i, site: 'https://ndcoslo.com/', cfp: 'https://ndcoslo.com/call-for-papers' },
  { match: /\bkcdc\b/i, site: 'https://www.kcdc.info/', cfp: 'https://www.kcdc.info/call-for-speakers' },
  { match: /techbash/i, site: 'https://techbash.com/', cfp: 'https://sessionize.com/techbash/' },
  { match: /developerweek/i, site: 'https://www.developerweek.com/', cfp: 'https://www.developerweek.com/call-for-papers/' },
  { match: /berlin buzzwords/i, site: 'https://berlinbuzzwords.de/', cfp: 'https://berlinbuzzwords.de/' },
  { match: /live!\s*360/i, site: 'https://live360events.com/', cfp: 'https://live360events.com/' },
  { match: /pytorch conference/i, site: 'https://events.linuxfoundation.org/pytorch-conference/', cfp: 'https://events.linuxfoundation.org/pytorch-conference/program/cfp/' },
  { match: /pydata london/i, site: 'https://pydata.org/', cfp: 'https://pydata.org/' },
  { match: /pyohio/i, site: 'https://www.pyohio.org/', cfp: 'https://www.pyohio.org/' },
  { match: /pybay/i, site: 'https://pybay.com/', cfp: 'https://pybay.com/' },
  { match: /mcp dev summit/i, site: 'https://mcpdevsummit.ai/', cfp: 'https://mcpdevsummit.ai/' },
  { match: /(agnt|mcp)con/i, site: 'https://agntcon.com/', cfp: 'https://agntcon.com/' },
  { match: /node congress/i, site: 'https://nodecongress.com/', cfp: 'https://nodecongress.com/' },
  { match: /js ?nation/i, site: 'https://jsnation.com/', cfp: 'https://jsnation.com/' },
  { match: /techorama/i, site: 'https://techorama.be/', cfp: 'https://techorama.be/' },
  { match: /scottish summit/i, site: 'https://scottishsummit.com/', cfp: 'https://scottishsummit.com/' },
  { match: /jdconf/i, site: 'https://jdconf.com/', cfp: 'https://jdconf.com/' },
  { match: /ai coding summit|ai\s*conf|ai by the bay|ai community conference|ai agent conference|all things ai|superai/i, site: '', cfp: '' },
];

// Turn a raw CFP bullet (markdown text after the leading "-") into a
// structured object the dashboard can render with real links.
function enrichCfp(text) {
  // Strip leading bold name: **Name** (date_loc) — note
  const nameMatch = text.match(/^\*\*([^*]+)\*\*/);
  const name = nameMatch ? nameMatch[1].trim() : text.split(/[—–-]/)[0].trim();
  const dateLocMatch = text.match(/\(([^)]+)\)/);
  const dateLoc = dateLocMatch ? dateLocMatch[1].trim() : '';
  let note = text;
  if (nameMatch) note = note.replace(nameMatch[0], '');
  if (dateLocMatch) note = note.replace(dateLocMatch[0], '');
  note = note.replace(/^\s*[—–-]\s*/, '').trim();

  // Pull any inline markdown link the agent already supplied.
  const inlineLinks = [];
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let lm;
  while ((lm = linkRe.exec(text))) {
    inlineLinks.push({ label: lm[1], url: lm[2] });
  }

  // Look up canonical site / CFP URLs from the known table.
  let site = '';
  let cfp = '';
  for (const entry of CONFERENCE_LINKS) {
    if (entry.match.test(name) || entry.match.test(text)) {
      site = entry.site || '';
      cfp = entry.cfp || '';
      break;
    }
  }

  return {
    raw: text,
    name,
    dateLoc,
    note,
    site,
    cfp,
    links: inlineLinks,
  };
}

app.get('/api/reports/:name', async (req, res) => {
  try {
    res.json(await readMarkdown(REPORTS_DIR, req.params.name));
  } catch (err) {
    res.status(404).json({ error: String(err.message || err) });
  }
});

app.get('/api/social/:name', async (req, res) => {
  try {
    res.json(await readMarkdown(SOCIAL_DIR, req.params.name));
  } catch (err) {
    res.status(404).json({ error: String(err.message || err) });
  }
});

// List PNG/JPG images associated with a given social-posts markdown file.
// Combines two sources:
//   1) "Save to:" / "social-posts/images/..." paths inside the markdown
//   2) Files on disk inside social-posts/images/<batch>/, where <batch> is
//      derived from the file's date-stamp prefix (YYYY-MM-DD-HHmm) or basename.
// Returns { images: [{ name, url, batch, source, bytes, mtime }] }.
app.get('/api/social/:name/images', async (req, res) => {
  const name = req.params.name;
  if (!isValidFilename(name) || !name.endsWith('.md')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(SOCIAL_DIR, name);
  const imagesRoot = path.join(SOCIAL_DIR, 'images');
  const seen = new Map(); // url -> entry
  // 1) Parse markdown for explicit image paths.
  let md = '';
  try { md = await fs.readFile(filePath, 'utf8'); } catch {
    return res.status(404).json({ error: 'Not found' });
  }
  const re = /social-posts[\\/]images[\\/]([\w.\-/\\]+\.(?:png|jpe?g|webp|gif))/gi;
  for (const m of md.matchAll(re)) {
    const rel = m[1].replace(/\\/g, '/');
    const abs = path.join(imagesRoot, rel);
    const url = `/brand-assets/${rel}`;
    if (seen.has(url)) continue;
    let stat = null;
    try { stat = await fs.stat(abs); } catch {}
    if (!stat) continue;
    seen.set(url, {
      name: path.basename(rel),
      url,
      batch: rel.split('/')[0] || '',
      source: 'spec',
      bytes: stat.size,
      mtime: stat.mtime.toISOString(),
    });
  }
  // 2) Scan likely batch directories (date prefix or full basename).
  const base = name.replace(/\.md$/i, '');
  const stamp = (base.match(/^\d{4}-\d{2}-\d{2}-\d{4}/) || [null])[0];
  const candidates = new Set();
  if (stamp) {
    candidates.add(stamp);
    candidates.add(stamp.slice(0, 10)); // date-only batch
  }
  candidates.add(base);
  for (const dir of candidates) {
    const abs = path.join(imagesRoot, dir);
    let entries = [];
    try { entries = await fs.readdir(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/\.(png|jpe?g|webp|gif)$/i.test(e.name)) continue;
      const url = `/brand-assets/${dir}/${e.name}`;
      if (seen.has(url)) continue;
      let stat = null;
      try { stat = await fs.stat(path.join(abs, e.name)); } catch {}
      if (!stat) continue;
      seen.set(url, {
        name: e.name,
        url,
        batch: dir,
        source: 'batch',
        bytes: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
  }
  const images = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  res.json({ images });
});

// Standalone, printable view of any report or social-posts file. Lets the
// dashboard's "Recent activity" links and the per-list "Open ↗" buttons pop
// the rendered output in its own window/tab, independent of the SPA.
function renderStandaloneHTML({ name, html, kind }) {
  const escHtml = (s) =>
    String(s).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escHtml(name)} — Content Scout</title>
<link rel="stylesheet" href="/theme-modern.css" />
<style>
  body { max-width: 880px; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
  .standalone-head {
    display: flex; align-items: center; gap: 0.75rem;
    padding-bottom: 0.75rem; margin-bottom: 1.25rem;
    border-bottom: 1px solid var(--border, #2a2a35);
    flex-wrap: wrap;
  }
  .standalone-head .crumb { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted, #8a8a99); }
  .standalone-head h1 { font-size: 1.05rem; margin: 0; word-break: break-all; }
  .standalone-head .spacer { flex: 1; }
  .standalone-head a, .standalone-head button {
    font-size: 0.85rem;
    padding: 0.35rem 0.7rem;
    border-radius: 6px;
    text-decoration: none;
  }
  @media print {
    .standalone-head { display: none; }
    body { max-width: none; padding: 0; }
  }
</style>
</head>
<body>
  <header class="standalone-head">
    <span class="crumb">${escHtml(kind)}</span>
    <h1>${escHtml(name)}</h1>
    <span class="spacer"></span>
    <button type="button" onclick="window.print()">Print</button>
    <a href="/" target="_blank" rel="noopener">Back to Scout</a>
  </header>
  <article class="markdown">${html}</article>
</body>
</html>`;
}

app.get('/view/reports/:name', async (req, res) => {
  try {
    const { name, html } = await readMarkdown(REPORTS_DIR, req.params.name);
    res.type('html').send(renderStandaloneHTML({ name, html, kind: 'Report' }));
  } catch (err) {
    res.status(404).type('html').send(`<h1>Not found</h1><p>${String(err.message || err)}</p>`);
  }
});

app.get('/view/social/:name', async (req, res) => {
  try {
    const { name, html } = await readMarkdown(SOCIAL_DIR, req.params.name);
    res.type('html').send(renderStandaloneHTML({ name, html, kind: 'Social posts' }));
  } catch (err) {
    res.status(404).type('html').send(`<h1>Not found</h1><p>${String(err.message || err)}</p>`);
  }
});

// =====================================================================
// Item / conversation / author / source index
// ---------------------------------------------------------------------
// Lazily builds an in-memory index by parsing every *-content.md report.
// Cached for 30s (or until reports/ mtime changes) so /api/items,
// /api/conversations, /api/authors, /api/search, /api/source-health all
// share the same scan. Read-only; never writes back to disk.
// =====================================================================

let _indexCache = null; // { builtAt, signature, items, conversations, authors, sources, reports }
const INDEX_TTL_MS = 30_000;

async function getIndex() {
  const reports = (await listMarkdownFiles(REPORTS_DIR)).filter((r) =>
    /-content\.md$/.test(r.name)
  );
  const signature = reports
    .map((r) => `${r.name}@${r.mtime || ''}`)
    .sort()
    .join('|');
  if (
    _indexCache &&
    _indexCache.signature === signature &&
    Date.now() - _indexCache.builtAt < INDEX_TTL_MS
  ) {
    return _indexCache;
  }

  const items = [];
  const conversations = [];
  const authors = new Map(); // name -> aggregate
  const sources = new Map(); // sourceKey -> aggregate
  const reportsMeta = [];

  for (const r of reports) {
    let raw = '';
    try {
      raw = await fs.readFile(path.join(REPORTS_DIR, r.name), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseReport(raw, r.name);
    reportsMeta.push({
      name: r.name,
      mtime: r.mtime,
      slug: parsed.slug,
      generatedAt: parsed.generatedAt,
      itemCount: parsed.items.length,
      convoCount: parsed.conversations.length,
      sentimentTotals: parsed.sentimentTotals,
      skippedSources: parsed.skippedSources,
    });
    for (const it of parsed.items) items.push({ ...it, report: r.name });
    for (const c of parsed.conversations) conversations.push({ ...c, report: r.name });

    for (const it of parsed.items) {
      if (it.author) {
        const key = it.author.toLowerCase();
        const entry =
          authors.get(key) ||
          { name: it.author, items: 0, conversations: 0, lastSeen: '', sentiments: {}, slugs: new Set(), urls: new Set() };
        entry.items += 1;
        if (it.date && it.date > entry.lastSeen) entry.lastSeen = it.date;
        entry.slugs.add(parsed.slug);
        if (it.url) entry.urls.add(it.url);
        authors.set(key, entry);
      }
      if (it.source) {
        const key = it.source.toLowerCase();
        const entry = sources.get(key) || { source: it.source, items: 0, lastSeen: '', skipped: 0 };
        entry.items += 1;
        if (it.date && it.date > entry.lastSeen) entry.lastSeen = it.date;
        sources.set(key, entry);
      }
    }
    for (const c of parsed.conversations) {
      if (c.author) {
        const key = c.author.toLowerCase();
        const entry =
          authors.get(key) ||
          { name: c.author, items: 0, conversations: 0, lastSeen: '', sentiments: {}, slugs: new Set(), urls: new Set() };
        entry.conversations += 1;
        const s = (c.sentiment || 'unknown').toLowerCase();
        entry.sentiments[s] = (entry.sentiments[s] || 0) + 1;
        if (c.date && c.date > entry.lastSeen) entry.lastSeen = c.date;
        entry.slugs.add(parsed.slug);
        if (c.url) entry.urls.add(c.url);
        authors.set(key, entry);
      }
      if (c.platform) {
        const key = c.platform.toLowerCase();
        const entry = sources.get(key) || { source: c.platform, items: 0, lastSeen: '', skipped: 0 };
        entry.items += 1;
        if (c.date && c.date > entry.lastSeen) entry.lastSeen = c.date;
        sources.set(key, entry);
      }
    }
    for (const s of parsed.skippedSources) {
      const key = s.name.toLowerCase();
      const entry = sources.get(key) || { source: s.name, items: 0, lastSeen: '', skipped: 0 };
      entry.skipped += 1;
      entry.lastSkipReason = s.reason;
      sources.set(key, entry);
    }
  }

  _indexCache = {
    builtAt: Date.now(),
    signature,
    items,
    conversations,
    authors: [...authors.values()].map((a) => ({
      name: a.name,
      items: a.items,
      conversations: a.conversations,
      lastSeen: a.lastSeen,
      sentiments: a.sentiments,
      slugs: [...a.slugs],
      urls: [...a.urls],
    })),
    sources: [...sources.values()],
    reports: reportsMeta,
  };
  return _indexCache;
}

// Parse a single content report into structured items + conversations + meta.
function parseReport(raw, fileName) {
  const lines = raw.split(/\r?\n/);
  const slugMatch = fileName.match(/^\d{4}-\d{2}-\d{2}-\d{4}-(.+)-content\.md$/);
  const slug = slugMatch ? slugMatch[1] : '';
  const genMatch = raw.match(/\*\*Generated:\*\*\s*([^\n]+)/);
  const generatedAt = genMatch ? genMatch[1].trim() : '';

  const items = [];
  const conversations = [];
  let currentSection = '';
  const seenItems = new Set();
  const sentimentTotals = { positive: 0, neutral: 0, negative: 0, mixed: 0, unknown: 0 };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^##+\s+(.+)$/);
    if (headerMatch) {
      currentSection = headerMatch[1].trim();
      continue;
    }
    if (!/^\s*\|/.test(line)) continue;
    const next = lines[i + 1] || '';
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(next)) continue;
    const headers = line
      .split('|')
      .slice(1, -1)
      .map((s) => s.trim().toLowerCase());
    const idx = (names) => headers.findIndex((h) => names.includes(h));
    const titleIdx = idx(['title', 'topic', 'session', 'summary', 'post', 'thread', 'discussion', 'mention']);
    const linkIdx = idx(['link', 'url']);
    const dateIdx = idx(['date']);
    const epIdx = idx(['ep', 'score']);
    const authorIdx = idx(['speaker', 'author']);
    const sourceIdx = idx(['source', 'channel', 'platform']);
    const tagsIdx = idx(['tags']);
    const sentimentIdx = idx(['sentiment']);
    const summaryIdx = idx(['summary']);
    const communityIdx = idx(['community']);
    const engagementIdx = idx(['engagement']);
    const isConversation = sentimentIdx >= 0 || /conversations|mentions/i.test(currentSection);

    let j = i + 2;
    while (j < lines.length && /^\s*\|/.test(lines[j])) {
      const cells = lines[j]
        .split('|')
        .slice(1, -1)
        .map((s) => s.trim());
      const titleCell = titleIdx >= 0 ? cells[titleIdx] || '' : '';
      const linkCell = linkIdx >= 0 ? cells[linkIdx] || '' : '';
      const dateCell = dateIdx >= 0 ? cells[dateIdx] || '' : '';
      const epRaw = epIdx >= 0 ? cells[epIdx] || '' : '';
      const authorCell = authorIdx >= 0 ? cells[authorIdx] || '' : '';
      const sourceCell = sourceIdx >= 0 ? cells[sourceIdx] || '' : '';
      const tagsCell = tagsIdx >= 0 ? cells[tagsIdx] || '' : '';
      const sentimentCell = sentimentIdx >= 0 ? cells[sentimentIdx] || '' : '';
      const summaryCell = summaryIdx >= 0 ? cells[summaryIdx] || '' : '';
      const communityCell = communityIdx >= 0 ? cells[communityIdx] || '' : '';
      const engagementCell = engagementIdx >= 0 ? cells[engagementIdx] || '' : '';

      const linkMatch = linkCell.match(/\((https?:\/\/[^\s)]+)\)/);
      const url = linkMatch ? linkMatch[1] : '';
      const title = titleCell
        .replace(/\\\|/g, '|')
        .replace(/\s+/g, ' ')
        .trim();
      const ep = parseInt(epRaw, 10);

      if (!title || title.length < 3) {
        j++;
        continue;
      }
      const sentiment = normalizeSentiment(sentimentCell);
      const tags = tagsCell
        .split(/[,;]/)
        .map((t) => t.replace(/[`*_]/g, '').trim())
        .filter(Boolean);

      if (isConversation) {
        sentimentTotals[sentiment] = (sentimentTotals[sentiment] || 0) + 1;
        const community = (communityCell || '').replace(/[`*_]/g, '').trim().toLowerCase();
        // Heuristic: rows tagged "official", "product", "first-party", or matching
        // a known Microsoft/official handle pattern get classified as product.
        // Everything else (including blanks, "community", "third-party", "story",
        // "user", "mvp") is community-generated.
        const isProduct =
          /^(official|product|first[\s-]?party|microsoft|brand|company)$/.test(community) ||
          /microsoft|@msft|@azure/i.test(authorCell);
        conversations.push({
          date: dateCell,
          platform: sourceCell || 'Unknown',
          author: authorCell || '',
          summary: summaryCell || title,
          sentiment,
          community: isProduct ? 'product' : 'community',
          communityRaw: community || '',
          engagement: engagementCell.replace(/[`*_]/g, '').trim(),
          url,
          section: currentSection,
        });
      } else {
        const dedupKey = url || `${title}::${authorCell}`;
        if (!seenItems.has(dedupKey)) {
          seenItems.add(dedupKey);
          items.push({
            title,
            url,
            date: dateCell,
            ep: Number.isFinite(ep) ? ep : null,
            author: authorCell || '',
            source: sourceCell || '',
            tags,
            section: currentSection,
            kind: classifyItem(currentSection, sourceCell, url),
          });
        }
      }
      j++;
    }
    i = j - 1;
  }

  // Skipped sources from "Sources That Could Not Be Reached" or "Skipped Sources" sections.
  const skippedSources = [];
  const skipStart = lines.findIndex((l) =>
    /^##\s+(Sources That Could Not Be Reached|Skipped Sources|Sources Skipped)/i.test(l)
  );
  if (skipStart >= 0) {
    for (let k = skipStart + 1; k < lines.length; k++) {
      const l = lines[k];
      if (/^##\s+/.test(l)) break;
      const m = l.match(/^\s*[-*]\s+\*\*([^*]+)\*\*\s*[—:-]\s*(.+)$/);
      if (m) skippedSources.push({ name: m[1].trim(), reason: m[2].trim() });
    }
  }

  return { slug, generatedAt, items, conversations, sentimentTotals, skippedSources };
}

function normalizeSentiment(cell) {
  if (!cell) return 'unknown';
  const lower = cell.toLowerCase();
  if (cell.includes('🟢') || /positive|advoc/i.test(lower)) return 'positive';
  if (cell.includes('🔴') || /negative|critic|frustrat/i.test(lower)) return 'negative';
  if (cell.includes('🟡') || /mixed|cautious|confus/i.test(lower)) return 'mixed';
  if (/neutral/i.test(lower)) return 'neutral';
  return 'unknown';
}

function classifyItem(section, source, url) {
  const s = (section + ' ' + source + ' ' + url).toLowerCase();
  if (/youtube\.com|youtu\.be|video/i.test(s)) return 'video';
  if (/dev\.to|medium\.com|hashnode|dzone|infoq|blog|article/i.test(s)) return 'blog';
  if (/github\.com|repo|project/i.test(s)) return 'repo';
  if (/reddit/i.test(s)) return 'reddit';
  if (/hacker news|news\.ycombinator/i.test(s)) return 'hn';
  if (/bluesky|bsky/i.test(s)) return 'bluesky';
  if (/twitter|^x$|\bx\/|x\.com/i.test(s)) return 'x';
  if (/stack overflow|stackoverflow/i.test(s)) return 'stackoverflow';
  if (/conf|talk|session|stream/i.test(s)) return 'video';
  return 'other';
}

app.get('/api/items', async (req, res) => {
  try {
    const idx = await getIndex();
    const { slug, minEp, kind, tag, q } = req.query;
    let items = idx.items;
    if (slug) items = items.filter((i) => i.report.includes(`-${slug}-`) || i.report.includes(`-${slug}.`));
    if (minEp) {
      const n = parseInt(minEp, 10);
      if (Number.isFinite(n)) items = items.filter((i) => (i.ep ?? -1) >= n);
    }
    if (kind) items = items.filter((i) => i.kind === kind);
    if (tag) {
      const t = String(tag).toLowerCase();
      items = items.filter((i) => i.tags.some((x) => x.toLowerCase() === t));
    }
    if (q) {
      const needle = String(q).toLowerCase();
      items = items.filter(
        (i) =>
          i.title.toLowerCase().includes(needle) ||
          (i.author || '').toLowerCase().includes(needle) ||
          i.tags.some((t) => t.toLowerCase().includes(needle))
      );
    }
    res.json({ items, total: items.length, builtAt: idx.builtAt });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/conversations', async (req, res) => {
  try {
    const idx = await getIndex();
    const { sentiment, platform, slug, q } = req.query;
    let convs = idx.conversations;
    if (slug)
      convs = convs.filter((c) => c.report.includes(`-${slug}-`) || c.report.includes(`-${slug}.`));
    if (sentiment) convs = convs.filter((c) => c.sentiment === sentiment);
    if (platform)
      convs = convs.filter((c) => (c.platform || '').toLowerCase() === String(platform).toLowerCase());
    if (q) {
      const needle = String(q).toLowerCase();
      convs = convs.filter(
        (c) =>
          (c.summary || '').toLowerCase().includes(needle) ||
          (c.author || '').toLowerCase().includes(needle)
      );
    }
    convs = convs
      .slice()
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    res.json({ conversations: convs, total: convs.length, builtAt: idx.builtAt });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/authors', async (req, res) => {
  try {
    const idx = await getIndex();
    const { slug, q } = req.query;
    let authors = idx.authors;
    if (slug) authors = authors.filter((a) => a.slugs.includes(slug));
    if (q) {
      const needle = String(q).toLowerCase();
      authors = authors.filter((a) => a.name.toLowerCase().includes(needle));
    }
    authors = authors
      .slice()
      .sort((a, b) => b.items + b.conversations - (a.items + a.conversations));
    res.json({ authors, total: authors.length, builtAt: idx.builtAt });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/source-health', async (_req, res) => {
  try {
    const idx = await getIndex();
    const sources = idx.sources
      .slice()
      .sort((a, b) => b.items - a.items || (b.lastSeen || '').localeCompare(a.lastSeen || ''));
    const lastReportName = idx.reports
      .slice()
      .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''))[0]?.name;
    const lastSkipped =
      idx.reports
        .slice()
        .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''))[0]?.skippedSources || [];
    res.json({ sources, lastReport: lastReportName, lastSkipped, builtAt: idx.builtAt });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/sentiment-summary', async (_req, res) => {
  try {
    const idx = await getIndex();
    // Sort reports by generatedAt then mtime; aggregate by slug.
    const bySlug = new Map();
    for (const r of idx.reports) {
      const list = bySlug.get(r.slug) || [];
      list.push(r);
      bySlug.set(r.slug, list);
    }
    const groups = [];
    for (const [slug, list] of bySlug.entries()) {
      list.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
      const latest = list[0];
      const prior = list[1];
      groups.push({
        slug,
        latest: latest && {
          report: latest.name,
          generatedAt: latest.generatedAt,
          totals: latest.sentimentTotals,
          convoCount: latest.convoCount,
          itemCount: latest.itemCount,
        },
        prior: prior && {
          report: prior.name,
          generatedAt: prior.generatedAt,
          totals: prior.sentimentTotals,
        },
      });
    }
    res.json({ groups, builtAt: idx.builtAt });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ q, items: [], conversations: [], reports: [], authors: [] });
    const idx = await getIndex();
    const needle = q.toLowerCase();
    const itemHits = idx.items
      .filter(
        (i) =>
          i.title.toLowerCase().includes(needle) ||
          (i.author || '').toLowerCase().includes(needle) ||
          i.tags.some((t) => t.toLowerCase().includes(needle))
      )
      .slice(0, 20);
    const convoHits = idx.conversations
      .filter(
        (c) =>
          (c.summary || '').toLowerCase().includes(needle) ||
          (c.author || '').toLowerCase().includes(needle) ||
          (c.platform || '').toLowerCase().includes(needle)
      )
      .slice(0, 20);
    const reportHits = idx.reports.filter((r) => r.name.toLowerCase().includes(needle)).slice(0, 10);
    const authorHits = idx.authors
      .filter((a) => a.name.toLowerCase().includes(needle))
      .slice(0, 10);
    res.json({
      q,
      items: itemHits,
      conversations: convoHits,
      reports: reportHits,
      authors: authorHits,
      builtAt: idx.builtAt,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/runs', (_req, res) => {
  const list = [...runs.values()]
    .map((r) => ({
      id: r.id,
      status: r.status,
      command: redactSecrets(r.command),
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      bulkId: r.bulkId || null,
      bulkLabel: r.bulkLabel || null,
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  // Lightweight bulk index so the UI can render a single parent
  // "operation" per bulk submission and group its child runs under it.
  // The bulk is considered done only once every child has finished.
  const bulks = [...bulkRuns.values()].map((b) => {
    const total = b.items.length;
    const done = b.items.filter((i) => i.status && i.status !== 'running' && i.status !== 'queued').length;
    const failed = b.items.filter((i) => i.status === 'error' || i.status === 'cancelled').length;
    const running = b.items.filter((i) => i.status === 'running').length;
    let status;
    if (b.cancelled && done < total) status = 'running'; // still draining
    else if (done < total) status = 'running';
    else if (failed > 0) status = 'error';
    else status = 'success';
    return {
      bulkId: b.bulkId,
      command: b.command,
      slug: b.slug || null,
      concurrency: b.concurrency || 1,
      startedAt: b.startedAt,
      total,
      done,
      failed,
      running,
      pending: b.pending,
      cancelled: !!b.cancelled,
      status,
      summaryFile: b.summaryFile || null,
    };
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  res.json({ runs: list, bulks });
});

app.get('/api/runs/:id', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json({
    id: run.id,
    status: run.status,
    command: redactSecrets(run.command),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    output: run.output,
  });
});

function buildPrompt(command, args = {}) {
  const safe = (s) => String(s).replace(/["`$\\]/g, '');
  if (command === 'custom' && typeof args.prompt === 'string') {
    return safe(args.prompt);
  }
  const parts = [`/${command}`];
  if (args.slug) parts.push(safe(args.slug));
  if (args.extra) parts.push(safe(args.extra));
  return parts.join(' ');
}

// --- Image upload for /scout-alt ----------------------------------
// Accepts a base64-encoded image plus filename, writes it to
// social-posts/images/{YYYY-MM-DD}/{timestamp}-{safe-name}.{ext}, and returns
// the workspace-relative path so the agent can read it from disk. Localhost
// only (server already binds loopback by default); 25 MB cap.
const ALT_IMAGES_ROOT = path.join(REPO_ROOT, 'social-posts', 'images');
const ALT_ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);

function safeImageName(rawName) {
  const base = String(rawName || 'image').split(/[\\/]/).pop() || 'image';
  // strip everything except letters, numbers, dot, dash, underscore
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const finalName = cleaned || 'image';
  const ext = path.extname(finalName).toLowerCase();
  return { name: finalName, ext };
}

app.post('/api/alt/upload', express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const { filename, dataBase64 } = req.body || {};
    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ error: 'filename required' });
    }
    if (!dataBase64 || typeof dataBase64 !== 'string') {
      return res.status(400).json({ error: 'dataBase64 required' });
    }
    const { name, ext } = safeImageName(filename);
    if (!ALT_ALLOWED_EXT.has(ext)) {
      return res.status(400).json({ error: `unsupported extension: ${ext || '(none)'}` });
    }
    // strip optional data URL prefix
    const stripped = dataBase64.replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(stripped, 'base64');
    if (buf.length === 0) return res.status(400).json({ error: 'empty image' });
    if (buf.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'image too large (>25MB)' });

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const dayDir = `${yyyy}-${mm}-${dd}`;
    const targetDir = path.join(ALT_IMAGES_ROOT, dayDir);
    await fs.mkdir(targetDir, { recursive: true });

    const stamp = Date.now().toString(36);
    const finalName = `${stamp}-${name}`;
    const absPath = path.join(targetDir, finalName);
    // safety: ensure resolved path stays inside ALT_IMAGES_ROOT
    if (!absPath.startsWith(ALT_IMAGES_ROOT + path.sep)) {
      return res.status(400).json({ error: 'invalid path' });
    }
    await fs.writeFile(absPath, buf);

    const relPath = path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
    const previewUrl = `/brand-assets/${dayDir}/${finalName}`;
    res.json({ relativePath: relPath, previewUrl, bytes: buf.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Vision (image describe) for /scout-alt -----------------------
async function readEnvObject() {
  const { raw } = await readEnvRaw();
  const entries = parseEnv(raw);
  const out = { ...process.env };
  for (const { key, value } of entries) {
    if (out[key] === undefined || out[key] === '') out[key] = value;
  }
  return out;
}

app.get('/api/alt/vision-status', async (_req, res) => {
  try {
    const env = await readEnvObject();
    const status = await probeVision(env);
    res.json(status);
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Read/write the small set of vision-related keys without disturbing the rest of .env.
app.get('/api/vision/config', async (_req, res) => {
  try {
    const { raw } = await readEnvRaw();
    const map = Object.fromEntries(parseEnv(raw).map((e) => [e.key, e.value]));
    res.json({
      provider: (map.VISION_PROVIDER || 'none').toLowerCase(),
      ollamaHost: map.OLLAMA_HOST || '',
      ollamaModel: map.OLLAMA_VISION_MODEL || '',
      openaiModel: map.OPENAI_VISION_MODEL || '',
      hasOpenaiKey: !!map.OPENAI_API_KEY,
      customBaseUrl: map.CUSTOM_VISION_BASE_URL || '',
      customModel: map.CUSTOM_VISION_MODEL || '',
      customAuthStyle: (map.CUSTOM_VISION_AUTH_STYLE || 'bearer').toLowerCase(),
      hasCustomKey: !!map.CUSTOM_VISION_API_KEY,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vision/config', express.json(), async (req, res) => {
  const body = req.body || {};
  const provider = String(body.provider || 'none').toLowerCase();
  if (!['none', 'ollama', 'openai', 'custom'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be none|ollama|openai|custom' });
  }
  const authStyle = body.customAuthStyle === 'api-key' ? 'api-key' : 'bearer';
  const updates = {
    VISION_PROVIDER: provider === 'none' ? '' : provider,
    OLLAMA_HOST: typeof body.ollamaHost === 'string' ? body.ollamaHost.trim() : undefined,
    OLLAMA_VISION_MODEL: typeof body.ollamaModel === 'string' ? body.ollamaModel.trim() : undefined,
    OPENAI_VISION_MODEL: typeof body.openaiModel === 'string' ? body.openaiModel.trim() : undefined,
    CUSTOM_VISION_BASE_URL: typeof body.customBaseUrl === 'string' ? body.customBaseUrl.trim() : undefined,
    CUSTOM_VISION_MODEL: typeof body.customModel === 'string' ? body.customModel.trim() : undefined,
    CUSTOM_VISION_AUTH_STYLE: typeof body.customAuthStyle === 'string' ? authStyle : undefined,
  };
  // Only persist secret keys if explicitly provided (allow blank to leave alone).
  if (typeof body.openaiApiKey === 'string' && body.openaiApiKey.length > 0) {
    updates.OPENAI_API_KEY = body.openaiApiKey.trim();
  }
  if (typeof body.customApiKey === 'string' && body.customApiKey.length > 0) {
    updates.CUSTOM_VISION_API_KEY = body.customApiKey.trim();
  }
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    if (/[\r\n]/.test(v)) return res.status(400).json({ error: `value for ${k} contains a newline` });
  }
  try {
    const { raw } = await readEnvRaw();
    const entries = parseEnv(raw);
    const seen = new Set();
    const next = [];
    for (const { key, value } of entries) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        seen.add(key);
        const v = updates[key];
        if (v === undefined) { next.push({ key, value }); continue; }
        if (v === '') continue; // drop the row entirely when cleared
        next.push({ key, value: v });
      } else {
        next.push({ key, value });
      }
    }
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === '' || seen.has(key)) continue;
      next.push({ key, value });
    }
    await fs.writeFile(ENV_FILE, serializeEnv(next), 'utf8');
    res.json({ ok: true, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recommended Ollama vision models surfaced to the UI
const OLLAMA_VISION_MODELS = [
  { name: 'llama3.2-vision', size: '~8 GB', note: 'best balance — recommended for charts & diagrams' },
  { name: 'moondream', size: '~2 GB', note: 'small & fast, great for screenshots' },
  { name: 'llava', size: '~5 GB', note: 'classic multimodal, broad compatibility' },
  { name: 'qwen2.5vl:7b', size: '~5 GB', note: 'strong on text-in-image / OCR' },
  { name: 'bakllava', size: '~5 GB', note: 'alternative to llava' },
];

app.get('/api/vision/ollama-models', (_req, res) => {
  res.json({ models: OLLAMA_VISION_MODELS });
});

// Probe localhost for known local AI services so onboarding / the vision panel
// can offer auto-detect instead of forcing users to paste localhost URLs.
// Currently checks Ollama (default 11434) and LM Studio (default 1234).
// Honors OLLAMA_HOST override from .env. Returns shape:
//   { services: [{ id, name, running, host, models?: string[], message }] }
app.get('/api/services/detect', async (_req, res) => {
  let envMap = {};
  try {
    const { raw } = await readEnvRaw();
    envMap = Object.fromEntries(parseEnv(raw).map((e) => [e.key, e.value]));
  } catch { /* fall back to {} */ }

  const probe = async (name, url, parseModels) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return { running: false, message: `${name} returned ${r.status}` };
      const data = await r.json().catch(() => ({}));
      return { running: true, models: parseModels(data), message: `${name} reachable` };
    } catch (err) {
      return { running: false, message: `${name} unreachable: ${err.message}` };
    }
  };

  const ollamaHost = (envMap.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
  const lmStudioHost = 'http://localhost:1234';

  const [ollama, lmStudio] = await Promise.all([
    probe('Ollama', `${ollamaHost}/api/tags`, (d) => (d.models || []).map((m) => m.name)),
    probe('LM Studio', `${lmStudioHost}/v1/models`, (d) => (d.data || []).map((m) => m.id)),
  ]);

  res.json({
    services: [
      { id: 'ollama', name: 'Ollama', host: ollamaHost, ...ollama },
      { id: 'lm-studio', name: 'LM Studio', host: lmStudioHost, ...lmStudio },
    ],
  });
});

// Ollama pull progress: start a pull and stream JSONL via SSE.
const ollamaPulls = new Map(); // model -> { lines: string[], done: boolean, error?: string, startedAt }

app.post('/api/vision/ollama-pull', express.json(), async (req, res) => {
  const model = String(req.body?.model || '').trim();
  if (!/^[a-z0-9._:\-/]+$/i.test(model) || model.length > 80) {
    return res.status(400).json({ error: 'invalid model name' });
  }
  if (ollamaPulls.get(model)?.done === false) {
    return res.json({ ok: true, alreadyRunning: true });
  }
  const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
  const state = { lines: [], done: false, startedAt: Date.now() };
  ollamaPulls.set(model, state);
  // Use Ollama's HTTP API (no shell) so we don't depend on the CLI being on PATH.
  (async () => {
    try {
      const r = await fetch(`${host}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: model, stream: true }),
      });
      if (!r.ok || !r.body) {
        state.error = `Ollama pull returned ${r.status}`;
        state.done = true;
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const line of parts) {
          if (!line.trim()) continue;
          state.lines.push(line);
          if (state.lines.length > 500) state.lines.splice(0, state.lines.length - 500);
        }
      }
      state.done = true;
    } catch (err) {
      state.error = err.message;
      state.done = true;
    }
  })();
  res.json({ ok: true, model });
});

app.get('/api/vision/ollama-pull/status', (req, res) => {
  const model = String(req.query?.model || '').trim();
  const state = ollamaPulls.get(model);
  if (!state) return res.json({ exists: false });
  // Parse the last JSONL line for a human-friendly status
  let last = null;
  for (let i = state.lines.length - 1; i >= 0; i--) {
    try { last = JSON.parse(state.lines[i]); break; } catch { /* skip */ }
  }
  let percent = null;
  if (last && typeof last.completed === 'number' && typeof last.total === 'number' && last.total > 0) {
    percent = Math.round((last.completed / last.total) * 100);
  }
  res.json({
    exists: true,
    done: state.done,
    error: state.error || null,
    status: last?.status || null,
    percent,
    elapsedSec: Math.round((Date.now() - state.startedAt) / 1000),
  });
});

app.post('/api/alt/describe', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const { relativePath } = req.body || {};
    if (!relativePath || typeof relativePath !== 'string') {
      return res.status(400).json({ error: 'relativePath required' });
    }
    const abs = path.resolve(REPO_ROOT, relativePath);
    if (!abs.startsWith(ALT_IMAGES_ROOT + path.sep)) {
      return res.status(400).json({ error: 'path must be under social-posts/images/' });
    }
    try { await fs.access(abs); } catch {
      return res.status(404).json({ error: 'file not found' });
    }
    const env = await readEnvObject();
    if (getVisionProvider(env) === 'none') {
      return res.status(400).json({ error: 'No vision provider configured. Set VISION_PROVIDER=ollama|openai in .env.' });
    }
    const report = await describeImage(abs, env);
    res.json({ report, formatted: formatVisionReport(report) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/runs', async (req, res) => {
  const { command, args } = req.body || {};
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'command required' });
  }
  const result = await startRunInternal(command, args || {});
  if (result.error) return res.status(result.status || 400).json(result.error);
  res.json({ id: result.id, command: result.commandLine, prompt: result.prompt });
});

// Internal helper extracted so /api/runs and /api/runs/bulk can share spawn
// logic. Returns { id, commandLine, prompt } on success or { error, status }.
async function startRunInternal(command, args, opts = {}) {
  const prompt = buildPrompt(command, args || {});
  const { runner } = await getRunner();
  if (!runner) {
    return {
      error: {
        error: 'No agent configured. Pick one on the Setup view, or set SCOUT_RUNNER env var. You can also copy the prompt and run it manually.',
        prompt,
      },
      status: 400,
    };
  }
  const id = randomUUID();
  const MAX_INLINE_CMD = 1500;
  const inlineCmd = runner.replace('{prompt}', prompt);
  let commandLine = inlineCmd;
  let usedStdin = false;
  if (inlineCmd.length > MAX_INLINE_CMD && runner.includes('{prompt}')) {
    const stripped = runner
      .replace(/\s*(?:-p|--prompt|exec)\s+["']?\{prompt\}["']?/, '')
      .replace(/\s*["']?\{prompt\}["']?/, '')
      .trim();
    commandLine = stripped;
    usedStdin = true;
  }
  const run = {
    id,
    status: 'running',
    command: commandLine,
    cmdName: command,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    output: '',
    listeners: new Set(),
    promptFile: null,
    bulkId: opts.bulkId || null,
    bulkLabel: opts.bulkLabel || null,
  };
  runs.set(id, run);
  if (usedStdin) {
    pushRunOutput(run, `[scout-web] Prompt is ${prompt.length} chars (>${MAX_INLINE_CMD}) — piping via the child process's stdin to avoid the OS command-line length limit.\n[scout-web] Spawning: ${commandLine}\n`);
  }
  if (opts.bulkLabel) {
    pushRunOutput(run, `[scout-web] Bulk run — item: ${opts.bulkLabel}\n`);
  }
  const child = spawn(commandLine, {
    shell: true,
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  run.child = child;
  if (usedStdin) {
    try {
      child.stdin.write(prompt);
      child.stdin.write('\n');
      child.stdin.end();
    } catch (err) {
      pushRunOutput(run, `\n[scout-web] Failed to write prompt to stdin: ${err.message}\n`);
    }
  }
  child.stdout.on('data', (d) => pushRunOutput(run, d.toString()));
  child.stderr.on('data', (d) => pushRunOutput(run, d.toString()));
  const cleanupPromptFile = () => {
    if (run.promptFile) {
      fs.unlink(run.promptFile).catch(() => {});
      run.promptFile = null;
    }
  };
  child.on('close', (code) => {
    run.child = null;
    cleanupPromptFile();
    closeRun(run, code === 0 ? 'success' : `exited ${code}`);
    if (opts.onClose) {
      try { opts.onClose(run); } catch {}
    }
  });
  child.on('error', (err) => {
    pushRunOutput(run, `\n[runner error] ${err.message}\n`);
    run.child = null;
    cleanupPromptFile();
    closeRun(run, 'error');
    if (opts.onClose) {
      try { opts.onClose(run); } catch {}
    }
  });
  return { id, commandLine, prompt };
}

// Allowed bulk commands — these are the ones that take a single URL or
// per-item input, so running them once-per-URL makes sense.
const BULK_COMMANDS = new Set(['scout-post', 'scout-seo', 'scout-reddit-import', 'scout-alt']);

// Bulk URL submission. Body: { command, slug, urls: [string], extra?, range? }
// Spawns one /command run per URL **sequentially** (not in parallel) so the
// underlying agent doesn't race file writes or rate-limit itself. Returns
// the list of accepted URLs immediately; clients track progress via the
// existing /api/runs queue UI.
app.post('/api/runs/bulk', express.json({ limit: '512kb' }), async (req, res) => {
  const { command, slug, urls, extra, range, concurrency } = req.body || {};
  if (!command || typeof command !== 'string' || !BULK_COMMANDS.has(command)) {
    return res.status(400).json({
      error: `bulk runs supported only for: ${[...BULK_COMMANDS].join(', ')}`,
    });
  }
  if (!Array.isArray(urls) || !urls.length) {
    return res.status(400).json({ error: 'urls (non-empty array) required' });
  }
  // Sanitize entries: accept either a plain URL string or a { url, notes }
  // object. Keep http(s) only, dedupe by URL, cap URL/notes length to avoid
  // abuse. Notes are appended to each URL's prompt so the agent treats them
  // as guidance for the generated post (tone, audience, angle, etc.).
  const NOTES_MAX = 500;
  const sanitizeNotes = (raw) => {
    if (typeof raw !== 'string') return '';
    // Strip control chars + collapse whitespace; trim; cap.
    const cleaned = raw.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned.length > NOTES_MAX ? cleaned.slice(0, NOTES_MAX) : cleaned;
  };
  const seen = new Set();
  const cleaned = [];
  for (const raw of urls) {
    let url;
    let notes = '';
    if (typeof raw === 'string') {
      url = raw;
    } else if (raw && typeof raw === 'object') {
      url = raw.url;
      notes = sanitizeNotes(raw.notes);
    } else {
      continue;
    }
    if (typeof url !== 'string') continue;
    const u = url.trim();
    if (!u) continue;
    if (!/^https?:\/\//i.test(u)) continue;
    if (u.length > 2048) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    cleaned.push({ url: u, notes });
  }
  if (!cleaned.length) {
    return res.status(400).json({ error: 'no valid http(s) URLs found' });
  }
  if (cleaned.length > 100) {
    return res.status(400).json({ error: 'bulk run capped at 100 URLs per submission' });
  }
  const safeExtra = typeof extra === 'string' ? extra.trim() : '';
  const safeRange = typeof range === 'string' ? range.trim() : '';
  const safeSlug = typeof slug === 'string' && isValidSlug(slug) ? slug : '';
  // Concurrency: how many agent subprocesses to run side-by-side. Each
  // worker is an independent /scout-* invocation, so this gives genuine
  // parallelism (separate Node + agent processes, separate network
  // sockets). Capped to keep CPU/RAM/API-rate-limit usage sane.
  const MAX_CONCURRENCY = 6;
  const reqConc = Number(concurrency);
  const safeConcurrency = Number.isFinite(reqConc) && reqConc >= 1
    ? Math.min(MAX_CONCURRENCY, Math.floor(reqConc))
    : 1;
  const bulkId = randomUUID();
  const accepted = [];

  // Pre-seed the bulk record so we can update each item as runs close.
  // Items keep insertion order so the summary table mirrors the input list.
  const bulkRecord = {
    bulkId,
    command,
    slug: safeSlug,
    concurrency: safeConcurrency,
    startedAt: new Date().toISOString(),
    items: cleaned.map(({ url, notes }) => ({
      url,
      notes,
      runId: null,
      status: 'queued',
      posts: [],
      output: '',
      error: null,
    })),
    pending: cleaned.length,
    summaryWritten: false,
    summaryFile: null,
  };
  bulkRuns.set(bulkId, bulkRecord);

  const finalizeItem = (item, run) => {
    item.status = run ? run.status : 'error';
    item.posts = run ? extractSocialPostPaths(run.output) : [];
    // Capture the (already-redacted) run output so the bulk summary can
    // inline the post body even if no `social-posts/*.md` file was written
    // — and so the bulk report is fully self-contained (no cross-file
    // links that may or may not resolve in the user's markdown viewer).
    item.output = run ? (run.output || '') : '';
    if (run && run.status !== 'success' && !item.error) {
      item.error = `Run exited with status: ${run.status}`;
    }
    bulkRecord.pending = Math.max(0, bulkRecord.pending - 1);
    if (bulkRecord.pending === 0) {
      writeBulkSummary(bulkId).catch(() => {});
    }
  };

  let cursor = 0;
  const startNext = async () => {
    if (bulkRecord.cancelled) {
      // User pressed Stop. Mark every still-queued item as cancelled and
      // finalize the bulk run so the summary file gets written.
      for (let i = cursor; i < bulkRecord.items.length; i++) {
        const it = bulkRecord.items[i];
        it.status = 'cancelled';
        it.error = 'Cancelled before start (Stop pressed).';
        bulkRecord.pending = Math.max(0, bulkRecord.pending - 1);
      }
      cursor = bulkRecord.items.length;
      if (bulkRecord.pending === 0) {
        writeBulkSummary(bulkId).catch(() => {});
      }
      return;
    }
    if (cursor >= bulkRecord.items.length) return;
    const item = bulkRecord.items[cursor++];
    // Notes (if any) are surfaced to the agent as a labelled trailing
    // segment so it's clear they are guidance for shaping the post — not
    // additional URLs or unrelated args.
    const noteSegment = item.notes ? `Notes: ${item.notes}` : '';
    const args = {
      slug: safeSlug,
      extra: [safeRange, item.url, safeExtra, noteSegment].filter(Boolean).join(' '),
    };
    const r = await startRunInternal(command, args, {
      bulkId,
      bulkLabel: item.url,
      onClose: (run) => {
        finalizeItem(item, run);
        startNext().catch(() => {});
      },
    });
    if (r.error) {
      // Skip this URL and continue with the next so one bad URL doesn't
      // stall the whole queue. Record the failure so the manifest reports it.
      item.status = 'error';
      item.error = (r.error && r.error.error) || 'Failed to start run.';
      bulkRecord.pending = Math.max(0, bulkRecord.pending - 1);
      if (bulkRecord.pending === 0) {
        writeBulkSummary(bulkId).catch(() => {});
      }
      startNext().catch(() => {});
      return;
    }
    item.runId = r.id;
    item.status = 'running';
    accepted.push({ url: item.url, runId: r.id });
  };

  // Kick off `safeConcurrency` workers in parallel. Each worker calls
  // startNext() on close, which pulls the next pending item off the shared
  // cursor — so workers stay saturated until the queue drains. With
  // concurrency=1 this is identical to the old sequential behavior.
  const initial = Math.min(safeConcurrency, bulkRecord.items.length);
  await Promise.all(Array.from({ length: initial }, () => startNext().catch(() => {})));

  res.json({
    bulkId,
    command,
    queued: cleaned.length,
    concurrency: safeConcurrency,
    urls: cleaned.map((c) => c.url),
  });
});

// Inspect a bulk run (per-URL status + final summary file once written).
app.get('/api/runs/bulk/:id', (req, res) => {
  const bulk = bulkRuns.get(req.params.id);
  if (!bulk) return res.status(404).json({ error: 'not found' });
  res.json({
    bulkId: bulk.bulkId,
    command: bulk.command,
    slug: bulk.slug,
    concurrency: bulk.concurrency || 1,
    startedAt: bulk.startedAt,
    pending: bulk.pending,
    summaryFile: bulk.summaryFile,
    items: bulk.items.map((i) => ({
      url: i.url,
      notes: i.notes || '',
      runId: i.runId,
      status: i.status,
      posts: i.posts,
      error: i.error,
    })),
  });
});

// Downloadable CSV template for the "Bulk URLs" feature. Headers match the
// fields that the bulk endpoint understands; comments at the top explain
// each column. Served as text/csv with a Content-Disposition so the browser
// triggers a download.
app.get('/api/templates/urls.csv', (_req, res) => {
  const csv =
    'url,notes\n' +
    '# url    — required. Must be http:// or https://\n' +
    '# notes  — optional. Free-text guidance that influences the generated post:\n' +
    '#          tone, audience, angle, hashtags to favor, things to avoid, etc.\n' +
    '#          Each note is appended to that URL\'s prompt as extra context.\n' +
    '#          Wrap in double-quotes if the note contains a comma.\n' +
    'https://example.com/post-one,"casual tone; emphasize the perf gains; one CTA"\n' +
    'https://example.com/post-two,"developer audience; lead with the code sample"\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="content-scout-urls-template.csv"');
  res.send(csv);
});



// Write a message to a running process's stdin — used by the in-browser
// "reply to the agent" UI for custom prompts and interactive flows.
app.post('/api/runs/:id/input', express.json(), (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  if (run.status !== 'running' || !run.child || !run.child.stdin || run.child.stdin.destroyed) {
    return res.status(409).json({ error: 'run is not accepting input' });
  }
  const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
  try {
    run.child.stdin.write(text.endsWith('\n') ? text : text + '\n');
    // Echo into the run output so the transcript shows what the user said.
    pushRunOutput(run, `\n› ${text}\n`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Request the runner to stop. Tries SIGINT first, then SIGTERM.
// On Windows, child.kill() doesn't propagate to grandchildren when the child
// was spawned with `shell: true`, so the actual agent process keeps running
// after we kill the cmd.exe wrapper. Use `taskkill /pid <pid> /T /F` there to
// terminate the whole tree. Also mark the parent bulk run (if any) as
// cancelled so queued items don't auto-start.
app.post('/api/runs/:id/stop', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  if (run.bulkId) {
    const bulk = bulkRuns.get(run.bulkId);
    if (bulk) bulk.cancelled = true;
  }
  if (run.status !== 'running' || !run.child) return res.json({ ok: true, note: 'not running' });
  try {
    run.stopRequested = true;
    if (process.platform === 'win32') {
      // /T = tree (kill descendants), /F = force.
      const killer = spawn('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], {
        windowsHide: true,
      });
      killer.on('error', () => {
        try { run.child && run.child.kill('SIGTERM'); } catch {}
      });
    } else {
      run.child.kill('SIGINT');
      setTimeout(() => { try { run.child && run.child.kill('SIGTERM'); } catch {} }, 2000);
      setTimeout(() => { try { run.child && run.child.kill('SIGKILL'); } catch {} }, 5000);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/runs/:id/stream', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).end();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  if (run.output) {
    res.write(`data: ${JSON.stringify({ chunk: run.output })}\n\n`);
  }
  if (run.status !== 'running') {
    res.write(`event: done\ndata: ${JSON.stringify({ status: run.status })}\n\n`);
    return res.end();
  }
  run.listeners.add(res);
  req.on('close', () => run.listeners.delete(res));
});

// ===== Browser-scan integration ===================================
// Surfaces the tools/browser-scan/ tool inside the web UI: list known
// browsers, check whether the user is logged in (via the CDP debug port),
// launch the helper to open Edge/Chrome with the debug port, and trigger
// a scan that writes Layer-0 sidecars under reports/.browser-scan/{slug}/.

const BROWSER_SCAN_DIR = path.join(REPO_ROOT, 'tools', 'browser-scan');
const BROWSER_SCAN_INSTALLED = fsExistsSync(path.join(BROWSER_SCAN_DIR, 'index.mjs'));

// Reused by /api/browser-scan/status to peek at the CDP port without
// requiring playwright (the agent server doesn't have it; only the
// browser-scan tool does).
async function probeCdpPort(port) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { up: false, status: r.status };
    const body = await r.json().catch(() => null);
    return { up: true, browser: body?.Browser || null };
  } catch (err) {
    return { up: false, error: err.message };
  }
}

// GET /api/browser-scan/info — capabilities + which Chromium-family
// browsers are installed on this machine.
app.get('/api/browser-scan/info', async (_req, res) => {
  if (!BROWSER_SCAN_INSTALLED) {
    return res.json({
      installed: false,
      reason: 'tools/browser-scan/ is not present in this checkout',
    });
  }
  let browsers = [];
  let pickResult = null;
  try {
    const detect = await import(`file://${path.join(BROWSER_SCAN_DIR, 'lib', 'browser-detect.mjs').replace(/\\/g, '/')}`);
    browsers = detect.listKnownBrowsers();
    pickResult = detect.pickBrowser({});
  } catch (err) {
    return res.json({ installed: true, error: `Could not load browser-detect: ${err.message}`, browsers: [] });
  }
  res.json({
    installed: true,
    cdpPort: 9222,
    browsers,
    recommended: pickResult?.ok ? { name: pickResult.browser.name, source: pickResult.source, notice: pickResult.notice } : null,
    error: pickResult?.ok ? null : pickResult?.error || null,
  });
});

// GET /api/browser-scan/status — is Edge/Chrome currently running with
// CDP enabled? Are the three sessions active? Lists sidecars per slug.
app.get('/api/browser-scan/status', async (req, res) => {
  if (!BROWSER_SCAN_INSTALLED) return res.json({ installed: false });
  const port = Number(req.query.port || 9222);
  const cdp = await probeCdpPort(port);
  // List sidecars per slug under reports/.browser-scan/{slug}/
  const sidecarRoot = path.join(REPORTS_DIR, '.browser-scan');
  const bySlug = {};
  try {
    const slugs = await fs.readdir(sidecarRoot);
    for (const slug of slugs) {
      if (!isValidSlug(slug)) continue;
      const slugDir = path.join(sidecarRoot, slug);
      let files = [];
      try { files = await fs.readdir(slugDir); } catch { continue; }
      const platforms = {};
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const m = f.match(/^(\d{4}-\d{2}-\d{2}-\d{4})-(x|linkedin|reddit)\.json$/);
        if (!m) continue;
        const platform = m[2];
        const stamp = m[1];
        let stat = null;
        try { stat = await fs.stat(path.join(slugDir, f)); } catch { continue; }
        const existing = platforms[platform];
        if (!existing || stamp > existing.stamp) {
          platforms[platform] = { stamp, file: f, mtime: stat.mtimeMs };
        }
      }
      bySlug[slug] = platforms;
    }
  } catch { /* no sidecar dir yet */ }
  res.json({
    installed: true,
    port,
    cdp,
    sidecarsBySlug: bySlug,
  });
});

// POST /api/browser-scan/launch — spawn launch-edge.mjs in the background.
// Body: { browser?: 'Microsoft Edge'|... , port?: 9222, useDefaultProfile?: false }
app.post('/api/browser-scan/launch', async (req, res) => {
  if (!BROWSER_SCAN_INSTALLED) return res.status(404).json({ error: 'browser-scan not installed' });
  const { browser, port, useDefaultProfile } = req.body || {};
  // Refuse if CDP is already up — don't accidentally double-launch.
  const existing = await probeCdpPort(Number(port || 9222));
  if (existing.up) {
    return res.json({ ok: true, alreadyRunning: true, browser: existing.browser });
  }
  const launcher = path.join(BROWSER_SCAN_DIR, 'launch-edge.mjs');
  const args = [launcher];
  if (port) args.push('--port', String(Number(port)));
  if (browser) args.push('--browser', String(browser));
  if (useDefaultProfile) args.push('--use-default-profile');
  // Use the same node binary the server is running on.
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  res.json({ ok: true, pid: child.pid, alreadyRunning: false });
});

// POST /api/browser-scan/scan — run `node index.mjs scan --slug {slug}`
// as a child process and stream output via the same /api/runs/:id/stream
// surface used by other commands.
app.post('/api/browser-scan/scan', async (req, res) => {
  if (!BROWSER_SCAN_INSTALLED) return res.status(404).json({ error: 'browser-scan not installed' });
  const { slug, platforms, port } = req.body || {};
  if (!slug || !isValidSlug(slug)) return res.status(400).json({ error: 'valid slug required' });
  // Make sure CDP is reachable before spawning — friendlier error than the
  // child failing 8 seconds in.
  const probe = await probeCdpPort(Number(port || 9222));
  if (!probe.up) {
    return res.status(409).json({
      error: 'No browser is listening on the CDP port. Click "Open browser" first to launch and sign in.',
      port: Number(port || 9222),
    });
  }
  const args = [path.join(BROWSER_SCAN_DIR, 'index.mjs'), 'scan', '--slug', slug];
  if (port) { args.push('--port', String(Number(port))); }
  if (Array.isArray(platforms) && platforms.length) {
    const valid = platforms.filter((p) => ['x', 'linkedin', 'reddit'].includes(p));
    if (valid.length) args.push('--platforms', valid.join(','));
  }
  // Reuse the existing run plumbing so the operations queue + output
  // streaming Just Work.
  const id = randomUUID();
  const cmdName = 'browser-scan';
  const command = `${process.execPath} ${args.join(' ')}`;
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: process.env,
  });
  const run = {
    id,
    cmdName,
    command,
    output: '',
    listeners: new Set(),
    status: 'running',
    startedAt: new Date().toISOString(),
    child,
  };
  runs.set(id, run);
  child.stdout.on('data', (d) => pushRunOutput(run, d.toString()));
  child.stderr.on('data', (d) => pushRunOutput(run, d.toString()));
  child.on('close', (code) => { run.child = null; closeRun(run, code === 0 ? 'success' : `exited ${code}`); });
  child.on('error', (err) => { pushRunOutput(run, `[browser-scan] ${err.message}\n`); run.child = null; closeRun(run, 'error'); });
  res.json({ ok: true, id, command });
});

app.listen(PORT, HOST, async () => {
  const { runner, source } = await getRunner();
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Content Scout web UI running at http://${displayHost}:${PORT}`);
  console.log(`Repo root: ${REPO_ROOT}`);
  console.log(`Bind: ${HOST}${HOST === '0.0.0.0' ? ' (LAN-exposed — set SCOUT_HOST=127.0.0.1 to restrict)' : ' (loopback only)'}`);
  console.log(`Runner: ${runner || '(none — pick an agent on the Setup view)'}${source !== 'none' ? ` [${source}]` : ''}`);
  // Health check: warn if any command-prompt files referenced by the UI are
  // missing from disk, AND warn if any command-style prompt files exist on
  // disk that the UI doesn't know about (likely orphans from a removed feature
  // or a typo). scout-config-*.prompt.md is excluded — those are user configs.
  const expectedPrompts = [
    'scout-onboard.prompt.md', 'scout-scan.prompt.md', 'scout-post.prompt.md',
    'scout-calendar.prompt.md', 'scout-gaps.prompt.md', 'scout-trends.prompt.md',
    'scout-creators.prompt.md', 'scout-doctor.prompt.md', 'scout-keys.prompt.md',
    'scout-replay.prompt.md', 'scout-seo.prompt.md', 'scout-reddit-import.prompt.md',
    'scout-alt.prompt.md', 'scout-vision.prompt.md',
  ];
  let diskFiles = [];
  try { diskFiles = await fs.readdir(PROMPTS_DIR); } catch { /* ignore */ }
  const missing = findMissingPrompts(expectedPrompts, diskFiles);
  if (missing.length) {
    console.warn(`[warn] missing prompt files (${missing.length}): ${missing.join(', ')}`);
  }
  const unreferenced = findUnreferencedPrompts(expectedPrompts, diskFiles);
  if (unreferenced.length) {
    console.warn(`[warn] unreferenced prompt files (${unreferenced.length}) — on disk but not wired into the UI: ${unreferenced.join(', ')}`);
  }
});
