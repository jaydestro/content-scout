import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateRawConfig, MAX_CONFIG_BYTES } from '../lib/config-validator.js';

const goodConfig = `---
description: Content Scout configuration for Foo
mode: content-scout
---

# scout-config: Foo

Apply this configuration to the Content Scout agent.
`;

describe('validateRawConfig', () => {
  it('accepts a valid scout-config payload', () => {
    const r = validateRawConfig(goodConfig);
    assert.equal(r.ok, true);
  });

  it('rejects non-string input', () => {
    assert.equal(validateRawConfig(undefined).ok, false);
    assert.equal(validateRawConfig(null).ok, false);
    assert.equal(validateRawConfig(42).ok, false);
    assert.equal(validateRawConfig({}).ok, false);
    assert.equal(validateRawConfig(undefined).code, 'not-string');
  });

  it('rejects empty / whitespace-only', () => {
    assert.equal(validateRawConfig('').code, 'empty');
    assert.equal(validateRawConfig('   \n\t').code, 'empty');
  });

  it('rejects payloads missing the scout-config header', () => {
    const bad = '# Some Other Heading\n\nblah blah';
    const r = validateRawConfig(bad);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'missing-header');
  });

  it('rejects payloads larger than MAX_CONFIG_BYTES', () => {
    const huge = '# scout-config: Foo\n\n' + 'x'.repeat(MAX_CONFIG_BYTES);
    const r = validateRawConfig(huge);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'too-large');
  });

  it('accepts a config with a leading BOM', () => {
    const r = validateRawConfig('\uFEFF' + goodConfig);
    assert.equal(r.ok, true);
  });
});
