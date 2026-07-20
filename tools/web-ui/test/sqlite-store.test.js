import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openArtifactStore, restoreArtifactStore, SqliteArtifactStore } from '../../lib/sqlite-store.mjs';
import { CONTENT_SCOUT_DB_FILE, STATE_DIR } from '../../lib/paths.mjs';

const cleanups = [];

test('default database path stays inside the gitignored local state directory', () => {
  assert.equal(CONTENT_SCOUT_DB_FILE, 'content-scout.db');
  assert.equal(path.dirname(path.join(STATE_DIR, CONTENT_SCOUT_DB_FILE)), STATE_DIR);
  assert.match(STATE_DIR.replace(/\\/g, '/'), /\/state$/);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'content-scout-sqlite-'));
  const reportsDir = path.join(root, 'reports');
  const socialDir = path.join(root, 'social-posts');
  const configsDir = path.join(root, '.local', 'configs');
  const imagesDir = path.join(socialDir, 'images');
  const dbPath = path.join(root, '.local', 'state', 'content-scout.db');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(socialDir, { recursive: true });
  mkdirSync(configsDir, { recursive: true });
  mkdirSync(imagesDir, { recursive: true });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, reportsDir, socialDir, configsDir, imagesDir, browserDirs: [], dbPath };
}

test('creates SQLite storage and idempotently imports artifact metadata', () => {
  const dirs = fixture();
  writeFileSync(
    path.join(dirs.reportsDir, '2026-07-20-1200-demo-content.md'),
    '# Demo report\n\n**Generated:** 2026-07-20\n\nVector search shipped.\n',
  );
  writeFileSync(
    path.join(dirs.socialDir, '2026-07-20-1201-demo-social-posts.md'),
    '# Demo social posts\n\nA post about vector search.\n',
  );

  const store = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
  cleanups.push(() => store.close());
  const first = store.reconcileWorkspace(dirs);
  const second = store.reconcileWorkspace(dirs);

  assert.equal(existsSync(dirs.dbPath), true);
  assert.deepEqual(first.reports, {
    kind: 'reports', imported: 1, unchanged: 0, removed: 0, total: 1,
  });
  assert.equal(second.reports.imported, 0);
  assert.equal(second.reports.unchanged, 1);
  assert.equal(store.health().schemaVersion, 8);
  assert.equal(store.health().journalMode, 'wal');
  assert.equal(store.listArtifacts('reports')[0].name, '2026-07-20-1200-demo-content.md');
  assert.equal(store.listArtifacts('social-posts')[0].meta.title, 'Demo social posts');
  assert.match(store.readArtifact('reports', '2026-07-20-1200-demo-content.md').content, /Vector search/);
});

test('serves compatible search results from SQLite FTS content', () => {
  const dirs = fixture();
  writeFileSync(
    path.join(dirs.reportsDir, '2026-07-20-1200-demo-content.md'),
    '# Demo report\n\nFirst line.\nVector search shipped with DiskANN.\n',
  );
  const store = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
  cleanups.push(() => store.close());
  store.reconcileWorkspace(dirs);

  const result = store.search('vector search');

  assert.equal(result.totals.files, 1);
  assert.equal(result.totals.hits, 1);
  assert.equal(result.results[0].kind, 'reports');
  assert.equal(result.results[0].path, 'reports/2026-07-20-1200-demo-content.md');
  assert.equal(result.results[0].snippets[0].line, 4);
  assert.match(result.results[0].snippets[0].text, /Vector search shipped/);

  store.fts5Enabled = false;
  const fallback = store.search('vector search');
  assert.equal(fallback.totals.files, 1);
  assert.equal(fallback.results[0].snippets[0].line, 4);
});

test('reconciliation updates changed files and removes deleted artifacts', () => {
  const dirs = fixture();
  const report = path.join(dirs.reportsDir, '2026-07-20-1200-demo-content.md');
  writeFileSync(report, '# Demo report\n\nOld content.\n');
  const store = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
  cleanups.push(() => store.close());
  store.reconcileWorkspace(dirs);

  writeFileSync(report, '# Demo report\n\nNew searchable content with more bytes.\n');
  const changed = store.reconcileWorkspace(dirs);
  assert.equal(changed.reports.imported, 1);
  assert.equal(store.search('searchable').totals.files, 1);

  unlinkSync(report);
  const removed = store.reconcileWorkspace(dirs);
  assert.equal(removed.reports.removed, 1);
  assert.equal(store.listArtifacts('reports').length, 0);
});

test('persists parsed index snapshots by content signature', () => {
  const dirs = fixture();
  const store = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
  cleanups.push(() => store.close());
  const payload = {
    builtAt: 1234,
    signature: 'reports@1234',
    items: [{ title: 'Stored item' }],
    conversations: [],
    authors: [],
    sources: [],
    reports: [],
  };

  store.saveIndexSnapshot(payload.signature, payload);

  assert.deepEqual(store.loadIndexSnapshot(payload.signature), payload);
  assert.equal(store.loadIndexSnapshot('other-signature'), null);
});

test('verifies, backs up, and deterministically exports stored artifacts', () => {
  const dirs = fixture();
  const reportName = '2026-07-20-1200-demo-content.md';
  writeFileSync(path.join(dirs.reportsDir, reportName), '# Demo report\n\nPortable content.\n');
  const store = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
  cleanups.push(() => store.close());
  store.reconcileWorkspace(dirs);

  assert.deepEqual(store.verifyWorkspace(), {
    ok: true,
    checked: 1,
    missing: [],
    mismatched: [],
  });

  const backupPath = path.join(dirs.root, 'backups', 'content-scout.db');
  store.backup(backupPath);
  assert.equal(existsSync(backupPath), true);

  const exportRoot = path.join(dirs.root, 'export');
  const exported = store.exportArtifacts(exportRoot);
  assert.equal(exported.exported, 1);
  assert.match(readFileSync(path.join(exportRoot, 'reports', reportName), 'utf8'), /Portable content/);
});

test('imports active subject configs and exposes their setup metadata', () => {
  const dirs = fixture();
  writeFileSync(
    path.join(dirs.configsDir, 'scout-config-demo.md'),
    '# Scout Config\n\n- **Name:** Demo Product\n- **Type:** database\n',
  );
  const store = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
  cleanups.push(() => store.close());

  const result = store.reconcileConfigs({ configsDir: dirs.configsDir });

  assert.equal(result.imported, 1);
  assert.deepEqual(store.listSubjects().map(({ slug, name, type }) => ({ slug, name, type })), [
    { slug: 'demo', name: 'Demo Product', type: 'database' },
  ]);
  assert.equal(store.health().subjects, 1);
});

test('transactionally persists and hydrates normalized dashboard records', () => {
  const dirs = fixture();
  const store = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
  cleanups.push(() => store.close());
  const payload = {
    signature: 'normalized-signature',
    builtAt: 42,
    reports: [{ name: 'demo-content.md', slug: 'demo', itemCount: 1, convoCount: 1, sentimentTotals: { positive: 1 } }],
    items: [{ report: 'demo-content.md', title: 'Vector search', url: 'https://example.com/item', author: 'Ada', tags: ['vector-search'], ep: 7 }],
    conversations: [{ report: 'demo-content.md', url: 'https://example.com/post', author: 'Grace', platform: 'x', sentiment: 'positive' }],
    authors: [{ name: 'Ada', items: 1, conversations: 0, sentiments: {}, slugs: ['demo'], urls: [] }],
    sources: [{ source: 'Blog', items: 1, skipped: 0 }],
  };

  const counts = store.replaceNormalizedIndex(payload.signature, payload);
  const hydrated = store.loadNormalizedIndex(payload.signature);

  assert.deepEqual(counts, { reports: 1, items: 1, conversations: 1, creators: 1, sources: 1 });
  assert.equal(hydrated.reports[0].slug, 'demo');
  assert.equal(hydrated.items[0].title, 'Vector search');
  assert.equal(hydrated.conversations[0].sentiment, 'positive');
  assert.equal(hydrated.authors[0].name, 'Ada');
  assert.equal(hydrated.sources[0].source, 'Blog');
  assert.equal(store.loadNormalizedIndex('stale-signature'), null);
  assert.deepEqual(store.normalizedCounts(), counts);
});

test('persists run history and exposes social drafts as queryable records', () => {
  const dirs = fixture();
  writeFileSync(
    path.join(dirs.socialDir, '2026-07-20-1201-demo-social-posts.md'),
    '# Demo social posts\n\nDraft body.\n',
  );
  const store = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
  cleanups.push(() => store.close());
  store.reconcileWorkspace(dirs);
  store.saveRun({
    id: 'run-1',
    cmdName: 'scout-scan',
    command: 'copilot -p [redacted]',
    status: 'success',
    startedAt: '2026-07-20T12:00:00.000Z',
    finishedAt: '2026-07-20T12:01:00.000Z',
    output: 'done',
    args: { slug: 'demo' },
  });

  assert.equal(store.listRuns()[0].cmdName, 'scout-scan');
  assert.equal(store.getRun('run-1').args.slug, 'demo');
  assert.equal(store.health().runs, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM social_drafts').get().count, 1);
});

test('quarantines a corrupt database and rebuilds an empty local store', () => {
  const dirs = fixture();
  mkdirSync(path.dirname(dirs.dbPath), { recursive: true });
  writeFileSync(dirs.dbPath, 'not a sqlite database');

  const store = openArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
  cleanups.push(() => store.close());

  assert.equal(store.health().schemaVersion, 8);
  assert.equal(store.recovery.recovered, true);
  assert.equal(existsSync(store.recovery.quarantinePath), true);
});

test('restores a checkpointed backup into the canonical database path', () => {
  const dirs = fixture();
  const sourceDb = path.join(dirs.root, 'source.db');
  const source = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: sourceDb });
  source.saveRun({ id: 'restored-run', status: 'success', startedAt: '2026-07-20T12:00:00.000Z' });
  const backup = path.join(dirs.root, 'backup.db');
  source.backup(backup);
  source.close();

  const result = restoreArtifactStore({ source: backup, dbPath: dirs.dbPath });
  const restored = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
  cleanups.push(() => restored.close());

  assert.equal(result.health.schemaVersion, 8);
  assert.equal(restored.getRun('restored-run').status, 'success');
});

test('imports and updates sentiment overrides in SQLite', () => {
  const dirs = fixture();
  const overrideFile = path.join(dirs.root, 'sentiment-overrides.json');
  writeFileSync(overrideFile, JSON.stringify({
    'https://example.com/post': {
      sentiment: 'negative',
      confidence: 'high',
      rationale: 'initial review',
      reviewedAt: '2026-07-20T12:00:00.000Z',
    },
  }));
  const store = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
  cleanups.push(() => store.close());

  const imported = store.importSentimentOverrides({ filePath: overrideFile });
  store.upsertSentimentOverrides({
    'https://example.com/post': {
      sentiment: 'mixed',
      confidence: 'medium',
      rationale: 'updated review',
    },
  });

  assert.equal(imported.imported, 1);
  assert.equal(store.listSentimentOverrides()[0].value.sentiment, 'mixed');
  assert.match(store.sentimentOverrideSignature(), /^1@/);
  assert.equal(store.health().sentimentOverrides, 1);
});

test('indexes image and browser-capture metadata without storing blobs', () => {
  const dirs = fixture();
  const imagesDir = path.join(dirs.socialDir, 'images', '2026-07-20-1201');
  const browserDir = path.join(dirs.root, '.local', 'state', 'browser-scan', 'demo');
  mkdirSync(imagesDir, { recursive: true });
  mkdirSync(browserDir, { recursive: true });
  writeFileSync(
    path.join(dirs.socialDir, '2026-07-20-1201-demo-social-posts.md'),
    '# Demo social posts\n',
  );
  const png = Buffer.alloc(24);
  png.writeUInt8(0x89, 0);
  png.write('PNG', 1, 'ascii');
  png.writeUInt32BE(1200, 16);
  png.writeUInt32BE(627, 20);
  writeFileSync(path.join(imagesDir, '1-linkedin-demo.png'), png);
  writeFileSync(path.join(browserDir, '2026-07-20-1200-x.json'), '[]');
  const store = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
  cleanups.push(() => store.close());
  store.reconcileWorkspace({
    ...dirs,
    browserDirs: [browserDir],
  });
  store.reconcileAssets({
    imagesDir: path.join(dirs.socialDir, 'images'),
    browserDirs: [browserDir],
    runId: 'asset-run',
  });

  const image = store.listAssets('generated-image')[0];
  const capture = store.listAssets('browser-capture')[0];
  assert.equal(image.width, 1200);
  assert.equal(image.height, 627);
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.relatedArtifact, 'social-posts/2026-07-20-1201-demo-social-posts.md');
  assert.equal(image.runId, 'asset-run');
  assert.equal(capture.mimeType, 'application/json');
  assert.equal(capture.runId, 'asset-run');
  assert.equal(store.health().assets, 2);
});

test('retention is explicit and protects reports, social drafts, configs, and generated images', () => {
  const dirs = fixture();
  const browserDir = path.join(dirs.root, '.local', 'state', 'browser-scan', 'demo');
  mkdirSync(browserDir, { recursive: true });
  const capturePath = path.join(browserDir, 'old-x.json');
  writeFileSync(capturePath, '[]');
  const store = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
  cleanups.push(() => store.close());
  store.reconcileAssets({ imagesDir: dirs.imagesDir, browserDirs: [browserDir] });
  store.saveRun({ id: 'old-run', status: 'success', startedAt: '2020-01-01T00:00:00.000Z' });
  store.saveRun({ id: 'new-run', status: 'success', startedAt: '2026-07-20T00:00:00.000Z' });
  store.db.prepare('UPDATE asset_records SET mtime_ms = 0 WHERE path LIKE ?').run('%old-x.json');

  const plan = store.retentionPlan({ keepRuns: 1, keepBackups: 0, captureDays: 1 });
  assert.deepEqual(plan.runs, ['old-run']);
  assert.equal(plan.browserCaptures.length, 1);
  assert.deepEqual(plan.protected, ['reports', 'social-posts', 'generated-images', 'configs']);
  assert.equal(existsSync(capturePath), true, 'planning must not delete files');

  const applied = store.applyRetention(plan);
  assert.equal(applied.ok, true);
  assert.equal(store.getRun('old-run'), null);
  assert.equal(store.getRun('new-run').status, 'success');
  assert.equal(existsSync(capturePath), false);
});

test('representative schema versions 1 through 4 upgrade with pre-migration backups', async (t) => {
  const dropsByVersion = {
    1: [
      'DROP TABLE report_sidecars',
      'DROP TABLE asset_records',
      'DROP TABLE sentiment_overrides',
      'DROP VIEW social_drafts',
      'DROP TABLE scan_runs',
      'DROP TABLE source_records',
      'DROP TABLE creator_records',
      'DROP TABLE conversation_records',
      'DROP TABLE item_records',
      'DROP TABLE report_records',
      'DROP TABLE subjects',
      'DROP TABLE index_snapshots',
    ],
    2: [
      'DROP TABLE report_sidecars',
      'DROP TABLE asset_records',
      'DROP TABLE sentiment_overrides',
      'DROP VIEW social_drafts',
      'DROP TABLE scan_runs',
      'DROP TABLE source_records',
      'DROP TABLE creator_records',
      'DROP TABLE conversation_records',
      'DROP TABLE item_records',
      'DROP TABLE report_records',
      'DROP TABLE subjects',
    ],
    3: [
      'DROP TABLE report_sidecars',
      'DROP TABLE asset_records',
      'DROP TABLE sentiment_overrides',
      'DROP VIEW social_drafts',
      'DROP TABLE scan_runs',
      'DROP TABLE source_records',
      'DROP TABLE creator_records',
      'DROP TABLE conversation_records',
      'DROP TABLE item_records',
      'DROP TABLE report_records',
    ],
    4: [
      'DROP TABLE report_sidecars',
      'DROP TABLE asset_records',
      'DROP TABLE sentiment_overrides',
      'DROP VIEW social_drafts',
      'DROP TABLE scan_runs',
    ],
  };

  for (const version of [1, 2, 3, 4]) {
    await t.test(`schema ${version} upgrades to schema 8`, () => {
      const dirs = fixture();
      const initial = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
      initial.close();
      const raw = new DatabaseSync(dirs.dbPath);
      for (const sql of dropsByVersion[version]) raw.exec(sql);
      raw.exec(`PRAGMA user_version = ${version}`);
      raw.close();

      const upgraded = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
      cleanups.push(() => upgraded.close());

      assert.equal(upgraded.health().schemaVersion, 8);
      assert.equal(existsSync(`${dirs.dbPath}.bak-v${version}`), true);
    });
  }
});

test('WAL permits reads during a writer lock and busy_timeout bounds competing writes', () => {
  const dirs = fixture();
  const store = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
  cleanups.push(() => store.close());
  store.db.exec('PRAGMA busy_timeout = 50');
  const writer = new DatabaseSync(dirs.dbPath);
  cleanups.push(() => writer.close());
  writer.exec('PRAGMA journal_mode = WAL');
  writer.exec('BEGIN IMMEDIATE');

  assert.equal(store.health().ok, true, 'WAL readers should remain available');
  assert.throws(
    () => store.saveRun({ id: 'blocked', status: 'running', startedAt: new Date().toISOString() }),
    /busy|locked/i,
  );

  writer.exec('ROLLBACK');
  store.saveRun({ id: 'unblocked', status: 'success', startedAt: new Date().toISOString() });
  assert.equal(store.getRun('unblocked').status, 'success');
});

test('imports report JSON sidecars and exposes stable stored signatures', () => {
  const dirs = fixture();
  const sidecarName = '2026-07-20-1200-demo-content.json';
  writeFileSync(path.join(dirs.reportsDir, sidecarName), JSON.stringify({ items: [{ title: 'Stored' }] }));
  const store = new SqliteArtifactStore({ repoRoot: dirs.root, dbPath: dirs.dbPath });
  cleanups.push(() => store.close());

  const result = store.reconcileReportSidecars(dirs.reportsDir);
  const stored = store.readReportSidecar(sidecarName);
  const signatures = store.reportSidecarSignatures([sidecarName.replace(/\.json$/, '.md')]);

  assert.equal(result.imported, 1);
  assert.match(stored.content, /Stored/);
  assert.match(signatures.get(sidecarName.replace(/\.json$/, '.md')), /^\d+:[0-9a-f]{64}$/);
  assert.equal(store.health().reportSidecars, 1);
});