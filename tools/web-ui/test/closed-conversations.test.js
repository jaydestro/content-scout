import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  convoKey,
  loadClosed,
  closeMany,
  reopenMany,
  isValidReason,
  ALLOWED_REASONS,
} from '../lib/closed-conversations.js';
import { stateFilePath, CLOSED_CONVERSATIONS_FILE } from '../../lib/paths.mjs';

// The state lib centralizes writes on STATE_DIR (it ignores the per-call dir),
// so tests in this file share one on-disk file. Reset it before each test so
// one test's writes can't leak into another's assertions. The hermetic runner
// (test/run.mjs) points STATE_DIR at a throwaway temp dir, so this never
// touches real state.
beforeEach(async () => {
  await fs.rm(stateFilePath(CLOSED_CONVERSATIONS_FILE), { force: true });
});

async function tmpReportsDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-closed-'));
  return dir;
}

test('convoKey: prefers normalized URL when present', () => {
  const a = convoKey({ url: 'https://Example.com/foo?ref=bar#x', summary: 'x' });
  const b = convoKey({ url: 'https://example.com/foo', summary: 'y' });
  assert.equal(a, b);
  assert.ok(a.startsWith('url::'));
});

test('convoKey: falls back to composite when no URL', () => {
  const k = convoKey({ platform: 'Reddit', author: 'alice', date: '2026-05-01', summary: 'Hello there' });
  assert.ok(k.startsWith('mix::'));
  // Same inputs → same key (case + whitespace normalized).
  const k2 = convoKey({ platform: 'reddit', author: 'ALICE ', date: '2026-05-01', summary: 'Hello   there' });
  assert.equal(k, k2);
});

test('isValidReason: accepts known IDs, rejects others', () => {
  for (const r of ALLOWED_REASONS) assert.ok(isValidReason(r.id));
  assert.ok(!isValidReason('bogus'));
  assert.ok(!isValidReason(''));
  assert.ok(!isValidReason(null));
});

test('close → load → reopen lifecycle', async () => {
  const dir = await tmpReportsDir();
  const conv = { url: 'https://example.com/post', platform: 'X', author: 'bob', date: '2026-04-01', summary: 'noise' };
  const key = convoKey(conv);

  // Initially empty
  let state = await loadClosed(dir);
  assert.equal(Object.keys(state.items).length, 0);

  // Close one
  const closed = await closeMany(dir, [{ key, conv }], 'spam', 'Recruiter');
  assert.equal(closed.added, 1);
  state = await loadClosed(dir);
  assert.ok(state.items[key]);
  assert.equal(state.items[key].reason, 'spam');
  assert.equal(state.items[key].note, 'Recruiter');
  assert.equal(state.items[key].url, conv.url);

  // Reopen
  const r = await reopenMany(dir, [key]);
  assert.equal(r.removed, 1);
  state = await loadClosed(dir);
  assert.equal(Object.keys(state.items).length, 0);
});

test('closeMany: rejects invalid reason', async () => {
  const dir = await tmpReportsDir();
  await assert.rejects(
    () => closeMany(dir, [{ key: 'mix::a|b|c|d', conv: {} }], 'nope', ''),
    /Invalid reason/
  );
});

test('closeMany: "other" requires a note', async () => {
  const dir = await tmpReportsDir();
  await assert.rejects(
    () => closeMany(dir, [{ key: 'mix::a|b|c|d', conv: {} }], 'other', ''),
    /requires a note/
  );
  // With note it should succeed.
  const res = await closeMany(dir, [{ key: 'mix::a|b|c|d', conv: {} }], 'other', 'because reasons');
  assert.equal(res.added, 1);
});

test('loadClosed: returns empty state when file missing', async () => {
  const dir = await tmpReportsDir();
  const state = await loadClosed(dir);
  assert.deepEqual(state, { version: 1, items: {} });
});
