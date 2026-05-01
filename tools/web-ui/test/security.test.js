import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isValidSlug, isValidFilename, safeJoin } from '../lib/security.js';

describe('isValidSlug', () => {
  it('accepts simple slugs', () => {
    assert.equal(isValidSlug('python'), true);
    assert.equal(isValidSlug('azure-cosmos-db'), true);
    assert.equal(isValidSlug('a'), true);
    assert.equal(isValidSlug('a1b2-c3'), true);
  });

  it('rejects traversal and separator characters', () => {
    assert.equal(isValidSlug('../etc/passwd'), false);
    assert.equal(isValidSlug('foo/bar'), false);
    assert.equal(isValidSlug('foo\\bar'), false);
    assert.equal(isValidSlug('foo bar'), false);
    assert.equal(isValidSlug('.hidden'), false);
    assert.equal(isValidSlug('-leading-dash'), false);
  });

  it('rejects empty / non-strings / wrong case', () => {
    assert.equal(isValidSlug(''), false);
    assert.equal(isValidSlug(null), false);
    assert.equal(isValidSlug(undefined), false);
    assert.equal(isValidSlug(42), false);
    assert.equal(isValidSlug('UPPER'), false);
  });

  it('rejects overly long slugs', () => {
    assert.equal(isValidSlug('a'.repeat(64)), true);
    assert.equal(isValidSlug('a'.repeat(65)), false);
  });
});

describe('isValidFilename', () => {
  it('accepts well-formed report names', () => {
    assert.equal(isValidFilename('2026-04-30-1425-azure-cosmos-db-content.md'), true);
    assert.equal(isValidFilename('foo.json'), true);
    assert.equal(isValidFilename('a_b-c.1.md'), true);
  });

  it('rejects traversal sequences', () => {
    assert.equal(isValidFilename('../etc/passwd'), false);
    assert.equal(isValidFilename('foo/../bar.md'), false);
    assert.equal(isValidFilename('..'), false);
    assert.equal(isValidFilename('a/b.md'), false);
    assert.equal(isValidFilename('a\\b.md'), false);
  });

  it('rejects empty / non-strings / leading dot', () => {
    assert.equal(isValidFilename(''), false);
    assert.equal(isValidFilename(null), false);
    assert.equal(isValidFilename('.env'), false);
  });
});

describe('safeJoin', () => {
  const base = path.resolve('/tmp/scout-base');

  it('resolves a child file inside base', () => {
    const out = safeJoin(base, 'report.md');
    assert.equal(out, path.join(base, 'report.md'));
  });

  it('throws on absolute paths that escape', () => {
    assert.throws(() => safeJoin(base, '/etc/passwd'), /escapes/);
  });

  it('throws on .. traversal', () => {
    assert.throws(() => safeJoin(base, '../outside.md'), /escapes/);
    assert.throws(() => safeJoin(base, 'a/../../b'), /escapes/);
  });

  it('allows nested paths inside base', () => {
    const out = safeJoin(base, 'sub/dir/file.md');
    assert.equal(out, path.join(base, 'sub', 'dir', 'file.md'));
  });
});
