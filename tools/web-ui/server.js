import express from 'express';
import { marked } from 'marked';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo root = tools/web-ui/../..
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROMPTS_DIR = path.join(REPO_ROOT, '.github', 'prompts');
const REPORTS_DIR = path.join(REPO_ROOT, 'reports');
const SOCIAL_DIR = path.join(REPO_ROOT, 'social-posts');
const ENV_FILE = path.join(REPO_ROOT, '.env');
const ENV_EXAMPLE = path.join(REPO_ROOT, '.env.example');
const SETTINGS_FILE = path.join(__dirname, '.scout-web-settings.json');

const PORT = Number(process.env.PORT || 4477);

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
    runner: 'copilot -p "{prompt}"',
    install: 'https://docs.github.com/en/copilot/github-copilot-in-the-cli',
    note: 'Requires the newer `copilot` CLI (not `gh copilot`). Agent mode + prompt files supported.',
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
      (f) => f.startsWith('scout-config-') && f.endsWith('.prompt.md') && f !== 'scout-config-example.prompt.md'
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
  const file = path.join(PROMPTS_DIR, `scout-config-${slug}.prompt.md`);
  const raw = await fs.readFile(file, 'utf8');
  return { slug, file: `scout-config-${slug}.prompt.md`, raw };
}

async function writeConfig(slug, raw) {
  const file = path.join(PROMPTS_DIR, `scout-config-${slug}.prompt.md`);
  await fs.writeFile(file, raw, 'utf8');
}

// Built-in role presets. Each sets smart defaults matching the /scout-onboard role table.
// Keys are short ids; `label` is the human name written into the config.
const ROLE_PRESETS = {
  'program-manager': {
    label: 'Program Manager',
    focus: 'Adoption metrics, SDK usage, feature coverage, feature request flagging, community feedback',
    ordering: 'adoption first',
    flags: { socialPosts: false, postingCalendar: false, competitorTracking: false, conferenceCfp: false, launchCoverage: false, risingContributors: false, communityHealth: false, docGapFocus: false, sdkAdoption: true, featureRequests: true, unansweredQuestions: true },
  },
  'product-manager': {
    label: 'Product Manager',
    focus: 'Market signals, competitor mentions, customer requests, sentiment analysis',
    ordering: 'market signals first',
    flags: { socialPosts: false, postingCalendar: false, competitorTracking: true, conferenceCfp: false, launchCoverage: false, risingContributors: false, communityHealth: false, docGapFocus: false, sdkAdoption: true, featureRequests: true, unansweredQuestions: true },
  },
  'social-media-manager': {
    label: 'Social Media Manager',
    focus: 'Post-ready content, engagement opportunities, trending topics, conversation sentiment',
    ordering: 'trending first',
    flags: { socialPosts: true, postingCalendar: true, competitorTracking: false, conferenceCfp: false, launchCoverage: false, risingContributors: false, communityHealth: false, docGapFocus: false, sdkAdoption: false, featureRequests: false, unansweredQuestions: false },
  },
  'product-marketer': {
    label: 'Product Marketer',
    focus: 'Launch coverage, success stories, analyst mentions, campaign amplification',
    ordering: 'launches first',
    flags: { socialPosts: true, postingCalendar: true, competitorTracking: true, conferenceCfp: true, launchCoverage: true, risingContributors: false, communityHealth: false, docGapFocus: false, sdkAdoption: false, featureRequests: true, unansweredQuestions: false },
  },
  'developer-advocate': {
    label: 'Developer Advocate',
    focus: 'Community projects, tutorials, rising contributors, conference talks',
    ordering: 'community first',
    flags: { socialPosts: true, postingCalendar: true, competitorTracking: false, conferenceCfp: true, launchCoverage: false, risingContributors: true, communityHealth: true, docGapFocus: false, sdkAdoption: false, featureRequests: false, unansweredQuestions: true },
  },
  'community-manager': {
    label: 'Community Manager',
    focus: 'Contributor tracking, sentiment trends, engagement health, unanswered questions',
    ordering: 'community first',
    flags: { socialPosts: false, postingCalendar: false, competitorTracking: false, conferenceCfp: false, launchCoverage: false, risingContributors: true, communityHealth: true, docGapFocus: false, sdkAdoption: false, featureRequests: false, unansweredQuestions: true },
  },
  'technical-writer': {
    label: 'Technical Writer',
    focus: 'Doc gap analysis, tutorial patterns, FAQ signals, community tutorials vs. official docs',
    ordering: 'doc gaps first',
    flags: { socialPosts: false, postingCalendar: false, competitorTracking: false, conferenceCfp: false, launchCoverage: false, risingContributors: false, communityHealth: false, docGapFocus: true, sdkAdoption: false, featureRequests: false, unansweredQuestions: true },
  },
};

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

// Suggest canonical topic tags based on the subject's type, name, and search terms.
// This is a deterministic heuristic — no AI call required — so it works offline
// and returns instantly. The goal is to seed a sensible starter set the user
// can edit, matching patterns the /scout-onboard prompt uses.
const TAG_LIBRARY = {
  universal: ['getting-started', 'best-practices', 'troubleshooting', 'performance', 'security'],
  database: ['data-modeling', 'partitioning', 'indexing', 'query-perf', 'migration', 'backup-restore', 'replication', 'consistency', 'cost-optimization', 'sdk'],
  language: ['syntax', 'stdlib', 'async', 'concurrency', 'tooling', 'package-management', 'testing', 'ffi-interop', 'ecosystem'],
  framework: ['routing', 'state-management', 'data-fetching', 'auth', 'testing', 'deployment', 'plugins', 'upgrade-guides'],
  tool: ['configuration', 'integrations', 'automation', 'ci-cd', 'plugins', 'workflows'],
  topic: ['fundamentals', 'patterns', 'case-studies', 'tooling', 'integrations'],
  product: ['features', 'integrations', 'sdk', 'migration', 'cost-optimization', 'monitoring', 'observability'],
  project: ['contributing', 'architecture', 'extensions', 'integrations', 'release-notes'],
  technology: ['fundamentals', 'patterns', 'sdk', 'integrations', 'deployment', 'observability', 'cost-optimization'],
};
// Keyword hits → bonus tags (adds domain-specific suggestions from search terms).
const TAG_KEYWORDS = [
  [/\b(ai|llm|gpt|model|embedding|agent)\b/i, ['ai', 'llm', 'embeddings']],
  [/\b(serverless|functions?|lambda|workers?)\b/i, ['serverless', 'cold-start', 'scaling']],
  [/\b(container|docker|kubernetes|k8s|aks)\b/i, ['containers', 'orchestration', 'deployment']],
  [/\b(cosmos|mongo|postgres|mysql|sql|database|db)\b/i, ['data-modeling', 'partitioning', 'query-perf']],
  [/\b(react|vue|angular|svelte|next|nuxt)\b/i, ['state-management', 'ssr', 'routing']],
  [/\b(security|auth|oauth|jwt|saml|entra|ad)\b/i, ['auth', 'security', 'identity']],
  [/\b(test|pytest|jest|playwright|cypress|junit)\b/i, ['testing', 'e2e', 'unit-tests']],
  [/\b(devops|ci|cd|pipeline|github\s*actions)\b/i, ['ci-cd', 'automation', 'deployment']],
  [/\b(observability|telemetry|logs?|metrics|tracing)\b/i, ['observability', 'monitoring', 'tracing']],
  [/\b(mobile|ios|android|flutter|react\s*native)\b/i, ['mobile', 'native', 'cross-platform']],
  [/\b(web|frontend|ui|ux)\b/i, ['frontend', 'ui-patterns', 'accessibility']],
  [/\b(api|rest|graphql|grpc)\b/i, ['api-design', 'integrations']],
];

app.post('/api/suggest-topic-tags', express.json(), (req, res) => {
  const body = req.body || {};
  const type = String(body.type || 'product').toLowerCase();
  const terms = Array.isArray(body.searchTerms) ? body.searchTerms : [];
  const name = String(body.name || '');
  const haystack = [name, ...terms].join(' ').toLowerCase();

  const set = new Set();
  // Seed with type-specific + universal tags.
  const typeKey = type in TAG_LIBRARY ? type : 'product';
  for (const t of (TAG_LIBRARY[typeKey] || [])) set.add(t);
  // Add a universal "getting-started" + "best-practices" baseline for all.
  for (const t of TAG_LIBRARY.universal) set.add(t);
  // Apply keyword matches.
  for (const [pattern, tags] of TAG_KEYWORDS) {
    if (pattern.test(haystack)) tags.forEach((t) => set.add(t));
  }
  // Cap at ~12 so the list stays scannable.
  const suggestions = [...set].slice(0, 12);
  res.json({ suggestions, type: typeKey });
});

// Suggest search terms and hashtags derived from a subject's name. Produces
// aliases, lowercase, with/without vendor prefix, spaced/unspaced variants,
// plus a few common extensions. Pure heuristic — no network or AI call.
const VENDOR_PREFIXES = ['Azure', 'AWS', 'Google', 'GCP', 'Microsoft', 'Apple', 'Oracle', 'IBM'];
function stripVendor(s) {
  for (const v of VENDOR_PREFIXES) {
    const re = new RegExp(`^${v}\\s+`, 'i');
    if (re.test(s)) return s.replace(re, '');
  }
  return null;
}
function camelize(s) {
  return s.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}
app.post('/api/suggest-identity', express.json(), (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const type = String(body.type || 'product').toLowerCase();
  if (!name) return res.status(400).json({ error: 'name required' });

  // --- Search terms: full name, stripped-vendor name, unspaced, lowercase ---
  const termsSet = new Set();
  termsSet.add(name);
  const stripped = stripVendor(name);
  if (stripped) termsSet.add(stripped);
  const unspaced = name.replace(/\s+/g, '');
  if (unspaced !== name) termsSet.add(unspaced);
  // Acronyms (e.g., "Azure Cosmos DB" → "ACD") — only if 2+ capital-starting words
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const acr = words.map((w) => w[0]).join('').toUpperCase();
    if (acr.length >= 2 && acr.length <= 5) termsSet.add(acr);
  }

  // --- Hashtags: camelized full, camelized stripped, vendor alone ---
  const hashSet = new Set();
  hashSet.add(camelize(name));
  if (stripped) hashSet.add(camelize(stripped));
  for (const v of VENDOR_PREFIXES) {
    if (new RegExp(`\\b${v}\\b`, 'i').test(name)) hashSet.add(v);
  }
  // Add type-flavored hashtag if relevant
  if (type === 'framework' || type === 'language' || type === 'tool') {
    const key = camelize(stripped || name);
    if (key) hashSet.add(`${key}Dev`);
  }

  res.json({
    terms: [...termsSet].filter(Boolean).slice(0, 8),
    hashtags: [...hashSet].filter((t) => t && t.length >= 2).slice(0, 8),
  });
});

// Suggest likely official channel URLs/handles. Pure heuristic — users verify.
// Returns { blog: [...], youtube: [...], social: [...] }.
app.post('/api/suggest-channels', express.json(), (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const slugIn = String(body.slug || '').trim().toLowerCase();
  if (!name) return res.status(400).json({ error: 'name required' });
  const slug = slugIn || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const stripped = stripVendor(name) || name;
  const camelFull = camelize(name);
  const camelStripped = camelize(stripped);
  const unspaced = name.replace(/\s+/g, '');
  const slugNoDash = slug.replace(/-/g, '');
  const isMsft = /\b(azure|microsoft)\b/i.test(name);
  const isAws = /\baws\b/i.test(name);
  const isGoogle = /\b(google|gcp)\b/i.test(name);

  const blog = [];
  if (isMsft) {
    blog.push(`https://devblogs.microsoft.com/${slug}/`);
    blog.push(`https://techcommunity.microsoft.com/category/${slug}`);
    blog.push(`https://aka.ms/${slugNoDash}blog`);
  } else if (isAws) {
    blog.push(`https://aws.amazon.com/blogs/${slug}/`);
  } else if (isGoogle) {
    blog.push(`https://cloud.google.com/blog/products/${slug}`);
  }
  blog.push(`https://www.google.com/search?q=${encodeURIComponent(name + ' official blog')}`);

  const youtube = [];
  youtube.push(`https://www.youtube.com/@${camelStripped || camelFull}`);
  if (camelFull !== camelStripped) youtube.push(`https://www.youtube.com/@${camelFull}`);
  youtube.push(`https://www.youtube.com/@${unspaced}`);
  youtube.push(`https://www.youtube.com/results?search_query=${encodeURIComponent(name)}`);

  const social = [];
  // X/Twitter + Bluesky style handles
  if (camelStripped) social.push(`@${camelStripped}`);
  if (camelFull && camelFull !== camelStripped) social.push(`@${camelFull}`);
  if (unspaced && !social.includes(`@${unspaced}`)) social.push(`@${unspaced}`);
  // LinkedIn
  if (isMsft) {
    social.push(`https://www.linkedin.com/showcase/${slug}/`);
  } else {
    social.push(`https://www.linkedin.com/company/${slug}/`);
  }
  // Mastodon (fedi-friendly)
  if (camelStripped) social.push(`@${camelStripped.toLowerCase()}@mastodon.social`);

  // Dedupe preserving order
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  res.json({ blog: uniq(blog).slice(0, 6), youtube: uniq(youtube).slice(0, 5), social: uniq(social).slice(0, 8) });
});

// Suggest competitors + conferences. Heuristic map keyed on words in the subject name.
// Users verify/edit — this is just a seed list to save typing.
const COMPETITOR_MAP = [
  [/\bcosmos\b|\bdynamodb\b|\bmongo\b|nosql/i, ['MongoDB', 'DynamoDB', 'Firestore', 'Couchbase', 'CockroachDB', 'FaunaDB', 'ScyllaDB']],
  [/\bredis\b|\bcache\b|memcached/i, ['Redis', 'Memcached', 'Hazelcast', 'KeyDB', 'DragonflyDB']],
  [/\bkubernetes\b|\baks\b|\beks\b|\bgke\b/i, ['EKS', 'GKE', 'AKS', 'OpenShift', 'Rancher', 'Nomad']],
  [/\bfunctions?\b|\blambda\b|serverless/i, ['AWS Lambda', 'Google Cloud Functions', 'Cloudflare Workers', 'Vercel Functions']],
  [/\bservice bus\b|\bkafka\b|\bpubsub\b|messaging/i, ['Apache Kafka', 'RabbitMQ', 'AWS SQS', 'Google Pub/Sub', 'NATS']],
  [/\bsql\b|\bpostgres\b|\bmysql\b|database/i, ['PostgreSQL', 'MySQL', 'SQL Server', 'Aurora', 'CockroachDB']],
  [/\bstorage\b|\bblob\b|\bs3\b/i, ['Amazon S3', 'Google Cloud Storage', 'Backblaze B2', 'Cloudflare R2']],
  [/\bai\b|\bopenai\b|\bllm\b|foundry/i, ['OpenAI', 'Anthropic', 'Google Vertex AI', 'AWS Bedrock', 'Hugging Face']],
  [/\bapp service\b|\bweb app\b|\bhosting\b/i, ['Vercel', 'Netlify', 'Heroku', 'Render', 'Fly.io']],
  [/\bcontainer apps\b|\bcloud run\b|\becs\b/i, ['Google Cloud Run', 'AWS ECS', 'AWS App Runner', 'Fly.io']],
];

const CONFERENCE_MAP = [
  [/\bazure\b|\bmicrosoft\b/i, ['Microsoft Build', 'Microsoft Ignite', 'MVP Summit']],
  [/\baws\b|\bamazon\b/i, ['AWS re:Invent', 'AWS Summit']],
  [/\bgoogle\b|\bgcp\b/i, ['Google Cloud Next', 'Google I/O']],
  [/\bkubernetes\b|\baks\b|\beks\b|\bcontainer\b/i, ['KubeCon', 'CloudNativeCon', 'DockerCon']],
  [/\bai\b|\bopenai\b|\bllm\b/i, ['NeurIPS', 'ICML', 'AI Engineer Summit']],
  [/\bjava\b/i, ['JavaOne', 'Devoxx', 'SpringOne']],
  [/\bdotnet\b|\b\.net\b|\bc#\b/i, ['.NET Conf', 'NDC', 'Microsoft Build']],
  [/\bjavascript\b|\bnode\b|\breact\b/i, ['JSConf', 'React Conf', 'Node Congress']],
  [/\bpython\b/i, ['PyCon', 'PyData', 'EuroPython']],
  [/\bdata\b|\banalytics\b|\bsql\b/i, ['Data + AI Summit', 'Strata', 'PASS Data Community Summit']],
];

app.post('/api/suggest-related', express.json(), (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const competitors = [];
  const conferences = [];
  for (const [re, list] of COMPETITOR_MAP) {
    if (re.test(name)) {
      for (const c of list) if (!competitors.includes(c) && c.toLowerCase() !== name.toLowerCase()) competitors.push(c);
    }
  }
  for (const [re, list] of CONFERENCE_MAP) {
    if (re.test(name)) {
      for (const c of list) if (!conferences.includes(c)) conferences.push(c);
    }
  }
  res.json({ competitors: competitors.slice(0, 10), conferences: conferences.slice(0, 8) });
});

// --- Brand logo upload --------------------------------------------
// Accepts a base64-encoded image and saves it under
//   social-posts/images/brand/{slug}/{filename}
// Returns { path, dir } with repo-relative paths so the UI can populate
// the Logo directory field. Keeps things simple — no multer dependency.
const LOGO_EXT_RE = /\.(png|jpe?g|gif|svg|webp|ico|avif)$/i;
app.post('/api/upload-logo', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const slugIn = String(body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
    if (!slugIn) return res.status(400).json({ error: 'slug required' });
    const filenameIn = String(body.filename || '').trim();
    // Sanitize filename: strip path separators, keep only basename + allowed extension.
    const safeName = path.basename(filenameIn).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!safeName || !LOGO_EXT_RE.test(safeName)) {
      return res.status(400).json({ error: 'filename must end in a supported image extension (.png, .jpg, .svg, .webp, .gif, .ico, .avif)' });
    }
    const dataBase64 = String(body.dataBase64 || '');
    const comma = dataBase64.indexOf(',');
    const b64 = comma >= 0 ? dataBase64.slice(comma + 1) : dataBase64;
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return res.status(400).json({ error: 'empty file' });
    if (buf.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'file too large (>10 MB)' });
    const relDir = path.posix.join('social-posts', 'images', 'brand', slugIn);
    const absDir = path.join(REPO_ROOT, 'social-posts', 'images', 'brand', slugIn);
    await fs.mkdir(absDir, { recursive: true });
    const absFile = path.join(absDir, safeName);
    await fs.writeFile(absFile, buf);
    res.json({ path: path.posix.join(relDir, safeName), dir: relDir + '/', filename: safeName, size: buf.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List images already present in a brand logo directory (repo-relative).
app.get('/api/list-logos', async (req, res) => {
  try {
    const dirIn = String(req.query.dir || '').trim();
    if (!dirIn) return res.json({ files: [] });
    // Resolve against repo root and ensure we stay inside it.
    const abs = path.resolve(REPO_ROOT, dirIn);
    if (!abs.startsWith(REPO_ROOT)) return res.status(400).json({ error: 'path escapes repo' });
    const entries = await fs.readdir(abs).catch(() => []);
    const files = entries.filter((f) => LOGO_EXT_RE.test(f)).sort();
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Suggest known community authors/MVPs for the subject. Pure heuristic map of
// publicly recognized community voices keyed on subject-name regexes. Users
// MUST verify each before saving — suggestions are starting points only.
const AUTHORS_MAP = [
  [/\bcosmos\s*db\b|\bcosmosdb\b/i, [
    'Mark Brown | Microsoft | Azure Cosmos DB PM',
    'Tim Sander | Microsoft | Azure Cosmos DB PM',
    'Leonard Lobel | MVP | .NET + Cosmos DB',
  ]],
  [/\bazure\b/i, [
    'Scott Hanselman | Microsoft | Developer advocate',
    'Troy Hunt | MVP | Azure security',
    'Richard Campbell | .NET Rocks | .NET + Azure podcast',
  ]],
  [/\bkubernetes\b|\bk8s\b|\baks\b/i, [
    'Kelsey Hightower | Independent | Kubernetes educator',
    'Liz Rice | Isovalent | eBPF + security',
    'Bridget Kromhout | Microsoft | Cloud native',
  ]],
  [/\b\.net\b|\bdotnet\b|\bc#\b/i, [
    'Nick Chapsas | YouTube | .NET deep dives',
    'Tim Corey | YouTube | .NET educator',
    'Scott Hanselman | Microsoft | .NET',
    'Jon Skeet | Google | C# expert',
  ]],
  [/\bjava\b|\bspring\b/i, [
    'Josh Long | VMware | Spring advocate',
    'Venkat Subramaniam | Independent | Agile Developer',
    'Baeldung | Baeldung.com | Java tutorials',
  ]],
  [/\bpython\b/i, [
    'Miguel Grinberg | Independent | Flask/Python expert',
    'Will McGugan | Textualize | Python TUI',
    'Raymond Hettinger | Core Python | Python tutorials',
  ]],
  [/\breact\b/i, [
    'Dan Abramov | Independent | React core',
    'Kent C. Dodds | Independent | React educator',
    'Josh W. Comeau | Independent | React/CSS',
  ]],
  [/\bpostgres\b|\bpostgresql\b/i, [
    'Bruce Momjian | EDB | Postgres core',
    'Lukas Fittl | pganalyze | Postgres performance',
    'Craig Kerstiens | Crunchy Data | Postgres',
  ]],
  [/\bmongodb\b/i, [
    'Lauren Schaefer | MongoDB | Developer advocate',
    'Michael Lynn | MongoDB | Developer advocate',
  ]],
  [/\baws\b|\blambda\b/i, [
    'Yan Cui | theburningmonk | Serverless',
    'Jeremy Daly | Serverless Inc | Serverless',
    'Corey Quinn | Last Week in AWS | AWS commentary',
  ]],
];

app.post('/api/suggest-authors', express.json(), (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const authors = [];
  for (const [re, list] of AUTHORS_MAP) {
    if (re.test(name)) {
      for (const a of list) if (!authors.includes(a)) authors.push(a);
    }
  }
  res.json({ authors: authors.slice(0, 10) });
});

// Suggest defaults for the Advanced step — brand, social-post standards,
// posting prefs, and language/region. Pure heuristic; users always edit.
app.post('/api/suggest-brand-defaults', express.json(), (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const stripped = stripVendor(name) || name;
  const unspaced = name.replace(/\s+/g, '');
  const brand = {
    productName: name,
    logoRules: 'Use full logo on dark backgrounds, icon-only on accent. Maintain clear space ≥ logo height ÷ 2.',
    colors: { bg: '#0f172a', accent: '#2563eb', highlight: '#22d3ee', text: '#ffffff' },
    font: 'Segoe UI Semibold for headlines, Segoe UI Regular for body',
    composition: 'Logo top-left, headline center-left, accent bar bottom edge',
    guardrails: 'Never stretch or recolor the logo. Never use competitor brand colors. Never crop the logo.',
  };
  const socialStandards = {
    audience: 'Backend developers, cloud architects, DevOps engineers',
    tone: 'Plainspoken, technically credible, non-marketing',
    shortName: stripped !== name ? stripped : '',
    neverWrite: unspaced !== name ? unspaced : '',
    avoidWords: 'revolutionary, game-changer, leverage, synergy, ecosystem, unlock, supercharge',
    emoji: '0–2 max, never decorative',
    hashtag: '1–2 at end of post',
    thingsAvoid: 'em dashes, UTM links, fluff phrases, vague claims without numbers',
    additional: '',
  };
  const postingPrefs = {
    frequency: '3–5 posts per week',
    avoid: 'No posts late Friday or weekends',
    approval: 'Drafts go to review doc before publishing',
    tagTeam: '',
  };
  const language = { langs: 'English', regions: 'Global' };
  res.json({ brand, socialStandards, postingPrefs, language });
});

// Curated map of VERIFIED excluded GitHub orgs/repos and domains for known
// subjects. Each entry must be a real, currently-existing GitHub org/repo or
// a real public domain/path. If a subject doesn't match any entry we return
// empty arrays rather than fabricate plausible-looking but invalid values.
// Last verified: 2026-04-24.
const EXTRAS_MAP = [
  [/\bcosmos\s*db\b|\bcosmosdb\b/i, {
    repos: [
      'Azure/azure-cosmos-dotnet-v3',
      'Azure/azure-cosmos-js',
      'Azure/azure-cosmos-java',
      'Azure/azure-cosmos-python',
      'Azure-Samples/cosmos-db-design-patterns',
      'Azure-Samples/azure-cosmos-db-dotnet',
    ],
    domains: [
      'devblogs.microsoft.com/cosmosdb',
      'learn.microsoft.com/azure/cosmos-db',
    ],
  }],
  [/\bazure\s+functions?\b/i, {
    repos: [
      'Azure/azure-functions-host',
      'Azure/azure-functions-core-tools',
      'Azure-Samples/azure-functions-samples',
    ],
    domains: [
      'learn.microsoft.com/azure/azure-functions',
      'techcommunity.microsoft.com/category/azure/azure-functions',
    ],
  }],
  [/\bazure\b/i, {
    repos: ['Azure/*', 'Azure-Samples/*', 'microsoft/*'],
    domains: [
      'azure.microsoft.com',
      'learn.microsoft.com/azure',
      'devblogs.microsoft.com',
      'techcommunity.microsoft.com',
    ],
  }],
  [/\baws\s+lambda\b|\blambda\b/i, {
    repos: [
      'aws/aws-lambda-runtime-interface-emulator',
      'aws/aws-lambda-dotnet',
      'aws/aws-lambda-java-libs',
      'aws-samples/serverless-patterns',
    ],
    domains: [
      'aws.amazon.com/blogs/compute',
      'docs.aws.amazon.com/lambda',
    ],
  }],
  [/\baws\b/i, {
    repos: ['aws/*', 'aws-samples/*', 'awsdocs/*'],
    domains: ['aws.amazon.com/blogs', 'docs.aws.amazon.com'],
  }],
  [/\b(google\s*cloud|gcp)\b/i, {
    repos: ['GoogleCloudPlatform/*', 'googleapis/*'],
    domains: ['cloud.google.com/blog', 'cloud.google.com/docs'],
  }],
  [/\bkubernetes\b|\bk8s\b/i, {
    repos: ['kubernetes/kubernetes', 'kubernetes/website', 'kubernetes-sigs/*'],
    domains: ['kubernetes.io/blog', 'kubernetes.io/docs'],
  }],
  [/\b\.net\b|\bdotnet\b/i, {
    repos: ['dotnet/*', 'microsoft/dotnet'],
    domains: ['devblogs.microsoft.com/dotnet', 'learn.microsoft.com/dotnet'],
  }],
  [/\bpostgres\b|\bpostgresql\b/i, {
    repos: ['postgres/postgres'],
    domains: ['postgresql.org/about/news', 'postgresql.org/docs'],
  }],
  [/\bmongodb\b/i, {
    repos: ['mongodb/mongo', 'mongodb/docs'],
    domains: ['mongodb.com/blog', 'mongodb.com/docs'],
  }],
  [/\breact\b/i, {
    repos: ['facebook/react', 'reactjs/react.dev'],
    domains: ['react.dev/blog'],
  }],
];

// Suggest extras for the Advanced step — influencers (high-signal accounts),
// excluded GitHub orgs/repos, and excluded domains. Returns ONLY verified
// entries; unknown subjects yield empty arrays so users aren't fed fabricated
// repo paths or URLs.
app.post('/api/suggest-extras', express.json(), (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });

  const influencers = [];
  for (const [re, list] of AUTHORS_MAP) {
    if (re.test(name)) {
      for (const a of list) if (!influencers.includes(a)) influencers.push(a);
    }
  }

  const repos = [];
  const domains = [];
  for (const [re, entry] of EXTRAS_MAP) {
    if (re.test(name)) {
      for (const r of entry.repos || []) if (!repos.includes(r)) repos.push(r);
      for (const d of entry.domains || []) if (!domains.includes(d)) domains.push(d);
    }
  }

  res.json({
    influencers: influencers.slice(0, 10),
    repos: repos.slice(0, 10),
    domains: domains.slice(0, 8),
  });
});

// valid config — users can enrich brand assets, conferences, competitors, etc. via the
// Configs editor or by running /scout-onboard in a chat agent.
function renderConfigTemplate(opts) {
  const {
    name, slug, type,
    roleIds = [], customRoleLabel = '',
    flags = {},
    focusOverride = '', orderingOverride = '',
    searchTerms = [], hashtags = [], topicTags = [],
    exclusions = {}, // { blog, youtube, handles: [], repos: [], domains: [] }
    watchlist = [],  // [{ name, affiliation, handle }]
    influencers = [], // [{ name, platform, handle }]
    teamMembers = [], // [{ name, context }]
    brand = {},      // { logoDir, thumbnailStyle, theme, productName, logoRules, colors:{bg,accent,highlight,text}, font, composition, guardrails }
    socialAccounts = {}, // { linkedin, x, bluesky, youtube }
    socialStandards = {}, // { audience, tone, shortName, neverWrite, avoidWords, emoji, hashtag, thingsAvoid, additional }
    postingPrefs = {}, // { frequency, avoid, approval, tagTeam }
    language = {},   // { langs, regions }
    competitors = [], // ["MongoDB", "DynamoDB"]
    conferences = [], // ["KubeCon", "re:Invent"]
    customSources = [], // [{ name, type, url }]
    standardSources = null, // optional array to override the default standard-source list
  } = opts;
  const terms = searchTerms.length ? searchTerms.map((t) => `"${t}"`).join(', ') : `"${name}"`;
  const tags = hashtags.length ? hashtags.map((h) => `#${h}`).join(', ') : 'none';
  const topicList = topicTags.length ? topicTags.join(', ') : 'architecture, integration, sdk, performance, release, tutorial';

  // Resolve role label(s) and default flags by merging selected presets (any-true wins).
  const selected = roleIds.map((id) => ROLE_PRESETS[id]).filter(Boolean);
  const roleLabel = selected.length
    ? selected.map((p) => p.label).join(', ')
    : (customRoleLabel || 'Custom');
  const mergedFlags = selected.reduce((acc, p) => {
    for (const [k, v] of Object.entries(p.flags)) acc[k] = acc[k] || v;
    return acc;
  }, {});
  // Explicit form overrides win over preset defaults.
  const f = { ...mergedFlags, ...flags };
  const focus = focusOverride || selected[0]?.focus || 'Tutorials, SDK releases, integration content, performance deep-dives';
  const ordering = orderingOverride || selected[0]?.ordering || 'SDK first';
  const on = (v) => (v ? 'on' : 'off');

  const joinList = (v, fallback) => {
    if (Array.isArray(v)) {
      const items = v.map((s) => String(s).trim()).filter(Boolean);
      return items.length ? items.join(', ') : fallback;
    }
    if (typeof v === 'string' && v.trim()) return v.trim();
    return fallback;
  };
  const officialBlog = joinList(exclusions.blog, '(add during refinement)');
  const officialYouTube = joinList(exclusions.youtube, '(add during refinement)');
  const officialHandles = joinList(exclusions.handles, '(add during refinement)');

  const watchRows = Array.isArray(watchlist) && watchlist.length
    ? watchlist.map((w) => `| ${w.name || ''} | ${w.affiliation || ''} | ${w.handle || ''} |`)
    : ['|      |             |        |'];

  const influencerLines = Array.isArray(influencers) && influencers.length
    ? influencers.map((i) => `- ${i.name || ''} — ${i.platform || ''} — ${i.handle || ''}`).join('\n')
    : '_None tracked. Add to enable high-signal account monitoring._';

  const teamLines = Array.isArray(teamMembers) && teamMembers.length
    ? teamMembers.map((t) => `- ${t.name || ''} — ${t.context || ''}`).join('\n')
    : '_None listed. Add to flag team-authored content as Team Member Mentions instead of external coverage._';

  const repoLines = Array.isArray(exclusions.repos) && exclusions.repos.length
    ? exclusions.repos.map((r) => `- ${r}`).join('\n')
    : '- none';
  const domainLines = Array.isArray(exclusions.domains) && exclusions.domains.length
    ? exclusions.domains.map((d) => `- ${d}`).join('\n')
    : '- none';

  const brandLogoDir = brand.logoDir?.trim() || 'none';
  const brandThumbStyle = brand.thumbnailStyle?.trim() || 'text-only';
  const brandTheme = brand.theme?.trim() || 'dark';

  const competitorList = Array.isArray(competitors) && competitors.length
    ? competitors.map((c) => `- ${c}`).join('\n')
    : '_None tracked. Add to enable competitor mention tracking._';

  const conferenceList = Array.isArray(conferences) && conferences.length
    ? conferences.map((c) => `- ${c}`).join('\n')
    : '_None tracked. Add to enable CFP and talk tracking._';

  const defaultStandardSources = [
    '1. **GitHub** — community repos, SDK releases, samples',
    '2. **Community blogs** — Dev.to, Medium, Hashnode, Blogspot, WordPress, DZone, C# Corner, InfoQ',
    '3. **Conversation tracking (not numbered):** Stack Overflow, Reddit, Hacker News, Bluesky, X/Twitter, LinkedIn',
  ];
  const standardSourceList = Array.isArray(standardSources) && standardSources.length
    ? standardSources
    : defaultStandardSources;

  const customSourceRows = Array.isArray(customSources) && customSources.length
    ? customSources.map((s) => `| ${s.name || ''} | ${s.type || ''} | ${s.url || ''} |`)
    : [];

  return [
    '---',
    `description: Content Scout configuration for ${name}`,
    'mode: content-scout',
    '---',
    '',
    `# scout-config: ${name}`,
    '',
    `Apply this configuration to the Content Scout agent.`,
    '',
    '## Role',
    '',
    `- **Role:** ${roleLabel}`,
    `- **Social posts:** ${on(f.socialPosts)}`,
    `- **Posting calendar:** ${on(f.postingCalendar)}`,
    `- **Report focus:** ${focus}`,
    `- **Report section ordering:** ${ordering}`,
    `- **Engagement scoring:** on`,
    `- **Conversation sentiment:** on`,
    `- **Feature request flagging:** ${on(f.featureRequests)}`,
    `- **Unanswered question tracking:** ${on(f.unansweredQuestions)}`,
    `- **Rising contributors:** ${on(f.risingContributors)}`,
    `- **SDK/feature adoption tracking:** ${on(f.sdkAdoption)}`,
    `- **Competitor tracking:** ${on(f.competitorTracking)}`,
    `- **Conference CFP tracking:** ${on(f.conferenceCfp)}`,
    `- **Launch coverage tracking:** ${on(f.launchCoverage)}`,
    `- **Community health signals:** ${on(f.communityHealth)}`,
    `- **Doc gap focus:** ${on(f.docGapFocus)}`,
    '',
    '## Topic Identity',
    '',
    `- **Name:** ${name}`,
    `- **Slug:** ${slug}`,
    `- **Type:** ${type}`,
    `- **Search terms (text):** ${terms}`,
    `- **Search hashtags:** ${tags}`,
    '',
    '## Official Channels (used to classify content as Official vs. Community)',
    '',
    `- **Official blog URLs:** ${officialBlog}`,
    `- **Official YouTube channels:** ${officialYouTube}`,
    `- **Official social accounts:** ${officialHandles}`,
    '',
    '### Excluded GitHub Orgs/Repos',
    '',
    repoLines,
    '',
    '### Excluded Domains/Authors',
    '',
    domainLines,
    '',
    '### Product Team Members',
    '<!-- Content by these people appears in "Team Member Mentions" section, not as numbered items. -->',
    '',
    teamLines,
    '',
    '## Known Author Watchlist',
    '',
    'External community developers whose content always passes quality filter. Fill in as you identify them.',
    '',
    '| Name | Affiliation | Handle |',
    '|------|-------------|--------|',
    ...watchRows,
    '',
    '## Influencers to Monitor',
    '',
    influencerLines,
    '',
    '## Brand Assets',
    '',
    `- **Logo directory:** ${brandLogoDir}`,
    `- **Logos available:** ${brandLogoDir === 'none' ? 'none' : '(auto-discovered from directory)'}`,
    `- **Product name on thumbnails:** ${brand.productName || name}`,
    `- **Logo usage rules:** ${brand.logoRules || 'none'}`,
    '- **Brand colors:**',
    `  - Primary background: ${brand.colors?.bg || 'none'}`,
    `  - Accent: ${brand.colors?.accent || 'none'}`,
    `  - Highlight: ${brand.colors?.highlight || 'none'}`,
    `  - Text: ${brand.colors?.text || 'none'}`,
    `- **Thumbnail style:** ${brandThumbStyle}`,
    `- **Background theme:** ${brandTheme}`,
    `- **Font:** ${brand.font || 'none'}`,
    `- **Thumbnail composition:** ${brand.composition || 'none'}`,
    `- **Brand guardrails (never do):** ${brand.guardrails || 'none'}`,
    '',
    '## Social Post Platforms',
    '',
    '| Platform | Account |',
    '|----------|---------|',
    `| LinkedIn | ${socialAccounts.linkedin || 'none'} |`,
    `| X | ${socialAccounts.x || 'none'} |`,
    `| Bluesky | ${socialAccounts.bluesky || 'none'} |`,
    `| YouTube Community | ${socialAccounts.youtube || 'none'} |`,
    '',
    '## Social Post Standards',
    '',
    `- **Target audience:** ${socialStandards.audience || 'defaults'}`,
    `- **Tone:** ${socialStandards.tone || 'defaults'}`,
    `- **Brand name — canonical form:** ${brand.productName || name}`,
    `- **Brand name — acceptable short form:** ${socialStandards.shortName || 'none — always use full name'}`,
    `- **Brand name — never write:** ${socialStandards.neverWrite || 'none'}`,
    `- **Avoid words/phrases:** ${socialStandards.avoidWords || 'none'}`,
    `- **Emoji policy:** ${socialStandards.emoji || '0-2 max'}`,
    `- **Hashtag policy:** ${socialStandards.hashtag || '1-2 at end'}`,
    `- **Things to avoid:** ${socialStandards.thingsAvoid || 'none'}`,
    `- **Additional rules:** ${socialStandards.additional || 'none'}`,
    '',
    '## Posting Preferences',
    '',
    `- **Target posting frequency:** ${postingPrefs.frequency || 'none specified'}`,
    `- **Days/times to avoid:** ${postingPrefs.avoid || 'none'}`,
    `- **Approval workflow:** ${postingPrefs.approval || 'none'}`,
    `- **Team members to tag:** ${postingPrefs.tagTeam || 'none'}`,
    '',
    '## Language & Region',
    '',
    `- **Languages:** ${language.langs || 'English'}`,
    `- **Region focus:** ${language.regions || 'Global'}`,
    '',
    '## Competitors',
    '',
    competitorList,
    '',
    '## Conferences',
    '',
    conferenceList,
    '',
    '## API Keys',
    '',
    '_Keys are stored in `.env` — see `.env.example` for setup._',
    '',
    '## Content Sources (scan order)',
    '',
    '### Standard Sources',
    ...standardSourceList,
    '',
    '_To enable YouTube scanning, add it here along with your official channel ID to exclude (e.g., `YouTube (excluding UCxxxx) — community tutorials via Data API v3`)._',
    '',
    '### Custom Sources',
    '',
    customSourceRows.length ? '| Name | Type | URL |' : '_None configured. Add rows to the table below to track specific blogs, newsletters, podcasts, or other sources._',
    ...(customSourceRows.length ? ['|------|------|-----|', ...customSourceRows] : ['', '| Name | Type | URL |', '|------|------|-----|']),
    '',
    '## Content Quality Filter',
    '',
    '**INCLUDE:** tutorials, architecture deep-dives, problem-solving stories, demos, SDK releases, conference talks, performance deep-dives, integration content, success stories, educational content with depth',
    '',
    '**EXCLUDE:** "What is" intros, shallow listicles, name-drop posts, AI content farms, job postings, certification guides, YouTube videos with no description',
    '',
    '**Scoring:** Product depth (1-3) + practical value (1-3) + originality (1-3) >= 5/9 to include',
    '',
    '## Topic Tags',
    '',
    topicList,
    '',
    '## Output Files',
    '',
    `- Reports: \`reports/{YYYY-MM-DD-HHmm}-${slug}-content.md\``,
    '- Dedup tracker: `reports/.seen-links.json`',
    `- Social posts: \`social-posts/{YYYY-MM-DD-HHmm}-${slug}-social-posts.md\``,
    `- Thumbnails: \`social-posts/images/{YYYY-MM-DD-HHmm}/{N}-{platform}-${slug}.png\``,
    `- Posting calendar: \`social-posts/{YYYY-MM-DD-HHmm}-${slug}-posting-calendar.md\``,
    '',
  ].join('\n');
}

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
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error('invalid filename');
  }
  const file = path.join(dir, name);
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
    if (existing.some((c) => c.slug === slug)) {
      return res.status(409).json({ error: `config already exists for slug "${slug}"` });
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
    if (typeof req.body?.raw !== 'string') {
      return res.status(400).json({ error: 'raw must be a string' });
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
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      return res.status(400).json({ error: 'invalid slug' });
    }
    const file = path.join(PROMPTS_DIR, `scout-config-${slug}.prompt.md`);
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

app.listen(PORT, async () => {
  const { runner, source } = await getRunner();
  console.log(`Content Scout web UI running at http://localhost:${PORT}`);
  console.log(`Repo root: ${REPO_ROOT}`);
  console.log(`Runner: ${runner || '(none — pick an agent on the Setup view)'}${source !== 'none' ? ` [${source}]` : ''}`);
});
