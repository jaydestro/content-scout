#!/usr/bin/env node
// Content Scout — interactive onboarding CLI
// Arrow-key navigation via @inquirer/prompts. Writes scout-config-{slug}.prompt.md
// at the repo root's .github/prompts/ directory, plus optional .env entries.

import { select, input, checkbox, confirm, password } from '@inquirer/prompts';
import { writeFile, mkdir, readFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo root is three levels up: tools/onboard-cli/bin -> tools/onboard-cli -> tools -> root
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const PROMPTS_DIR = join(REPO_ROOT, '.github', 'prompts');
const ENV_PATH = join(REPO_ROOT, '.env');
const ENV_EXAMPLE = join(REPO_ROOT, '.env.example');

const ROLES = [
  { value: 'program-manager', name: 'Program Manager', summary: 'Adoption metrics, SDK usage, feature coverage' },
  { value: 'product-manager', name: 'Product Manager', summary: 'Market signals, competitors, customer requests' },
  { value: 'social-media-manager', name: 'Social Media Manager', summary: 'Post-ready content, engagement, calendar' },
  { value: 'product-marketer', name: 'Product Marketer', summary: 'Launches, success stories, analysts' },
  { value: 'developer-advocate', name: 'Developer Advocate / DevRel', summary: 'Community projects, tutorials, conferences' },
  { value: 'community-manager', name: 'Community Manager', summary: 'Contributors, sentiment, engagement health' },
  { value: 'technical-writer', name: 'Technical Writer', summary: 'Doc gaps, FAQs, tutorial patterns' },
  { value: 'custom', name: 'Custom', summary: 'Pick features individually' },
];

const PRODUCT_TYPES = [
  { value: 'product', name: 'Product' },
  { value: 'technology', name: 'Technology / language' },
  { value: 'project', name: 'Open-source project' },
  { value: 'tool', name: 'Tool / CLI' },
];

const SOURCES = [
  { value: 'devto', name: 'Dev.to' },
  { value: 'medium', name: 'Medium' },
  { value: 'hashnode', name: 'Hashnode' },
  { value: 'dzone', name: 'DZone' },
  { value: 'csharpcorner', name: 'C# Corner' },
  { value: 'infoq', name: 'InfoQ' },
  { value: 'youtube', name: 'YouTube (needs API key)', auth: 'YOUTUBE_API_KEY' },
  { value: 'github', name: 'GitHub' },
  { value: 'stackoverflow', name: 'Stack Overflow' },
  { value: 'reddit', name: 'Reddit (needs OAuth2)', auth: 'REDDIT' },
  { value: 'hackernews', name: 'Hacker News' },
  { value: 'bluesky', name: 'Bluesky (needs app password)', auth: 'BLUESKY' },
  { value: 'linkedin', name: 'LinkedIn' },
  { value: 'x', name: 'X / Twitter (needs bearer token)', auth: 'X_BEARER_TOKEN' },
];

const CUSTOM_FEATURES = [
  { value: 'social_posts', name: 'Social posts' },
  { value: 'posting_calendar', name: 'Posting calendar' },
  { value: 'competitor_tracking', name: 'Competitor tracking' },
  { value: 'cfp_tracking', name: 'Conference CFP tracking' },
  { value: 'sentiment', name: 'Conversation sentiment' },
  { value: 'community_health', name: 'Community health signals' },
  { value: 'rising_contributors', name: 'Rising contributors' },
  { value: 'feature_requests', name: 'Feature request flagging' },
  { value: 'unanswered_questions', name: 'Unanswered question tracking' },
  { value: 'doc_gaps', name: 'Doc gap focus' },
  { value: 'sdk_adoption', name: 'SDK/feature adoption tracking' },
  { value: 'engagement_scoring', name: 'Engagement potential scoring' },
  { value: 'launch_coverage', name: 'Launch coverage tracking' },
];

// Role defaults table (union when multi-role)
const ROLE_DEFAULTS = {
  'program-manager':      { social_posts: false, posting_calendar: false, competitor_tracking: false, cfp_tracking: false, sentiment: true,  community_health: false, rising_contributors: false, feature_requests: true,  unanswered_questions: false, doc_gaps: false, sdk_adoption: true,  engagement_scoring: false, launch_coverage: false },
  'product-manager':      { social_posts: false, posting_calendar: false, competitor_tracking: true,  cfp_tracking: false, sentiment: true,  community_health: false, rising_contributors: false, feature_requests: true,  unanswered_questions: false, doc_gaps: false, sdk_adoption: false, engagement_scoring: false, launch_coverage: false },
  'social-media-manager': { social_posts: true,  posting_calendar: true,  competitor_tracking: false, cfp_tracking: false, sentiment: true,  community_health: false, rising_contributors: false, feature_requests: false, unanswered_questions: false, doc_gaps: false, sdk_adoption: false, engagement_scoring: true,  launch_coverage: false },
  'product-marketer':     { social_posts: true,  posting_calendar: true,  competitor_tracking: true,  cfp_tracking: true,  sentiment: true,  community_health: false, rising_contributors: false, feature_requests: true,  unanswered_questions: false, doc_gaps: false, sdk_adoption: false, engagement_scoring: true,  launch_coverage: true  },
  'developer-advocate':   { social_posts: true,  posting_calendar: true,  competitor_tracking: false, cfp_tracking: true,  sentiment: true,  community_health: true,  rising_contributors: true,  feature_requests: false, unanswered_questions: false, doc_gaps: false, sdk_adoption: true,  engagement_scoring: true,  launch_coverage: false },
  'community-manager':    { social_posts: false, posting_calendar: false, competitor_tracking: false, cfp_tracking: false, sentiment: true,  community_health: true,  rising_contributors: true,  feature_requests: false, unanswered_questions: true,  doc_gaps: false, sdk_adoption: false, engagement_scoring: false, launch_coverage: false },
  'technical-writer':     { social_posts: false, posting_calendar: false, competitor_tracking: false, cfp_tracking: false, sentiment: true,  community_health: false, rising_contributors: false, feature_requests: false, unanswered_questions: true,  doc_gaps: true,  sdk_adoption: false, engagement_scoring: false, launch_coverage: false },
};

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function mergeRoleDefaults(roles) {
  const result = {};
  for (const key of Object.keys(CUSTOM_FEATURES.reduce((a, f) => ({ ...a, [f.value]: true }), {}))) {
    result[key] = roles.some((r) => ROLE_DEFAULTS[r]?.[key]);
  }
  return result;
}

function suggestSearchTerms(name) {
  const variants = new Set([name, name.replace(/\s+/g, ''), name.replace(/\s+/g, '-')]);
  return Array.from(variants);
}

function suggestHashtags(name) {
  const base = name.replace(/[^A-Za-z0-9]+/g, '');
  return [`#${base}`];
}

async function onUnexpectedError(e) {
  if (e?.name === 'ExitPromptError') {
    console.log('\nCancelled.');
    process.exit(0);
  }
  throw e;
}

async function main() {
  console.log('\nContent Scout — onboarding\n');

  const tier = await select({
    message: 'How much do you want to customize?',
    choices: [
      { value: 'quick',    name: 'Quick — 3 questions, ~1 min' },
      { value: 'standard', name: 'Standard — ~6 questions, ~3 min', default: true },
      { value: 'full',     name: 'Full — all groups, ~10 min' },
    ],
    default: 'standard',
  });

  // ---- Product name ----
  const productName = await input({
    message: 'What product, technology, or project are you tracking?',
    validate: (v) => v.trim().length > 0 || 'Required',
  });

  // ---- Role ----
  const role = await select({
    message: 'What is your role?',
    choices: ROLES.map((r) => ({ value: r.value, name: `${r.name} — ${r.summary}` })),
  });

  let selectedRoles = [role];
  let features;

  if (role === 'custom') {
    const picked = await checkbox({
      message: 'Pick the features you want (space to toggle, enter to confirm):',
      choices: CUSTOM_FEATURES.map((f) => ({ value: f.value, name: f.name })),
    });
    features = Object.fromEntries(CUSTOM_FEATURES.map((f) => [f.value, picked.includes(f.value)]));
  } else {
    features = mergeRoleDefaults(selectedRoles);
  }

  // ---- Networks ----
  let networks;
  if (tier === 'quick') {
    const all = await confirm({ message: 'Scan all networks?', default: true });
    networks = all ? SOURCES.map((s) => s.value) : await checkbox({
      message: 'Pick networks to scan:',
      choices: SOURCES.map((s) => ({ value: s.value, name: s.name, checked: true })),
    });
  } else {
    networks = await checkbox({
      message: 'Which networks should I scan? (space to toggle)',
      choices: SOURCES.map((s) => ({ value: s.value, name: s.name, checked: true })),
    });
  }

  // ---- Standard / Full extras ----
  let productType = 'product';
  let slug = slugify(productName);
  let searchTerms = suggestSearchTerms(productName);
  let hashtags = suggestHashtags(productName);

  if (tier !== 'quick') {
    productType = await select({
      message: 'What type is this?',
      choices: PRODUCT_TYPES,
      default: 'product',
    });

    slug = await input({
      message: 'Short slug for file naming:',
      default: slug,
      validate: (v) => /^[a-z0-9-]+$/.test(v) || 'Lowercase letters, numbers, and hyphens only',
    });

    const acceptTerms = await confirm({
      message: `Use these search terms? ${searchTerms.map((t) => `"${t}"`).join(', ')}`,
      default: true,
    });
    if (!acceptTerms) {
      const custom = await input({ message: 'Enter comma-separated search terms:', default: searchTerms.join(', ') });
      searchTerms = custom.split(',').map((s) => s.trim()).filter(Boolean);
    }

    const acceptTags = await confirm({
      message: `Use these hashtags? ${hashtags.join(', ')}`,
      default: true,
    });
    if (!acceptTags) {
      const custom = await input({ message: 'Enter comma-separated hashtags (include #):', default: hashtags.join(', ') });
      hashtags = custom.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  // ---- API keys for selected auth sources ----
  const envEntries = {};
  const authSources = SOURCES.filter((s) => s.auth && networks.includes(s.value));
  for (const src of authSources) {
    console.log(`\n${src.name} requires credentials. Press Enter to skip any prompt.`);
    if (src.auth === 'YOUTUBE_API_KEY') {
      const v = await password({ message: 'YouTube Data API v3 key:', mask: '*' });
      if (v) envEntries.YOUTUBE_API_KEY = v;
    } else if (src.auth === 'REDDIT') {
      const id = await input({ message: 'Reddit client ID:' });
      const sec = id ? await password({ message: 'Reddit client secret:', mask: '*' }) : '';
      if (id) envEntries.REDDIT_CLIENT_ID = id;
      if (sec) envEntries.REDDIT_CLIENT_SECRET = sec;
    } else if (src.auth === 'BLUESKY') {
      const h = await input({ message: 'Bluesky handle (e.g., you.bsky.social):' });
      const p = h ? await password({ message: 'Bluesky app password:', mask: '*' }) : '';
      if (h) envEntries.BLUESKY_HANDLE = h;
      if (p) envEntries.BLUESKY_APP_PASSWORD = p;
    } else if (src.auth === 'X_BEARER_TOKEN') {
      const v = await password({ message: 'X bearer token:', mask: '*' });
      if (v) envEntries.X_BEARER_TOKEN = v;
    }
  }

  // ---- Write config ----
  await mkdir(PROMPTS_DIR, { recursive: true });
  const configPath = join(PROMPTS_DIR, `scout-config-${slug}.prompt.md`);

  if (existsSync(configPath)) {
    const overwrite = await confirm({
      message: `${configPath} already exists. Overwrite?`,
      default: false,
    });
    if (!overwrite) {
      console.log('Aborted — existing config preserved.');
      process.exit(0);
    }
  }

  const content = renderConfig({
    productName,
    slug,
    productType,
    roles: selectedRoles,
    features,
    networks,
    searchTerms,
    hashtags,
  });
  await writeFile(configPath, content, 'utf8');
  console.log(`\n✔ Wrote ${configPath}`);

  // ---- Write .env ----
  if (Object.keys(envEntries).length) {
    await appendEnv(envEntries);
    console.log(`✔ Updated ${ENV_PATH} with ${Object.keys(envEntries).length} key(s)`);
  }

  console.log('\nDone. Run the agent command "scout scan" to start your first scan.\n');
}

async function appendEnv(entries) {
  let existing = '';
  try {
    existing = await readFile(ENV_PATH, 'utf8');
  } catch {
    try {
      existing = await readFile(ENV_EXAMPLE, 'utf8');
      existing = existing.split('\n').map((l) => (l.trim() && !l.startsWith('#') ? `# ${l}` : l)).join('\n');
    } catch {
      existing = '';
    }
  }
  const lines = existing.split('\n');
  for (const [k, v] of Object.entries(entries)) {
    const idx = lines.findIndex((l) => l.startsWith(`${k}=`));
    const line = `${k}=${v}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  await writeFile(ENV_PATH, lines.join('\n'), 'utf8');
}

function renderConfig({ productName, slug, productType, roles, features, networks, searchTerms, hashtags }) {
  const on = (b) => (b ? 'on' : 'off');
  const yn = (b) => (b ? 'yes' : 'no');
  const isOn = (v) => networks.includes(v);
  const roleLabel = roles.map((r) => ROLES.find((x) => x.value === r)?.name ?? r).join(', ');

  return `---
mode: agent
agent: content-scout
description: "Content Scout configuration for ${productName}"
---

# Content Scout Configuration: ${productName}

## Role
- **Role:** ${roleLabel}
- **Social posts:** ${on(features.social_posts)}
- **Posting calendar:** ${on(features.posting_calendar)}
- **Engagement scoring:** ${on(features.engagement_scoring)}
- **Conversation sentiment:** ${on(features.sentiment)}
- **Feature request flagging:** ${on(features.feature_requests)}
- **Unanswered question tracking:** ${on(features.unanswered_questions)}
- **Rising contributors:** ${on(features.rising_contributors)}
- **SDK/feature adoption tracking:** ${on(features.sdk_adoption)}
- **Competitor tracking:** ${on(features.competitor_tracking)}
- **Conference CFP tracking:** ${on(features.cfp_tracking)}
- **Launch coverage tracking:** ${on(features.launch_coverage)}
- **Doc gap focus:** ${on(features.doc_gaps)}
- **Community health signals:** ${on(features.community_health)}

## Topic
- **Name:** ${productName}
- **Slug:** ${slug}
- **Type:** ${productType}

## Search Terms

### Text Searches
${searchTerms.map((t) => `- "${t}"`).join('\n')}

### Hashtags
${hashtags.map((t) => `- ${t}`).join('\n')}

## Networks

### Standard Sources
| Source | Enabled |
|--------|---------|
| Dev.to | ${yn(isOn('devto'))} |
| Medium | ${yn(isOn('medium'))} |
| Hashnode | ${yn(isOn('hashnode'))} |
| DZone | ${yn(isOn('dzone'))} |
| C# Corner | ${yn(isOn('csharpcorner'))} |
| InfoQ | ${yn(isOn('infoq'))} |
| YouTube | ${yn(isOn('youtube'))} |
| GitHub | ${yn(isOn('github'))} |
| Stack Overflow | ${yn(isOn('stackoverflow'))} |
| Reddit | ${yn(isOn('reddit'))} |
| Hacker News | ${yn(isOn('hackernews'))} |
| Bluesky | ${yn(isOn('bluesky'))} |
| LinkedIn | ${yn(isOn('linkedin'))} |
| X/Twitter | ${yn(isOn('x'))} |

<!-- Generated by tools/onboard-cli. Edit freely or re-run \`scout-onboard\` to regenerate. -->
`;
}

main().catch(onUnexpectedError);
