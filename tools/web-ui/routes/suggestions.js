// All `/api/suggest-*` and brand-logo endpoints. These were extracted from
// server.js to shrink the monolith. They are pure heuristics (no network /
// AI calls) plus two filesystem helpers for brand logos.
//
// Usage in server.js:
//   import createSuggestionsRouter from './routes/suggestions.js';
//   app.use(createSuggestionsRouter({ repoRoot: REPO_ROOT }));
//
// Mounted at root because the routes already begin with `/api/`.

import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';

// --- Topic tag library ----------------------------------------------------
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

// --- Vendor / camelize helpers --------------------------------------------
const VENDOR_PREFIXES = ['Azure', 'AWS', 'Google', 'GCP', 'Microsoft', 'Apple', 'Oracle', 'IBM'];

export function stripVendor(s) {
  for (const v of VENDOR_PREFIXES) {
    const re = new RegExp(`^${v}\\s+`, 'i');
    if (re.test(s)) return s.replace(re, '');
  }
  return null;
}

export function camelize(s) {
  return s.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

// --- Competitor / conference / authors / extras maps ---------------------
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

const LOGO_EXT_RE = /\.(png|jpe?g|gif|svg|webp|ico|avif)$/i;

/**
 * Build the suggestions / brand-logo Express router.
 * @param {{ repoRoot: string }} opts
 */
export default function createSuggestionsRouter({ repoRoot }) {
  if (!repoRoot) throw new Error('repoRoot is required');
  const router = express.Router();

  router.post('/api/suggest-topic-tags', express.json(), (req, res) => {
    const body = req.body || {};
    const type = String(body.type || 'product').toLowerCase();
    const terms = Array.isArray(body.searchTerms) ? body.searchTerms : [];
    const name = String(body.name || '');
    const haystack = [name, ...terms].join(' ').toLowerCase();

    const set = new Set();
    const typeKey = type in TAG_LIBRARY ? type : 'product';
    for (const t of (TAG_LIBRARY[typeKey] || [])) set.add(t);
    for (const t of TAG_LIBRARY.universal) set.add(t);
    for (const [pattern, tags] of TAG_KEYWORDS) {
      if (pattern.test(haystack)) tags.forEach((t) => set.add(t));
    }
    res.json({ suggestions: [...set].slice(0, 12), type: typeKey });
  });

  router.post('/api/suggest-identity', express.json(), (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const type = String(body.type || 'product').toLowerCase();
    if (!name) return res.status(400).json({ error: 'name required' });

    const termsSet = new Set();
    termsSet.add(name);
    const stripped = stripVendor(name);
    if (stripped) termsSet.add(stripped);
    const unspaced = name.replace(/\s+/g, '');
    if (unspaced !== name) termsSet.add(unspaced);
    const words = name.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      const acr = words.map((w) => w[0]).join('').toUpperCase();
      if (acr.length >= 2 && acr.length <= 5) termsSet.add(acr);
    }

    const hashSet = new Set();
    hashSet.add(camelize(name));
    if (stripped) hashSet.add(camelize(stripped));
    for (const v of VENDOR_PREFIXES) {
      if (new RegExp(`\\b${v}\\b`, 'i').test(name)) hashSet.add(v);
    }
    if (type === 'framework' || type === 'language' || type === 'tool') {
      const key = camelize(stripped || name);
      if (key) hashSet.add(`${key}Dev`);
    }

    res.json({
      terms: [...termsSet].filter(Boolean).slice(0, 8),
      hashtags: [...hashSet].filter((t) => t && t.length >= 2).slice(0, 8),
    });
  });

  router.post('/api/suggest-channels', express.json(), (req, res) => {
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
    if (camelStripped) social.push(`@${camelStripped}`);
    if (camelFull && camelFull !== camelStripped) social.push(`@${camelFull}`);
    if (unspaced && !social.includes(`@${unspaced}`)) social.push(`@${unspaced}`);
    if (isMsft) {
      social.push(`https://www.linkedin.com/showcase/${slug}/`);
    } else {
      social.push(`https://www.linkedin.com/company/${slug}/`);
    }
    if (camelStripped) social.push(`@${camelStripped.toLowerCase()}@mastodon.social`);

    const uniq = (arr) => [...new Set(arr.filter(Boolean))];
    res.json({ blog: uniq(blog).slice(0, 6), youtube: uniq(youtube).slice(0, 5), social: uniq(social).slice(0, 8) });
  });

  router.post('/api/suggest-related', express.json(), (req, res) => {
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

  // Brand logo upload — saves under social-posts/images/brand/{slug}/{filename}.
  router.post('/api/upload-logo', express.json({ limit: '20mb' }), async (req, res) => {
    try {
      const body = req.body || {};
      const slugIn = String(body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
      if (!slugIn) return res.status(400).json({ error: 'slug required' });
      const filenameIn = String(body.filename || '').trim();
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
      const absDir = path.join(repoRoot, 'social-posts', 'images', 'brand', slugIn);
      await fs.mkdir(absDir, { recursive: true });
      const absFile = path.join(absDir, safeName);
      await fs.writeFile(absFile, buf);
      res.json({ path: path.posix.join(relDir, safeName), dir: relDir + '/', filename: safeName, size: buf.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/list-logos', async (req, res) => {
    try {
      const dirIn = String(req.query.dir || '').trim();
      if (!dirIn) return res.json({ files: [] });
      const abs = path.resolve(repoRoot, dirIn);
      if (!abs.startsWith(repoRoot)) return res.status(400).json({ error: 'path escapes repo' });
      const entries = await fs.readdir(abs).catch(() => []);
      const files = entries.filter((f) => LOGO_EXT_RE.test(f)).sort();
      res.json({ files });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/suggest-authors', express.json(), (req, res) => {
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

  router.post('/api/suggest-brand-defaults', express.json(), (req, res) => {
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

  router.post('/api/suggest-extras', express.json(), (req, res) => {
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

  return router;
}
