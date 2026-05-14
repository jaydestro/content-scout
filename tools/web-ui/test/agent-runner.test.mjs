// agent-runner.test.mjs — verifies CLI / web parity via the shared lib.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, AGENT_PRESETS } from '../../lib/agent-runner.mjs';

test('buildPrompt: bare command', () => {
  assert.equal(buildPrompt('scout-scan'), '/scout-scan');
});

test('buildPrompt: slug + extra', () => {
  assert.equal(
    buildPrompt('scout-post', { slug: 'azure-cosmos-db', extra: 'linkedin only' }),
    '/scout-post azure-cosmos-db linkedin only',
  );
});

test('buildPrompt: strips shell-injection chars', () => {
  const got = buildPrompt('scout-scan', { slug: 'foo`rm -rf /`$X"\\bar' });
  assert.ok(!/[`$\\"]/.test(got), `prompt still contains unsafe chars: ${got}`);
});

test('buildPrompt: custom command uses raw prompt', () => {
  assert.equal(buildPrompt('custom', { prompt: 'do the thing' }), 'do the thing');
});

test('AGENT_PRESETS: all expected agents present', () => {
  for (const id of ['claude', 'copilot', 'codex', 'cursor', 'gemini']) {
    assert.ok(AGENT_PRESETS[id], `missing preset: ${id}`);
    assert.ok(AGENT_PRESETS[id].runner.includes('{prompt}'), `runner missing {prompt}: ${id}`);
  }
});

test('CLI parity: every web /api/runs command name is reachable from the CLI', async () => {
  // The 9 agent commands the web UI exposes in its Run view.
  const expected = [
    'scan',
    'post',
    'calendar',
    'gaps',
    'trends',
    'creators',
    'doctor',
    'replay',
    'seo',
    'onboard',
  ];
  // The CLI defines AGENT_COMMANDS as a Set. Re-derive from source so the
  // test fails loudly if the umbrella drops one.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const cli = await fs.readFile(
    path.resolve('..', 'scout-cli', 'index.mjs'),
    'utf8',
  );
  for (const name of expected) {
    assert.ok(
      cli.includes(`'${name}'`),
      `scout-cli is missing agent command: ${name}`,
    );
  }
});
