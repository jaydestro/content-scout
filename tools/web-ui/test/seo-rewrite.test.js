import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __test,
  getSeoRewriteProvider,
  hasAnyRewrite,
  generateSeoRewrites,
} from '../lib/seo-rewrite.js';

const { buildPrompt, tryParseJson, normalizeRewrites, agentLabel, stripPromptPlaceholder, clampStr } = __test;

const SNAPSHOT = {
  url: 'https://example.com/cosmos-vector-search',
  title: 'Vector search',
  titleLength: 13,
  description: '',
  descriptionLength: 0,
  h1: ['Vector search in Cosmos DB'],
  h2: ['Embeddings', 'Indexing', 'Queries'],
  jsonLdTypes: [],
  wordCount: 850,
};

// ---- buildPrompt --------------------------------------------------

test('buildPrompt: embeds url, snapshot fields, and JSON schema', () => {
  const p = buildPrompt({ url: SNAPSHOT.url, snapshot: SNAPSHOT, excerpt: 'Intro text.' });
  assert.match(p, /example\.com\/cosmos-vector-search/);
  assert.match(p, /Current title \(13 chars\): "Vector search"/);
  assert.match(p, /Vector search in Cosmos DB/);
  assert.match(p, /Embeddings \| Indexing \| Queries/);
  assert.match(p, /"h1s": \["\.\.\.", "\.\.\.", "\.\.\."\]/);
  assert.match(p, /Respond with JSON only/);
});

test('buildPrompt: includes optional keyword/audience/goal when provided', () => {
  const p = buildPrompt({
    url: SNAPSHOT.url,
    snapshot: SNAPSHOT,
    excerpt: '',
    keywords: 'vector search',
    audience: 'senior .NET developers',
    goal: 'rank for vector search',
  });
  assert.match(p, /Target keyword\(s\): vector search/);
  assert.match(p, /Audience: senior \.NET developers/);
  assert.match(p, /Goal: rank for vector search/);
});

test('buildPrompt: falls back to a default goal and omits blank context lines', () => {
  const p = buildPrompt({ url: SNAPSHOT.url, snapshot: SNAPSHOT, excerpt: '' });
  assert.match(p, /Goal: organic discoverability/);
  assert.doesNotMatch(p, /Target keyword/);
  assert.doesNotMatch(p, /Audience:/);
  assert.doesNotMatch(p, /Product context:/);
});

test('buildPrompt: caps the page excerpt to 1500 chars', () => {
  const long = 'x'.repeat(5000);
  const p = buildPrompt({ url: SNAPSHOT.url, snapshot: SNAPSHOT, excerpt: long });
  const block = p.split('"""')[1] || '';
  assert.ok(block.replace(/\s/g, '').length <= 1500, 'excerpt should be truncated to <= 1500 chars');
});

test('buildPrompt: tolerates a missing snapshot', () => {
  const p = buildPrompt({ url: '', snapshot: null, excerpt: 'body' });
  assert.match(p, /Current title \(0 chars\): "\(missing\)"/);
  assert.match(p, /Current H1\(s\): \(none\)/);
});

// ---- normalizeRewrites --------------------------------------------

test('normalizeRewrites: keeps a well-formed object', () => {
  const out = normalizeRewrites({
    title: 'Vector Search in Azure Cosmos DB: A Practical Guide',
    metaDescription: 'Learn how to run vector search in Azure Cosmos DB with embeddings, indexing, and queries.',
    h1s: ['A', 'B', 'C'],
    openingParagraph: 'Vector search finds nearest neighbors by embedding similarity.',
    jsonLd: { '@type': 'Article' },
  });
  assert.equal(out.h1s.length, 3);
  assert.match(out.title, /Vector Search/);
  assert.deepEqual(out.jsonLd, { '@type': 'Article' });
});

test('normalizeRewrites: coerces a string H1 into an array and caps at 5', () => {
  assert.deepEqual(normalizeRewrites({ h1s: 'Only one' }).h1s, ['Only one']);
  const many = normalizeRewrites({ h1s: ['1', '2', '3', '4', '5', '6', '7'] });
  assert.equal(many.h1s.length, 5);
});

test('normalizeRewrites: accepts snake_case + alias keys', () => {
  const out = normalizeRewrites({
    meta_description: 'desc',
    opening_paragraph: 'para',
    alternativeH1s: ['x'],
  });
  assert.equal(out.metaDescription, 'desc');
  assert.equal(out.openingParagraph, 'para');
  assert.deepEqual(out.h1s, ['x']);
});

test('normalizeRewrites: parses a JSON-LD string, else keeps it raw', () => {
  assert.deepEqual(normalizeRewrites({ jsonLd: '{"@type":"FAQPage"}' }).jsonLd, { '@type': 'FAQPage' });
  assert.equal(normalizeRewrites({ jsonLd: 'not json' }).jsonLd, 'not json');
});

test('normalizeRewrites: returns empty shape for junk input', () => {
  const out = normalizeRewrites(null);
  assert.equal(out.title, '');
  assert.deepEqual(out.h1s, []);
  assert.equal(out.jsonLd, null);
});

// ---- hasAnyRewrite ------------------------------------------------

test('hasAnyRewrite: true when any field is populated, false otherwise', () => {
  assert.equal(hasAnyRewrite({ title: 'x' }), true);
  assert.equal(hasAnyRewrite({ h1s: ['a'] }), true);
  assert.equal(hasAnyRewrite({ jsonLd: { '@type': 'Article' } }), true);
  assert.equal(hasAnyRewrite({ title: '', metaDescription: '', h1s: [], openingParagraph: '', jsonLd: null }), false);
  assert.equal(hasAnyRewrite({ error: 'boom' }), false);
  assert.equal(hasAnyRewrite(null), false);
});

// ---- getSeoRewriteProvider ----------------------------------------

test('getSeoRewriteProvider: defaults to agent and respects explicit values', () => {
  assert.equal(getSeoRewriteProvider({}), 'agent');
  assert.equal(getSeoRewriteProvider({ SEO_REWRITE_PROVIDER: 'AGENT' }), 'agent');
  assert.equal(getSeoRewriteProvider({ SEO_REWRITE_PROVIDER: 'openai' }), 'openai');
  assert.equal(getSeoRewriteProvider({ SEO_REWRITE_PROVIDER: 'ollama' }), 'ollama');
  assert.equal(getSeoRewriteProvider({ SEO_REWRITE_PROVIDER: 'openai-compatible' }), 'custom');
  assert.equal(getSeoRewriteProvider({ SEO_REWRITE_PROVIDER: 'none' }), 'none');
});

// ---- generateSeoRewrites guard rails ------------------------------

test('generateSeoRewrites: errors out when there is nothing to rewrite', async () => {
  const r = await generateSeoRewrites({ snapshot: null, excerpt: '' }, { SEO_REWRITE_PROVIDER: 'openai' });
  assert.match(r.error, /Not enough page content/);
});

test('generateSeoRewrites: reports when provider is disabled', async () => {
  const r = await generateSeoRewrites(
    { snapshot: SNAPSHOT, excerpt: 'body' },
    { SEO_REWRITE_PROVIDER: 'none' },
  );
  assert.equal(r.provider, 'none');
  assert.match(r.error, /No SEO rewrite provider configured/);
});

test('generateSeoRewrites: openai path reports a missing key without throwing', async () => {
  const r = await generateSeoRewrites(
    { snapshot: SNAPSHOT, excerpt: 'body' },
    { SEO_REWRITE_PROVIDER: 'openai', OPENAI_API_KEY: '' },
  );
  assert.equal(r.provider, 'openai');
  assert.match(r.error, /OPENAI_API_KEY not set/);
});

// ---- small helpers ------------------------------------------------

test('stripPromptPlaceholder: removes the -p "{prompt}" tail', () => {
  assert.equal(stripPromptPlaceholder('copilot --allow-all-tools -p "{prompt}"'), 'copilot --allow-all-tools');
  assert.equal(stripPromptPlaceholder('claude exec {prompt}'), 'claude');
});

test('agentLabel: strips path + extension', () => {
  assert.equal(agentLabel('C:\\Tools\\copilot.cmd -p "{prompt}"'), 'copilot');
  assert.equal(agentLabel('/usr/bin/claude'), 'claude');
  assert.equal(agentLabel(''), '');
});

test('clampStr: coerces and truncates', () => {
  assert.equal(clampStr(null, 5), '');
  assert.equal(clampStr('abcdefg', 3), 'abc');
});

test('tryParseJson: strips code fences and finds the object', () => {
  assert.deepEqual(tryParseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(tryParseJson('noise {"b":2} trailing'), { b: 2 });
  assert.equal(tryParseJson('not json'), null);
});
