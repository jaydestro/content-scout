import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applySentimentOverrides,
  canonicalUrlKey,
  normalizeSentiment,
  parseProductTeamNamesFromConfig,
  parseReport,
  parseReportFromJson,
  loadReport,
} from '../../lib/report-index.mjs';

test('normalizeSentiment treats white/yellow as neutral and orange as mixed', () => {
  assert.equal(normalizeSentiment('⚪ Neutral'), 'neutral');
  assert.equal(normalizeSentiment('🟡 Neutral'), 'neutral');
  assert.equal(normalizeSentiment('🟠 Mixed'), 'mixed');
});

test('applySentimentOverrides updates confidence even when label stays neutral', () => {
  const url = 'https://bsky.app/profile/example.bsky.social/post/abc123';
  const parsed = parseReportFromJson({
    generated_at: '2026-05-22',
    items: [
      {
        section: 'social',
        title: 'Is Cosmos DB right for this use case?',
        url,
        author: { display_name: 'Example User', platform: 'bluesky' },
        sentiment: 'neutral',
        sentiment_confidence: 'low',
      },
    ],
  }, '2026-05-22-1200-test-product-content.md');

  applySentimentOverrides(parsed, new Map([
    [canonicalUrlKey(url), { sentiment: 'neutral', confidence: 'high' }],
  ]));

  assert.equal(parsed.conversations[0].sentiment, 'neutral');
  assert.equal(parsed.conversations[0].sentimentConfidence, 'high');
  assert.equal(parsed.conversations[0].sentimentOverridden, true);
  assert.deepEqual(parsed.sentimentTotals, {
    positive: 0,
    neutral: 1,
    negative: 0,
    mixed: 0,
    unknown: 0,
  });
});

test('applySentimentOverrides moves totals when label changes to mixed', () => {
  const url = 'https://www.linkedin.com/feed/update/urn:li:activity:123';
  const parsed = parseReportFromJson({
    generated_at: '2026-05-22',
    items: [
      {
        section: 'social',
        title: 'Cosmos DB solved our scale problem, but RU costs surprised us.',
        url,
        author: { display_name: 'Example User', platform: 'linkedin' },
        sentiment: 'neutral',
        sentiment_confidence: 'low',
      },
    ],
  }, '2026-05-22-1200-test-product-content.md');

  applySentimentOverrides(parsed, new Map([
    [canonicalUrlKey(url), { sentiment: 'mixed', confidence: 'medium' }],
  ]));

  assert.equal(parsed.conversations[0].sentiment, 'mixed');
  assert.equal(parsed.conversations[0].sentimentConfidence, 'medium');
  assert.deepEqual(parsed.sentimentTotals, {
    positive: 0,
    neutral: 0,
    negative: 0,
    mixed: 1,
    unknown: 0,
  });
});

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

test('parseReportFromJson exposes competitor aggregates without changing primary sentiment totals', () => {
  const competitorMention = {
    competitor: 'Amazon DynamoDB',
    competitorSentiment: 'negative',
    competitorSentimentConfidence: 'high',
    platform: 'reddit',
    timestamp: '2026-07-20T12:00:00Z',
    url: 'https://reddit.com/r/databases/comments/1/example',
    switchingDirection: 'competitor_to_primary',
  };
  const competitorAggregates = {
    mentions: 1,
    byCompetitor: {
      'Amazon DynamoDB': {
        mentions: 1,
        sentiments: { positive: 0, neutral: 0, negative: 1, mixed: 0, unknown: 0 },
        bySource: { reddit: 1 },
      },
    },
    bySource: { reddit: { mentions: 1 } },
  };
  const parsed = parseReportFromJson({
    generated_at: '2026-07-20',
    items: [],
    competitor_mentions: [competitorMention],
    competitor_aggregates: competitorAggregates,
    competitor_source_failures: [{ source: 'x', error: 'unavailable' }],
  }, '2026-07-20-1200-test-product-content.md');

  assert.deepEqual(parsed.competitorMentions, [competitorMention]);
  assert.deepEqual(parsed.competitorAggregates, competitorAggregates);
  assert.deepEqual(parsed.competitorSourceFailures, [{ source: 'x', error: 'unavailable' }]);
  assert.deepEqual(parsed.sentimentTotals, {
    positive: 0,
    neutral: 0,
    negative: 0,
    mixed: 0,
    unknown: 0,
  });
});

test('parseReportFromJson normalizes malformed competitor metadata to stable defaults', () => {
  const parsed = parseReportFromJson({
    generated_at: '2026-07-20',
    items: [],
    competitor_mentions: {},
    competitor_aggregates: 'broken',
    competitor_source_failures: { source: 'x', error: 'unavailable' },
  }, '2026-07-20-1200-test-product-content.md');

  assert.deepEqual(parsed.competitorMentions, []);
  assert.deepEqual(parsed.competitorAggregates, {
    mentions: 0,
    byCompetitor: {},
    bySource: {},
  });
  assert.deepEqual(parsed.competitorSourceFailures, []);
});

test('parseReport exposes default competitor fields for legacy markdown reports', () => {
  const report = `
**Generated:** 2026-07-20

## Official Content

| # | Date | Title | Channel | Tags | EP | Link |
|---|------|-------|---------|------|----|------|
| 1 | 2026-07-20 | Example post | Blog | \`#tag\` | 5 | [link](https://example.com/post) |
`;

  const parsed = parseReport(report, '2026-07-20-1200-test-product-content.md');

  assert.deepEqual(parsed.competitorMentions, []);
  assert.deepEqual(parsed.competitorAggregates, {
    mentions: 0,
    byCompetitor: {},
    bySource: {},
  });
  assert.deepEqual(parsed.competitorSourceFailures, []);
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
test('parseReportFromJson: competitor mentions do not affect primary sentiment totals (reconciliation)', () => {
  // A conversation item that belongs to the primary product should count in
  // sentimentTotals; a competitor mention row must not.
  const parsed = parseReportFromJson({
    generated_at: '2026-07-20',
    items: [],
    // One community conversation — positive sentiment.
    conversations: [
      {
        section: 'conversations',
        date: '2026-07-20',
        title: 'Azure Cosmos DB rocks',
        url: 'https://reddit.com/r/databases/comments/2/primary',
        author: { display_name: 'CommunityUser', platform: 'reddit' },
        sentiment: 'positive',
        sentiment_confidence: 'high',
      },
    ],
    // One competitor mention with negative sentiment toward the competitor.
    competitor_mentions: [
      {
        competitor: 'Amazon DynamoDB',
        competitorSentiment: 'negative',
        competitorSentimentConfidence: 'high',
        platform: 'reddit',
        timestamp: '2026-07-20T12:00:00Z',
        url: 'https://reddit.com/r/databases/comments/3/comp',
        switchingDirection: 'competitor_to_primary',
      },
    ],
    competitor_aggregates: {
      mentions: 1,
      byCompetitor: {
        'Amazon DynamoDB': {
          mentions: 1,
          sentiments: { positive: 0, neutral: 0, negative: 1, mixed: 0, unknown: 0 },
          bySource: { reddit: 1 },
        },
      },
      bySource: { reddit: { mentions: 1 } },
    },
  }, '2026-07-20-1200-test-product-content.md');

  // Primary sentiment totals should only count the community conversation.
  assert.deepEqual(parsed.sentimentTotals, {
    positive: 1,
    neutral: 0,
    negative: 0,
    mixed: 0,
    unknown: 0,
  });
  // Competitor aggregates are exposed but do not leak into primary totals.
  assert.equal(parsed.competitorAggregates.mentions, 1);
  assert.equal(
    parsed.competitorAggregates.byCompetitor['Amazon DynamoDB'].sentiments.negative,
    1
  );
});

test('parseReportFromJson: partial competitor source failures are exposed', () => {
  const parsed = parseReportFromJson({
    generated_at: '2026-07-20',
    items: [],
    competitor_mentions: [],
    competitor_aggregates: { mentions: 0, byCompetitor: {}, bySource: {} },
    competitor_source_failures: [
      { source: 'x', error: 'rate limited' },
      { source: 'linkedin', error: 'login required' },
    ],
  }, '2026-07-20-1200-test-product-content.md');

  assert.equal(parsed.competitorSourceFailures.length, 2);
  assert.equal(parsed.competitorSourceFailures[0].source, 'x');
  assert.equal(parsed.competitorSourceFailures[1].source, 'linkedin');
  // Despite source failures, primary sentiment totals are zero (no conversations).
  assert.deepEqual(parsed.sentimentTotals, {
    positive: 0,
    neutral: 0,
    negative: 0,
    mixed: 0,
    unknown: 0,
  });
});

test('parseReportFromJson: multiple competitors aggregated independently', () => {
  const parsed = parseReportFromJson({
    generated_at: '2026-07-20',
    items: [],
    competitor_mentions: [
      {
        competitor: 'Amazon DynamoDB',
        competitorSentiment: 'negative',
        platform: 'reddit',
        url: 'https://reddit.com/r/databases/comments/1/a',
      },
      {
        competitor: 'MongoDB Atlas',
        competitorSentiment: 'positive',
        platform: 'hackernews',
        url: 'https://news.ycombinator.com/item?id=1',
      },
    ],
    competitor_aggregates: {
      mentions: 2,
      byCompetitor: {
        'Amazon DynamoDB': {
          mentions: 1,
          sentiments: { positive: 0, neutral: 0, negative: 1, mixed: 0, unknown: 0 },
          bySource: { reddit: 1 },
        },
        'MongoDB Atlas': {
          mentions: 1,
          sentiments: { positive: 1, neutral: 0, negative: 0, mixed: 0, unknown: 0 },
          bySource: { hackernews: 1 },
        },
      },
      bySource: {
        reddit: { mentions: 1 },
        hackernews: { mentions: 1 },
      },
    },
  }, '2026-07-20-1200-test-product-content.md');

  const byComp = parsed.competitorAggregates.byCompetitor;
  assert.equal(parsed.competitorAggregates.mentions, 2);
  assert.equal(byComp['Amazon DynamoDB'].sentiments.negative, 1);
  assert.equal(byComp['MongoDB Atlas'].sentiments.positive, 1);
  // Each competitor's data is independent.
  assert.equal(byComp['Amazon DynamoDB'].mentions, 1);
  assert.equal(byComp['MongoDB Atlas'].mentions, 1);
  // Primary sentiment totals are still empty (no conversations).
  assert.deepEqual(parsed.sentimentTotals, {
    positive: 0,
    neutral: 0,
    negative: 0,
    mixed: 0,
    unknown: 0,
  });
});

test('loadReport: competitor aggregates survive round-trip through JSON sidecar', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-comp-agg-'));
  try {
    const json = {
      generated_at: '2026-07-20',
      items: [],
      competitor_mentions: [
        {
          competitor: 'Amazon DynamoDB',
          competitorSentiment: 'mixed',
          competitorSentimentConfidence: 'high',
          platform: 'reddit',
          url: 'https://reddit.com/r/databases/comments/4/roundtrip',
          switchingDirection: 'none',
        },
      ],
      competitor_aggregates: {
        mentions: 1,
        byCompetitor: {
          'Amazon DynamoDB': {
            mentions: 1,
            sentiments: { positive: 0, neutral: 0, negative: 0, mixed: 1, unknown: 0 },
            bySource: { reddit: 1 },
          },
        },
        bySource: { reddit: { mentions: 1 } },
      },
      competitor_source_failures: [{ source: 'x', error: 'unavailable' }],
    };
    const fileName = '2026-07-20-1400-test-product-content.md';
    await fs.writeFile(path.join(tmp, fileName.replace(/\.md$/, '.json')), JSON.stringify(json));

    const parsed = await loadReport(tmp, fileName);
    assert.equal(parsed.competitorMentions.length, 1);
    assert.equal(parsed.competitorMentions[0].competitor, 'Amazon DynamoDB');
    assert.equal(parsed.competitorMentions[0].competitorSentiment, 'mixed');
    assert.equal(parsed.competitorAggregates.mentions, 1);
    assert.equal(parsed.competitorAggregates.byCompetitor['Amazon DynamoDB'].sentiments.mixed, 1);
    assert.equal(parsed.competitorSourceFailures.length, 1);
    assert.equal(parsed.competitorSourceFailures[0].source, 'x');
    // Primary product sentiment totals must be unaffected.
    assert.deepEqual(parsed.sentimentTotals, {
      positive: 0,
      neutral: 0,
      negative: 0,
      mixed: 0,
      unknown: 0,
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
