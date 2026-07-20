import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getMdSection, parseBulletList } from '../public/lib/config-md.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const configPaths = [
  '.local/configs/scout-config-azure-cosmos-db.md',
  '.github/prompts/scout-config-azure-cosmos-db.prompt.md',
];

function parseCompetitors(raw) {
  return parseBulletList(getMdSection(raw, 'Competitors')).map((line) => {
    const match = line.match(/^\*\*(.+?)\*\*\s+—\s+(.+?)\s+Aliases:\s+(.+)$/);
    assert.ok(match, `invalid competitor entry: ${line}`);
    return {
      name: match[1],
      description: match[2],
      aliases: [...match[3].matchAll(/`([^`]+)`/g)].map((alias) => alias[1]),
    };
  });
}

function mentions(alias, text) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

const configs = configPaths.map((path) => ({
  path,
  raw: readFileSync(`${root}/${path}`, 'utf8'),
}));

describe('Azure Cosmos DB competitor configs', () => {
  it('keep the active and fallback competitor lists aligned', () => {
    assert.deepEqual(parseCompetitors(configs[0].raw), parseCompetitors(configs[1].raw));
  });

  it('contain each established and newly tracked competitor exactly once', () => {
    const competitors = parseCompetitors(configs[0].raw);
    const names = competitors.map(({ name }) => name);

    for (const name of [
      'MongoDB Atlas',
      'Amazon DynamoDB',
      'Redis / Redis Enterprise / Azure Managed Redis',
      'Valkey',
      'Microsoft Garnet',
    ]) {
      assert.equal(names.filter((candidate) => candidate === name).length, 1, name);
    }

    for (const competitor of competitors) {
      assert.ok(competitor.description.length > 0, competitor.name);
      assert.ok(competitor.aliases.length > 0, competitor.name);
    }
  });

  it('matches aliases case-insensitively without noisy Garnet substrings', () => {
    const competitors = parseCompetitors(configs[0].raw);
    const garnet = competitors.find(({ name }) => name === 'Microsoft Garnet');
    const redis = competitors.find(({ name }) => name.startsWith('Redis /'));

    assert.ok(garnet.aliases.every((alias) => alias.toLowerCase() !== 'garnet'));
    assert.ok(mentions('Microsoft Garnet', 'MICROSOFT GARNET reached version 1.0'));
    assert.ok(mentions('microsoft/garnet', 'Try github.com/microsoft/garnet today'));
    assert.ok(!garnet.aliases.some((alias) => mentions(alias, 'The garnet gemstone is red')));
    assert.ok(redis.aliases.some((alias) => mentions(alias, 'Migrating from Azure Managed Redis')));
    assert.ok(!mentions('Redis', 'We redistributed the cache entries'));
  });

  it('does not leave Redis in the adjacent-only section', () => {
    for (const { path, raw } of configs) {
      const adjacent = getMdSection(raw, 'Adjacent Products');
      assert.doesNotMatch(adjacent, /\b(?:redis|valkey|garnet)\b/i, path);
    }
  });
});
