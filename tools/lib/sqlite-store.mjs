import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractDocMeta } from './doc-meta.mjs';
import {
  CONTENT_SCOUT_DB_FILE,
  REPO_ROOT,
  SENTIMENT_OVERRIDES_FILE,
  stateFilePath,
} from './paths.mjs';

const SCHEMA_VERSION = 8;
const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_SNIPPETS = 5;
const SNIPPET_RADIUS = 60;

function posixPath(value) {
  return String(value).split(path.sep).join('/');
}

function inferSlug(name) {
  return String(name || '')
    .replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '')
    .replace(/-(?:content|social-posts|mindshare|roundup|competitors|posting-calendar)\.md$/i, '')
    .replace(/\.md$/i, '');
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function quotedFtsQuery(query) {
  return `"${String(query || '').replace(/"/g, '""')}"`;
}

function buildMatcher(query, regex) {
  if (regex) {
    try {
      const expression = new RegExp(query, 'i');
      return (value) => expression.test(value);
    } catch {
      // Preserve the existing corpus-search behavior: malformed regex falls
      // back to a case-insensitive literal search.
    }
  }
  const needle = String(query).toLowerCase();
  return (value) => String(value).toLowerCase().includes(needle);
}

function highlightIndex(line, query, regex) {
  if (regex) {
    try {
      const match = new RegExp(query, 'i').exec(line);
      if (match) return { start: match.index, end: match.index + match[0].length };
    } catch {
      // Fall through to literal matching.
    }
  }
  const start = line.toLowerCase().indexOf(String(query).toLowerCase());
  return start < 0 ? null : { start, end: start + String(query).length };
}

function snippet(line, hit) {
  const start = Math.max(0, hit.start - SNIPPET_RADIUS);
  const end = Math.min(line.length, hit.end + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

function readTextFile(fullPath) {
  try {
    return {
      stat: statSync(fullPath),
      content: readFileSync(fullPath, 'utf8'),
    };
  } catch {
    return null;
  }
}

function imageDimensions(buffer, extension) {
  const ext = String(extension || '').toLowerCase();
  if (ext === '.png' && buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (ext === '.gif' && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3 && offset + 8 < buffer.length) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (length < 2) break;
      offset += length + 2;
    }
  }
  return { width: null, height: null };
}

function listFilesRecursive(root) {
  const files = [];
  const visit = (directory) => {
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  visit(root);
  return files;
}

export class SqliteArtifactStore {
  constructor({ repoRoot = REPO_ROOT, dbPath = stateFilePath(CONTENT_SCOUT_DB_FILE) } = {}) {
    this.repoRoot = path.resolve(repoRoot);
    this.dbPath = path.resolve(dbPath);
    this.stateDir = path.dirname(this.dbPath);
    this.localRoot = path.dirname(this.stateDir);
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    try {
      this.configure();
      this.migrate();
      this.configureSearch();
    } catch (error) {
      try { this.db.close(); } catch {}
      throw error;
    }
  }

  configure() {
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  configureSearch() {
    const existed = Boolean(
      this.db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'artifacts_fts'").get(),
    );
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
          title,
          summary,
          content,
          content='artifacts',
          content_rowid='id'
        );
        CREATE TRIGGER IF NOT EXISTS artifacts_ai AFTER INSERT ON artifacts BEGIN
          INSERT INTO artifacts_fts(rowid, title, summary, content)
          VALUES (new.id, new.title, new.summary, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS artifacts_ad AFTER DELETE ON artifacts BEGIN
          INSERT INTO artifacts_fts(artifacts_fts, rowid, title, summary, content)
          VALUES ('delete', old.id, old.title, old.summary, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS artifacts_au AFTER UPDATE ON artifacts BEGIN
          INSERT INTO artifacts_fts(artifacts_fts, rowid, title, summary, content)
          VALUES ('delete', old.id, old.title, old.summary, old.content);
          INSERT INTO artifacts_fts(rowid, title, summary, content)
          VALUES (new.id, new.title, new.summary, new.content);
        END;
      `);
      if (!existed) this.db.exec("INSERT INTO artifacts_fts(artifacts_fts) VALUES ('rebuild')");
      this.fts5Enabled = true;
    } catch (error) {
      if (!/fts5|no such module/i.test(error.message)) throw error;
      this.fts5Enabled = false;
    }
  }

  migrate() {
    let version = Number(this.db.prepare('PRAGMA user_version').get().user_version || 0);
    if (version > SCHEMA_VERSION) {
      throw new Error(`Content Scout database schema ${version} is newer than supported schema ${SCHEMA_VERSION}`);
    }
    if (version > 0 && version < SCHEMA_VERSION && existsSync(this.dbPath)) {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      copyFileSync(this.dbPath, `${this.dbPath}.bak-v${version}`);
    }
    if (version < 1) {
      this.applyMigration(1, `
        CREATE TABLE artifacts (
          id INTEGER PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL CHECK (kind IN ('reports', 'social-posts')),
          name TEXT NOT NULL,
          slug TEXT NOT NULL,
          mtime_ms INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          meta_json TEXT NOT NULL DEFAULT '{}',
          indexed_at TEXT NOT NULL
        );

        CREATE INDEX artifacts_kind_mtime_idx
          ON artifacts(kind, mtime_ms DESC);
        CREATE INDEX artifacts_slug_mtime_idx
          ON artifacts(slug, mtime_ms DESC);

      `);
      version = 1;
    }
    if (version < 2) {
      this.applyMigration(2, `
        CREATE TABLE index_snapshots (
          signature TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          built_at INTEGER NOT NULL
        );
        CREATE INDEX index_snapshots_built_at_idx
          ON index_snapshots(built_at DESC);
      `);
      version = 2;
    }
    if (version < 3) {
      this.applyMigration(3, `
        CREATE TABLE subjects (
          slug TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          type TEXT NOT NULL DEFAULT '',
          mtime_ms INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          content TEXT NOT NULL,
          indexed_at TEXT NOT NULL
        );
        CREATE INDEX subjects_name_idx ON subjects(name);
      `);
      version = 3;
    }
    if (version < 4) {
      this.applyMigration(4, `
        CREATE TABLE report_records (
          name TEXT PRIMARY KEY,
          signature TEXT NOT NULL,
          slug TEXT NOT NULL,
          generated_at TEXT NOT NULL DEFAULT '',
          mtime TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT '',
          item_count INTEGER NOT NULL DEFAULT 0,
          conversation_count INTEGER NOT NULL DEFAULT 0,
          sentiment_json TEXT NOT NULL DEFAULT '{}',
          competitor_json TEXT NOT NULL DEFAULT '{}',
          payload_json TEXT NOT NULL
        );
        CREATE INDEX report_records_slug_generated_idx
          ON report_records(slug, generated_at DESC);

        CREATE TABLE item_records (
          id INTEGER PRIMARY KEY,
          signature TEXT NOT NULL,
          report_name TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          url TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          author TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT '',
          published_at TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL DEFAULT '',
          ep INTEGER,
          tags_json TEXT NOT NULL DEFAULT '[]',
          payload_json TEXT NOT NULL,
          UNIQUE(report_name, ordinal)
        );
        CREATE INDEX item_records_report_idx ON item_records(report_name, ordinal);
        CREATE INDEX item_records_url_idx ON item_records(url);
        CREATE INDEX item_records_author_idx ON item_records(author);

        CREATE TABLE conversation_records (
          id INTEGER PRIMARY KEY,
          signature TEXT NOT NULL,
          report_name TEXT NOT NULL DEFAULT '',
          ordinal INTEGER NOT NULL,
          url TEXT NOT NULL DEFAULT '',
          author TEXT NOT NULL DEFAULT '',
          platform TEXT NOT NULL DEFAULT '',
          published_at TEXT NOT NULL DEFAULT '',
          sentiment TEXT NOT NULL DEFAULT 'unknown',
          confidence TEXT NOT NULL DEFAULT '',
          community TEXT NOT NULL DEFAULT '',
          competitor TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL,
          UNIQUE(signature, ordinal)
        );
        CREATE INDEX conversation_records_report_idx ON conversation_records(report_name);
        CREATE INDEX conversation_records_sentiment_idx ON conversation_records(sentiment);
        CREATE INDEX conversation_records_platform_idx ON conversation_records(platform);
        CREATE INDEX conversation_records_url_idx ON conversation_records(url);

        CREATE TABLE creator_records (
          name TEXT PRIMARY KEY,
          signature TEXT NOT NULL,
          item_count INTEGER NOT NULL DEFAULT 0,
          conversation_count INTEGER NOT NULL DEFAULT 0,
          last_seen TEXT NOT NULL DEFAULT '',
          is_product INTEGER NOT NULL DEFAULT 0,
          sentiments_json TEXT NOT NULL DEFAULT '{}',
          payload_json TEXT NOT NULL
        );

        CREATE TABLE source_records (
          source TEXT PRIMARY KEY,
          signature TEXT NOT NULL,
          item_count INTEGER NOT NULL DEFAULT 0,
          last_seen TEXT NOT NULL DEFAULT '',
          skipped_count INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL
        );
      `);
      version = 4;
    }
    if (version < 5) {
      this.applyMigration(5, `
        CREATE TABLE scan_runs (
          id TEXT PRIMARY KEY,
          command_name TEXT NOT NULL DEFAULT '',
          command_text TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          bulk_id TEXT,
          bulk_label TEXT,
          output TEXT NOT NULL DEFAULT '',
          args_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL
        );
        CREATE INDEX scan_runs_started_idx ON scan_runs(started_at DESC);

        CREATE VIEW social_drafts AS
          SELECT id, path, name, slug, mtime_ms, size_bytes, title, summary, content
          FROM artifacts
          WHERE kind = 'social-posts';
      `);
      version = 5;
    }
    if (version < 6) {
      this.applyMigration(6, `
        CREATE TABLE sentiment_overrides (
          url TEXT PRIMARY KEY,
          sentiment TEXT NOT NULL,
          confidence TEXT NOT NULL DEFAULT '',
          rationale TEXT NOT NULL DEFAULT '',
          provider TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '',
          reviewed_at TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX sentiment_overrides_reviewed_idx
          ON sentiment_overrides(reviewed_at DESC);
      `);
      version = 6;
    }
    if (version < 7) {
      this.applyMigration(7, `
        CREATE TABLE asset_records (
          path TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('generated-image', 'browser-capture')),
          mime_type TEXT NOT NULL DEFAULT '',
          size_bytes INTEGER NOT NULL,
          mtime_ms INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          width INTEGER,
          height INTEGER,
          related_artifact TEXT,
          run_id TEXT,
          indexed_at TEXT NOT NULL
        );
        CREATE INDEX asset_records_kind_mtime_idx ON asset_records(kind, mtime_ms DESC);
        CREATE INDEX asset_records_related_idx ON asset_records(related_artifact);
      `);
      version = 7;
    }
    if (version < 8) {
      this.applyMigration(8, `
        CREATE TABLE report_sidecars (
          name TEXT PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          mtime_ms INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          content TEXT NOT NULL,
          indexed_at TEXT NOT NULL
        );
        CREATE INDEX report_sidecars_mtime_idx ON report_sidecars(mtime_ms DESC);
      `);
    }
  }

  applyMigration(version, sql) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(sql);
      this.db.exec(`PRAGMA user_version = ${Number(version)}`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw new Error(`Unable to apply Content Scout database migration ${version}: ${error.message}`);
    }
  }

  reconcileDirectory(directory, kind) {
    const absoluteDirectory = path.resolve(directory);
    let names = [];
    try {
      names = readdirSync(absoluteDirectory).filter((name) => name.endsWith('.md'));
    } catch {
      names = [];
    }

    const existing = new Map(
      this.db.prepare('SELECT path, mtime_ms, size_bytes FROM artifacts WHERE kind = ?').all(kind)
        .map((row) => [row.path, row]),
    );
    const seen = new Set();
    const changes = [];
    let unchanged = 0;

    for (const name of names) {
      const fullPath = path.join(absoluteDirectory, name);
      const relativePath = posixPath(path.relative(this.repoRoot, fullPath));
      const file = readTextFile(fullPath);
      if (!file) continue;
      seen.add(relativePath);
      const { stat, content } = file;
      const prior = existing.get(relativePath);
      if (prior && Number(prior.mtime_ms) === Math.trunc(stat.mtimeMs) && Number(prior.size_bytes) === stat.size) {
        unchanged++;
        continue;
      }
      const meta = extractDocMeta(content, name);
      changes.push({
        relativePath,
        kind,
        name,
        slug: meta.slug || inferSlug(name),
        mtimeMs: Math.trunc(stat.mtimeMs),
        size: stat.size,
        sha256: createHash('sha256').update(content).digest('hex'),
        title: meta.title || '',
        summary: meta.summary || '',
        content,
        metaJson: JSON.stringify(meta),
      });
    }

    const removed = [...existing.keys()].filter((relativePath) => !seen.has(relativePath));
    const upsert = this.db.prepare(`
      INSERT INTO artifacts (
        path, kind, name, slug, mtime_ms, size_bytes, sha256,
        title, summary, content, meta_json, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        kind = excluded.kind,
        name = excluded.name,
        slug = excluded.slug,
        mtime_ms = excluded.mtime_ms,
        size_bytes = excluded.size_bytes,
        sha256 = excluded.sha256,
        title = excluded.title,
        summary = excluded.summary,
        content = excluded.content,
        meta_json = excluded.meta_json,
        indexed_at = excluded.indexed_at
    `);
    const remove = this.db.prepare('DELETE FROM artifacts WHERE path = ?');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const indexedAt = new Date().toISOString();
      for (const change of changes) {
        upsert.run(
          change.relativePath,
          change.kind,
          change.name,
          change.slug,
          change.mtimeMs,
          change.size,
          change.sha256,
          change.title,
          change.summary,
          change.content,
          change.metaJson,
          indexedAt,
        );
      }
      for (const relativePath of removed) remove.run(relativePath);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return { kind, imported: changes.length, unchanged, removed: removed.length, total: names.length };
  }

  reconcileWorkspace({
    reportsDir,
    socialDir,
    configsDir,
    legacyConfigsDir,
    imagesDir,
    browserDirs,
    assetRunId,
  } = {}) {
    return {
      reports: this.reconcileDirectory(reportsDir || path.join(this.repoRoot, 'reports'), 'reports'),
      reportSidecars: this.reconcileReportSidecars(reportsDir || path.join(this.repoRoot, 'reports')),
      social: this.reconcileDirectory(socialDir || path.join(this.repoRoot, 'social-posts'), 'social-posts'),
      configs: this.reconcileConfigs({
        configsDir: configsDir || path.join(this.localRoot, 'configs'),
        legacyConfigsDir: legacyConfigsDir || path.join(this.repoRoot, '.github', 'prompts'),
      }),
      sentimentOverrides: this.importSentimentOverrides(),
      assets: this.reconcileAssets({
        imagesDir: imagesDir || path.join(this.repoRoot, 'social-posts', 'images'),
        browserDirs: browserDirs || [path.join(this.stateDir, 'browser-scan'), path.join(this.repoRoot, 'reports', '.browser-scan')],
        runId: assetRunId || null,
      }),
    };
  }

  reconcileReportSidecars(directory) {
    const absoluteDirectory = path.resolve(directory);
    let names = [];
    try {
      names = readdirSync(absoluteDirectory).filter((name) => name.endsWith('.json'));
    } catch {
      names = [];
    }
    const existing = new Map(
      this.db.prepare('SELECT name, mtime_ms, size_bytes FROM report_sidecars').all()
        .map((row) => [row.name, row]),
    );
    const seen = new Set();
    const changes = [];
    let unchanged = 0;
    for (const name of names) {
      const fullPath = path.join(absoluteDirectory, name);
      const file = readTextFile(fullPath);
      if (!file) continue;
      seen.add(name);
      const { stat, content } = file;
      const prior = existing.get(name);
      if (prior && Number(prior.mtime_ms) === Math.trunc(stat.mtimeMs) && Number(prior.size_bytes) === stat.size) {
        unchanged++;
        continue;
      }
      changes.push({
        name,
        path: posixPath(path.relative(this.repoRoot, fullPath)),
        mtimeMs: Math.trunc(stat.mtimeMs),
        size: stat.size,
        sha256: createHash('sha256').update(content).digest('hex'),
        content,
      });
    }
    const removed = [...existing.keys()].filter((name) => !seen.has(name));
    const upsert = this.db.prepare(`
      INSERT INTO report_sidecars(name, path, mtime_ms, size_bytes, sha256, content, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        path = excluded.path,
        mtime_ms = excluded.mtime_ms,
        size_bytes = excluded.size_bytes,
        sha256 = excluded.sha256,
        content = excluded.content,
        indexed_at = excluded.indexed_at
    `);
    const remove = this.db.prepare('DELETE FROM report_sidecars WHERE name = ?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const indexedAt = new Date().toISOString();
      for (const change of changes) {
        upsert.run(
          change.name, change.path, change.mtimeMs, change.size,
          change.sha256, change.content, indexedAt,
        );
      }
      for (const name of removed) remove.run(name);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { imported: changes.length, unchanged, removed: removed.length, total: names.length };
  }

  readReportSidecar(name) {
    const row = this.db.prepare(`
      SELECT content, mtime_ms, sha256 FROM report_sidecars WHERE name = ?
    `).get(name);
    return row ? { content: row.content, mtimeMs: Number(row.mtime_ms), sha256: row.sha256 } : null;
  }

  reportSidecarSignatures(reportNames) {
    const output = new Map();
    const lookup = this.db.prepare('SELECT mtime_ms, sha256 FROM report_sidecars WHERE name = ?');
    for (const reportName of reportNames || []) {
      const sidecarName = String(reportName).replace(/\.md$/, '.json');
      const row = lookup.get(sidecarName);
      output.set(reportName, row ? `${Number(row.mtime_ms)}:${row.sha256}` : '');
    }
    return output;
  }

  reconcileAssets({
    imagesDir = path.join(this.repoRoot, 'social-posts', 'images'),
    browserDirs = [path.join(this.stateDir, 'browser-scan'), path.join(this.repoRoot, 'reports', '.browser-scan')],
    runId = null,
  } = {}) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
    const captureExtensions = new Set(['.json', '.html', '.htm']);
    const candidates = [];
    for (const fullPath of listFilesRecursive(imagesDir)) {
      if (imageExtensions.has(path.extname(fullPath).toLowerCase())) {
        candidates.push({ fullPath, kind: 'generated-image' });
      }
    }
    for (const directory of browserDirs) {
      for (const fullPath of listFilesRecursive(directory)) {
        if (captureExtensions.has(path.extname(fullPath).toLowerCase())) {
          candidates.push({ fullPath, kind: 'browser-capture' });
        }
      }
    }
    const existing = new Map(
      this.db.prepare('SELECT path, mtime_ms, size_bytes, run_id FROM asset_records').all()
        .map((row) => [row.path, row]),
    );
    const seen = new Set();
    const changes = [];
    let unchanged = 0;
    for (const candidate of candidates) {
      const stat = statSync(candidate.fullPath);
      const relativePath = posixPath(path.relative(this.repoRoot, candidate.fullPath));
      seen.add(relativePath);
      const prior = existing.get(relativePath);
      if (prior && Number(prior.mtime_ms) === Math.trunc(stat.mtimeMs) && Number(prior.size_bytes) === stat.size) {
        if (runId && prior.run_id !== runId) {
          this.db.prepare('UPDATE asset_records SET run_id = ? WHERE path = ?').run(runId, relativePath);
        }
        unchanged++;
        continue;
      }
      const buffer = readFileSync(candidate.fullPath);
      const extension = path.extname(candidate.fullPath).toLowerCase();
      const dimensions = candidate.kind === 'generated-image'
        ? imageDimensions(buffer, extension)
        : { width: null, height: null };
      let relatedArtifact = null;
      if (candidate.kind === 'generated-image') {
        const batch = relativePath.match(/social-posts\/images\/([^/]+)\//)?.[1];
        if (batch) {
          relatedArtifact = this.db.prepare(`
            SELECT path FROM artifacts
            WHERE kind = 'social-posts' AND name LIKE ?
            ORDER BY mtime_ms DESC LIMIT 1
          `).get(`${batch}%`)?.path || null;
        }
      }
      const mime = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.webp': 'image/webp', '.gif': 'image/gif', '.json': 'application/json',
        '.html': 'text/html', '.htm': 'text/html',
      }[extension] || 'application/octet-stream';
      changes.push({
        relativePath,
        kind: candidate.kind,
        mime,
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
        sha256: createHash('sha256').update(buffer).digest('hex'),
        ...dimensions,
        relatedArtifact,
        runId,
      });
    }
    const removed = [...existing.keys()].filter((relativePath) => !seen.has(relativePath));
    const upsert = this.db.prepare(`
      INSERT INTO asset_records(
        path, kind, mime_type, size_bytes, mtime_ms, sha256,
        width, height, related_artifact, run_id, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        kind = excluded.kind,
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        sha256 = excluded.sha256,
        width = excluded.width,
        height = excluded.height,
        related_artifact = excluded.related_artifact,
        run_id = excluded.run_id,
        indexed_at = excluded.indexed_at
    `);
    const remove = this.db.prepare('DELETE FROM asset_records WHERE path = ?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const indexedAt = new Date().toISOString();
      for (const change of changes) {
        upsert.run(
          change.relativePath, change.kind, change.mime, change.size, change.mtimeMs,
          change.sha256, change.width, change.height, change.relatedArtifact, change.runId, indexedAt,
        );
      }
      for (const relativePath of removed) remove.run(relativePath);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { imported: changes.length, unchanged, removed: removed.length, total: candidates.length };
  }

  listAssets(kind) {
    const rows = kind
      ? this.db.prepare('SELECT * FROM asset_records WHERE kind = ? ORDER BY mtime_ms DESC').all(kind)
      : this.db.prepare('SELECT * FROM asset_records ORDER BY mtime_ms DESC').all();
    return rows.map((row) => ({
      path: row.path,
      kind: row.kind,
      mimeType: row.mime_type,
      size: Number(row.size_bytes),
      mtime: new Date(Number(row.mtime_ms)).toISOString(),
      sha256: row.sha256,
      width: row.width == null ? null : Number(row.width),
      height: row.height == null ? null : Number(row.height),
      relatedArtifact: row.related_artifact,
      runId: row.run_id,
    }));
  }

  retentionPlan({ keepRuns = 500, keepBackups = 10, captureDays = 180 } = {}) {
    const safeRuns = Math.max(0, Number(keepRuns) || 0);
    const safeBackups = Math.max(0, Number(keepBackups) || 0);
    const safeCaptureDays = Math.max(0, Number(captureDays) || 0);
    const runRows = this.db.prepare(`
      SELECT id, started_at FROM scan_runs ORDER BY started_at DESC
    `).all();
    const runIds = runRows.slice(safeRuns).map((row) => row.id);
    const captureCutoff = Date.now() - safeCaptureDays * 24 * 60 * 60 * 1000;
    const captures = this.db.prepare(`
      SELECT path, mtime_ms, size_bytes FROM asset_records
      WHERE kind = 'browser-capture' AND mtime_ms < ?
      ORDER BY mtime_ms
    `).all(captureCutoff).map((row) => ({
      path: row.path,
      mtime: new Date(Number(row.mtime_ms)).toISOString(),
      size: Number(row.size_bytes),
    }));
    const backupDir = path.join(path.dirname(this.dbPath), 'backups');
    let backups = [];
    try {
      backups = readdirSync(backupDir)
        .filter((name) => /\.db$/i.test(name))
        .map((name) => {
          const fullPath = path.join(backupDir, name);
          const stat = statSync(fullPath);
          return { path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(safeBackups)
        .map((entry) => ({
          path: entry.path,
          mtime: new Date(entry.mtimeMs).toISOString(),
          size: entry.size,
        }));
    } catch {
      backups = [];
    }
    return {
      policy: { keepRuns: safeRuns, keepBackups: safeBackups, captureDays: safeCaptureDays },
      runs: runIds,
      browserCaptures: captures,
      backups,
      protected: ['reports', 'social-posts', 'generated-images', 'configs'],
      totals: {
        runs: runIds.length,
        browserCaptures: captures.length,
        backups: backups.length,
        bytes: [...captures, ...backups].reduce((sum, entry) => sum + entry.size, 0),
      },
    };
  }

  applyRetention(plan) {
    if (!plan || !plan.policy) throw new Error('A retention plan is required');
    const removeRun = this.db.prepare('DELETE FROM scan_runs WHERE id = ?');
    const removeAsset = this.db.prepare('DELETE FROM asset_records WHERE path = ?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of plan.runs || []) removeRun.run(id);
      for (const capture of plan.browserCaptures || []) removeAsset.run(capture.path);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const deletedFiles = [];
    const failedFiles = [];
    for (const entry of [...(plan.browserCaptures || []), ...(plan.backups || [])]) {
      const absolutePath = path.isAbsolute(entry.path)
        ? entry.path
        : path.resolve(this.repoRoot, entry.path);
      try {
        rmSync(absolutePath, { force: true });
        deletedFiles.push(entry.path);
      } catch (error) {
        failedFiles.push({ path: entry.path, error: error.message });
      }
    }
    return {
      ok: failedFiles.length === 0,
      deletedRuns: (plan.runs || []).length,
      deletedFiles,
      failedFiles,
      protected: plan.protected || [],
    };
  }

  importSentimentOverrides({ filePath, force = false } = {}) {
    const existing = Number(this.db.prepare('SELECT COUNT(*) AS count FROM sentiment_overrides').get().count || 0);
    if (existing > 0 && !force) return { imported: 0, existing, source: null };
    const candidates = [
      filePath,
      path.join(this.stateDir, SENTIMENT_OVERRIDES_FILE),
      path.join(this.repoRoot, 'reports', '.sentiment-overrides.json'),
    ].filter(Boolean);
    const source = candidates.find((candidate) => existsSync(candidate));
    if (!source) return { imported: 0, existing, source: null };
    const parsed = parseJson(readFileSync(source, 'utf8'), {});
    const imported = this.upsertSentimentOverrides(parsed);
    return { imported, existing, source: posixPath(source) };
  }

  upsertSentimentOverrides(overrides) {
    const entries = overrides instanceof Map ? [...overrides.entries()] : Object.entries(overrides || {});
    const upsert = this.db.prepare(`
      INSERT INTO sentiment_overrides(
        url, sentiment, confidence, rationale, provider, model,
        reviewed_at, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        sentiment = excluded.sentiment,
        confidence = excluded.confidence,
        rationale = excluded.rationale,
        provider = excluded.provider,
        model = excluded.model,
        reviewed_at = excluded.reviewed_at,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);
    let imported = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const updatedAt = new Date().toISOString();
      for (const [url, value] of entries) {
        if (!url || !value || typeof value !== 'object' || !value.sentiment) continue;
        upsert.run(
          url,
          value.sentiment,
          value.confidence || '',
          value.rationale || '',
          value.provider || '',
          value.model || '',
          value.reviewedAt || '',
          JSON.stringify(value),
          updatedAt,
        );
        imported++;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return imported;
  }

  listSentimentOverrides() {
    return this.db.prepare(`
      SELECT url, payload_json FROM sentiment_overrides ORDER BY url
    `).all().map((row) => ({ url: row.url, value: parseJson(row.payload_json) }));
  }

  sentimentOverrideSignature() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS updated_at
      FROM sentiment_overrides
    `).get();
    return `${Number(row.count || 0)}@${row.updated_at || ''}`;
  }

  reconcileConfigs({
    configsDir = path.join(this.localRoot, 'configs'),
    legacyConfigsDir = path.join(this.repoRoot, '.github', 'prompts'),
  } = {}) {
    const candidates = new Map();
    const collect = (directory, pattern, priority) => {
      let names = [];
      try {
        names = readdirSync(directory).filter((name) => pattern.test(name));
      } catch {
        return;
      }
      for (const name of names) {
        const slug = name
          .replace(/^scout-config-/, '')
          .replace(/\.prompt\.md$|\.md$/i, '');
        if (/^example(?:-|$)/i.test(slug)) continue;
        const prior = candidates.get(slug);
        if (!prior || priority > prior.priority) {
          candidates.set(slug, { slug, fullPath: path.join(directory, name), priority });
        }
      }
    };
    collect(legacyConfigsDir, /^scout-config-.+\.prompt\.md$/i, 1);
    collect(configsDir, /^scout-config-.+\.md$/i, 2);

    const existing = new Map(
      this.db.prepare('SELECT slug, mtime_ms, size_bytes FROM subjects').all()
        .map((row) => [row.slug, row]),
    );
    const changes = [];
    let unchanged = 0;
    for (const candidate of candidates.values()) {
      const stat = statSync(candidate.fullPath);
      const prior = existing.get(candidate.slug);
      if (prior && Number(prior.mtime_ms) === Math.trunc(stat.mtimeMs) && Number(prior.size_bytes) === stat.size) {
        unchanged++;
        continue;
      }
      const content = readFileSync(candidate.fullPath, 'utf8');
      const name = content.match(/^\s*-\s*\*\*Name:\*\*\s*(.+)$/m)?.[1]?.trim() || candidate.slug;
      const type = content.match(/^\s*-\s*\*\*Type:\*\*\s*(.+)$/m)?.[1]?.trim() || '';
      changes.push({
        ...candidate,
        relativePath: posixPath(path.relative(this.repoRoot, candidate.fullPath)),
        mtimeMs: Math.trunc(stat.mtimeMs),
        size: stat.size,
        sha256: createHash('sha256').update(content).digest('hex'),
        content,
        name,
        type,
      });
    }
    const removed = [...existing.keys()].filter((slug) => !candidates.has(slug));
    const upsert = this.db.prepare(`
      INSERT INTO subjects(slug, path, name, type, mtime_ms, size_bytes, sha256, content, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        path = excluded.path,
        name = excluded.name,
        type = excluded.type,
        mtime_ms = excluded.mtime_ms,
        size_bytes = excluded.size_bytes,
        sha256 = excluded.sha256,
        content = excluded.content,
        indexed_at = excluded.indexed_at
    `);
    const remove = this.db.prepare('DELETE FROM subjects WHERE slug = ?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const indexedAt = new Date().toISOString();
      for (const change of changes) {
        upsert.run(
          change.slug,
          change.relativePath,
          change.name,
          change.type,
          change.mtimeMs,
          change.size,
          change.sha256,
          change.content,
          indexedAt,
        );
      }
      for (const slug of removed) remove.run(slug);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      imported: changes.length,
      unchanged,
      removed: removed.length,
      total: candidates.size,
    };
  }

  listSubjects() {
    return this.db.prepare(`
      SELECT slug, path, name, type, mtime_ms
      FROM subjects
      ORDER BY name COLLATE NOCASE, slug
    `).all().map((row) => ({
      slug: row.slug,
      path: row.path,
      name: row.name,
      type: row.type,
      mtime: new Date(Number(row.mtime_ms)).toISOString(),
    }));
  }

  listArtifacts(kind) {
    return this.db.prepare(`
      SELECT name, mtime_ms, size_bytes, meta_json
      FROM artifacts
      WHERE kind = ?
      ORDER BY mtime_ms DESC
    `).all(kind).map((row) => ({
      name: row.name,
      mtime: new Date(Number(row.mtime_ms)).toISOString(),
      size: Number(row.size_bytes),
      meta: parseJson(row.meta_json),
    }));
  }

  readArtifact(kind, name) {
    const row = this.db.prepare(`
      SELECT content, mtime_ms, size_bytes, meta_json
      FROM artifacts
      WHERE kind = ? AND name = ?
    `).get(kind, name);
    if (!row) return null;
    return {
      content: row.content,
      mtime: new Date(Number(row.mtime_ms)).toISOString(),
      size: Number(row.size_bytes),
      meta: parseJson(row.meta_json),
    };
  }

  loadIndexSnapshot(signature) {
    const row = this.db.prepare(`
      SELECT payload_json
      FROM index_snapshots
      WHERE signature = ?
    `).get(signature);
    return row ? parseJson(row.payload_json, null) : null;
  }

  saveIndexSnapshot(signature, payload) {
    const builtAt = Number(payload?.builtAt || Date.now());
    this.db.prepare(`
      INSERT INTO index_snapshots(signature, payload_json, built_at)
      VALUES (?, ?, ?)
      ON CONFLICT(signature) DO UPDATE SET
        payload_json = excluded.payload_json,
        built_at = excluded.built_at
    `).run(signature, JSON.stringify(payload), builtAt);
    this.db.prepare(`
      DELETE FROM index_snapshots
      WHERE signature NOT IN (
        SELECT signature FROM index_snapshots ORDER BY built_at DESC LIMIT 3
      )
    `).run();
  }

  replaceNormalizedIndex(signature, payload) {
    const reports = Array.isArray(payload?.reports) ? payload.reports : [];
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const conversations = Array.isArray(payload?.conversations) ? payload.conversations : [];
    const creators = Array.isArray(payload?.authors) ? payload.authors : [];
    const sources = Array.isArray(payload?.sources) ? payload.sources : [];
    const insertReport = this.db.prepare(`
      INSERT INTO report_records(
        name, signature, slug, generated_at, mtime, source, item_count,
        conversation_count, sentiment_json, competitor_json, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertItem = this.db.prepare(`
      INSERT INTO item_records(
        signature, report_name, ordinal, url, title, author, source,
        published_at, kind, ep, tags_json, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertConversation = this.db.prepare(`
      INSERT INTO conversation_records(
        signature, report_name, ordinal, url, author, platform, published_at,
        sentiment, confidence, community, competitor, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertCreator = this.db.prepare(`
      INSERT INTO creator_records(
        name, signature, item_count, conversation_count, last_seen,
        is_product, sentiments_json, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSource = this.db.prepare(`
      INSERT INTO source_records(
        source, signature, item_count, last_seen, skipped_count, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        DELETE FROM report_records;
        DELETE FROM item_records;
        DELETE FROM conversation_records;
        DELETE FROM creator_records;
        DELETE FROM source_records;
      `);
      for (const report of reports) {
        insertReport.run(
          report.name || '', signature, report.slug || '', report.generatedAt || '',
          report.mtime || '', report.source || '', Number(report.itemCount || 0),
          Number(report.convoCount || 0), JSON.stringify(report.sentimentTotals || {}),
          JSON.stringify(report.competitorAggregates || {}), JSON.stringify(report),
        );
      }
      items.forEach((item, ordinal) => {
        insertItem.run(
          signature, item.report || '', ordinal, item.url || '', item.title || '',
          item.author || '', item.source || '', item.date || '', item.kind || '',
          Number.isFinite(item.ep) ? item.ep : null, JSON.stringify(item.tags || []),
          JSON.stringify(item),
        );
      });
      conversations.forEach((conversation, ordinal) => {
        insertConversation.run(
          signature, conversation.report || '', ordinal, conversation.url || '',
          conversation.author || '', conversation.platform || '', conversation.date || '',
          conversation.sentiment || 'unknown', conversation.sentimentConfidence || '',
          conversation.community || '', conversation.competitor || '', JSON.stringify(conversation),
        );
      });
      for (const creator of creators) {
        insertCreator.run(
          creator.name || '', signature, Number(creator.items || 0),
          Number(creator.conversations || 0), creator.lastSeen || '',
          creator.isProduct ? 1 : 0, JSON.stringify(creator.sentiments || {}),
          JSON.stringify(creator),
        );
      }
      for (const source of sources) {
        insertSource.run(
          source.source || '', signature, Number(source.items || 0), source.lastSeen || '',
          Number(source.skipped || 0), JSON.stringify(source),
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      reports: reports.length,
      items: items.length,
      conversations: conversations.length,
      creators: creators.length,
      sources: sources.length,
    };
  }

  loadNormalizedIndex(signature) {
    const current = this.db.prepare('SELECT signature FROM report_records LIMIT 1').get()?.signature
      || this.db.prepare('SELECT signature FROM conversation_records LIMIT 1').get()?.signature;
    if (!current || current !== signature) return null;
    const parseRows = (table, orderBy) => this.db.prepare(
      `SELECT payload_json FROM ${table} WHERE signature = ? ORDER BY ${orderBy}`,
    ).all(signature).map((row) => parseJson(row.payload_json, null)).filter(Boolean);
    return {
      signature,
      reports: parseRows('report_records', 'generated_at DESC, name'),
      items: parseRows('item_records', 'ordinal'),
      conversations: parseRows('conversation_records', 'ordinal'),
      authors: parseRows('creator_records', 'name COLLATE NOCASE'),
      sources: parseRows('source_records', 'source COLLATE NOCASE'),
    };
  }

  normalizedCounts() {
    const count = (table) => Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count || 0);
    return {
      reports: count('report_records'),
      items: count('item_records'),
      conversations: count('conversation_records'),
      creators: count('creator_records'),
      sources: count('source_records'),
    };
  }

  saveRun(run) {
    this.db.prepare(`
      INSERT INTO scan_runs(
        id, command_name, command_text, status, started_at, finished_at,
        bulk_id, bulk_label, output, args_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        command_name = excluded.command_name,
        command_text = excluded.command_text,
        status = excluded.status,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        bulk_id = excluded.bulk_id,
        bulk_label = excluded.bulk_label,
        output = excluded.output,
        args_json = excluded.args_json,
        updated_at = excluded.updated_at
    `).run(
      run.id,
      run.cmdName || '',
      run.command || '',
      run.status || 'unknown',
      run.startedAt || new Date().toISOString(),
      run.finishedAt || null,
      run.bulkId || null,
      run.bulkLabel || null,
      run.output || '',
      JSON.stringify(run.args || {}),
      new Date().toISOString(),
    );
  }

  listRuns(limit = 100) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    return this.db.prepare(`
      SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT ?
    `).all(safeLimit).map((row) => ({
      id: row.id,
      cmdName: row.command_name,
      command: row.command_text,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      bulkId: row.bulk_id,
      bulkLabel: row.bulk_label,
      output: row.output,
      args: parseJson(row.args_json),
    }));
  }

  getRun(id) {
    const row = this.db.prepare('SELECT * FROM scan_runs WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id,
      cmdName: row.command_name,
      command: row.command_text,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      bulkId: row.bulk_id,
      bulkLabel: row.bulk_label,
      output: row.output,
      args: parseJson(row.args_json),
    };
  }

  verifyWorkspace() {
    const rows = this.db.prepare('SELECT path, sha256 FROM artifacts ORDER BY path').all();
    const missing = [];
    const mismatched = [];
    for (const row of rows) {
      const fullPath = path.resolve(this.repoRoot, row.path);
      if (!existsSync(fullPath)) {
        missing.push(row.path);
        continue;
      }
      const digest = createHash('sha256').update(readFileSync(fullPath)).digest('hex');
      if (digest !== row.sha256) mismatched.push(row.path);
    }
    return {
      ok: missing.length === 0 && mismatched.length === 0,
      checked: rows.length,
      missing,
      mismatched,
    };
  }

  exportArtifacts(targetRoot) {
    const root = path.resolve(targetRoot);
    mkdirSync(root, { recursive: true });
    const rows = this.db.prepare('SELECT path, content FROM artifacts ORDER BY path').all();
    for (const row of rows) {
      const destination = path.resolve(root, row.path);
      if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Refusing to export unsafe artifact path: ${row.path}`);
      }
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, row.content, 'utf8');
    }
    return { ok: true, targetRoot: root, exported: rows.length };
  }

  backup(targetPath) {
    const destination = path.resolve(targetPath);
    mkdirSync(path.dirname(destination), { recursive: true });
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copyFileSync(this.dbPath, destination);
    return { ok: true, source: this.dbPath, destination };
  }

  search(query, options = {}) {
    const value = String(query || '').trim();
    if (!value) {
      return { query: '', builtAt: Date.now(), totals: { files: 0, hits: 0 }, results: [] };
    }
    const kinds = Array.isArray(options.kinds) && options.kinds.length
      ? options.kinds.filter((kind) => kind === 'reports' || kind === 'social-posts')
      : ['reports', 'social-posts'];
    const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : DEFAULT_MAX_FILES;
    const maxSnippets = Number.isFinite(options.maxSnippetsPerFile)
      ? options.maxSnippetsPerFile
      : DEFAULT_MAX_SNIPPETS;
    const placeholders = kinds.map(() => '?').join(', ');
    const useFts = !options.regex && this.fts5Enabled;
    let parameters;
    let sql;
    if (options.regex) {
      parameters = kinds;
      sql = `SELECT kind, name, path, mtime_ms, content FROM artifacts WHERE kind IN (${placeholders}) ORDER BY mtime_ms DESC`;
    } else if (useFts) {
      parameters = [quotedFtsQuery(value), value, ...kinds];
      sql = `
          WITH candidates(id) AS (
            SELECT rowid FROM artifacts_fts WHERE artifacts_fts MATCH ?
            UNION
            SELECT id FROM artifacts WHERE instr(lower(content), lower(?)) > 0
          )
          SELECT kind, name, path, mtime_ms, content
          FROM artifacts
          WHERE id IN (SELECT id FROM candidates) AND kind IN (${placeholders})
          ORDER BY mtime_ms DESC
        `;
    } else {
      parameters = [...kinds, value];
      sql = `
          SELECT kind, name, path, mtime_ms, content
          FROM artifacts
          WHERE kind IN (${placeholders}) AND instr(lower(content), lower(?)) > 0
          ORDER BY mtime_ms DESC
        `;
    }
    const rows = this.db.prepare(sql).all(...parameters);
    const matcher = buildMatcher(value, !!options.regex);
    const perKind = new Map(kinds.map((kind) => [kind, 0]));
    const results = [];

    for (const row of rows) {
      if ((perKind.get(row.kind) || 0) >= maxFiles || !matcher(row.content)) continue;
      const snippets = [];
      const lines = row.content.split(/\r?\n/);
      for (let index = 0; index < lines.length && snippets.length < maxSnippets; index++) {
        const hit = highlightIndex(lines[index], value, !!options.regex);
        if (!hit) continue;
        snippets.push({ line: index + 1, text: snippet(lines[index], hit) });
      }
      if (!snippets.length) continue;
      perKind.set(row.kind, (perKind.get(row.kind) || 0) + 1);
      results.push({
        kind: row.kind,
        name: row.name,
        path: row.path,
        mtime: Number(row.mtime_ms),
        hits: snippets.length,
        snippets,
      });
    }

    return {
      query: value,
      builtAt: Date.now(),
      totals: {
        files: results.length,
        hits: results.reduce((sum, result) => sum + result.hits, 0),
      },
      results,
    };
  }

  health() {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS artifacts,
        SUM(CASE WHEN kind = 'reports' THEN 1 ELSE 0 END) AS reports,
        SUM(CASE WHEN kind = 'social-posts' THEN 1 ELSE 0 END) AS social_posts
      FROM artifacts
    `).get();
    const subjects = this.db.prepare('SELECT COUNT(*) AS count FROM subjects').get();
    return {
      ok: true,
      dbPath: this.dbPath,
      schemaVersion: Number(this.db.prepare('PRAGMA user_version').get().user_version),
      journalMode: this.db.prepare('PRAGMA journal_mode').get().journal_mode,
      fts5: this.fts5Enabled,
      artifacts: Number(row.artifacts || 0),
      reports: Number(row.reports || 0),
      socialPosts: Number(row.social_posts || 0),
      subjects: Number(subjects.count || 0),
      normalized: this.normalizedCounts(),
      runs: Number(this.db.prepare('SELECT COUNT(*) AS count FROM scan_runs').get().count || 0),
      sentimentOverrides: Number(
        this.db.prepare('SELECT COUNT(*) AS count FROM sentiment_overrides').get().count || 0,
      ),
      assets: Number(this.db.prepare('SELECT COUNT(*) AS count FROM asset_records').get().count || 0),
      reportSidecars: Number(this.db.prepare('SELECT COUNT(*) AS count FROM report_sidecars').get().count || 0),
    };
  }

  close() {
    this.db.close();
  }
}

export function openArtifactStore(options) {
  try {
    return new SqliteArtifactStore(options);
  } catch (error) {
    const dbPath = path.resolve(options?.dbPath || stateFilePath(CONTENT_SCOUT_DB_FILE));
    if (!existsSync(dbPath)) throw error;
    const quarantinePath = `${dbPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      renameSync(dbPath, quarantinePath);
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${dbPath}${suffix}`;
        if (existsSync(sidecar)) renameSync(sidecar, `${quarantinePath}${suffix}`);
      }
      const store = new SqliteArtifactStore({ ...options, dbPath });
      store.recovery = {
        recovered: true,
        reason: error.message,
        quarantinePath,
      };
      return store;
    } catch (recoveryError) {
      throw new Error(`Unable to open or recover Content Scout SQLite storage: ${recoveryError.message}`);
    }
  }
}

export function restoreArtifactStore({ source, dbPath = stateFilePath(CONTENT_SCOUT_DB_FILE) }) {
  const backupPath = path.resolve(source);
  const destination = path.resolve(dbPath);
  if (!existsSync(backupPath)) throw new Error(`Backup not found: ${backupPath}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const current = `${destination}${suffix}`;
    if (existsSync(current)) renameSync(current, `${destination}.pre-restore-${Date.now()}${suffix}`);
  }
  copyFileSync(backupPath, destination);
  const store = new SqliteArtifactStore({ dbPath: destination });
  const health = store.health();
  store.close();
  return { ok: true, source: backupPath, destination, health };
}