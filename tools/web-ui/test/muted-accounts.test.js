import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  NO_TRIAGE_REASON,
  isMutedConv,
  isNoTriageConv,
  loadMuted,
  muteAccount,
  mutedInfoForConv,
  muteKey,
  normHandle,
  normPlatform,
  unmuteMany,
} from '../lib/muted-accounts.js';

async function tmpReportsDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-muted-'));
}

test('normHandle and normPlatform normalize account identity', () => {
  assert.equal(normHandle('@@Alice '), 'alice');
  assert.equal(normPlatform(' LinkedIn '), 'linkedin');
  assert.equal(normPlatform(''), '*');
  assert.equal(muteKey('LinkedIn', '@Alice'), 'linkedin::alice');
});

test('muteAccount marks Microsoft employees as no-triage', async () => {
  const dir = await tmpReportsDir();
  const { key } = await muteAccount(dir, {
    platform: 'linkedin',
    handle: '@Jane-Doe',
    reason: NO_TRIAGE_REASON,
    note: 'Likely Microsoft employee; no community triage needed.',
  });

  const state = await loadMuted(dir);
  assert.equal(key, 'linkedin::jane-doe');
  assert.equal(state.items[key].reason, NO_TRIAGE_REASON);
  assert.equal(state.items[key].noTriage, true);

  const conv = { platform: 'LinkedIn', author: 'jane-doe' };
  assert.equal(isMutedConv(state, conv), true);
  assert.equal(isNoTriageConv(state, conv), true);
  assert.equal(mutedInfoForConv(state, conv).note, 'Likely Microsoft employee; no community triage needed.');
});

test('global no-triage entries match any platform', async () => {
  const dir = await tmpReportsDir();
  await muteAccount(dir, {
    platform: '',
    handle: 'jane-doe',
    reason: NO_TRIAGE_REASON,
    note: '',
  });

  const state = await loadMuted(dir);
  assert.equal(isNoTriageConv(state, { platform: 'x', author: '@jane-doe' }), true);
  assert.equal(isNoTriageConv(state, { platform: 'reddit', author: 'jane-doe' }), true);
});

test('unmuteMany removes a no-triage account', async () => {
  const dir = await tmpReportsDir();
  const { key } = await muteAccount(dir, {
    platform: 'linkedin',
    handle: 'jane-doe',
    reason: NO_TRIAGE_REASON,
    note: '',
  });
  const result = await unmuteMany(dir, [key]);
  assert.equal(result.removed, 1);
  const state = await loadMuted(dir);
  assert.equal(Object.keys(state.items).length, 0);
});
