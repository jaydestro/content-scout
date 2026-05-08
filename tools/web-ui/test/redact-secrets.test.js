
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, _resetSecretCacheForTests } from '../lib/security.js';

describe('redactSecrets', () => {
  beforeEach(() => _resetSecretCacheForTests());

  it('masks env values whose key looks like a secret', () => {
    process.env.SCOUT_TEST_API_KEY = 'super-secret-value-12345';
    _resetSecretCacheForTests();
    const text = 'Using token super-secret-value-12345 to authenticate.';
    const out = redactSecrets(text);
    assert.ok(!out.includes('super-secret-value-12345'));
    assert.match(out, /\[REDACTED:SCOUT_TEST_API_KEY\]/);
    delete process.env.SCOUT_TEST_API_KEY;
  });

  it('redacts GitHub PATs', () => {
    const out = redactSecrets('header: ghp_' + 'A'.repeat(36));
    assert.match(out, /\[REDACTED\]/);
    assert.ok(!out.includes('ghp_AAAA'));
  });

  it('redacts OpenAI sk- tokens', () => {
    const out = redactSecrets('OPENAI=sk-' + 'a'.repeat(40));
    assert.match(out, /\[REDACTED/);
    assert.ok(!out.includes('sk-aaaa'));
  });

  it('preserves Authorization scheme but masks the token', () => {
    const out = redactSecrets('Authorization: Bearer abcdef0123456789ABCDEF');
    assert.match(out, /Authorization:?\s*Bearer\s*\[REDACTED\]/i);
  });

  it('catches generic KEY=value patterns for secret-looking keys', () => {
    const out = redactSecrets('SCOUT_FAKE_TOKEN=hunter22hunter22');
    assert.match(out, /\[REDACTED(:[A-Z_]+)?\]/);
    assert.ok(!out.includes('hunter22hunter22'));
  });

  it('leaves non-secret text alone', () => {
    const out = redactSecrets('Just regular log output, nothing sensitive here.');
    assert.equal(out, 'Just regular log output, nothing sensitive here.');
  });
});
