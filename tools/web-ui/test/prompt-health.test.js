import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { findMissingPrompts, findUnreferencedPrompts } from '../lib/prompt-health.js';

const expected = [
  'scout-onboard.prompt.md',
  'scout-scan.prompt.md',
  'scout-post.prompt.md',
];

test('findMissingPrompts returns expected names not on disk', () => {
  const disk = ['scout-onboard.prompt.md', 'scout-scan.prompt.md'];
  assert.deepEqual(findMissingPrompts(expected, disk), ['scout-post.prompt.md']);
});

test('findMissingPrompts returns [] when all expected exist', () => {
  const disk = [...expected, 'extra.prompt.md'];
  assert.deepEqual(findMissingPrompts(expected, disk), []);
});

test('findUnreferencedPrompts flags command prompts not in expected list', () => {
  const disk = [...expected, 'scout-mystery.prompt.md', 'scout-orphan.prompt.md'];
  assert.deepEqual(
    findUnreferencedPrompts(expected, disk),
    ['scout-mystery.prompt.md', 'scout-orphan.prompt.md'],
  );
});

test('findUnreferencedPrompts ignores scout-config-*.prompt.md (user configs)', () => {
  const disk = [
    ...expected,
    'scout-config-azure-cosmos-db.prompt.md',
    'scout-config-foo.prompt.md',
  ];
  assert.deepEqual(findUnreferencedPrompts(expected, disk), []);
});

test('findUnreferencedPrompts ignores non-prompt files', () => {
  const disk = [...expected, 'README.md', 'notes.txt', 'subdir'];
  assert.deepEqual(findUnreferencedPrompts(expected, disk), []);
});

test('findUnreferencedPrompts returns sorted output', () => {
  const disk = [...expected, 'scout-zeta.prompt.md', 'scout-alpha.prompt.md'];
  assert.deepEqual(
    findUnreferencedPrompts(expected, disk),
    ['scout-alpha.prompt.md', 'scout-zeta.prompt.md'],
  );
});

test('content scout sentiment sidecar schema includes every web-ui bucket', async () => {
  const raw = await fs.readFile(
    new URL('../../../.github/agents/content-scout.agent.md', import.meta.url),
    'utf8',
  );
  assert.match(raw, /"sentiment": "positive\|neutral\|negative\|mixed\|unknown\|null"/);
  assert.match(raw, /"sentiment": \{"positive":0,"neutral":0,"negative":0,"mixed":0,"unknown":0\}/);
});

test('content scout sentiment rubric prevents neutral from absorbing off-topic rows', async () => {
  const raw = await fs.readFile(
    new URL('../../../.github/agents/content-scout.agent.md', import.meta.url),
    'utf8',
  );
  assert.match(raw, /Decision order — MUST follow/);
  assert.match(raw, /Do not keep them as neutral just because they mention the product/);
  assert.match(raw, /Neutral is for on-topic posts with no verdict; it is not a safe fallback/);
  assert.match(raw, /Bulk-stamping `sentiment: "neutral", sentiment_confidence: "low"`/);
});
