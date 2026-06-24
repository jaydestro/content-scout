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
import { reviewSentiment, probeSentiment, getSentimentProvider } from './lib/sentiment-review.js';
import { getSeoRewriteProvider, generateSeoRewrites, hasAnyRewrite } from './lib/seo-rewrite.js';
import { suggestReply, getReplyProvider } from './lib/reply-suggest.js';
import { searchCorpus } from '../lib/corpus-search.mjs';
import { extractDocMeta } from '../lib/doc-meta.mjs';
import { responseCache } from '../lib/response-cache.mjs';
import { getCopilotModels, warmCopilotModels } from './lib/copilot-models.mjs';
import { probeUrl } from '../lib/url-validate.mjs';
import {
  runSeoAudit,
  extractSeoSnapshot,
  htmlToText,
} from '../lib/analytics.mjs';
import {
  loadReport,
  parseReport,
  parseReportFromJson,
  normalizeSentiment,
  classifyItem,
  canonicalUrlKey,
  platformFromUrl,
  isProductAuthorName,
  parseProductTeamNamesFromConfig,
  handleFromUrl,
} from '../lib/report-index.mjs';
import { isHiringContent } from '../browser-scan/lib/hiring-filter.mjs';
import {
  SENTIMENT_OVERRIDES_FILE,
  WEB_SETTINGS_FILE,
  STATE_DIR,
  stateFilePath,
  resolveStateRead,
  resolveStateWrite,
  SCOUT_STATE_DIR,
  LEGACY_SCOUT_STATE_DIR,
  browserScanReadDirs,
  BROWSER_SCAN_DIR as BROWSER_SCAN_SIDECAR_DIR,
  LEGACY_BROWSER_SCAN_DIR,
  BROWSER_PROFILE_DIR,
  LEGACY_BROWSER_PROFILE_DIR,
} from '../lib/paths.mjs';
import {
  ALLOWED_REASONS,
  convoKey,
  loadClosed,
  closeMany,
  reopenMany,
} from './lib/closed-conversations.js';
import {
  loadMuted,
  muteAccount,
  unmuteMany,
  isMutedConv,
  mutedInfoForConv,
  isNoTriageInfo,
  muteKey,
  normHandle,
  normPlatform,
  NO_TRIAGE_REASON,
  parseOwnedAccountsFromConfig,
  parseTeamMemberAccountsFromConfig,
} from './lib/muted-accounts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Render single newlines as <br> so report front-matter (consecutive
// `**Generated:** ...` lines) doesn't collapse into one paragraph.
marked.setOptions({ breaks: true, gfm: true });

// Repo root = tools/web-ui/../..
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROMPTS_DIR = path.join(REPO_ROOT, '.github', 'prompts');
// Personal product configs live in the gitignored .local/configs/ dir
// (standard location: scout-config-{slug}.md). Legacy installs kept them in
// .github/prompts/scout-config-{slug}.prompt.md. Reads prefer .local; writes
// always go to .local so a config can never be accidentally committed.
const CONFIGS_DIR = path.join(REPO_ROOT, '.local', 'configs');
const REPORTS_DIR = path.join(REPO_ROOT, 'reports');
const SOCIAL_DIR = path.join(REPO_ROOT, 'social-posts');
const ENV_FILE = path.join(REPO_ROOT, '.env');
const ENV_EXAMPLE = path.join(REPO_ROOT, '.env.example');
const SETTINGS_FILE = path.join(__dirname, '.scout-web-settings.json');
const SETTINGS_FILE_NEW = stateFilePath(WEB_SETTINGS_FILE);

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
    note: 'Runs /scout-* prompts non-interactively via Claude Code.',
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot runner',
    runner: 'copilot --allow-all-tools --allow-all-paths --allow-all-urls -p "{prompt}"',
    install: 'https://docs.github.com/en/copilot/github-copilot-in-the-cli',
    note: 'Requires the newer `copilot` headless runner (not `gh copilot`). Runs with --allow-all-tools/paths/urls so the agent can fetch web content and execute shell commands without an interactive permission prompt (there is no TTY when spawned by the server). Tighten the runner string in Settings if you want to scope it.',
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex runner',
    runner: 'codex exec "{prompt}"',
    install: 'https://github.com/openai/codex',
    note: 'Non-interactive exec mode. Reads repo context automatically.',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor agent runner',
    runner: 'cursor-agent -p "{prompt}"',
    install: 'https://docs.cursor.com/en/cli/overview',
    note: 'Headless Cursor agent. Reads `.cursor/rules/content-scout.mdc` automatically.',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini runner',
    runner: 'gemini -p "{prompt}"',
    install: 'https://github.com/google-gemini/gemini-cli',
    note: 'Google Gemini in non-interactive prompt mode.',
  },
  none: {
    id: 'none',
    label: 'In-editor only (VS Code Copilot / Windsurf / Cline) — copy prompts manually',
    runner: '',
    note: 'For editor-embedded agents without a headless runner. The Run view will show the prompt text so you can paste it into your editor\'s chat panel.',
  },
};

// --- Model selection ----------------------------------------------
// Optional per-session model override. The runner is a shell command string;
// when a model is chosen we inject "<flag> <model>" right after the binary name
// (first token) so it lands before any subcommand (e.g. `codex exec`). Only
// agents listed here support a model switch; custom runners are left untouched
// (the user fully controls their own string).
const MODEL_FLAG = {
  claude: '--model',
  copilot: '--model',
  codex: '--model',
  cursor: '--model',
  gemini: '--model',
};

// Curated suggestions surfaced in the UI dropdown. Each entry carries a short
// label plus `reasoning` and `context` metadata so the picker can show what
// each model is good at and how much it can hold. These are NOT a live query of
// the CLI — the actual set of models a CLI accepts is fetched at runtime and
// depends on your account/plan, and the CLIs have no offline "list models"
// command. Free-text is always allowed (the UI offers an "Other…" entry) so
// volatile/preview model ids we don't hard-code still work, and "Agent default"
// (copilot also accepts the "auto" id) leaves the CLI's built-in choice. CLIs
// rename model ids often, so treat these as guidance — if a run errors on an
// unknown id, switch to "Other…", "auto", or "Agent default".
const MODEL_SUGGESTIONS = {
  claude: [
    { id: 'haiku', label: 'Haiku', reasoning: 'Fast, light reasoning', context: '200K' },
    { id: 'sonnet', label: 'Sonnet', reasoning: 'Balanced, extended thinking', context: '200K' },
    { id: 'opus', label: 'Opus', reasoning: 'Deepest reasoning', context: '200K' },
  ],
  copilot: [
    { id: 'auto', label: 'Auto', reasoning: 'Let Copilot pick the best model' },
    { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', reasoning: 'Balanced, extended thinking', context: '200K' },
    { id: 'claude-opus-4.5', label: 'Claude Opus 4.5', reasoning: 'Deepest reasoning', context: '200K' },
    { id: 'gpt-5.1', label: 'GPT-5.1', reasoning: 'Strong general reasoning', context: '128K' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', reasoning: 'Huge context', context: '1M' },
  ],
  codex: [
    { id: 'gpt-5-codex', label: 'GPT-5 Codex', reasoning: 'Agentic coding reasoning', context: '128K' },
    { id: 'o4-mini', label: 'o4-mini', reasoning: 'Fast reasoning', context: '128K' },
  ],
  cursor: [
    { id: 'sonnet-4.5', label: 'Sonnet 4.5', reasoning: 'Balanced, extended thinking', context: '200K' },
    { id: 'gpt-5', label: 'GPT-5', reasoning: 'Strong general reasoning', context: '128K' },
  ],
  gemini: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', reasoning: 'Deep reasoning, huge context', context: '1M' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', reasoning: 'Fast, light reasoning', context: '1M' },
  ],
};

// Model ids are inserted into a shell command (spawned with shell:true), so we
// allow only a conservative character set to prevent argument/command
// injection. Anything outside this set disables injection rather than risking a
// malformed or abusable command.
const MODEL_SAFE_RE = /^[A-Za-z0-9._:@/-]+$/;

// Resolve the model suggestion list for an agent. For Copilot we try to
// inherit the live, plan-specific list from the CLI's ACP server; on any
// failure we fall back to the curated static list above.
async function modelSuggestionsFor(agentId) {
  if (agentId === 'copilot') {
    try {
      const live = await getCopilotModels();
      if (live && live.length) return live;
    } catch { /* fall through to static */ }
  }
  return MODEL_SUGGESTIONS[agentId] || [];
}

function injectModel(runner, agent, model) {
  if (!runner || !model) return runner;
  const flag = MODEL_FLAG[agent];
  if (!flag) return runner;                       // agent doesn't support a model switch
  if (!MODEL_SAFE_RE.test(model)) return runner;  // reject unsafe ids
  // Don't double-inject if the runner string already carries the flag.
  const flagRe = new RegExp(`(^|\\s)${flag.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}([=\\s]|$)`);
  if (flagRe.test(runner)) return runner;
  const trimmed = runner.replace(/^\s+/, '');
  const sp = trimmed.indexOf(' ');
  if (sp === -1) return `${trimmed} ${flag} ${model}`;
  const bin = trimmed.slice(0, sp);
  const rest = trimmed.slice(sp + 1);
  return `${bin} ${flag} ${model} ${rest}`;
}

// --- Settings persistence -----------------------------------------
// Settings live at .local/state/web-settings.json. Reads fall back to the
// legacy tools/web-ui/.scout-web-settings.json so the first run after the
// path-refactor doesn't lose the saved agent/runner.
async function loadSettings() {
  let raw;
  try {
    raw = await fs.readFile(SETTINGS_FILE_NEW, 'utf8');
  } catch {
    try {
      raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    } catch {
      return { agent: null, runner: '', model: '' };
    }
  }
  try {
    const data = JSON.parse(raw);
    return {
      agent: typeof data.agent === 'string' ? data.agent : null,
      runner: typeof data.runner === 'string' ? data.runner : '',
      model: typeof data.model === 'string' ? data.model : '',
    };
  } catch {
    return { agent: null, runner: '', model: '' };
  }
}

async function saveSettings(settings) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE_NEW, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

// Effective runner: env var wins, then saved settings (with optional model
// injected). The env runner is used verbatim — never model-injected — because
// the operator set it explicitly.
async function getRunner() {
  if (typeof process.env.SCOUT_RUNNER === 'string' && process.env.SCOUT_RUNNER.length > 0) {
    return { runner: process.env.SCOUT_RUNNER, source: 'env', model: '' };
  }
  const s = await loadSettings();
  let runner = s.runner || '';
  if (runner && s.model) runner = injectModel(runner, s.agent, s.model);
  return { runner, source: s.runner ? 'settings' : 'none', model: s.model || '' };
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
// Defense-in-depth: wrap res.json so every JSON response body has all string
// fields run through redactSecrets. Catches `err.message` payloads from
// upstream API failures that may echo URLs or headers containing keys, without
// requiring every endpoint to remember to call redactSecrets itself.
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (body) => origJson(redactDeep(body));
  next();
});
function redactDeep(v) {
  if (v == null) return v;
  if (typeof v === 'string') return redactSecrets(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = redactDeep(v[i]);
    return v;
  }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) v[k] = redactDeep(v[k]);
    return v;
  }
  return v;
}
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
  // or streaming. Defense-in-depth: even if a runner prints a key, the UI and
  // the persisted in-memory log will only ever see [REDACTED:KEY].
  const safe = redactSecrets(chunk);
  run.output += safe;
  for (const listener of run.listeners) {
    try {
      listener.write(`data: ${JSON.stringify({ chunk: safe })}\n\n`);
    } catch {}
  }
}

function safeRunOutput(run) {
  return redactSecrets(run && run.output ? run.output : '');
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
  // A finished scan/post run has (likely) written new reports or social-posts
  // to disk. Proactively drop the TTL response caches and the parsed index so
  // the dashboard, Conversations, and Reports reflect the new artifacts on the
  // next request instead of serving up-to-30s-stale data. The index also
  // self-invalidates via its content signature, but clearing here removes the
  // directory-cache lag so a just-completed scan shows up immediately.
  if (status === 'success') {
    clearArtifactResponseCaches();
    _indexCache = null;
    // Rebuild the index in the background with the now-fresh directory
    // listing so the next dashboard / Conversations load after a scan is
    // served warm. Without this, a just-finished scan invalidates the cache
    // and the next visit pays a cold rebuild that can time out the
    // Community-signals card and make the dashboard look broken until a
    // manual refresh. Fire-and-forget; failures simply rebuild on demand.
    getIndex().catch(() => { /* will rebuild on demand */ });
  }
  // Auto-render thumbnails for any run that produced a social-posts/*.md.
  // scout-post always writes one. scout-scan only writes one when the user
  // explicitly asked for social posts (opt-in) — a plain scan is report-only,
  // so autoRenderThumbnails freshness-gates on run.startedAt and no-ops when
  // this run didn't produce a new social-posts file. Fire-and-forget so the
  // SSE close above isn't delayed. Honor the per-run `options.skipThumbnails`
  // flag set when the user chose "Thumbnail style: Off" in the Run form.
  if (status === 'success' && (run.cmdName === 'scout-post' || run.cmdName === 'scout-scan')) {
    if (run.options && run.options.skipThumbnails) {
      pushRunOutput(run, `\n[scout-web] Skipping auto-thumbnail render (Thumbnail style: Off).\n`);
    } else {
      autoRenderThumbnails(run).catch(() => {});
    }
  }
  // CFPs + Conferences are no longer written as separate dated artifacts.
  // Each /scout-scan now produces ONE consolidated content report whose
  // "Open Calls for Papers (CFPs)" and "Conferences & Events" sections hold
  // that data inline (navigable via the in-doc section nav and in a plain
  // editor). The read-only /api/cfp-conferences live snapshot remains
  // available for ad-hoc lookups.
}

// Find the most-recently-modified social-posts/*.md file (bulk, solo, or
// calendar). Returns { name, mtimeMs } or null. Used to freshness-gate the
// auto-thumbnail render so a report-only scan doesn't re-render an old batch.
async function newestSocialPostFile() {
  const dir = path.join(REPO_ROOT, 'social-posts');
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  let best = null;
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    try {
      const st = await fs.stat(path.join(dir, name));
      if (!best || st.mtimeMs > best.mtimeMs) best = { name, mtimeMs: st.mtimeMs };
    } catch {
      /* ignore unreadable entry */
    }
  }
  return best;
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
  // Only render when THIS run actually produced (or updated) a social-posts
  // markdown file. Social posts are opt-in for /scout-scan now: a plain scan
  // writes the report only, leaving social-posts/ untouched, so we must not
  // re-render an older batch. scout-post (and an opt-in scan that generated
  // posts) writes a fresh file, so newest.mtime >= run.startedAt holds there.
  const newest = await newestSocialPostFile();
  if (!newest) return;
  if (run.startedAt && newest.mtimeMs < Date.parse(run.startedAt) - 1000) {
    return; // nothing new in social-posts/ from this run
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
// Config file resolution: the standard home is .local/configs/scout-config-
// {slug}.md (gitignored). The legacy home was .github/prompts/scout-config-
// {slug}.prompt.md. Reads prefer .local and fall back to legacy; writes go to
// .local only (and clean up any legacy copy) so configs stay uncommittable.
function localConfigPath(slug) {
  return safeJoin(CONFIGS_DIR, `scout-config-${slug}.md`);
}
function legacyConfigPath(slug) {
  return safeJoin(PROMPTS_DIR, `scout-config-${slug}.prompt.md`);
}
async function resolveConfigPath(slug) {
  for (const p of [localConfigPath(slug), legacyConfigPath(slug)]) {
    try {
      await fs.access(p);
      return p;
    } catch {}
  }
  return null;
}

async function listConfigs() {
  const bySlug = new Map();
  // Legacy first, then .local — .local entries win on slug collision.
  for (const [dir, suffix] of [
    [PROMPTS_DIR, '.prompt.md'],
    [CONFIGS_DIR, '.md'],
  ]) {
    let files = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    const entries = files.filter(
      (f) =>
        f.startsWith('scout-config-') &&
        f.endsWith(suffix) &&
        f !== `scout-config-example${suffix}` &&
        !f.startsWith('scout-config-example-')
    );
    for (const f of entries) {
      const slug = f.slice('scout-config-'.length, f.length - suffix.length);
      if (!slug) continue;
      let name = '';
      let type = '';
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf8');
        const nameM = raw.match(/^\s*-\s*\*\*Name:\*\*\s*(.+)$/m);
        const typeM = raw.match(/^\s*-\s*\*\*Type:\*\*\s*(.+)$/m);
        if (nameM) name = nameM[1].trim();
        if (typeM) type = typeM[1].trim();
      } catch {}
      bySlug.set(slug, { slug, file: f, name, type });
    }
  }
  return [...bySlug.values()];
}

async function readConfig(slug) {
  if (!isValidSlug(slug)) throw new Error('invalid slug');
  const file = await resolveConfigPath(slug);
  if (!file) throw new Error('config not found');
  const raw = await fs.readFile(file, 'utf8');
  return { slug, file: path.basename(file), raw };
}

async function writeConfig(slug, raw) {
  if (!isValidSlug(slug)) throw new Error('invalid slug');
  await fs.mkdir(CONFIGS_DIR, { recursive: true });
  await fs.writeFile(localConfigPath(slug), raw, 'utf8');
  // Remove any legacy .github/prompts copy so the config lives only in the
  // gitignored .local/ tree and can never be accidentally committed.
  try {
    await fs.unlink(legacyConfigPath(slug));
  } catch {}
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

// In-memory cache for the parsed doc-meta blob attached to each list entry.
// Reports/social markdown can be 5–50 KB; parsing every file on every
// dashboard refresh would dominate cold-load time. Key by full path + mtimeMs
// so any save invalidates the entry automatically.
const docMetaCache = new Map();

function clearArtifactResponseCaches() {
  responseCache.clear('reports:');
  responseCache.clear('activity:');
  responseCache.clear('markdown:');
  responseCache.clear('thumbs:');
  responseCache.clear('search:');
}

async function readDocMeta(fullPath, mtimeMs, name) {
  const key = `${fullPath}:${mtimeMs}`;
  const hit = docMetaCache.get(key);
  if (hit) return hit;
  try {
    // Only the first ~8 KB is needed for H1 + summary + date-range metadata.
    const fh = await fs.open(fullPath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const raw = buf.slice(0, bytesRead).toString('utf8');
      const meta = extractDocMeta(raw, name);
      docMetaCache.set(key, meta);
      // Soft cap so a noisy workspace doesn't grow the cache unbounded.
      if (docMetaCache.size > 2000) {
        const firstKey = docMetaCache.keys().next().value;
        if (firstKey) docMetaCache.delete(firstKey);
      }
      return meta;
    } finally {
      await fh.close();
    }
  } catch {
    return extractDocMeta('', name);
  }
}

async function listMarkdownFiles(dir) {
  const cacheKey = `markdown:${dir}`;
  const cached = responseCache.get(cacheKey);
  if (cached) return cached;
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'));
    // Stat + meta-parse in parallel — directory may have 100+ entries and a
    // sequential await per-file was a measurable chunk of the dashboard's
    // cold load. Meta is cached by (path, mtimeMs) so steady-state refreshes
    // hit RAM.
    const stats = await Promise.all(
      files.map(async (f) => {
        try {
          const full = path.join(dir, f);
          const stat = await fs.stat(full);
          const meta = await readDocMeta(full, stat.mtimeMs, f);
          return {
            name: f,
            mtime: stat.mtime.toISOString(),
            size: stat.size,
            meta,
          };
        } catch {
          return null;
        }
      })
    );
    const out = stats
      .filter(Boolean)
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
    responseCache.set(cacheKey, out, 30_000);
    return out;
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

// Detect whether some external agent (e.g. Copilot Chat in VS Code, or a
// headless runner session) has been writing into the workspace recently. We
// can't see their processes, but we can see their side-effects:
//   - a new/updated file under reports/ or social-posts/
//   - mtime changes in .scout-state/
// If anything has been touched in the last `windowSec` seconds AND no
// in-process web-UI run is currently active, we treat it as an external
// agent operation and surface it in the status pill.
async function detectExternalActivity(windowSec = 90) {
  // If we already have a live web-UI run, don't claim "external".
  for (const r of runs.values()) {
    if (!r.endedAt) return null;
  }
  const dirs = [
    { dir: path.join(REPO_ROOT, 'reports'), kind: 'report', exts: ['.md', '.json'] },
    { dir: path.join(REPO_ROOT, 'social-posts'), kind: 'social post', exts: ['.md'] },
    { dir: path.join(REPO_ROOT, 'reports', '.scout-state'), kind: 'state', exts: null },
    { dir: path.join(STATE_DIR, 'scout-state'), kind: 'state', exts: null },
  ];
  const now = Date.now();
  let best = null;
  for (const { dir, kind, exts } of dirs) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (exts && !exts.includes(path.extname(ent.name).toLowerCase())) continue;
      let st;
      try { st = await fs.stat(path.join(dir, ent.name)); }
      catch { continue; }
      const ageMs = now - st.mtimeMs;
      if (ageMs < 0 || ageMs > windowSec * 1000) continue;
      if (!best || st.mtimeMs > best.mtimeMs) {
        best = { kind, file: ent.name, mtimeMs: st.mtimeMs };
      }
    }
  }
  if (!best) return null;
  return {
    active: true,
    kind: best.kind,
    file: best.file,
    ageSeconds: Math.round((now - best.mtimeMs) / 1000),
    mtime: new Date(best.mtimeMs).toISOString(),
  };
}

app.get('/api/status', async (_req, res) => {
  const [env, configs, settings, runnerInfo, externalActivity] = await Promise.all([
    readEnv(),
    listConfigs(),
    loadSettings(),
    getRunner(),
    detectExternalActivity(),
  ]);
  const modelOptions = await modelSuggestionsFor(settings.agent);
  res.json({
    repoRoot: REPO_ROOT,
    runner: runnerInfo.runner || null,
    runnerSource: runnerInfo.source,
    runnerConfigured: !!runnerInfo.runner,
    runnerLocked: runnerInfo.source === 'env',
    agent: settings.agent,
    model: settings.model || null,
    modelSupported: !!MODEL_FLAG[settings.agent] && runnerInfo.source !== 'env',
    modelFlag: MODEL_FLAG[settings.agent] || null,
    modelOptions,
    hasConfigs: configs.length > 0,
    configCount: configs.length,
    externalActivity,
    env,
  });
});

app.get('/api/agents', async (_req, res) => {
  const agents = await Promise.all(
    Object.values(AGENT_PRESETS).map(async ({ id, label, runner, install, note }) => ({
      id, label, runner, install, note,
      modelFlag: MODEL_FLAG[id] || null,
      modelSuggestions: await modelSuggestionsFor(id),
    })),
  );
  res.json({ agents });
});

app.get('/api/settings', async (_req, res) => {
  res.json(await loadSettings());
});

app.post('/api/settings', async (req, res) => {
  const { agent, runner, model } = req.body || {};
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
  // Optional per-session model override. Sanitize against the same safe set used
  // for injection, and only persist it for agents that actually support a model
  // switch (custom runners and `none` ignore it).
  let cleanModel = '';
  if (typeof model === 'string' && model.trim()) {
    const mt = model.trim();
    if (mt.length > 100 || !MODEL_SAFE_RE.test(mt)) {
      return res.status(400).json({ error: 'invalid model id (allowed: letters, digits and . _ : @ / -)' });
    }
    cleanModel = MODEL_FLAG[agent] ? mt : '';
  }
  try {
    await saveSettings({ agent, runner: effectiveRunner, model: cleanModel });
    res.json({ ok: true, agent, runner: effectiveRunner, model: cleanModel });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Read .env values merged with the key superset from .env.example so preset keys
// always appear in the form even if the user's .env is missing some of them.
//
// Vision-provider keys are owned by the dedicated Vision card (see
// /api/vision-config) and intentionally hidden here so they don't appear
// twice — and so users don't confuse `OLLAMA_HOST` for an API key.
const VISION_ENV_KEYS = new Set([
  'VISION_PROVIDER',
  'OLLAMA_HOST',
  'OLLAMA_VISION_MODEL',
  'OPENAI_VISION_MODEL',
  'CUSTOM_VISION_BASE_URL',
  'CUSTOM_VISION_API_KEY',
  'CUSTOM_VISION_MODEL',
  'CUSTOM_VISION_AUTH_STYLE',
]);

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
    if (VISION_ENV_KEYS.has(k)) continue;
    if (!seen.has(k)) { orderedKeys.push(k); seen.add(k); }
  }
  for (const e of envEntries) {
    if (VISION_ENV_KEYS.has(e.key)) continue;
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
    // Preserve vision-provider keys: they're owned by the Vision card and
    // hidden from GET /api/env, so the incoming payload won't contain them.
    // Without this merge, saving the API keys form would silently wipe them.
    const { raw: existingRaw } = await readEnvRaw();
    const existing = parseEnv(existingRaw);
    const sentKeys = new Set(cleaned.map((e) => e.key));
    for (const e of existing) {
      if (VISION_ENV_KEYS.has(e.key) && !sentKeys.has(e.key)) {
        cleaned.push({ key: e.key, value: e.value });
      }
    }
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
    res.json({ ok: true, slug, file: `scout-config-${slug}.md` });
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

// Delete a config by slug. The config file is removed from .local/configs/
// (and any legacy .github/prompts/ copy). Reports and social posts produced
// for this slug are kept on disk.
app.delete('/api/configs/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!isValidSlug(slug)) {
      return res.status(400).json({ error: 'invalid slug' });
    }
    let removed = false;
    for (const file of [localConfigPath(slug), legacyConfigPath(slug)]) {
      try {
        await fs.unlink(file);
        removed = true;
      } catch (err) {
        if (err && err.code !== 'ENOENT') throw err;
      }
    }
    if (!removed) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, slug });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/reports', async (_req, res) => {
  const cached = responseCache.get('reports:all');
  if (cached) return res.json(cached);
  const payload = {
    reports: await listMarkdownFiles(REPORTS_DIR),
    social: await listMarkdownFiles(SOCIAL_DIR),
  };
  responseCache.set('reports:all', payload, 30_000);
  res.json(payload);
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
  const cached = responseCache.get('thumbs:batches');
  if (cached) return cached;
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
  const sorted = out.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
  responseCache.set('thumbs:batches', sorted, 30_000);
  return sorted;
}

// Unified dashboard feed: real totals + a single time-sorted activity stream
// that mixes reports, social posts, posting calendars, thumbnail batches, and
// recent runs. The "doesn't truly represent what's been done" complaint is
// solved here — no more cards-of-counts that ignore half the work.
app.get('/api/activity', async (_req, res) => {
  const cached = responseCache.get('activity:all');
  if (cached) return res.json(cached);
  const [reportFiles, socialFiles, thumbBatches] = await Promise.all([
    listMarkdownFiles(REPORTS_DIR),
    listMarkdownFiles(SOCIAL_DIR),
    listThumbnailBatches(),
  ]);

  const reports = reportFiles.filter((f) => /-content\.md$/.test(f.name));
  const calendars = socialFiles.filter((f) => /-posting-calendar\.md$/.test(f.name));
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
  };

  // Build the unified activity stream.
  const slugFromFile = (name) => {
    // Pattern: YYYY-MM-DD-HHmm-{slug}-{kind}.md  or  …-{slug}-solo-…
    const m = name.match(/^\d{4}-\d{2}-\d{2}-\d{4}-(.+?)-(content|social-posts|posting-calendar|solo|alt)/);
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
  const payload = { totals, last, activity: stream.slice(0, 10) };
  responseCache.set('activity:all', payload, 30_000);
  res.json(payload);
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

// --- Conference / CFP date parsing + open-status policy -------------
// Scans must only surface conferences that haven't happened yet and CFPs we
// can prove are still open. These helpers parse the free-form date strings in
// the config table and decide upcoming/open deterministically (offline).
const MONTH_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Parse a date string into the END date of the event/window.
// Handles "Apr 19–20, 2026", "Jul 19, 2026", "Feb 9–11, 2027", "Sep 6–7, 2026",
// and ISO "2026-06-30". Returns a Date (end of that day, UTC) or null for
// "TBD"/unparseable strings.
function parseEndDate(s) {
  const str = String(s || '');
  const iso = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3], 23, 59, 59));
  const m = str.match(/([A-Za-z]{3,})\s+(\d{1,2})(?:\s*[–—-]\s*(\d{1,2}))?,?\s*(\d{4})/);
  if (m) {
    const mon = MONTH_INDEX[m[1].slice(0, 3).toLowerCase()];
    if (mon != null) {
      const day = parseInt(m[3] || m[2], 10);
      return new Date(Date.UTC(parseInt(m[4], 10), mon, day, 23, 59, 59));
    }
  }
  return null;
}

// Parse a "CFP Closes" cell. Returns { date, openAlways }.
//   "rolling" / "open" / "always"  → openAlways: true (never expires)
//   "closed" / "n/a" / "—" / ""    → date in the past (treated as closed)
//   a real date                     → parsed Date
function parseCfpClose(s) {
  const str = String(s || '').trim();
  if (!str || /^[—–-]+$/.test(str)) return { date: new Date(0), openAlways: false };
  if (/rolling|always|^open$/i.test(str)) return { date: null, openAlways: true };
  if (/closed|^n\/?a$|past|tbd/i.test(str)) return { date: new Date(0), openAlways: false };
  return { date: parseEndDate(str), openAlways: false };
}

// Default scan policy — a conference is "upcoming" when its event end date is
// today or later. Unparseable / TBD dates are kept (we can't prove they're past).
function isUpcomingConference(row, now = new Date()) {
  if (!row.endDate) return true;
  return row.endDate.getTime() >= now.getTime();
}

// Default scan policy — a CFP only counts as OPEN when we can prove it: the
// conference is upcoming, it has a submission link, and its close date is today
// or later (or it is explicitly rolling). Unknown close dates are NOT open, so
// unvalidated CFPs never leak into the CFP report.
function isOpenCfp(row, now = new Date()) {
  if (!isUpcomingConference(row, now)) return false;
  if (!row.cfp) return false;
  if (row.cfpOpenAlways) return true;
  if (!row.cfpCloseDate) return false;
  return row.cfpCloseDate.getTime() >= now.getTime();
}

// Parse the "## Conferences & Events" table out of a scout-config-*.prompt.md.
// Header-aware: recognizes an optional "CFP Closes" / "Deadline" column. Returns
// rows of { name, dates, location, site, cfp, cfpClosesRaw, endDate,
// cfpCloseDate, cfpOpenAlways } — links are enriched from CONFERENCE_LINKS and
// the date fields feed isUpcomingConference()/isOpenCfp().
function parseConferencesFromConfig(rawConfig) {
  const lines = rawConfig.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Conferences\s*&\s*Events/i.test(l));
  if (start < 0) return [];
  const rows = [];
  // Find the first pipe-table header after the section heading.
  let i = start + 1;
  while (i < lines.length && !/^##\s+/.test(lines[i])) {
    if (/^\s*\|/.test(lines[i]) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const headers = lines[i]
        .split('|')
        .slice(1, -1)
        .map((s) => s.trim().toLowerCase());
      const nameIdx = headers.findIndex((h) => /event|conference|name/.test(h));
      const datesIdx = headers.findIndex((h) => /date/.test(h));
      const locIdx = headers.findIndex((h) => /location|venue|city/.test(h));
      const cfpIdx = headers.findIndex((h) => /cfp|close|deadline/.test(h));
      // Skip header + separator, then walk body rows.
      let j = i + 2;
      while (j < lines.length && /^\s*\|/.test(lines[j])) {
        const cells = lines[j]
          .split('|')
          .slice(1, -1)
          .map((s) => s.trim());
        const name = cells[nameIdx >= 0 ? nameIdx : 0] || '';
        const dates = cells[datesIdx >= 0 ? datesIdx : 1] || '';
        const location = cells[locIdx >= 0 ? locIdx : 2] || '';
        const cfpClosesRaw = cfpIdx >= 0 ? cells[cfpIdx] || '' : '';
        if (name) {
          let site = '';
          let cfp = '';
          for (const entry of CONFERENCE_LINKS) {
            if (entry.match.test(name)) {
              site = entry.site || '';
              cfp = entry.cfp || '';
              break;
            }
          }
          const close = parseCfpClose(cfpClosesRaw);
          rows.push({
            name,
            dates,
            location,
            site,
            cfp,
            cfpClosesRaw,
            endDate: parseEndDate(dates),
            cfpCloseDate: close.date,
            cfpOpenAlways: close.openAlways,
          });
        }
        j++;
      }
      break;
    }
    i++;
  }
  return rows;
}

// Locate the most recent content-report markdown for a given slug.
async function findLatestContentReport(slug) {
  if (!isValidSlug(slug)) return null;
  const reports = await listMarkdownFiles(REPORTS_DIR);
  return reports
    .filter(
      (r) =>
        /-content\.md$/.test(r.name) &&
        (r.name.includes(`-${slug}-`) || r.name.includes(`-${slug}.`))
    )
    .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''))[0] || null;
}

// --- Persisted CFP / Conference scan artifacts ----------------------
// Called from closeRun() after a successful /scout-scan. Writes two dated
// report files per subject so CFPs + Conferences become saved, browseable
// reports (same lifecycle as Content / Mindshare) rather than being re-
// derived live on every dashboard tab open. Deterministic + offline: CFPs
// come from the just-written content report's "## Open Calls for Papers"
// section and conferences from the active config's "## Conferences & Events"
// table; submission/site links come from the curated CONFERENCE_LINKS table
// (already vetted, no network calls). Idempotent — files sharing a run stamp
// are never overwritten. Never throws.
function mdCell(s) {
  return String(s || '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
}

function mdLinkCell(label, url) {
  return url ? `[${label}](${url})` : '';
}

function titleCase(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderCfpReportMd({ slug, now, source, cfps }) {
  const lines = [];
  lines.push(`# Open Calls for Papers — ${titleCase(slug)}`);
  lines.push('');
  lines.push(`**Generated:** ${now} · **Source scan:** ${source}`);
  lines.push('');
  lines.push(
    `Point-in-time snapshot of open conference CFPs relevant to ${slug.replace(/-/g, ' ')}, ` +
      `captured automatically when this scan completed. Submission and site links come from the ` +
      `curated known-events table.`
  );
  lines.push('');
  lines.push('| Conference | Date / Location | CFP | Site | Notes |');
  lines.push('|---|---|---|---|---|');
  for (const c of cfps) {
    const cfpLink = c.cfp
      ? mdLinkCell('Submit', c.cfp)
      : c.links && c.links[0]
        ? mdLinkCell(c.links[0].label, c.links[0].url)
        : '';
    const siteLink = c.site ? mdLinkCell('Site', c.site) : '';
    lines.push(
      `| **${mdCell(c.name || c.raw)}** | ${mdCell(c.dateLoc)} | ${cfpLink} | ${siteLink} | ${mdCell(c.note)} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function renderConferencesReportMd({ slug, now, source, conferences }) {
  const lines = [];
  lines.push(`# Conferences & Events — ${titleCase(slug)}`);
  lines.push('');
  lines.push(`**Generated:** ${now} · **Source config:** scout-config-${slug}.prompt.md`);
  lines.push('');
  lines.push(
    `Conferences tracked for ${slug.replace(/-/g, ' ')}, captured automatically at scan time. ` +
      `Submission and site links come from the curated known-events table.`
  );
  lines.push('');
  lines.push('| Conference | Dates | Location | CFP Closes | CFP | Site |');
  lines.push('|---|---|---|---|---|---|');
  for (const c of conferences) {
    const closes = c.cfpClosesRaw || (c.cfpOpenAlways ? 'Rolling' : '—');
    lines.push(
      `| **${mdCell(c.name)}** | ${mdCell(c.dates)} | ${mdCell(c.location)} | ${mdCell(closes)} | ${
        c.cfp ? mdLinkCell('Submit', c.cfp) : ''
      } | ${c.site ? mdLinkCell('Site', c.site) : ''} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

async function generateCfpConferenceArtifacts(run) {
  let slugs = [];
  try {
    slugs = await computePreflightSlugs((run && run.args) || {});
  } catch {
    return;
  }
  if (!slugs.length) return;
  let wrote = 0;
  for (const slug of slugs) {
    try {
      if (!isValidSlug(slug)) continue;
      const latest = await findLatestContentReport(slug);
      if (!latest) continue;
      const m = latest.name.match(/^(\d{4}-\d{2}-\d{2}-\d{4})-/);
      const stamp = m ? m[1] : new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
      const nowIso = new Date().toISOString();
      const now = new Date();

      let conferences = [];
      try {
        const cfg = await readConfig(slug);
        conferences = parseConferencesFromConfig(cfg.raw) || [];
      } catch {}

      // Default scan policy: only upcoming events, and CFPs we can prove are open.
      const upcoming = conferences.filter((c) => isUpcomingConference(c, now));
      const cfps = upcoming
        .filter((c) => isOpenCfp(c, now))
        .map((c) => ({
          name: c.name,
          raw: c.name,
          dateLoc: [c.dates, c.location].filter(Boolean).join(' · '),
          note: c.cfpOpenAlways ? 'Rolling CFP' : c.cfpClosesRaw ? `CFP closes ${c.cfpClosesRaw}` : '',
          site: c.site,
          cfp: c.cfp,
          links: [],
        }));

      if (cfps.length) {
        const file = path.join(REPORTS_DIR, `${stamp}-${slug}-cfp.md`);
        if (!fsExistsSync(file)) {
          await fs.writeFile(file, renderCfpReportMd({ slug, now: nowIso, source: latest.name, cfps }), 'utf8');
          wrote++;
        }
      }
      if (upcoming.length) {
        const file = path.join(REPORTS_DIR, `${stamp}-${slug}-conferences.md`);
        if (!fsExistsSync(file)) {
          await fs.writeFile(
            file,
            renderConferencesReportMd({ slug, now: nowIso, source: latest.name, conferences: upcoming }),
            'utf8'
          );
          wrote++;
        }
      }
    } catch (err) {
      pushRunOutput(run, `\n[cfp-artifacts] ${slug}: ${err.message}\n`);
    }
  }
  if (wrote > 0) {
    pushRunOutput(
      run,
      `\n[scout-web] Wrote ${wrote} CFP/Conference report artifact(s) to reports/ — browse them under Reports → CFPs / Conferences.\n`
    );
  }
}

// CFPs + Conferences for the active subject. CFPs come from the latest
// content report's "## Open Calls for Papers" section (populated by
// /scout-scan when "Conference CFP tracking" is on); conferences come
// from the active scout-config-*.prompt.md "## Conferences & Events"
// table. Read-only; no writes.
app.get('/api/cfp-conferences', async (req, res) => {
  const slug = String(req.query.slug || '').trim();
  if (!isValidSlug(slug)) {
    return res.status(400).json({ error: 'invalid slug' });
  }
  try {
    const out = {
      slug,
      cfps: [],
      conferences: [],
      report: null,
      reportMtime: null,
    };
    // CFPs + conferences from the active config — filtered to the same
    // default scan policy: only upcoming events, only provably-open CFPs.
    const latest = await findLatestContentReport(slug);
    if (latest) {
      out.report = latest.name;
      out.reportMtime = latest.mtime;
    }
    try {
      const cfg = await readConfig(slug);
      const all = parseConferencesFromConfig(cfg.raw);
      const now = new Date();
      out.conferences = all.filter((c) => isUpcomingConference(c, now));
      out.cfps = out.conferences
        .filter((c) => isOpenCfp(c, now))
        .map((c) => ({
          raw: c.name,
          name: c.name,
          dateLoc: [c.dates, c.location].filter(Boolean).join(' · '),
          note: c.cfpOpenAlways ? 'Rolling CFP' : c.cfpClosesRaw ? `CFP closes ${c.cfpClosesRaw}` : '',
          site: c.site,
          cfp: c.cfp,
          links: [],
        }));
    } catch {}
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

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
// Lazily builds an in-memory index by reading every *-content.md report
// (or, when available, its *-content.json sidecar — the agent writes a
// structured sidecar with sentiment/score/author already classified, so
// the JSON path avoids re-deriving anything from markdown emoji cells).
//
// Cached for 30s (or until reports/ mtime changes) so /api/items,
// /api/conversations, /api/authors, /api/search, /api/source-health all
// share the same scan. Read-only; never writes back to disk.
//
// All parsing/classification lives in tools/lib/report-index.mjs so the
// agent surface and the web UI surface stay in lock-step.
// =====================================================================

let _indexCache = null;// { builtAt, signature, items, conversations, authors, sources, reports }
let _indexBuilding = null; // in-flight build promise — concurrent callers share it

async function stateFileMtime(name) {
  try {
    const file = await resolveStateRead(name, REPORTS_DIR);
    if (!file) return '';
    const st = await fs.stat(file);
    return st.mtimeMs;
  } catch {
    return '';
  }
}

async function getIndex() {
  // If a build is already in flight, every concurrent caller awaits the same
  // promise instead of racing four parallel rebuilds. The dashboard fires four
  // index-backed endpoints in parallel (conversations, authors, sentiment,
  // source-health) and without this mutex each cold start did 4× the I/O,
  // pushing total time over the client-side timeout.
  if (_indexBuilding) return _indexBuilding;
  _indexBuilding = (async () => {
    try { return await _buildIndex(); }
    finally { _indexBuilding = null; }
  })();
  return _indexBuilding;
}

const BROWSER_SOCIAL_PLATFORMS = ['x', 'linkedin', 'reddit'];
const BROWSER_SOCIAL_LABELS = { x: 'X', linkedin: 'LinkedIn', reddit: 'Reddit' };

function parseContentReportName(name) {
  const m = String(name || '').match(/^(\d{4}-\d{2}-\d{2}-\d{4})-(.+)-content\.md$/);
  return m ? { stamp: m[1], slug: m[2] } : null;
}

async function collectBrowserSocialSidecars() {
  const bySlug = new Map();
  const signatureParts = [];
  for (const root of [BROWSER_SCAN_SIDECAR_DIR, LEGACY_BROWSER_SCAN_DIR]) {
    let slugs = [];
    try { slugs = await fs.readdir(root); } catch { continue; }
    for (const slug of slugs) {
      if (!isValidSlug(slug)) continue;
      const slugDir = path.join(root, slug);
      let files = [];
      try { files = await fs.readdir(slugDir); } catch { continue; }
      const entry = bySlug.get(slug) || { platforms: {} };
      for (const file of files) {
        const m = file.match(/^(\d{4}-\d{2}-\d{2}-\d{4})-(x|linkedin|reddit)\.json$/);
        if (!m) continue;
        const [, stamp, platform] = m;
        let stat;
        try { stat = await fs.stat(path.join(slugDir, file)); } catch { continue; }
        signatureParts.push(`${slug}/${file}@${stat.mtimeMs}`);
        const existing = entry.platforms[platform];
        if (!existing || stamp > existing.stamp || (stamp === existing.stamp && stat.mtimeMs > existing.mtimeMs)) {
          entry.platforms[platform] = { stamp, platform, file, dir: slugDir, mtimeMs: stat.mtimeMs };
        }
      }
      bySlug.set(slug, entry);
    }
  }
  return { bySlug, signature: signatureParts.sort().join('|') };
}

function browserSidecarDate(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function formatBrowserEngagement(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'object') return '';
  return Object.entries(value)
    .filter(([, v]) => v != null && v !== '' && Number(v) !== 0)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
}

function browserSidecarSummary(item) {
  const title = String(item.title || '').trim();
  const body = String(item.body || '').replace(/\s+/g, ' ').trim();
  if (title && body && !body.toLowerCase().includes(title.toLowerCase())) return `${title} — ${body}`;
  return title || body || String(item.thread_context || '').trim() || '(post)';
}

function browserSidecarAuthor(item) {
  const display = String(item.author_display || '').trim();
  const handle = String(item.author_handle || '').trim();
  if (display && handle && !display.includes(handle)) return `${display} (${handle})`;
  return display || handle || '';
}

function browserSidecarIsRelevant(item, slug) {
  const text = [item.title, item.body, item.url, item.thread_context, item.source]
    .map((v) => String(v || '').toLowerCase())
    .join(' ');
  // Bare "cosmos" is noisy (NVIDIA Cosmos, novels, astronomy, etc.). For
  // Azure Cosmos DB / DocumentDB, require a product phrase.
  if (/cosmos/.test(String(slug || '').toLowerCase())) {
    return ['cosmos db', 'cosmosdb', 'azure cosmos', 'documentdb'].some((term) => text.includes(term));
  }
  const slugTokens = String(slug || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !['azure', 'microsoft', 'cloud'].includes(token));
  const terms = new Set(slugTokens);
  if (!terms.size) return true;
  return [...terms].some((term) => text.includes(term));
}

function browserSidecarConversation(item, { slug, platform, stamp, community }) {
  // LinkedIn search posts only expose a synthesized `/feed/sdui-post/{hash}`
  // permalink that dead-ends (the real post URL is lazy-loaded on "..." menu
  // open). The scraped `author_profile` (e.g. /in/{handle} or /company/…) IS
  // navigable, so carry it as a working fallback link for the dashboard.
  const authorUrl = /^https?:\/\//i.test(String(item.author_profile || '').trim())
    ? String(item.author_profile).trim()
    : '';
  return {
    date: browserSidecarDate(item.post_date || item.scraped_at),
    // URL host is authoritative; the filename platform is a fallback. This
    // keeps a stray cross-posted permalink from landing under the wrong
    // platform.
    platform: platformFromUrl(item.url) || BROWSER_SOCIAL_LABELS[platform] || platform,
    author: browserSidecarAuthor(item),
    summary: browserSidecarSummary(item),
    sentiment: 'unknown',
    community: community || 'community',
    communityRaw: '',
    engagement: formatBrowserEngagement(item.engagement),
    url: String(item.url || '').trim(),
    authorUrl,
    section: 'Browser scan sidecar',
    report: `${stamp}-${slug}-content.md`,
    source: `browser-scan:${platform}`,
  };
}

// Normalize a scraped handle ("u/sajee_mvp", "@hasansavran", "/in/foo") down
// to the bare, lowercased handle used by the muted/team account keys.
function cleanScrapedHandle(raw) {
  return String(raw || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/^u\//i, '')
    .replace(/^\/?(in|company)\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function normProductName(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Per-slug index of product/owned accounts (handle keys + display names),
// derived from the scout config. Cached for the life of a build so the
// sidecar loop doesn't re-read the same config repeatedly.
async function loadProductAccountIndex(slug, cache) {
  if (cache.has(slug)) return cache.get(slug);
  let raw = '';
  try {
    raw = (await readConfig(slug)).raw || '';
  } catch {
    /* no config for this slug — everyone stays community */
  }
  const keys = new Set();
  const names = new Set();
  if (raw) {
    for (const acct of [
      ...parseTeamMemberAccountsFromConfig(raw),
      ...parseOwnedAccountsFromConfig(raw),
    ]) {
      const h = normHandle(acct.handle);
      if (!h) continue;
      keys.add(`${normPlatform(acct.platform)}::${h}`);
      keys.add(`*::${h}`);
    }
    for (const name of parseProductTeamNamesFromConfig(raw)) {
      const n = normProductName(name);
      if (n) names.add(n);
    }
  }
  const index = { keys, names };
  cache.set(slug, index);
  return index;
}

// Decide whether a browser-sidecar row is a product / owned-account post
// rather than external community chatter. Sidecar rows otherwise default to
// 'community', so an unclassified Microsoft employee or owned brand handle
// would wrongly count as community sentiment.
function classifySidecarCommunity(item, platformKey, index) {
  const handle = cleanScrapedHandle(item.author_handle || item.author_display);
  if (handle && index) {
    const p = normPlatform(platformKey);
    if (index.keys.has(`${p}::${handle}`) || index.keys.has(`*::${handle}`)) return 'product';
  }
  const display = String(item.author_display || '').trim();
  if (display && index && index.names.has(normProductName(display))) return 'product';
  if (isProductAuthorName(display) || isProductAuthorName(item.author_handle || '')) return 'product';
  return 'community';
}

function addConversationAggregate(c, slug, authors, sources) {
  if (c.author) {
    const key = c.author.toLowerCase();
    const entry =
      authors.get(key) ||
      { name: c.author, items: 0, conversations: 0, lastSeen: '', sentiments: {}, slugs: new Set(), urls: new Set() };
    entry.conversations += 1;
    const s = (c.sentiment || 'unknown').toLowerCase();
    entry.sentiments[s] = (entry.sentiments[s] || 0) + 1;
    if (c.date && c.date > entry.lastSeen) entry.lastSeen = c.date;
    if (slug) entry.slugs.add(slug);
    if (c.url) entry.urls.add(c.url);
    if (c.community === 'product') entry.isProduct = true;
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

// Merge the company's own people + brand/owned channels across every known
// subject config into one matcher (display names + bare handles), augmented
// with owned + no-triage handles from the muted-accounts file. Used to keep
// internal actors out of Community signals and the Creators card — they work
// for us, so they are not external community signal.
async function buildProductActorMatcher(slugs, cache) {
  const names = new Set();
  const handles = new Set();
  for (const slug of slugs) {
    if (!slug) continue;
    const idx = await loadProductAccountIndex(slug, cache);
    for (const n of idx.names) names.add(n);
    for (const k of idx.keys) {
      const h = k.slice(k.indexOf('::') + 2);
      if (h) handles.add(h);
    }
  }
  try {
    const muted = await loadMuted(REPORTS_DIR);
    for (const [key, info] of Object.entries(muted.items || {})) {
      if (!info) continue;
      if (info.owned || info.noTriage || info.reason === NO_TRIAGE_REASON) {
        const h = normHandle(info.handle || key.slice(key.indexOf('::') + 2));
        if (h) handles.add(h);
      }
    }
  } catch {}
  return { names, handles };
}

// True when an author (by display name or any of their handles/URLs) is an
// internal product actor: a brand/owned channel or a configured team member.
// Author strings arrive in many shapes — `Display Name`, a bare `handle`,
// `display (u/handle)`, or a byline-polluted `u/handle (Display, Title) ·
// May 27, 2026 · r/Sub` — so we gather every plausible handle/name candidate
// before testing against the matcher.
function matcherFlagsAuthor(matcher, name, urls) {
  if (!matcher) return false;
  const raw = String(name || '').trim();
  if (isProductAuthorName(raw)) return true;
  if (normProductName(raw) && matcher.names.has(normProductName(raw))) return true;
  const candidates = [];
  // Every parenthetical group (handle or display name may live inside).
  for (const m of raw.matchAll(/\(([^)]+)\)/g)) {
    const inner = m[1].trim();
    candidates.push(inner);
    // A parenthetical display name like "(Sajeetharan Sinnathurai, Title)":
    // test its leading comma-separated chunk against the name set.
    const firstChunk = normProductName(inner.split(',')[0]);
    if (firstChunk && matcher.names.has(firstChunk)) return true;
  }
  // Leading token before the first space — covers "u/handle (…) · date".
  const lead = raw.split(/\s+/)[0];
  if (lead) candidates.push(lead);
  // Whole string when it has no spaces (a bare handle).
  if (raw && !/\s/.test(raw)) candidates.push(raw);
  for (const u of urls || []) {
    const h = handleFromUrl(u);
    if (h) candidates.push(h);
  }
  return candidates.map((h) => cleanScrapedHandle(h)).some((h) => h && matcher.handles.has(h));
}

async function _buildIndex() {
  const reports = (await listMarkdownFiles(REPORTS_DIR)).filter((r) =>
    /-content\.md$/.test(r.name)
  );
  const latestReportStampBySlug = new Map();
  for (const report of reports) {
    const parsedName = parseContentReportName(report.name);
    if (!parsedName) continue;
    const prev = latestReportStampBySlug.get(parsedName.slug) || '';
    if (parsedName.stamp > prev) latestReportStampBySlug.set(parsedName.slug, parsedName.stamp);
  }
  // Cache signature also hashes sidecar mtime so a fresh JSON write (e.g. an
  // agent rerun that updates sentiment without touching the .md) invalidates.
  const [sidecarMtimes, sentimentOverridesMtime, browserSidecars] = await Promise.all([
    Promise.all(
      reports.map(async (r) => {
        try {
          const st = await fs.stat(path.join(REPORTS_DIR, r.name.replace(/\.md$/, '.json')));
          return st.mtimeMs;
        } catch {
          return '';
        }
      })
    ),
    // Sentiment overrides alter parsed conversation labels and totals even
    // though the report markdown/JSON files are untouched.
    stateFileMtime(SENTIMENT_OVERRIDES_FILE),
    collectBrowserSocialSidecars(),
  ]);
  const signature = reports
    .map((r, idx) => `${r.name}@${r.mtime || ''}#${sidecarMtimes[idx] || ''}`)
    .sort()
    .join('|') +
    `|sentiment-overrides@${sentimentOverridesMtime || ''}` +
    `|browser-social-sidecars@${browserSidecars.signature || ''}`;
  // Validate the cache by content fingerprint, not by wall-clock age. The
  // signature already captures every input that can change the parsed index
  // (each report's mtime + its JSON sidecar mtime + the sentiment-overrides
  // mtime, all surfaced through listMarkdownFiles' own 30s directory cache).
  // If the fingerprint is unchanged, a rebuild would reparse the entire
  // corpus only to produce byte-identical output — so reuse it regardless of
  // age. Re-parsing every 30s was the dominant dashboard cold-load cost
  // (a full /api/conversations went from ~3.6s cold to ~0.6s warm purely on
  // index reuse). Freshness is unchanged: any real file change flips a
  // mtime, the signature differs, and the index rebuilds on the next call.
  if (_indexCache && _indexCache.signature === signature) {
    return _indexCache;
  }

  const items = [];
  const conversations = [];
  const authors = new Map(); // name -> aggregate
  const sources = new Map(); // sourceKey -> aggregate
  const reportsMeta = [];

  // Build the internal-actor matcher once for the whole index from every
  // known subject config (+ owned/no-triage handles in the muted file). Used
  // to stamp `isProduct` on items and authors so the company's own people and
  // brand channels stay out of Community signals and the Creators card.
  const productAccountCache = new Map();
  const allSlugs = new Set([
    ...latestReportStampBySlug.keys(),
    ...browserSidecars.bySlug.keys(),
  ]);
  const productMatcher = await buildProductActorMatcher([...allSlugs], productAccountCache);

  // Read + parse all reports in parallel via the shared lib. loadReport()
  // prefers the JSON sidecar (the agent's structured output) and falls back
  // to markdown for legacy reports.
  const parsedReports = await Promise.all(
    reports.map(async (r) => {
      const parsed = await loadReport(REPORTS_DIR, r.name);
      return parsed ? { r, parsed } : null;
    })
  );

  for (const reportEntry of parsedReports) {
    if (!reportEntry) continue;
    const { r, parsed } = reportEntry;
    reportsMeta.push({
      name: r.name,
      mtime: r.mtime,
      slug: parsed.slug,
      generatedAt: parsed.generatedAt,
      source: parsed.source || 'md',
      itemCount: parsed.items.length,
      convoCount: parsed.conversations.length,
      sentimentTotals: parsed.sentimentTotals,
      skippedSources: parsed.skippedSources,
    });
    for (const it of parsed.items)
      items.push({
        ...it,
        report: r.name,
        isProduct: matcherFlagsAuthor(productMatcher, it.author, it.url ? [it.url] : []),
      });
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
        if (c.community === 'product') entry.isProduct = true;
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

  // Safety net for freshness: browser-scan sidecars are written before the
  // agent/report step. If the report generation is still in flight or fails,
  // expose the newest social sidecars directly as conversation rows so the
  // dashboard does not keep showing stale community activity. Once a later
  // report is written for the same slug, these sidecar rows are skipped.
  const existingConversationKeys = new Set(conversations.map((c) => convoKey(c)).filter(Boolean));
  // productAccountCache is declared above (shared with the product matcher).
  for (const [slug, entry] of browserSidecars.bySlug.entries()) {
    const latestReportStamp = latestReportStampBySlug.get(slug) || '';
    const productIndex = await loadProductAccountIndex(slug, productAccountCache);
    for (const platform of BROWSER_SOCIAL_PLATFORMS) {
      const sidecar = entry.platforms[platform];
      if (!sidecar) continue;
      if (latestReportStamp && sidecar.stamp <= latestReportStamp) continue;
      let raw = [];
      try {
        raw = JSON.parse(await fs.readFile(path.join(sidecar.dir, sidecar.file), 'utf8'));
      } catch { continue; }
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        if (isHiringContent(item)) continue;
        if (!browserSidecarIsRelevant(item, slug)) continue;
        const community = classifySidecarCommunity(item, platform, productIndex);
        const conversation = browserSidecarConversation(item, { slug, platform, stamp: sidecar.stamp, community });
        if (!conversation.url && !conversation.summary) continue;
        const key = convoKey(conversation);
        if (key && existingConversationKeys.has(key)) continue;
        if (key) existingConversationKeys.add(key);
        conversations.push(conversation);
        addConversationAggregate(conversation, slug, authors, sources);
      }
    }
  }

  // Final pass: flag any remaining internal actors (brand/owned channels or
  // configured team members) who only surfaced via items, or whose
  // conversations weren't group-classified, so Creators + Community signals
  // can exclude them.
  for (const a of authors.values()) {
    if (!a.isProduct && matcherFlagsAuthor(productMatcher, a.name, [...a.urls])) {
      a.isProduct = true;
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
      isProduct: !!a.isProduct,
    })),
    sources: [...sources.values()],
    reports: reportsMeta,
  };
  return _indexCache;
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
    // `include`: 'open' (default — hide closed), 'closed' (only closed),
    // 'all' (everything with isClosed flag).
    const include = String(req.query.include || 'open').toLowerCase();
    // `includeMuted`: when true (or include === 'muted'), do NOT filter out
    // conversations from muted accounts. Default is to hide them entirely.
    const includeMutedFlag = String(req.query.includeMuted || '').toLowerCase();
    const includeMuted = includeMutedFlag === '1' || includeMutedFlag === 'true' || include === 'muted';
    const includeProductFlag = String(req.query.includeProduct || '').toLowerCase();
    const includeProduct = includeProductFlag === '1' || includeProductFlag === 'true' || include === 'all';
    const onlyMuted = include === 'muted';
    const onlyNoTriage = include === 'no-triage';
    const closed = await loadClosed(REPORTS_DIR);
    const muted = await loadMuted(REPORTS_DIR);
    let convs = idx.conversations.map((c) => {
      const key = convoKey(c);
      const closedInfo = key && closed.items[key] ? closed.items[key] : null;
      const mutedInfo = mutedInfoForConv(muted, c);
      const isMuted = !!mutedInfo || isMutedConv(muted, c);
      const isNoTriage = isNoTriageInfo(mutedInfo);
      const base = { ...c, key, isClosed: !!closedInfo, isMuted, isNoTriage };
      if (closedInfo) base.closedInfo = closedInfo;
      if (mutedInfo) base.mutedInfo = mutedInfo;
      return base;
    });
    if (!includeProduct) convs = convs.filter((c) => c.community !== 'product');
    if (onlyNoTriage) convs = convs.filter((c) => c.isNoTriage);
    else if (onlyMuted) convs = convs.filter((c) => c.isMuted);
    else if (!includeMuted) convs = convs.filter((c) => !c.isMuted);
    if (include === 'open') convs = convs.filter((c) => !c.isClosed);
    else if (include === 'closed') convs = convs.filter((c) => c.isClosed);
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
    const _convMs = (d) => {
      const t = Date.parse(d || '');
      return Number.isFinite(t) ? t : 0;
    };
    convs = convs
      .slice()
      .sort(
        (a, b) =>
          _convMs(b.date) - _convMs(a.date) || (b.date || '').localeCompare(a.date || '')
      );
    // Pass 1: dedupe by exact key (URL or composite). Same conversation
    // appears in multiple report files — keep the newest occurrence and
    // collect the other report names in `dupReports`.
    const seen = new Map();
    for (const c of convs) {
      const k = c.key || c.url || `${c.platform}::${c.author}::${c.summary}`;
      if (!seen.has(k)) {
        seen.set(k, { ...c, dupReports: [], dupUrls: [] });
      } else {
        const first = seen.get(k);
        if (c.report && c.report !== first.report && !first.dupReports.includes(c.report)) {
          first.dupReports.push(c.report);
        }
      }
    }
    let dedupedConvs = Array.from(seen.values());
    // Pass 2: collapse near-duplicate posts from the same author whose
    // bodies are virtually identical (e.g. recruiter/spam accounts that
    // re-post the same blurb daily with a fresh activity URN). Signature
    // is platform + author + first 120 chars of normalized summary.
    // Skip when author/summary is empty — those would over-collapse.
    const sigSeen = new Map();
    const collapsed = [];
    for (const c of dedupedConvs) {
      const author = (c.author || '').toString().toLowerCase().trim();
      const summary = (c.summary || '')
        .toString()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      if (!author || summary.length < 40) {
        collapsed.push(c);
        continue;
      }
      const platform = (c.platform || '').toString().toLowerCase().trim();
      const sig = `sig::${platform}|${author}|${summary}`;
      if (!sigSeen.has(sig)) {
        sigSeen.set(sig, c);
        collapsed.push(c);
      } else {
        const first = sigSeen.get(sig);
        if (c.url && c.url !== first.url && !first.dupUrls.includes(c.url)) {
          first.dupUrls.push(c.url);
        }
        if (c.report && c.report !== first.report && !first.dupReports.includes(c.report)) {
          first.dupReports.push(c.report);
        }
      }
    }
    const dupesRemoved = convs.length - collapsed.length;
    dedupedConvs = collapsed;
    res.json({
      conversations: dedupedConvs,
      total: dedupedConvs.length,
      dupesRemoved,
      closedCount: Object.keys(closed.items).length,
      mutedCount: Object.keys(muted.items).length,
      builtAt: idx.builtAt,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// --- Muted accounts --------------------------------------------
// Persistent block list — hides every conversation from a given
// platform+handle (or cross-platform when platform = '*'). State at
// reports/.muted-accounts.json, shared with tools/conversations-cli.mjs.

app.get('/api/muted-accounts', async (_req, res) => {
  try {
    const muted = await loadMuted(REPORTS_DIR);
    const items = Object.entries(muted.items).map(([key, info]) => ({ key, ...info }));
    items.sort((a, b) => (b.mutedAt || '').localeCompare(a.mutedAt || ''));
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/muted-accounts', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { state, key } = await muteAccount(REPORTS_DIR, {
      platform: body.platform,
      handle: body.handle,
      reason: body.reason,
      note: body.note,
      owned: !!body.owned,
    });
    res.json({
      ok: true,
      key,
      item: state.items[key],
      total: Object.keys(state.items).length,
    });
  } catch (err) {
    const status = err && err.code === 'HANDLE_REQUIRED' ? 400 : 500;
    res.status(status).json({ error: String(err.message || err), code: err && err.code });
  }
});

app.delete('/api/muted-accounts', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    let keys = Array.isArray(body.keys) ? body.keys.filter((k) => typeof k === 'string' && k) : [];
    // Convenience: accept { platform, handle } in addition to { keys: [...] }.
    if (!keys.length && body.handle) {
      keys = [muteKey(body.platform, body.handle)];
    }
    if (!keys.length) return res.status(400).json({ error: 'keys or {platform, handle}: required' });
    const { state, removed } = await unmuteMany(REPORTS_DIR, keys);
    res.json({ ok: true, unmuted: removed, total: Object.keys(state.items).length });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Import "owned" accounts (the product's own social handles) from a
// scout-config-*.prompt.md and mute every one with reason=owned-account.
// Body: { slug: string }.
app.post('/api/muted-accounts/import-owned', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const slug = String(body.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'slug: required' });
    let cfg;
    try {
      cfg = await readConfig(slug);
    } catch (err) {
      return res.status(404).json({ error: `config not found for slug "${slug}"` });
    }
    const owned = parseOwnedAccountsFromConfig(cfg.raw || '');
    const added = [];
    const skipped = [];
    for (const acct of owned) {
      try {
        const { key } = await muteAccount(REPORTS_DIR, {
          platform: acct.platform,
          handle: acct.handle,
          reason: 'owned-account',
          note: `Imported from ${cfg.file}`,
          owned: true,
        });
        added.push({ key, platform: acct.platform, handle: acct.handle });
      } catch (err) {
        skipped.push({ platform: acct.platform, handle: acct.handle, error: String(err.message || err) });
      }
    }
    const state = await loadMuted(REPORTS_DIR);
    res.json({
      ok: true,
      slug,
      file: cfg.file,
      parsed: owned.length,
      added,
      skipped,
      total: Object.keys(state.items).length,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Import configured product-team handles as no-triage accounts. These are
// verified employees / owned people whose posts should be tracked
// separately but should not clutter community triage.
// Body: { slug: string }.
app.post('/api/muted-accounts/import-team-members', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const slug = String(body.slug || '').trim();
    if (!slug) return res.status(400).json({ error: 'slug: required' });
    let cfg;
    try {
      cfg = await readConfig(slug);
    } catch (err) {
      return res.status(404).json({ error: `config not found for slug "${slug}"` });
    }
    const team = parseTeamMemberAccountsFromConfig(cfg.raw || '');
    const added = [];
    const skipped = [];
    for (const acct of team) {
      try {
        const { key } = await muteAccount(REPORTS_DIR, {
          platform: acct.platform,
          handle: acct.handle,
          reason: NO_TRIAGE_REASON,
          note: acct.name ? `Product team member from ${cfg.file}: ${acct.name}` : `Product team member from ${cfg.file}`,
        });
        added.push({ key, platform: acct.platform, handle: acct.handle, name: acct.name || '' });
      } catch (err) {
        skipped.push({ platform: acct.platform, handle: acct.handle, name: acct.name || '', error: String(err.message || err) });
      }
    }
    const state = await loadMuted(REPORTS_DIR);
    res.json({
      ok: true,
      slug,
      file: cfg.file,
      parsed: team.length,
      added,
      skipped,
      total: Object.keys(state.items).length,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// --- Conversation close / reopen --------------------------------
// Persistent "dismissed" state lives in reports/.closed-conversations.json
// and is consumed by both the web UI and tools/conversations-cli.mjs so
// the chat/headless agent and the browser see the same view.

app.get('/api/conversations/reasons', (_req, res) => {
  res.json({ reasons: ALLOWED_REASONS });
});

// URL liveness probe — used by the dashboard to hide/flag dead post links.
// In-memory cache; HEAD with GET fallback (many sites 405 HEAD). Treats
// 2xx / 3xx / 401 / 403 / 429 as "reachable" (the page exists; we just can't
// see it anonymously). Aggressively short timeout so we never block the UI.
const _urlCheckCache = new Map(); // url -> { at, ok, status }
const URL_CHECK_TTL_MS = 60 * 60 * 1000; // 1h
// probeUrl (HEAD→GET liveness, browser UA, short timeout) lives in the shared
// tools/lib/url-validate.mjs so the server, the validate-urls CLI, and any
// agent/scan flow all agree on what "reachable" means.
app.get('/api/check-url', async (req, res) => {
  const raw = String(req.query.u || '').trim();
  if (!raw) return res.status(400).json({ error: 'u: required' });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return res.json({ ok: false, status: 0, reason: 'malformed' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.json({ ok: false, status: 0, reason: 'bad-protocol' });
  }
  const key = parsed.toString();
  const now = Date.now();
  const hit = _urlCheckCache.get(key);
  if (hit && now - hit.at < URL_CHECK_TTL_MS) {
    return res.json({ ok: hit.ok, status: hit.status, cached: true });
  }
  const result = await probeUrl(key);
  _urlCheckCache.set(key, { at: now, ok: result.ok, status: result.status });
  res.json({ ...result, cached: false });
});

// Normalize a social handle: strip @, leading u//in//company/, and extract the
// handle/slug from a pasted full URL. Returns a bare handle/slug per platform.
function normalizeSocialHandle(platform, raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const segs = u.pathname.split('/').filter(Boolean);
      if (platform === 'bluesky') {
        // bsky.app/profile/<handle> → handle; custom-domain handle → hostname
        s = (/(^|\.)bsky\.app$/i.test(u.hostname) && segs[0] === 'profile') ? (segs[1] || '') : u.hostname;
      } else if (platform === 'linkedin') {
        // keep company/<slug> | in/<slug> | school/<slug>
        s = segs.length >= 2 ? `${segs[0]}/${segs[1]}` : (segs[0] || '');
      } else if (platform === 'youtube') {
        s = segs[0] || ''; // @handle | channel/<id> | c/<name> | user/<name>
        if ((segs[0] === 'channel' || segs[0] === 'c' || segs[0] === 'user') && segs[1]) s = `${segs[0]}/${segs[1]}`;
      } else {
        s = segs[0] || u.hostname; // x/twitter → first path segment
      }
    } catch { /* fall through to bare cleanup */ }
  }
  return s.replace(/^@+/, '').replace(/^\/+|\/+$/g, '');
}

// Verify an official social handle resolves to a real account. Bluesky uses the
// public AT-Protocol getProfile API (fully reliable). LinkedIn/X/YouTube fall
// back to a URL liveness probe; X is flagged inconclusive because its logged-out
// SPA serves the same shell for any path.
async function verifySocial(platform, rawHandle) {
  const h = normalizeSocialHandle(platform, rawHandle);
  if (!h) return { ok: false, normalized: '', reason: 'empty' };

  if (platform === 'bluesky') {
    const actor = h.replace(/^@/, '');
    const api = `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`;
    try {
      const r = await fetch(api, { headers: { accept: 'application/json' } });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        const handle = j.handle || actor;
        return {
          ok: true,
          normalized: handle,
          url: `https://bsky.app/profile/${handle}`,
          displayName: j.displayName || '',
          followers: typeof j.followersCount === 'number' ? j.followersCount : undefined,
        };
      }
      return { ok: false, normalized: actor, status: r.status, reason: 'not-found' };
    } catch (err) {
      return { ok: false, normalized: actor, reason: String(err && err.message || err) };
    }
  }

  let url;
  let inconclusive;
  let note;
  if (platform === 'linkedin') {
    const slug = h.includes('/') ? h : `company/${h}`;
    url = `https://www.linkedin.com/${slug}/`;
  } else if (platform === 'x') {
    url = `https://x.com/${h.replace(/^@/, '')}`;
    inconclusive = true;
    note = 'X serves the same app shell for any path when logged out — a reachable result does not prove the handle exists. Open the profile in a browser to confirm.';
  } else if (platform === 'youtube') {
    url = /^(channel|c|user)\//.test(h) ? `https://www.youtube.com/${h}` : `https://www.youtube.com/@${h}`;
  } else {
    return { ok: false, normalized: h, reason: 'unknown-platform' };
  }

  const probe = await probeUrl(url);
  return { ok: probe.ok, normalized: h, url, status: probe.status, inconclusive, note };
}

// Verify an official social account during onboarding (linkedin/x/bluesky/youtube).
app.get('/api/verify-social', async (req, res) => {
  const platform = String(req.query.platform || '').toLowerCase();
  const handle = String(req.query.handle || '').trim();
  const allowed = ['linkedin', 'x', 'bluesky', 'youtube'];
  if (!allowed.includes(platform)) {
    return res.status(400).json({ error: `platform: one of ${allowed.join(' / ')}` });
  }
  if (!handle) return res.status(400).json({ error: 'handle: required' });
  if (handle.length > 200) return res.status(400).json({ error: 'handle: too long' });
  try {
    const result = await verifySocial(platform, handle);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

app.get('/api/conversations/closed', async (_req, res) => {
  try {
    const closed = await loadClosed(REPORTS_DIR);
    const items = Object.entries(closed.items).map(([key, info]) => ({ key, ...info }));
    items.sort((a, b) => (b.closedAt || '').localeCompare(a.closedAt || ''));
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/conversations/close', express.json({ limit: '512kb' }), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const reason = body.reason;
    const note = body.note;
    const entries = Array.isArray(body.items) ? body.items : [];
    if (!entries.length) {
      return res.status(400).json({ error: 'items: non-empty array required' });
    }
    const { state, added } = await closeMany(REPORTS_DIR, entries, reason, note);
    res.json({ ok: true, closed: added, totalClosed: Object.keys(state.items).length });
  } catch (err) {
    const status = err && (err.code === 'INVALID_REASON' || err.code === 'NOTE_REQUIRED') ? 400 : 500;
    res.status(status).json({ error: String(err.message || err), code: err && err.code });
  }
});

app.post('/api/conversations/reopen', express.json({ limit: '128kb' }), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const keys = Array.isArray(body.keys) ? body.keys.filter((k) => typeof k === 'string' && k) : [];
    if (!keys.length) return res.status(400).json({ error: 'keys: non-empty array required' });
    const { state, removed } = await reopenMany(REPORTS_DIR, keys);
    res.json({ ok: true, reopened: removed, totalClosed: Object.keys(state.items).length });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/authors', async (req, res) => {
  try {
    const idx = await getIndex();
    const { slug, q } = req.query;
    // Creators is an EXTERNAL-community view: the company's own people and
    // brand/owned channels are excluded by default (they work for us, so they
    // are not community creators to track or engage). Pass includeProduct=1
    // to opt back in.
    const includeProduct = ['1', 'true'].includes(
      String(req.query.includeProduct || '').toLowerCase()
    );
    let authors = idx.authors;
    if (!includeProduct) authors = authors.filter((a) => !a.isProduct);
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

// Creator trajectories + interventions, read straight from the persistent
// creators.json so the web UI can SHOW this intel inline instead of only
// launching the interactive chat command. External-community lens: the
// company's own people are excluded (same as /api/authors).
app.get('/api/creators', async (req, res) => {
  try {
    const idx = await getIndex();
    let slug = String(req.query.slug || '').trim();
    if (!slug) {
      // Default to the slug that appears in the most reports (the primary
      // product being tracked in this workspace).
      const counts = new Map();
      for (const r of idx.reports) {
        if (r.slug) counts.set(r.slug, (counts.get(r.slug) || 0) + 1);
      }
      slug = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    }
    if (!slug) {
      return res.json({ slug: '', missing: true, counts: {}, buckets: {}, interventions: [] });
    }
    // Per-slug creators.json lives under scout-state/{slug}/. Prefer the
    // new .local/state location, fall back to the legacy reports/.scout-state.
    let file = null;
    for (const dir of [SCOUT_STATE_DIR, LEGACY_SCOUT_STATE_DIR]) {
      const candidate = path.join(dir, slug, 'creators.json');
      try {
        await fs.access(candidate);
        file = candidate;
        break;
      } catch {}
    }
    if (!file) {
      return res.json({ slug, missing: true, counts: {}, buckets: {}, interventions: [] });
    }
    let store;
    try {
      store = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return res.json({ slug, error: 'parse', counts: {}, buckets: {}, interventions: [] });
    }
    const all = Object.values(store.creators || {});
    const community = all.filter((c) => c && !c.is_team_member);
    const shape = (c) => {
      const sent = (c.sentiment_classification?.current || 'neutral').toLowerCase();
      const interventions = Array.isArray(c.interventions) ? c.interventions : [];
      return {
        handle: c.handle || '',
        name: c.display_name || c.handle || '(unknown)',
        platform: c.platform || '',
        url: c.profile_url || '',
        trajectory: (c.trajectory || 'new').toLowerCase(),
        sentiment: sent,
        prevSentiment: (c.sentiment_classification?.previous || '').toLowerCase() || null,
        firstSeen: c.first_seen || '',
        lastSeen: c.last_seen || '',
        isInfluencer: !!c.is_influencer,
        postsAll: c.totals?.posts_all ?? (Array.isArray(c.posts) ? c.posts.length : 0),
        posts30d: c.totals?.posts_30d || 0,
        interventionCount: interventions.length,
        lastIntervention: interventions.length ? interventions[interventions.length - 1] : null,
      };
    };
    const shaped = community.map(shape);
    const byActivity = (a, b) =>
      b.postsAll - a.postsAll || (b.lastSeen || '').localeCompare(a.lastSeen || '');
    const isAdvocate = (s) => s === 'positive' || s === 'supporter' || s === 'advocate';
    const buckets = {
      rising: shaped.filter((c) => c.trajectory === 'rising').sort(byActivity),
      dormant: shaped.filter((c) => c.trajectory === 'dormant').sort(byActivity),
      influencers: shaped.filter((c) => c.isInfluencer).sort(byActivity),
      advocates: shaped.filter((c) => isAdvocate(c.sentiment)).sort(byActivity),
      detractors: shaped.filter((c) => c.sentiment === 'negative').sort(byActivity),
    };
    const counts = {
      total: shaped.length,
      rising: buckets.rising.length,
      dormant: buckets.dormant.length,
      influencers: buckets.influencers.length,
      advocates: buckets.advocates.length,
      detractors: buckets.detractors.length,
    };
    // Flatten any logged interventions into a single reverse-chronological log.
    const interventions = [];
    for (const c of shaped) {
      const src = community.find((x) => (x.handle || '') === c.handle);
      const list = Array.isArray(src?.interventions) ? src.interventions : [];
      for (const iv of list) {
        interventions.push({
          creator: c.name,
          platform: c.platform,
          url: c.url,
          date: iv.date || iv.logged_at || '',
          owner: iv.owner || '',
          channel: iv.channel || '',
          note: iv.note || iv.summary || '',
          outcome: iv.outcome || '',
        });
      }
    }
    interventions.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    res.json({ slug, counts, buckets, interventions, builtAt: idx.builtAt });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Source health: which sources contributed and which were skipped last scan.
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
    const sentTotal = (t) =>
      ((t && (t.positive || 0) + (t.neutral || 0) + (t.mixed || 0) + (t.negative || 0)) || 0);
    const groups = [];
    for (const [slug, list] of bySlug.entries()) {
      list.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
      const newest = list[0];
      // Show the freshest report that actually classified sentiment, not just
      // the newest file. A Mindshare-only or items-only scan has 0 classified
      // conversations, and rigidly using it left the card blank ("No
      // conversations in latest scan") even though a recent scan DID have
      // sentiment — which read as stale/broken. Fall back to newest when none
      // have sentiment so brand-new subjects still render.
      const withSent = list.filter((r) => sentTotal(r.sentimentTotals) > 0);
      const latest = withSent[0] || newest;
      const prior = withSent[0] ? withSent[1] : list[1];
      groups.push({
        slug,
        latest: latest && {
          report: latest.name,
          generatedAt: latest.generatedAt,
          totals: latest.sentimentTotals,
          convoCount: latest.convoCount,
          itemCount: latest.itemCount,
        },
        // The literal newest scan, so the client can note when the sentiment
        // shown is carried from an earlier scan rather than the latest run.
        newest: newest && {
          report: newest.name,
          generatedAt: newest.generatedAt,
          convoCount: newest.convoCount,
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
    const cacheKey = `search:${q.toLowerCase()}`;
    const cached = responseCache.get(cacheKey);
    if (cached) return res.json(cached);
    const idx = await getIndex();
    const needle = q.toLowerCase();
    const closed = await loadClosed(REPORTS_DIR);
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
      .map((c) => ({ ...c, key: convoKey(c) }))
      .filter((c) => !closed.items[c.key])
      .slice(0, 20);
    const reportHits = idx.reports.filter((r) => r.name.toLowerCase().includes(needle)).slice(0, 25);
    const authorHits = idx.authors
      .filter((a) => a.name.toLowerCase().includes(needle))
      .slice(0, 10);
    // Full-text grep over reports/*.md + social-posts/*.md so the search
    // also surfaces matches that live in item bodies, blockquotes, social
    // post drafts, and posting-calendar files. Shared with tools/search.mjs.
    let fileHits = [];
    try {
      const corpus = await searchCorpus({
        repoRoot: REPO_ROOT,
        query: q,
        options: { maxFiles: 50, maxSnippetsPerFile: 3 },
      });
      fileHits = corpus.results;
    } catch {
      fileHits = [];
    }
    const payload = {
      q,
      items: itemHits,
      conversations: convoHits,
      reports: reportHits,
      authors: authorHits,
      files: fileHits,
      builtAt: idx.builtAt,
    };
    responseCache.set(cacheKey, payload, 30_000);
    res.json(payload);
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
    output: safeRunOutput(run),
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
  // Use Ollama's HTTP API (no shell) so we don't depend on an executable being on PATH.
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

// --- Sentiment review (local-LLM second opinion) -----------------
// Used by the Conversations triage inbox: a human clicks "🤖 Re-check"
// on a row and we ask the configured agent LLM what it thinks the
// sentiment is, given the same rules the agent uses at report-generation
// time. Default provider is `agent` — it reuses the CLI runner the user
// configured for /scout-scan (Claude Code, Copilot CLI, Codex, …).

app.get('/api/sentiment/status', async (_req, res) => {
  try {
    const env = await readEnvObject();
    const { runner } = await getRunner();
    const status = await probeSentiment(env, { runner });
    res.json(status);
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Derive a human-friendly product name for prompt context. Prefers the
// "**Name:**" line from the scout-config prompt for the slug; falls back
// to title-casing the slug.
async function resolveProductName(slug) {
  const s = String(slug || '').trim();
  if (!s) return '';
  try {
    if (!isValidSlug(s)) return _titleCaseSlug(s);
    const configPath = await resolveConfigPath(s);
    if (!configPath) return _titleCaseSlug(s);
    const raw = await fs.readFile(configPath, 'utf8');
    const m = raw.match(/^[-*]?\s*\*\*Name:\*\*\s*(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return _titleCaseSlug(s);
}
function _titleCaseSlug(slug) {
  return String(slug)
    .split('-')
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

app.post('/api/sentiment/review', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const summary = String(body.summary || '').trim();
    if (!summary) return res.status(400).json({ error: 'summary required' });
    const env = await readEnvObject();
    if (getSentimentProvider(env) === 'none') {
      return res.status(400).json({
        error: 'No sentiment provider configured. Set SENTIMENT_PROVIDER=agent|ollama|openai|custom in .env.',
      });
    }
    const productName = body.productName
      ? String(body.productName).trim()
      : await resolveProductName(body.slug || '');
    const { runner } = await getRunner();
    const result = await reviewSentiment(
      {
        summary,
        author: String(body.author || '').slice(0, 200),
        platform: String(body.platform || '').slice(0, 80),
        productName,
        currentSentiment: String(body.currentSentiment || 'unknown').toLowerCase(),
        userNote: String(body.userNote || '').slice(0, 500),
      },
      env,
      { runner, cwd: REPO_ROOT },
    );
    if (result?.error) {
      return res.status(502).json({ ...result, ok: false });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Suggest an AI explanation + ready-to-use reply for a flagged "needs reply"
// conversation. Powers the dashboard Community-signals "Needs reply" card so a
// click yields something actionable inline (why it matters + a draftable
// reply) instead of bouncing the user to a dead-end view.
app.get('/api/reply/status', async (_req, res) => {
  try {
    const env = await readEnvObject();
    const provider = getReplyProvider(env);
    if (provider === 'none') {
      return res.json({ ok: false, provider, message: 'No reply provider configured' });
    }
    if (provider === 'agent') {
      const { runner } = await getRunner();
      if (!runner) {
        return res.json({ ok: false, provider, message: 'No agent runner configured — pick one on the Setup view.' });
      }
      return res.json({ ok: true, provider, message: 'Reuses your agent runner' });
    }
    res.json({ ok: true, provider, message: `Provider: ${provider}` });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.post('/api/reply/suggest', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const summary = String(body.summary || '').trim();
    if (!summary) return res.status(400).json({ error: 'summary required' });
    const env = await readEnvObject();
    if (getReplyProvider(env) === 'none') {
      return res.status(400).json({
        error: 'No reply provider configured. Set REPLY_SUGGEST_PROVIDER=agent|ollama|openai|custom in .env.',
      });
    }
    const productName = body.productName
      ? String(body.productName).trim()
      : await resolveProductName(body.slug || '');
    const { runner } = await getRunner();
    const result = await suggestReply(
      {
        summary,
        author: String(body.author || '').slice(0, 200),
        platform: String(body.platform || '').slice(0, 80),
        sentiment: String(body.sentiment || 'mixed').toLowerCase(),
        productName,
      },
      env,
      { runner, cwd: REPO_ROOT },
    );
    if (result?.error) {
      return res.status(502).json({ ...result, ok: false });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk re-check sentiment for many conversation rows in one request. Used by
// the Conversations toolbar "Re-check N neutrals" button. Persists results to
// .local/state/sentiment-overrides.json so they survive a server restart and
// get applied during loadReport(). Runs items serially to avoid hammering a
// local Ollama model with parallel requests.
app.post('/api/sentiment/review-bulk', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return res.status(400).json({ error: 'items[] required' });
    const MAX = 100;
    const limited = items.slice(0, MAX);
    const env = await readEnvObject();
    if (getSentimentProvider(env) === 'none') {
      return res.status(400).json({
        error: 'No sentiment provider configured. Set SENTIMENT_PROVIDER=agent|ollama|openai|custom in .env.',
      });
    }
    const productName = body.productName
      ? String(body.productName).trim()
      : await resolveProductName(body.slug || '');
    const { runner } = await getRunner();
    // Sentiment overrides live at .local/state/sentiment-overrides.json;
    // the resolver auto-migrates from the legacy reports/.sentiment-overrides.json
    // on first read.
    const overridesReadPath = await resolveStateRead(SENTIMENT_OVERRIDES_FILE, REPORTS_DIR);
    let overrides = {};
    try {
      if (overridesReadPath) {
        overrides = JSON.parse(await fs.readFile(overridesReadPath, 'utf8')) || {};
      }
    } catch {}
    const results = [];
    for (const raw of limited) {
      const summary = String(raw?.summary || '').trim();
      const url = String(raw?.url || '').trim();
      const key = raw?.key || canonicalUrlKey(url);
      if (!summary) {
        results.push({ key, ok: false, error: 'empty summary' });
        continue;
      }
      try {
        const r = await reviewSentiment(
          {
            summary,
            author: String(raw?.author || '').slice(0, 200),
            platform: String(raw?.platform || '').slice(0, 80),
            productName,
            currentSentiment: String(raw?.currentSentiment || 'unknown').toLowerCase(),
          },
          env,
          { runner, cwd: REPO_ROOT },
        );
        if (r?.error) {
          results.push({ key, ok: false, error: r.error });
        } else {
          results.push({ key, ok: true, ...r });
          if (url) {
            overrides[url] = {
              sentiment: r.sentiment,
              confidence: r.confidence,
              rationale: r.rationale,
              provider: r.provider,
              model: r.model,
              reviewedAt: new Date().toISOString(),
            };
          }
        }
      } catch (err) {
        results.push({ key, ok: false, error: err.message });
      }
    }
    try {
      const overridesWritePath = await resolveStateWrite(SENTIMENT_OVERRIDES_FILE);
      await fs.writeFile(overridesWritePath, JSON.stringify(overrides, null, 2));
      // Overrides affect parsed conversation labels and sentiment totals, but
      // do not change report file mtimes. Drop the in-memory index so Pulse,
      // Conversations, and /api/sentiment-summary see the new verdicts on the
      // next request instead of waiting for the cache TTL.
      _indexCache = null;
      // Re-prime in the background so the next read is warm (see run-success
      // handler for rationale).
      getIndex().catch(() => { /* will rebuild on demand */ });
    } catch (err) {
      return res.json({ ok: true, results, persistError: err.message });
    }
    res.json({ ok: true, results, persisted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/runs', async (req, res) => {
  const { command, args, options } = req.body || {};
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'command required' });
  }
  const result = await startRunInternal(command, args || {}, { options: options || {} });
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
    args: args || {},
    startedAt: new Date().toISOString(),
    finishedAt: null,
    output: '',
    listeners: new Set(),
    promptFile: null,
    bulkId: opts.bulkId || null,
    bulkLabel: opts.bulkLabel || null,
    options: opts.options || {},
  };
  runs.set(id, run);
  if (usedStdin) {
    pushRunOutput(run, `[scout-web] Prompt is ${prompt.length} chars (>${MAX_INLINE_CMD}) — piping via the child process's stdin to avoid the OS command-line length limit.\n[scout-web] Spawning: ${commandLine}\n`);
  }
  if (opts.bulkLabel) {
    pushRunOutput(run, `[scout-web] Bulk run — item: ${opts.bulkLabel}\n`);
  }
  const cleanupPromptFile = () => {
    if (run.promptFile) {
      fs.unlink(run.promptFile).catch(() => {});
      run.promptFile = null;
    }
  };
  const spawnAgentChild = () => {
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
  };

  // ---- Browser-scan preflight (scout-scan only) -------------------
  // When the user runs /scout-scan, refresh the Layer-0 browser-scan
  // sidecars for X/LinkedIn/Reddit BEFORE the agent kicks in, so the
  // agent always sees fresh logged-in results. Opt-out via
  // options.browserScan === 'skip'; force-refresh via 'force'.
  const browserScanOpt = (opts.options && opts.options.browserScan) || 'auto';
  // Optional rangeDays from the Run form — used to scope the
  // browser-scan preflight to the same date window the agent will use.
  // Clamp to 1..365 to keep the CLI happy; missing/invalid → leave 0
  // so the preflight uses its default (30d).
  const rangeDaysRaw = Number(opts.options && opts.options.rangeDays);
  const preflightDays =
    Number.isFinite(rangeDaysRaw) && rangeDaysRaw >= 1
      ? Math.min(365, Math.floor(rangeDaysRaw))
      : 0;
  const preflightSlugs =
    command === 'scout-scan' && browserScanOpt !== 'skip'
      ? await computePreflightSlugs(args)
      : [];
  if (
    command === 'scout-scan' &&
    browserScanOpt !== 'skip' &&
    BROWSER_SCAN_INSTALLED &&
    preflightSlugs.length > 0
  ) {
    runBrowserScanPreflight(run, preflightSlugs, browserScanOpt === 'force', preflightDays)
      .catch((err) => {
        pushRunOutput(run, `\n[browser-scan preflight] error: ${err.message} — continuing without it\n`);
      })
      .then(() => {
        if (run.status === 'running') spawnAgentChild();
      });
  } else {
    if (command === 'scout-scan' && browserScanOpt === 'skip') {
      pushRunOutput(run, `[scout-web] Browser-scan preflight skipped (user opted out).\n`);
    }
    spawnAgentChild();
  }
  return { id, commandLine, prompt };
}

// Resolve the list of subject slugs that a /scout-scan invocation will
// cover. Mirrors the agent's own rule: explicit slug → that slug; "all"
// or empty with multiple configs → every config. Empty with a single
// config → that one config.
async function computePreflightSlugs(args) {
  const raw = String((args && args.slug) || '').trim();
  if (raw && raw !== 'all') {
    // Could be comma-separated from a multi-select. Split + filter.
    const parts = raw.split(/[,\s]+/).filter((s) => s && isValidSlug(s));
    if (parts.length) return parts;
  }
  try {
    const configs = await listConfigs();
    return configs.map((c) => c.slug);
  } catch {
    return [];
  }
}

// Run `node tools/browser-scan/index.mjs scan --slug {slug}` for every
// slug whose freshest sidecar is older than 6 hours (or force=true).
// Streams stdout/stderr into the parent run so the user sees progress.
// Resolves when every needed slug has finished (or been skipped). Never
// rejects — failures are logged into the run output.
async function runBrowserScanPreflight(run, slugs, force = false, days = 0) {
  const windowLine = days > 0 ? ` (date window: last ${days} day${days === 1 ? '' : 's'})` : '';
  pushRunOutput(
    run,
    `[browser-scan] Preflight starting for ${slugs.length} subject${slugs.length === 1 ? '' : 's'}${windowLine}: ${slugs.join(', ')}\n`,
  );
  const probe = await probeCdpPort(9222);
  if (!probe.up) {
    // No browser on the CDP port. Rather than skipping the whole Layer-0
    // pass and making the user hand-run launch-edge.mjs every time, try
    // to auto-launch the dedicated CDP-profile browser. That profile keeps
    // the signed-in cookies from the one-time sign-in, so the relaunch is
    // silent (no re-login) as long as the session is still valid.
    const relaunched = await ensureBrowserForPreflight(run, 9222);
    if (!relaunched.up) {
      pushRunOutput(
        run,
        `[browser-scan] No browser is running on CDP port 9222 and auto-launch did not come up in time — skipping preflight.\n` +
        `[browser-scan]   If you have never signed in, run: node tools/browser-scan/launch-edge.mjs (one-time login per platform).\n` +
        `[browser-scan]   Then sign in to X / LinkedIn / Reddit once; future runs relaunch the browser automatically.\n` +
        `[browser-scan] Continuing with API/RSS layers only.\n`,
      );
      return;
    }
    probe.up = true;
    probe.browser = relaunched.browser;
  }
  pushRunOutput(run, `[browser-scan] Attached to ${probe.browser || 'browser'} on CDP port 9222.\n`);

  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  for (const slug of slugs) {
    // Freshness check unless forced. Consult both the new and legacy
    // sidecar dirs and use the freshest mtime across either.
    if (!force) {
      let freshest = 0;
      for (const slugDir of browserScanReadDirs(slug)) {
        try {
          const files = await fs.readdir(slugDir);
          for (const f of files) {
            if (!/^\d{4}-\d{2}-\d{2}-\d{4}-(x|linkedin|reddit|google)\.json$/.test(f)) continue;
            const stat = await fs.stat(path.join(slugDir, f));
            if (stat.mtimeMs > freshest) freshest = stat.mtimeMs;
          }
        } catch { /* no dir yet → skip */ }
      }
      if (freshest && Date.now() - freshest < SIX_HOURS_MS) {
        const ageMin = Math.floor((Date.now() - freshest) / 60000);
        pushRunOutput(
          run,
          `[browser-scan] ${slug}: sidecars are ${ageMin}m old (<6h) — reusing.\n`,
        );
        continue;
      }
    }
    pushRunOutput(
      run,
      `[browser-scan] ${slug}: scanning X / LinkedIn / Reddit / Google News${days > 0 ? ` (last ${days}d)` : ''}…\n`,
    );
    const scanArgs = [path.join(BROWSER_SCAN_DIR, 'index.mjs'), 'scan', '--slug', slug];
    if (days > 0) scanArgs.push('--days', String(days));
    await new Promise((resolve) => {
      const child = spawn(process.execPath, scanArgs, { cwd: REPO_ROOT, env: process.env });
      // Track on run so a stop request can kill the preflight too.
      run.child = child;
      child.stdout.on('data', (d) => pushRunOutput(run, d.toString()));
      child.stderr.on('data', (d) => pushRunOutput(run, d.toString()));
      child.on('close', (code) => {
        run.child = null;
        if (code === 0) {
          pushRunOutput(run, `[browser-scan] ${slug}: preflight complete.\n`);
        } else {
          pushRunOutput(run, `[browser-scan] ${slug}: preflight exited ${code} — agent will fall back to API/RSS layers for this subject.\n`);
        }
        resolve();
      });
      child.on('error', (err) => {
        run.child = null;
        pushRunOutput(run, `[browser-scan] ${slug}: spawn error: ${err.message}\n`);
        resolve();
      });
    });
  }
  pushRunOutput(run, `[browser-scan] Preflight done — starting agent.\n\n`);
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
  const { command, slug, urls, extra, range, concurrency, options } = req.body || {};
  // Defensive: only accept a known options shape so a malformed payload
  // can't smuggle arbitrary fields onto the per-run record.
  const safeOptions = options && typeof options === 'object'
    ? { skipThumbnails: !!options.skipThumbnails }
    : {};
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
    const safeOutput = run ? safeRunOutput(run) : '';
    item.posts = run ? extractSocialPostPaths(safeOutput) : [];
    // Capture the (already-redacted) run output so the bulk summary can
    // inline the post body even if no `social-posts/*.md` file was written
    // — and so the bulk report is fully self-contained (no cross-file
    // links that may or may not resolve in the user's markdown viewer).
    item.output = safeOutput;
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
      options: safeOptions,
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
    res.write(`data: ${JSON.stringify({ chunk: safeRunOutput(run) })}\n\n`);
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

// Auto-launch the dedicated CDP-profile browser for a /scout-scan
// preflight when nothing is listening on the CDP port. This is what
// removes the per-run "go run launch-edge.mjs yourself" friction: the
// dedicated profile persists the signed-in cookies from the one-time
// sign-in, so relaunching it restores the X / LinkedIn / Reddit sessions
// without any human step. We only attempt this if that profile actually
// exists on disk (i.e. the user has signed in at least once); otherwise
// launching would just pop empty login pages with no session to reuse.
// Returns the post-launch probe result. Never throws.
async function ensureBrowserForPreflight(run, port) {
  if (!BROWSER_SCAN_INSTALLED) return { up: false };
  const hasProfile =
    fsExistsSync(BROWSER_PROFILE_DIR) || fsExistsSync(LEGACY_BROWSER_PROFILE_DIR);
  if (!hasProfile) {
    pushRunOutput(
      run,
      `[browser-scan] No signed-in browser profile found yet — auto-launch needs a one-time sign-in first.\n`,
    );
    return { up: false };
  }
  pushRunOutput(
    run,
    `[browser-scan] No browser on CDP port ${port} — auto-launching the signed-in profile…\n`,
  );
  try {
    const launcher = path.join(BROWSER_SCAN_DIR, 'launch-edge.mjs');
    // Default the auto-launched dedicated-profile browser to Edge so the
    // preflight never attaches to (or wakes) the user's everyday default
    // browser — that's the recurring source of "connected but couldn't read
    // tabs" hangs when the default is a heavily-loaded Chrome. The launcher
    // treats SCOUT_BROWSER as a SOFT preference and falls back to the OS
    // default if the chosen browser isn't installed. Override by exporting
    // SCOUT_BROWSER before starting the web UI server.
    const preferredBrowser = (process.env.SCOUT_BROWSER || 'Microsoft Edge').trim();
    pushRunOutput(run, `[browser-scan] Auto-launching ${preferredBrowser} (dedicated CDP profile).\n`);
    const child = spawn(process.execPath, [launcher, '--port', String(port)], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, SCOUT_BROWSER: preferredBrowser },
    });
    child.unref();
  } catch (err) {
    pushRunOutput(run, `[browser-scan] Auto-launch failed to spawn: ${err.message}\n`);
    return { up: false };
  }
  // Poll the CDP port until the browser is ready (up to ~30s).
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const probe = await probeCdpPort(port);
    if (probe.up) {
      pushRunOutput(run, `[browser-scan] Browser is up on CDP port ${port}.\n`);
      return probe;
    }
  }
  return { up: false };
}

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
  // List sidecars per slug across new (.local/state/browser-scan) and
  // legacy (reports/.browser-scan) dirs. Newer stamp wins per platform.
  const sidecarRoots = [BROWSER_SCAN_SIDECAR_DIR, LEGACY_BROWSER_SCAN_DIR];
  const bySlug = {};
  for (const sidecarRoot of sidecarRoots) {
    let slugs = [];
    try { slugs = await fs.readdir(sidecarRoot); } catch { continue; }
    for (const slug of slugs) {
      if (!isValidSlug(slug)) continue;
      const slugDir = path.join(sidecarRoot, slug);
      let files = [];
      try { files = await fs.readdir(slugDir); } catch { continue; }
      const platforms = bySlug[slug] || {};
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const m = f.match(/^(\d{4}-\d{2}-\d{2}-\d{4})-(x|linkedin|reddit|google)\.json$/);
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
  }
  res.json({
    installed: true,
    port,
    cdp,
    sidecarsBySlug: bySlug,
  });
});

// GET /api/browser-scan/pending?slug=X — are there browser-scan sidecars
// captured *after* the latest report for this slug (i.e. sign-in-scan posts
// that no /scout-scan run has folded into a report yet)? Powers the
// dashboard "captured but not ingested" hint so fresh social chatter doesn't
// silently look stale on the Community-signals card. Social platforms only
// (x / linkedin / reddit) — google sidecars are content-only and never feed
// that card. No CDP probe: this is a pure filesystem comparison.
app.get('/api/browser-scan/pending', async (req, res) => {
  if (!BROWSER_SCAN_INSTALLED) return res.json({ installed: false, pending: false, platforms: [] });
  const slug = String(req.query.slug || '').trim();
  if (!isValidSlug(slug)) return res.json({ installed: true, pending: false, platforms: [] });

  // Newest report stamp for this slug. Reports are {stamp}-{slug}-content.md.
  let latestReportStamp = '';
  try {
    const reports = await listMarkdownFiles(REPORTS_DIR);
    for (const r of reports) {
      const m = r.name.match(/^(\d{4}-\d{2}-\d{2}-\d{4})-(.+)-content\.md$/);
      if (m && m[2] === slug && m[1] > latestReportStamp) latestReportStamp = m[1];
    }
  } catch { /* no reports dir yet → every sidecar counts as pending */ }

  // Newest sidecar per social platform across canonical + legacy dirs.
  const SOCIAL = ['x', 'linkedin', 'reddit'];
  const newest = {}; // platform -> { stamp, dir, file }
  for (const root of [BROWSER_SCAN_SIDECAR_DIR, LEGACY_BROWSER_SCAN_DIR]) {
    const slugDir = path.join(root, slug);
    let files = [];
    try { files = await fs.readdir(slugDir); } catch { continue; }
    for (const f of files) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2}-\d{4})-(x|linkedin|reddit)\.json$/);
      if (!m) continue;
      const [, stamp, platform] = m;
      if (!newest[platform] || stamp > newest[platform].stamp) {
        newest[platform] = { stamp, dir: slugDir, file: f };
      }
    }
  }

  // A platform is "pending" when its newest sidecar postdates the latest
  // report. Count items by reading the sidecar array.
  const platforms = [];
  let totalItems = 0;
  let newestSidecarStamp = '';
  for (const platform of SOCIAL) {
    const s = newest[platform];
    if (!s) continue;
    if (s.stamp > newestSidecarStamp) newestSidecarStamp = s.stamp;
    if (latestReportStamp && s.stamp <= latestReportStamp) continue; // already ingested
    let count = 0;
    try {
      const arr = JSON.parse(await fs.readFile(path.join(s.dir, s.file), 'utf8'));
      count = Array.isArray(arr) ? arr.length : 0;
    } catch { /* unreadable sidecar — surface it with count 0 */ }
    platforms.push({ platform, stamp: s.stamp, count });
    totalItems += count;
  }

  res.json({
    installed: true,
    pending: totalItems > 0,
    latestReportStamp,
    newestSidecarStamp,
    platforms,
    totalItems,
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

// POST /api/browser-scan/auth-check — attach to the running browser via
// CDP and report per-platform sign-in status (X / LinkedIn / Reddit).
// Spawns tools/browser-scan/check-logins.mjs in --json mode. Slow (~10s)
// but accurate; the UI calls this on demand, not on every poll.
app.post('/api/browser-scan/auth-check', async (req, res) => {
  if (!BROWSER_SCAN_INSTALLED) return res.status(404).json({ error: 'browser-scan not installed' });
  const port = Number((req.body && req.body.port) || 9222);
  const probe = await probeCdpPort(port);
  if (!probe.up) {
    return res.status(409).json({
      ok: false,
      error: 'cdp-down',
      message: 'No browser is listening on the CDP port. Click "Open browser & sign in" first.',
      port,
    });
  }
  const checker = path.join(BROWSER_SCAN_DIR, 'check-logins.mjs');
  const args = [checker, '--port', String(port), '--json'];
  const child = spawn(process.execPath, args, {
    cwd: BROWSER_SCAN_DIR, // so `import 'playwright'` resolves
    env: process.env,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  const timeout = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }, 60000);
  child.on('close', (code) => {
    clearTimeout(timeout);
    // check-logins.mjs prints exactly one JSON line on success or on
    // graceful CDP errors (exit 2). Parse the last non-blank line.
    const line = out.trim().split(/\r?\n/).filter(Boolean).pop();
    if (line && line.startsWith('{')) {
      try {
        const parsed = JSON.parse(line);
        // Defense-in-depth: Playwright error messages echoed in `error`
        // / `raw` can include WS URLs, headers, or other tool output —
        // run them through the same redactor used for streamed logs.
        if (parsed && typeof parsed.error === 'string') parsed.error = redactSecrets(parsed.error);
        if (parsed && parsed.platforms && typeof parsed.platforms === 'object') {
          for (const k of Object.keys(parsed.platforms)) {
            const p = parsed.platforms[k];
            if (p && typeof p.raw === 'string') p.raw = redactSecrets(p.raw);
            if (p && typeof p.finalUrl === 'string') p.finalUrl = redactSecrets(p.finalUrl);
          }
        }
        return res.json(parsed);
      } catch { /* fall through */ }
    }
    res.status(500).json({
      ok: false,
      error: 'parse-failed',
      exitCode: code,
      stderr: redactSecrets(err.slice(-1000)),
      stdout: redactSecrets(out.slice(-1000)),
    });
  });
  child.on('error', (e) => {
    clearTimeout(timeout);
    res.status(500).json({ ok: false, error: 'spawn-failed', message: redactSecrets(e.message) });
  });
});

// POST /api/browser-scan/scan — run `node index.mjs scan --slug {slug}`
// as a child process and stream output via the same /api/runs/:id/stream
// surface used by other commands.
app.post('/api/browser-scan/scan', async (req, res) => {
  if (!BROWSER_SCAN_INSTALLED) return res.status(404).json({ error: 'browser-scan not installed' });
  const { slug, platforms, port, days } = req.body || {};
  if (!slug || !isValidSlug(slug)) return res.status(400).json({ error: 'valid slug required' });
  // Whether to fold the fresh sidecars into a report once the scan finishes.
  // Default true so "run completes → data is ingested" is the standard
  // behavior; pass { ingest: false } for a pure sidecar refresh.
  const wantIngest = (req.body && req.body.ingest) !== false;
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
    const valid = platforms.filter((p) => ['x', 'linkedin', 'reddit', 'google', 'content-sites'].includes(p));
    if (valid.length) args.push('--platforms', valid.join(','));
  }
  // Optional date-range scope. Clamp to a sane 1..365 day window.
  const daysNum = Number(days);
  if (Number.isFinite(daysNum) && daysNum >= 1) {
    args.push('--days', String(Math.min(365, Math.floor(daysNum))));
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
  // Capture the spawn time so the close handler can tell whether THIS run
  // wrote fresh social sidecars (used to gate auto-ingest — see below).
  const runStartMs = Date.now();
  child.stdout.on('data', (d) => pushRunOutput(run, d.toString()));
  child.stderr.on('data', (d) => pushRunOutput(run, d.toString()));
  child.on('close', async (code) => {
    run.child = null;
    closeRun(run, code === 0 ? 'success' : `exited ${code}`);
    if (!wantIngest) return;
    // Gate auto-ingest on "did this run write fresh X/LinkedIn/Reddit
    // sidecars?", NOT on the exit code. The browser-scan tool routinely
    // exits non-zero on a Google News timeout *after* successfully writing
    // all three social sidecars, so keying off code===0 would strand 100+
    // good posts (exactly the bug the user hit). A hard failure (CDP down)
    // writes no sidecars, so this check still correctly skips ingest.
    let freshSocial = 0;
    try {
      for (const dir of browserScanReadDirs(slug)) {
        let files = [];
        try { files = await fs.readdir(dir); } catch { continue; }
        for (const f of files) {
          if (!/-(x|linkedin|reddit)\.json$/.test(f)) continue;
          try {
            const st = await fs.stat(path.join(dir, f));
            // -2s slack for clock granularity between spawn and first write.
            if (st.mtimeMs >= runStartMs - 2000) freshSocial += 1;
          } catch { /* ignore unreadable */ }
        }
      }
    } catch { /* fall through → treated as no fresh sidecars */ }
    if (freshSocial === 0) {
      if (code !== 0) {
        pushRunOutput(run, `\n[scout-web] Browser scan exited ${code} and wrote no fresh social sidecars — skipping auto-ingest. Check the log above (often a sign-in/CDP issue).\n`);
      }
      return;
    }
    if (code !== 0) {
      pushRunOutput(run, `\n[scout-web] Browser scan reported exit ${code} but wrote ${freshSocial} fresh social sidecar(s) (commonly a Google News timeout after the social platforms succeeded) — ingesting anyway.\n`);
    }
    // Default behavior: a completed browser scan should leave its posts
    // ingested into a report, not stranded in sidecars. Chain a /scout-scan
    // agent run scoped to this slug (browserScan: 'skip' — we just scanned)
    // so the fresh X/LinkedIn/Reddit posts land in a report's Conversations
    // & Mentions section. Requires a configured runner; without one we leave
    // the dashboard's pending-sidecar hint to nudge manual ingestion.
    let runner = '';
    try { ({ runner } = await getRunner()); } catch { /* treat as unconfigured */ }
    if (!runner) {
      pushRunOutput(run, `\n[scout-web] Browser scan done. No agent runner is configured, so the posts stay in sidecars — open the dashboard and click "Run a scan to ingest", or run /scout-scan, to fold them into a report.\n`);
      return;
    }
    pushRunOutput(run, `\n[scout-web] Browser scan done — auto-starting /scout-scan for "${slug}" to ingest the fresh posts into a report (no re-scan).\n`);
    try {
      const chained = await startRunInternal('scout-scan', { slug }, { options: { browserScan: 'skip' } });
      if (chained && chained.id) {
        pushRunOutput(run, `[scout-web] Ingest run started → ${chained.id}. Watch it in the Operations drawer.\n`);
      } else if (chained && chained.error) {
        pushRunOutput(run, `[scout-web] Could not auto-start the ingest run: ${chained.error.error || 'unknown error'}\n`);
      }
    } catch (err) {
      pushRunOutput(run, `[scout-web] Could not auto-start the ingest run: ${err.message}\n`);
    }
  });
  child.on('error', (err) => { pushRunOutput(run, `[browser-scan] ${err.message}\n`); run.child = null; closeRun(run, 'error'); });
  res.json({ ok: true, id, command, willIngest: wantIngest });
});

// --- In-browser analytics endpoints --------------------------------
// Same artifacts the /scout-seo agent command produces, but computed in
// pure Node from data already on disk so the Reports view can run with one
// click. No LLM, no subprocess. See tools/lib/analytics.mjs for the engine.

app.post('/api/analytics/seo', express.json(), async (req, res) => {
  try {
    const { urls, slug } = req.body || {};
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'urls array is required' });
    }
    // Cap to 5 URLs per call so a stray paste can't fan out into a
    // long blocking fetch storm.
    const targets = urls.slice(0, 5).map((u) => String(u).trim()).filter(Boolean);
    const pages = await Promise.all(
      targets.map(async (url) => {
        try {
          const r = await fetch(url, {
            headers: { 'user-agent': 'Mozilla/5.0 (compatible; ContentScout/1.0; +https://github.com/jagordon/content-scout)' },
            redirect: 'follow',
          });
          if (!r.ok) return { url, error: `HTTP ${r.status}` };
          return { url, html: await r.text() };
        } catch (e) {
          return { url, error: String(e.message || e) };
        }
      })
    );
    // Optional LLM rewrite pass. Folds the /scout-seo "Suggested rewrites"
    // (title, meta description, alternative H1s, opening paragraph, JSON-LD)
    // into this audit when a provider is configured. Best-effort and serial:
    // any failure degrades to a note and the deterministic audit still
    // returns. Default provider reuses the configured agent runner. See
    // tools/web-ui/lib/seo-rewrite.js.
    const rewritesByUrl = {};
    let rewriteProvider = null;
    const wantRewrites = (req.body || {}).rewrites !== false;
    const env = await readEnvObject();
    const provider = getSeoRewriteProvider(env);
    if (wantRewrites && provider !== 'none') {
      rewriteProvider = provider;
      const productName = await resolveProductName(slug || '');
      const { runner } = await getRunner();
      const { keywords, audience, goal } = req.body || {};
      for (const p of pages) {
        if (!p.html) continue;
        try {
          const snapshot = extractSeoSnapshot(p.html, p.url);
          const excerpt = htmlToText(p.html).slice(0, 1500);
          rewritesByUrl[p.url] = await generateSeoRewrites(
            {
              url: p.url,
              snapshot,
              excerpt,
              productName,
              keywords: String(keywords || '').slice(0, 200),
              audience: String(audience || '').slice(0, 200),
              goal: String(goal || '').slice(0, 200),
            },
            env,
            { runner, cwd: REPO_ROOT },
          );
        } catch (e) {
          rewritesByUrl[p.url] = { provider, error: String(e.message || e) };
        }
      }
    }
    const result = runSeoAudit({ pages, slug: isValidSlug(slug) ? slug : '', rewritesByUrl });
    await fs.writeFile(path.join(REPORTS_DIR, result.fileName), result.markdown, 'utf8');
    const rewriteCount = Object.values(rewritesByUrl).filter((r) => hasAnyRewrite(r)).length;
    res.json({ ok: true, fileName: result.fileName, data: result.data, rewriteProvider, rewriteCount });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, HOST, async () => {
  const { runner, source } = await getRunner();
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Content Scout web UI running at http://${displayHost}:${PORT}`);
  console.log(`Repo root: ${REPO_ROOT}`);
  console.log(`Bind: ${HOST}${HOST === '0.0.0.0' ? ' (LAN-exposed — set SCOUT_HOST=127.0.0.1 to restrict)' : ' (loopback only)'}`);
  console.log(`Runner: ${runner || '(none — pick an agent on the Setup view)'}${source !== 'none' ? ` [${source}]` : ''}`);
  // Warm the live Copilot model list (ACP handshake takes ~10s) so the Setup
  // picker inherits the agent's real models without blocking the first request.
  warmCopilotModels().catch(() => {});
  // Health check: warn if any command-prompt files referenced by the UI are
  // missing from disk, AND warn if any command-style prompt files exist on
  // disk that the UI doesn't know about (likely orphans from a removed feature
  // or a typo). scout-config-*.prompt.md is excluded — those are user configs.
  const expectedPrompts = [
    'scout-onboard.prompt.md', 'scout-scan.prompt.md', 'scout-post.prompt.md',
    'scout-calendar.prompt.md',
    'scout-creators.prompt.md', 'scout-doctor.prompt.md', 'scout-keys.prompt.md',
    'scout-seo.prompt.md', 'scout-reddit-import.prompt.md',
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
  // Prime the report index in the background so the first dashboard load is
  // served warm. Building it lazily on the first /api/conversations call is
  // what made a freshly-started server feel slow on the very first open.
  // Fire-and-forget — failures here are non-fatal and will simply rebuild on
  // demand.
  getIndex().catch(() => { /* will rebuild on first request */ });
});
