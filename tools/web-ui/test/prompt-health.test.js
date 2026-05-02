import { test } from 'node:test';
import assert from 'node:assert/strict';
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
