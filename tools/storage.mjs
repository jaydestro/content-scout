#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openArtifactStore, restoreArtifactStore } from './lib/sqlite-store.mjs';
import { CONTENT_SCOUT_DB_FILE, STATE_DIR, stateFilePath } from './lib/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const command = args.find((value) => !value.startsWith('--')) || 'init';

function option(name) {
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function usage() {
  console.log(`Content Scout local storage

Usage:
  node tools/storage.mjs init
  node tools/storage.mjs import
  node tools/storage.mjs status
  node tools/storage.mjs verify
  node tools/storage.mjs backup [--output <file>]
  node tools/storage.mjs restore --input <file>
  node tools/storage.mjs export --output <directory>
  node tools/storage.mjs retention [--runs 500] [--backups 10] [--captures-days 180] [--apply]

SQLite is created automatically at .local/state/content-scout.db. The init
and import commands are idempotent and preserve all source files.`);
}

if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

if (command === 'restore') {
  try {
    const input = option('--input');
    if (!input) throw new Error('restore requires --input <file>');
    console.log(JSON.stringify(restoreArtifactStore({
      source: input,
      dbPath: stateFilePath(CONTENT_SCOUT_DB_FILE),
    }), null, 2));
  } catch (error) {
    console.error(`[storage] ${error.message}`);
    process.exitCode = 1;
  }
  process.exit();
}

const store = openArtifactStore({ repoRoot });
try {
  let result;
  switch (command) {
    case 'init':
    case 'import':
      result = {
        ok: true,
        import: store.reconcileWorkspace(),
        storage: store.health(),
        verification: store.verifyWorkspace(),
      };
      break;
    case 'status':
      result = store.health();
      break;
    case 'verify':
      result = store.verifyWorkspace();
      break;
    case 'backup': {
      const output = option('--output') || path.join(STATE_DIR, 'backups', `content-scout-${stamp()}.db`);
      result = store.backup(output);
      break;
    }
    case 'export': {
      const output = option('--output');
      if (!output) throw new Error('export requires --output <directory>');
      result = store.exportArtifacts(output);
      break;
    }
    case 'retention': {
      const plan = store.retentionPlan({
        keepRuns: option('--runs') ?? 500,
        keepBackups: option('--backups') ?? 10,
        captureDays: option('--captures-days') ?? 180,
      });
      result = args.includes('--apply')
        ? { applied: true, plan, result: store.applyRetention(plan) }
        : { applied: false, plan, note: 'Dry run only. Re-run with --apply to delete listed run history, backups, and raw browser captures.' };
      break;
    }
    default:
      usage();
      throw new Error(`Unknown storage command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false) process.exitCode = 1;
} catch (error) {
  console.error(`[storage] ${error.message}`);
  process.exitCode = 1;
} finally {
  store.close();
}