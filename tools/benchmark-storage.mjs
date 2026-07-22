#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { searchCorpus } from './lib/corpus-search.mjs';
import { SqliteArtifactStore } from './lib/sqlite-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function option(name) {
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function elapsed(start) {
  return Number((performance.now() - start).toFixed(2));
}

async function benchmarkRoot(root, label) {
  const reportsDir = path.join(root, 'reports');
  const socialDir = path.join(root, 'social-posts');
  const configsDir = path.join(root, '.local', 'configs');
  const imagesDir = path.join(socialDir, 'images');
  const dbPath = path.join(root, '.local', 'state', 'content-scout.db');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(socialDir, { recursive: true });
  mkdirSync(configsDir, { recursive: true });
  mkdirSync(imagesDir, { recursive: true });

  let start = performance.now();
  const fileSearch = await searchCorpus({
    repoRoot: root,
    query: 'vector search',
    options: { maxFiles: 50, maxSnippetsPerFile: 3 },
  });
  const fileSearchMs = elapsed(start);

  start = performance.now();
  let store = new SqliteArtifactStore({ repoRoot: root, dbPath });
  const openAndMigrateMs = elapsed(start);
  start = performance.now();
  const imported = store.reconcileWorkspace({
    reportsDir,
    socialDir,
    configsDir,
    imagesDir,
  });
  const initialImportMs = elapsed(start);
  start = performance.now();
  const reportList = store.listArtifacts('reports');
  const socialList = store.listArtifacts('social-posts');
  const sqliteListMs = elapsed(start);
  start = performance.now();
  const sqliteSearch = store.search('vector search', { maxFiles: 50, maxSnippetsPerFile: 3 });
  const sqliteSearchMs = elapsed(start);
  store.close();

  start = performance.now();
  store = new SqliteArtifactStore({ repoRoot: root, dbPath });
  const reopenMs = elapsed(start);
  start = performance.now();
  const secondImport = store.reconcileWorkspace({
    reportsDir,
    socialDir,
    configsDir,
    imagesDir,
  });
  const unchangedReconcileMs = elapsed(start);
  store.close();

  return {
    label,
    artifacts: reportList.length + socialList.length,
    results: {
      legacyFileSearchMs: fileSearchMs,
      sqliteOpenAndMigrateMs: openAndMigrateMs,
      sqliteInitialImportMs: initialImportMs,
      sqliteListMs,
      sqliteSearchMs,
      sqliteReopenMs: reopenMs,
      sqliteUnchangedReconcileMs: unchangedReconcileMs,
    },
    matches: {
      legacyFiles: fileSearch.totals.files,
      sqliteFiles: sqliteSearch.totals.files,
    },
    import: imported,
    secondImport,
  };
}

function createSyntheticCorpus(count) {
  const root = mkdtempSync(path.join(os.tmpdir(), `content-scout-bench-${count}-`));
  const reportsDir = path.join(root, 'reports');
  const socialDir = path.join(root, 'social-posts');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(socialDir, { recursive: true });
  for (let index = 0; index < count; index++) {
    const kind = index % 2 === 0 ? 'reports' : 'social-posts';
    const dir = kind === 'reports' ? reportsDir : socialDir;
    const suffix = kind === 'reports' ? 'content' : 'social-posts';
    const name = `2026-07-20-${String(index % 2400).padStart(4, '0')}-bench-${index}-${suffix}.md`;
    writeFileSync(
      path.join(dir, name),
      `# Benchmark ${index}\n\nVector search benchmark artifact ${index}.\n\n${'content '.repeat(12)}\n`,
    );
  }
  return root;
}

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function timeRequest(url) {
  const start = performance.now();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const body = await response.json();
  return { ms: elapsed(start), body };
}

async function benchmarkServer(root) {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverFile = path.join(repoRoot, 'tools', 'web-ui', 'server.js');
  const started = performance.now();
  const child = spawn(process.execPath, [serverFile], {
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(port),
      SCOUT_HOST: '127.0.0.1',
      SCOUT_REPO_ROOT: root,
      SCOUT_LOCAL_ROOT: path.join(root, '.local'),
    },
  });
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error(`Benchmark server exited with ${child.exitCode}`);
      try {
        const response = await fetch(`${baseUrl}/api/storage/status`);
        if (response.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const startupReadyMs = elapsed(started);
    const reports = await timeRequest(`${baseUrl}/api/reports`);
    const firstReport = reports.body.reports?.[0]?.name;
    const reportOpen = firstReport
      ? await timeRequest(`${baseUrl}/api/reports/${encodeURIComponent(firstReport)}`)
      : { ms: 0 };
    const dashboardItems = await timeRequest(`${baseUrl}/api/items`);
    const search = await timeRequest(`${baseUrl}/api/search?q=vector%20search`);
    return {
      startupReadyMs,
      firstReportListMs: reports.ms,
      firstReportOpenMs: reportOpen.ms,
      firstNormalizedItemsMs: dashboardItems.ms,
      firstSearchMs: search.ms,
    };
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
  }
}

const rawSizes = option('--sizes') || (args.includes('--include-50k') ? '500,5000,50000' : '500,5000');
const sizes = rawSizes.split(',').map(Number).filter((value) => Number.isInteger(value) && value > 0);
const results = [];

const current = await benchmarkRoot(repoRoot, 'current-workspace');
current.server = await benchmarkServer(repoRoot);
results.push(current);
for (const size of sizes) {
  const root = createSyntheticCorpus(size);
  try {
    results.push(await benchmarkRoot(root, `synthetic-${size}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, results }, null, 2));