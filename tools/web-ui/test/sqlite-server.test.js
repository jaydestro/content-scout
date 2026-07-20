import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteArtifactStore } from '../../lib/sqlite-store.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.resolve(testDir, '..', 'server.js');

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

async function waitForServer(url, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/storage/status`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for integration server');
}

async function stopServer(child) {
  if (child.exitCode != null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode == null) child.kill('SIGKILL');
      resolve();
    }, 3_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test('Express server initializes SQLite, serves normalized data, and hydrates after restart', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'content-scout-server-'));
  const reportsDir = path.join(root, 'reports');
  const socialDir = path.join(root, 'social-posts');
  const configsDir = path.join(root, '.local', 'configs');
  const stateDir = path.join(root, '.local', 'state');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(socialDir, { recursive: true });
  mkdirSync(configsDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(configsDir, 'scout-config-demo.md'),
    '# Scout Config\n\n- **Name:** Demo Product\n- **Type:** database\n',
  );
  const reportName = '2026-07-20-1200-demo-content.md';
  writeFileSync(
    path.join(reportsDir, reportName),
    '# Demo report\n\nVector search shipped with DiskANN.\n',
  );
  writeFileSync(path.join(reportsDir, reportName.replace(/\.md$/, '.json')), JSON.stringify({
    generated_at: '2026-07-20T12:00:00.000Z',
    items: [{
      section: 'community',
      date: '2026-07-20',
      title: 'Vector search shipped',
      url: 'https://example.com/vector-search',
      author: { display_name: 'Ada', platform: 'blog' },
      tags: ['vector-search'],
      ep: 7,
    }],
    conversations: [{
      section: 'conversations',
      date: '2026-07-20',
      title: 'Useful release',
      url: 'https://example.com/post',
      author: { display_name: 'Grace', platform: 'x' },
      sentiment: 'positive',
    }],
    competitor_aggregates: {
      mentions: 1,
      byCompetitor: {
        'Amazon DynamoDB': {
          mentions: 1,
          sentiments: { positive: 0, neutral: 0, negative: 1, mixed: 0, unknown: 0 },
          bySource: { reddit: 1 },
        },
      },
      bySource: { reddit: { mentions: 1 } },
    },
  }));
  writeFileSync(
    path.join(socialDir, '2026-07-20-1201-demo-social-posts.md'),
    '# Demo social posts\n\nVector search social draft.\n',
  );
  const dbPath = path.join(stateDir, 'content-scout.db');
  const seed = new SqliteArtifactStore({ repoRoot: root, dbPath });
  seed.saveRun({
    id: 'persisted-run',
    cmdName: 'scout-scan',
    command: 'test',
    status: 'success',
    startedAt: '2026-07-20T12:00:00.000Z',
  });
  seed.close();

  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    SCOUT_HOST: '127.0.0.1',
    SCOUT_REPO_ROOT: root,
    SCOUT_LOCAL_ROOT: path.join(root, '.local'),
    SCOUT_RUNNER: '',
  };
  const start = () => spawn(process.execPath, [serverFile], { env, stdio: 'ignore' });
  let child = start();
  try {
    await waitForServer(url, child);
    const storage = await fetch(`${url}/api/storage/status`).then((response) => response.json());
    const reports = await fetch(`${url}/api/reports`).then((response) => response.json());
    const search = await fetch(`${url}/api/search?q=vector%20search`).then((response) => response.json());
    const items = await fetch(`${url}/api/items`).then((response) => response.json());
    const conversations = await fetch(`${url}/api/conversations?include=all&includeMuted=true`).then((response) => response.json());
    const sentiment = await fetch(`${url}/api/sentiment-summary`).then((response) => response.json());
    const competitors = await fetch(`${url}/api/competitor-sentiment`).then((response) => response.json());
    const authors = await fetch(`${url}/api/authors`).then((response) => response.json());
    const sources = await fetch(`${url}/api/source-health`).then((response) => response.json());
    const runs = await fetch(`${url}/api/runs`).then((response) => response.json());

    assert.equal(storage.schemaVersion, 8);
    assert.equal(storage.dbPath, dbPath);
    assert.equal(reports.reports.length, 1);
    assert.equal(reports.social.length, 1);
    assert.equal(search.files.length, 2);
    assert.equal(items.total, 1);
    assert.equal(conversations.total, 1);
    assert.equal(sentiment.groups[0].latest.totals.positive, 1);
    assert.equal(competitors.groups[0].competitorAggregates.mentions, 1);
    assert.equal(authors.total, 2);
    assert.equal(sources.sources.length >= 1, true);
    assert.equal(runs.runs[0].id, 'persisted-run');

    const reportsOffline = `${reportsDir}-offline`;
    const socialOffline = `${socialDir}-offline`;
    renameSync(reportsDir, reportsOffline);
    renameSync(socialDir, socialOffline);
    try {
      const offlineReports = await fetch(`${url}/api/reports`).then((response) => response.json());
      const offlineReport = await fetch(`${url}/api/reports/${reportName}`).then((response) => response.json());
      const offlineSearch = await fetch(`${url}/api/search?q=vector%20search`).then((response) => response.json());
      const offlineItems = await fetch(`${url}/api/items`).then((response) => response.json());
      assert.equal(offlineReports.reports.length, 1);
      assert.match(offlineReport.raw, /Vector search shipped/);
      assert.equal(offlineSearch.files.length, 2);
      assert.equal(offlineItems.total, 1);
    } finally {
      renameSync(reportsOffline, reportsDir);
      renameSync(socialOffline, socialDir);
    }

    await stopServer(child);
    child = start();
    await waitForServer(url, child);
    const restartedStorage = await fetch(`${url}/api/storage/status`).then((response) => response.json());
    const restartedItems = await fetch(`${url}/api/items`).then((response) => response.json());
    const restartedRuns = await fetch(`${url}/api/runs`).then((response) => response.json());
    assert.equal(restartedStorage.normalized.items, 1);
    assert.equal(restartedItems.total, 1);
    assert.equal(restartedRuns.runs[0].id, 'persisted-run');
  } finally {
    await stopServer(child);
    rmSync(root, { recursive: true, force: true });
  }
});