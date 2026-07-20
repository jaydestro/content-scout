import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fetchViaAcp } from '../lib/copilot-models.mjs';

test('ACP model discovery treats a closed child stdin pipe as a soft failure', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = () => {
    process.nextTick(() => {
      const error = new Error('write EPIPE');
      error.code = 'EPIPE';
      child.stdin.emit('error', error);
    });
    return false;
  };
  child.kill = () => {};

  const resultPromise = fetchViaAcp({ spawnImpl: () => child, timeoutMs: 250 });
  child.stdout.emit('data', '{"result":{"agentInfo":{}}}\n');

  assert.equal(await resultPromise, null);
});