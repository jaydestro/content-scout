import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTrends } from '../../lib/analytics.mjs';

function monthOffset(offset) {
  const today = new Date();
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function reportName(month, slug = 'azure-cosmos-db') {
  return `${month}-01-1200-${slug}-content.md`;
}

test('runTrends normalizes tag spelling before comparing months', () => {
  const prevMonth = monthOffset(-1);
  const currentMonth = monthOffset(0);
  const result = runTrends({
    months: 2,
    slug: 'azure-cosmos-db',
    items: [
      { report: reportName(prevMonth), author: 'A', tags: ['#architecture'] },
      { report: reportName(currentMonth), author: 'B', tags: ['architecture'] },
      { report: reportName(currentMonth), author: 'C', tags: ['#architecture', 'ai-agents vector-search'] },
    ],
    conversations: [],
  });

  const architecture = result.data.rising.find((row) => row.tag === 'architecture');
  assert.deepEqual(
    { previous: architecture?.previous, current: architecture?.current, delta: architecture?.delta },
    { previous: 1, current: 2, delta: 1 },
  );
  assert.equal(result.data.rising.filter((row) => row.tag.includes('architecture')).length, 1);
  assert.match(result.markdown, /## How to read this/);
  assert.match(result.markdown, /Fastest-rising topic: #architecture/);
  assert.doesNotMatch(result.markdown, /\| architecture \|/);
});

test('runTrends ignores non-canonical historical tags when config is provided', () => {
  const prevMonth = monthOffset(-1);
  const currentMonth = monthOffset(0);
  const configRaw = '## Topic Tags (Canonical)\n\narchitecture, ai-agents\n\n## Output Files\n';
  const result = runTrends({
    months: 2,
    slug: 'azure-cosmos-db',
    configRaw,
    items: [
      { report: reportName(prevMonth), author: 'A', tags: ['oss-documentdb'] },
      { report: reportName(currentMonth), author: 'B', tags: ['#DocumentDB'] },
      { report: reportName(currentMonth), author: 'C', tags: ['#architecture'] },
    ],
    conversations: [],
  });

  assert.equal(result.data.rising.some((row) => /documentdb/i.test(row.tag)), false);
  assert.match(result.markdown, /#architecture/);
  assert.doesNotMatch(result.markdown, /documentdb/i);
});
