#!/usr/bin/env node
// Hermetic test runner.
//
// The state libraries (lib/closed-conversations.js, lib/muted-accounts.js,
// and others) centralize all reads/writes on STATE_DIR via tools/lib/paths.mjs
// and intentionally ignore any per-call directory argument. That means running
// the suite directly with `node --test` would read and OVERWRITE the
// developer's real .local/state/*.json files (muted accounts, closed
// conversations, sentiment overrides, …). It also clobbered them once.
//
// This runner points SCOUT_LOCAL_ROOT at a throwaway temp directory before any
// test process starts, so paths.mjs resolves LOCAL_ROOT/STATE_DIR inside the
// temp dir and the real .local/ is never touched. The temp dir is removed when
// the run finishes.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cs-webui-test-'));

// Discover test files explicitly so we don't depend on shell/Node glob
// expansion behavior across platforms.
const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(testDir, f));

if (!files.length) {
  console.error('No *.test.js files found in', testDir);
  process.exit(1);
}

const cleanup = () => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
};

const child = spawn(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: { ...process.env, SCOUT_LOCAL_ROOT: tmpRoot },
});

child.on('exit', (code, signal) => {
  cleanup();
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
