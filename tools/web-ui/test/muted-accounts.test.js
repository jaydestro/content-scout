import { test, beforeEach } from 'node:test';
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
  parseTeamMemberAccountsFromConfig,
  unmuteMany,
} from '../lib/muted-accounts.js';
import { stateFilePath, MUTED_ACCOUNTS_FILE } from '../../lib/paths.mjs';

// The state lib centralizes writes on STATE_DIR (it ignores the per-call dir),
// so tests in this file share one on-disk file. Reset it before each test so
// one test's writes can't leak into another's assertions. The hermetic runner
// (test/run.mjs) points STATE_DIR at a throwaway temp dir, so this never
// touches real state.
beforeEach(async () => {
  await fs.rm(stateFilePath(MUTED_ACCOUNTS_FILE), { force: true });
});

async function tmpReportsDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-muted-'));
}

test('normHandle and normPlatform normalize account identity', () => {
  assert.equal(normHandle('@@Alice '), 'alice');
  assert.equal(normPlatform(' LinkedIn '), 'linkedin');
  assert.equal(normPlatform(''), '*');
  assert.equal(muteKey('LinkedIn', '@Alice'), 'linkedin::alice');
});

test('muteAccount marks verified Microsoft employees as no-triage', async () => {
  const dir = await tmpReportsDir();
  const { key } = await muteAccount(dir, {
    platform: 'linkedin',
    handle: '@Jane-Doe',
    reason: NO_TRIAGE_REASON,
    note: 'Verified Microsoft employee or owned account; no community triage needed.',
  });

  const state = await loadMuted(dir);
  assert.equal(key, 'linkedin::jane-doe');
  assert.equal(state.items[key].reason, NO_TRIAGE_REASON);
  assert.equal(state.items[key].noTriage, true);

  const conv = { platform: 'LinkedIn', author: 'jane-doe' };
  assert.equal(isMutedConv(state, conv), true);
  assert.equal(isNoTriageConv(state, conv), true);
  assert.equal(mutedInfoForConv(state, conv).note, 'Verified Microsoft employee or owned account; no community triage needed.');
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

test('parseTeamMemberAccountsFromConfig extracts only handle-backed team members', () => {
  const raw = `
## Exclusions

### Product Team Members
<!-- comments should be ignored -->
- Name Only
- James Codella (hn: jcodella, github: jcodella, x: @jcodella, devto: jcodella, linkedin: /in/jamescodella)
- Pamela Fox (github: pamelafox, bluesky: pamelafox.bsky.social)

## Posting Preferences
- **Team members to tag:** @teamlead, linkedin: product-lead
`;
  const accounts = parseTeamMemberAccountsFromConfig(raw);
  assert.deepEqual(accounts, [
    { platform: 'hn', handle: 'jcodella', name: 'James Codella' },
    { platform: 'github', handle: 'jcodella', name: 'James Codella' },
    { platform: 'x', handle: 'jcodella', name: 'James Codella' },
    { platform: 'devto', handle: 'jcodella', name: 'James Codella' },
    { platform: 'linkedin', handle: 'jamescodella', name: 'James Codella' },
    { platform: 'github', handle: 'pamelafox', name: 'Pamela Fox' },
    { platform: 'bluesky', handle: 'pamelafox', name: 'Pamela Fox' },
    { platform: 'linkedin', handle: 'product-lead', name: '' },
    { platform: '', handle: 'teamlead', name: '' },
  ]);
});
