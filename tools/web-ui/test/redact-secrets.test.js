
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

  it('redacts lowercase password and api-key assignments', () => {
    const out = redactSecrets('password: hunter22hunter22 api-key=abc1234567890');
    assert.ok(!out.includes('hunter22hunter22'));
    assert.ok(!out.includes('abc1234567890'));
    assert.match(out, /password:\s*\[REDACTED/);
    assert.match(out, /api-key=\[REDACTED/);
  });

  it('redacts secret values in query strings', () => {
    const out = redactSecrets('https://example.test/search?api_key=abc1234567890&count=20&token=tok1234567890');
    assert.ok(!out.includes('abc1234567890'));
    assert.ok(!out.includes('tok1234567890'));
    assert.match(out, /api_key=\[REDACTED/);
    assert.match(out, /token=\[REDACTED/);
  });

  it('redacts natural-language password/token phrases', () => {
    const out = redactSecrets('The app password is xxxx-yyyy-zzzz-wwww and token was abcdefghijklmnop');
    assert.ok(!out.includes('xxxx-yyyy-zzzz-wwww'));
    assert.ok(!out.includes('abcdefghijklmnop'));
    assert.match(out, /password is \[REDACTED\]/i);
    assert.match(out, /token was \[REDACTED\]/i);
  });

  it('leaves non-secret text alone', () => {
    const out = redactSecrets('Just regular log output, nothing sensitive here.');
    assert.equal(out, 'Just regular log output, nothing sensitive here.');
  });
});
