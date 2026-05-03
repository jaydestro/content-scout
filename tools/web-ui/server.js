import express from 'express';
import { marked } from 'marked';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateFormat, testReachability, listSupportedKeys } from './lib/key-checks.js';
import { isValidSlug, isValidFilename, safeJoin } from './lib/security.js';
import { validateRawConfig } from './lib/config-validator.js';
import createSuggestionsRouter from './routes/suggestions.js';
import { ROLE_PRESETS, renderConfigTemplate } from './lib/config-template.js';
import { findMissingPrompts, findUnreferencedPrompts } from './lib/prompt-health.js';

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
app.use(express.json({ limit: '2mb' }));
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

function pushRunOutput(run, chunk) {
  run.output += chunk;
  for (const listener of run.listeners) {
    try {
      listener.write(`data: ${JSON.stringify({ chunk })}\n\n`);
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
      command: r.command,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  res.json({ runs: list });
});

app.get('/api/runs/:id', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json({
    id: run.id,
    status: run.status,
    command: run.command,
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

app.post('/api/runs', async (req, res) => {
  const { command, args } = req.body || {};
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'command required' });
  }
  const prompt = buildPrompt(command, args || {});
  const { runner } = await getRunner();

  if (!runner) {
    return res.status(400).json({
      error: 'No agent configured. Pick one on the Setup view, or set SCOUT_RUNNER env var. You can also copy the prompt and run it manually.',
      prompt,
    });
  }

  const id = randomUUID();
  const commandLine = runner.replace('{prompt}', prompt);
  const run = {
    id,
    status: 'running',
    command: commandLine,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    output: '',
    listeners: new Set(),
  };
  runs.set(id, run);

  const child = spawn(commandLine, {
    shell: true,
    cwd: REPO_ROOT,
    env: process.env,
  });
  run.child = child;
  child.stdout.on('data', (d) => pushRunOutput(run, d.toString()));
  child.stderr.on('data', (d) => pushRunOutput(run, d.toString()));
  child.on('close', (code) => { run.child = null; closeRun(run, code === 0 ? 'success' : `exited ${code}`); });
  child.on('error', (err) => {
    pushRunOutput(run, `\n[runner error] ${err.message}\n`);
    run.child = null;
    closeRun(run, 'error');
  });

  res.json({ id, command: commandLine, prompt });
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
app.post('/api/runs/:id/stop', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  if (run.status !== 'running' || !run.child) return res.json({ ok: true, note: 'not running' });
  try {
    run.child.kill('SIGINT');
    setTimeout(() => { try { run.child && run.child.kill('SIGTERM'); } catch {} }, 2000);
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
