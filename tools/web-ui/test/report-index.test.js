import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseProductTeamNamesFromConfig, parseReport, parseReportFromJson, loadReport } from '../../lib/report-index.mjs';

test('parseReport drops conversation rows that duplicate numbered content URLs', () => {
  const report = String.raw`
**Generated:** 2026-04-30

## Official Content

| # | Date | Title | Channel | Tags | EP | Link |
|---|------|-------|---------|------|----|------|
 | 1 | 2026-04-28 | Azure Cosmos DB Conf 2026 \| Live Stream | Microsoft Developer | ai-agents | 5 | [link](https://www.youtube.com/watch?v=OdPFriVuKtU) |

## Conversations & Mentions

| Date | Platform | Author | Summary | Sentiment | Link |
|------|----------|--------|---------|-----------|------|
| 2026-04-28 | YouTube | Cosmos DB Community | Azure Cosmos DB Conf 2026 full-day virtual event | 🟢 Positive | [link](https://www.youtube.com/watch?v=OdPFriVuKtU) |
`;

  const parsed = parseReport(report, '2026-04-30-1455-azure-cosmos-db-content.md');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.conversations.length, 0);
  assert.equal(parsed.sentimentTotals.positive, 0);
});

test('parseReportFromJson drops conversations that duplicate canonical YouTube item URLs', () => {
  const parsed = parseReportFromJson({
    generated_at: '2026-05-08',
    items: [
      {
        section: 'com_video',
        date: '2026-04-28',
        title: 'Azure Cosmos DB Conf 2026 | Live Stream',
        url: 'https://youtu.be/OdPFriVuKtU',
        author: { display_name: 'Microsoft Developer', platform: 'youtube' },
        tags: ['global-dist'],
        engagement_potential: 4,
      },
      {
        section: 'conversations',
        date: '2026-04-28',
        title: 'Azure Cosmos DB Conf 2026 full-day virtual event',
        url: 'https://www.youtube.com/watch?v=OdPFriVuKtU',
        author: { display_name: 'Cosmos DB Community', platform: 'youtube' },
        sentiment: 'positive',
      },
    ],
  }, '2026-05-08-1405-azure-cosmos-db-content.md');

  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.conversations.length, 0);
  assert.equal(parsed.sentimentTotals.positive, 0);
});

test('parseReport marks official account conversation rows as product-side', () => {
  const report = `
**Generated:** 2026-05-08

## Conversations & Mentions

| Date | Platform | Author | Summary | Sentiment | Link |
|------|----------|--------|---------|-----------|------|
| 2026-05-08 | X | Azure Cosmos DB | Official launch post | 🟢 Positive | [link](https://x.com/AzureCosmosDB/status/1) |
`;

  const parsed = parseReport(report, '2026-05-08-1405-azure-cosmos-db-content.md');
  assert.equal(parsed.conversations.length, 1);
  assert.equal(parsed.conversations[0].community, 'product');
});

test('parseReport does not treat Team Member Mentions as conversations', () => {
  const report = `
**Generated:** 2026-05-11

## Team Member Mentions

| Date | Platform | Author | Summary | Link |
|------|----------|--------|---------|------|
| 2026-05-12 | linkedin | Rakhi Thejraj | Importing Data into Azure Cosmos DB | [↗](https://www.linkedin.com/feed/update/urn:li:activity:7459779168067538944) |
`;

  const parsed = parseReport(report, '2026-05-11-2236-azure-cosmos-db-content.md');
  assert.equal(parsed.conversations.length, 0);
  assert.equal(parsed.items.length, 0);
});

test('parseReport marks configured product team names as product-side conversations', () => {
  const report = `
**Generated:** 2026-05-11

## Conversations & Community Questions

| Date | Platform | Author | Summary | Sentiment | Link |
|------|----------|--------|---------|-----------|------|
| 2026-05-12 | linkedin | Rakhi Thejraj | Importing Data into Azure Cosmos DB | 🟢 | [↗](https://www.linkedin.com/feed/update/urn:li:activity:7459779168067538944) |
`;

  const parsed = parseReport(report, '2026-05-11-2236-azure-cosmos-db-content.md', {
    productTeamNames: ['Rakhi Thejraj'],
  });
  assert.equal(parsed.conversations.length, 1);
  assert.equal(parsed.conversations[0].community, 'product');
});

test('parseProductTeamNamesFromConfig extracts name-only team members', () => {
  const names = parseProductTeamNamesFromConfig(`
## Product Team Members
<!-- comment -->
- Rakhi Thejraj
- James Codella (linkedin: jamescodella)

## Known Author Watchlist
- Community Person
`);

  assert.deepEqual(names, ['Rakhi Thejraj', 'James Codella']);
});

test('loadReport backfills empty conversation summaries from .cached-bodies.json', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-cached-bodies-'));
  try {
    const json = {
      generated_at: '2026-05-11',
      items: [
        {
          section: 'social',
          date: '2026-05-11T10:00:00Z',
          title: '',
          url: 'https://bsky.app/profile/example.bsky.social/post/abc123',
          author: { display_name: 'Example User', platform: 'bluesky' },
          sentiment: 'neutral',
        },
      ],
    };
    const fileName = '2026-05-11-1000-test-product-content.md';
    await fs.writeFile(path.join(tmp, fileName.replace(/\.md$/, '.json')), JSON.stringify(json), 'utf8');
    await fs.writeFile(path.join(tmp, '.cached-bodies.json'), JSON.stringify({
      'bsky.app/profile/example.bsky.social/post/abc123': {
        body: 'Hello from the cache — full post text restored.',
        fetchedAt: '2026-05-21T00:00:00Z',
        source: 'bluesky-api',
      },
    }), 'utf8');

    const parsed = await loadReport(tmp, fileName);
    assert.equal(parsed.conversations.length, 1);
    assert.equal(parsed.conversations[0].summary, 'Hello from the cache — full post text restored.');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});