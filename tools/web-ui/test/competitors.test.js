import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCompetitorSources,
  competitorTrackingEnabled,
  parseCompetitors,
  competitorQueryTerms,
  detectSwitchingDirection,
  matchCompetitors,
  tagCompetitorItems,
} from '../../lib/competitors.mjs';

const SAMPLE_CONFIG = `# scout-config: Azure Cosmos DB

## Competitors

Closest Azure Cosmos DB competitors — tracked for content volume, sentiment, switching signals, and product announcements. Aliases help match mentions across sources.

- **Amazon DynamoDB** — AWS fully-managed serverless NoSQL (key-value + document); the most directly compared alternative. Aliases: DynamoDB, DDB, Dynamo.
- **MongoDB Atlas** — managed document database; overlaps Cosmos DB's MongoDB API (RU + vCore). Aliases: MongoDB, Atlas, Mongo, MongoDB Atlas.
- **DataStax Astra DB (Apache Cassandra)** — managed Cassandra wide-column NoSQL; overlaps Cosmos DB's Cassandra API. Aliases: Cassandra, Apache Cassandra, Astra, Astra DB, DataStax.
- **ScyllaDB** — high-performance Cassandra-compatible NoSQL. Aliases: ScyllaDB, Scylla.

_Adjacent (watch, not primary): Redis / Azure Managed Redis, PlanetScale, Fauna, Aerospike, TiDB._

## Conferences & Events
`;

test('parseCompetitors extracts bold names + aliases and skips prose/adjacent lines', () => {
  const competitors = parseCompetitors(SAMPLE_CONFIG);
  assert.equal(competitors.length, 4);
  const dynamo = competitors[0];
  assert.equal(dynamo.name, 'Amazon DynamoDB');
  // Name is always part of its own alias set, plus the parsed aliases.
  assert.ok(dynamo.aliases.includes('Amazon DynamoDB'));
  assert.ok(dynamo.aliases.includes('DynamoDB'));
  assert.ok(dynamo.aliases.includes('DDB'));
  // The "_Adjacent…_" italic line is not a competitor.
  assert.ok(!competitors.some((c) => /Redis|PlanetScale|Aerospike/.test(c.name)));
});

test('parseCompetitors keeps the parenthetical name but also matches the stripped form', () => {
  const competitors = parseCompetitors(SAMPLE_CONFIG);
  const astra = competitors.find((c) => /Astra/.test(c.name));
  assert.equal(astra.name, 'DataStax Astra DB (Apache Cassandra)');
  assert.ok(astra.aliases.includes('DataStax Astra DB')); // parenthetical stripped
  assert.ok(astra.aliases.includes('Cassandra'));
});

test('parseCompetitors returns [] for "None tracked" and a missing section', () => {
  assert.deepEqual(parseCompetitors('## Competitors\n_None tracked. Add to enable._\n'), []);
  assert.deepEqual(parseCompetitors('# config\n\n## Topics\n- foo\n'), []);
});

test('competitor tracking requires an explicit on toggle', () => {
  assert.equal(competitorTrackingEnabled('- **Competitor tracking:** on'), true);
  assert.equal(competitorTrackingEnabled('- **Competitor tracking:** off'), false);
  assert.equal(competitorTrackingEnabled(SAMPLE_CONFIG), false);
});

test('competitorQueryTerms prefers distinctive names first and caps the list', () => {
  const competitors = parseCompetitors(SAMPLE_CONFIG);
  const terms = competitorQueryTerms(competitors, { max: 4 });
  assert.deepEqual(terms, ['Amazon DynamoDB', 'MongoDB Atlas', 'DataStax Astra DB', 'ScyllaDB']);
  // De-dupes case-insensitively across names + aliases.
  const all = competitorQueryTerms(competitors, { max: 100 });
  const lower = all.map((t) => t.toLowerCase());
  assert.equal(new Set(lower).size, lower.length);
});

test('matchCompetitors word-boundary matches and avoids substring false positives', () => {
  const competitors = parseCompetitors(SAMPLE_CONFIG);
  assert.deepEqual(matchCompetitors('We migrated from DynamoDB to Cosmos DB', competitors), ['Amazon DynamoDB']);
  // "Atlas" alias should NOT fire inside "Atlassian".
  assert.deepEqual(matchCompetitors('We use Atlassian Jira', competitors), []);
  // Multi-word alias + multiple competitors in one string.
  const hits = matchCompetitors('Comparing MongoDB Atlas vs ScyllaDB for scale', competitors);
  assert.ok(hits.includes('MongoDB Atlas'));
  assert.ok(hits.includes('ScyllaDB'));
});

test('tagCompetitorItems tags matches and drops items mentioning no competitor', () => {
  const competitors = parseCompetitors(SAMPLE_CONFIG);
  const items = [
    { title: 'Why we left DynamoDB', url: 'https://example.com/a' },
    { title: 'A post about Postgres tuning', url: 'https://example.com/b' },
    { title: 'ScyllaDB 2026.2 released', text: 'adds DynamoDB Streams', url: 'https://example.com/c' },
  ];
  const tagged = tagCompetitorItems(items, competitors);
  assert.equal(tagged.length, 2);
  assert.equal(tagged[0].competitor, 'Amazon DynamoDB');
  // Item c mentions both ScyllaDB (title) and DynamoDB (text).
  const c = tagged.find((t) => /2026\.2/.test(t.title));
  assert.ok(c.competitorMatches.includes('ScyllaDB'));
  assert.ok(c.competitorMatches.includes('Amazon DynamoDB'));
});

test('analyzeCompetitorSources deduplicates canonical URLs before classification', () => {
  const competitors = parseCompetitors(SAMPLE_CONFIG);
  let classifications = 0;
  const result = analyzeCompetitorSources([
    {
      source: 'x',
      items: [{ text: 'DynamoDB is great', url: 'https://twitter.com/user/status/1?utm_source=test' }],
    },
    {
      source: 'reddit',
      items: [{ text: 'DDB is great', url: 'https://x.com/user/status/1' }],
    },
  ], competitors, {
    classify: () => {
      classifications += 1;
      return { sentiment: 'positive', confidence: 'high' };
    },
  });

  assert.equal(result.items.length, 1);
  assert.equal(classifications, 1);
  assert.equal(result.aggregates.byCompetitor['Amazon DynamoDB'].mentions, 1);
});

test('competitor sentiment is isolated from primary-product sentiment', () => {
  const competitors = parseCompetitors(SAMPLE_CONFIG);
  const result = analyzeCompetitorSources([{
    source: 'reddit',
    items: [{
      title: 'Cosmos DB is awful. DynamoDB is great.',
      url: 'https://reddit.com/r/databases/comments/1/example',
    }],
  }], competitors, { primaryProduct: 'Cosmos DB' });

  const item = result.items[0];
  assert.equal(item.competitorSentiment, 'positive');
  assert.equal(item.competitorSentimentConfidence, 'high');
  assert.equal(item.switchingDirection, 'none');
});

test('switching direction stays separate from competitor sentiment', () => {
  const competitors = parseCompetitors(SAMPLE_CONFIG);
  assert.equal(
    detectSwitchingDirection('We migrated from DynamoDB to Cosmos DB.', 'Cosmos DB', competitors),
    'competitor_to_primary',
  );
  assert.equal(
    detectSwitchingDirection('We switched from Cosmos DB to MongoDB Atlas.', 'Cosmos DB', competitors),
    'primary_to_competitor',
  );

  const result = analyzeCompetitorSources([{
    source: 'x',
    items: [{
      text: 'We moved from DynamoDB to MongoDB Atlas.',
      url: 'https://x.com/user/status/2',
      post_date: '2026-07-20T12:00:00Z',
    }],
  }], competitors, { primaryProduct: 'Cosmos DB' });
  assert.equal(result.items[0].switchingDirection, 'competitor_to_competitor');
  assert.equal(result.items[0].competitorSentiment, 'neutral');
  assert.equal(result.items[0].timestamp, '2026-07-20T12:00:00Z');
});

test('partial competitor-source failure preserves successful results and aggregates', () => {
  const competitors = parseCompetitors(SAMPLE_CONFIG);
  const result = analyzeCompetitorSources([
    { source: 'reddit', error: new Error('rate limited') },
    {
      source: 'x',
      items: [{ text: 'ScyllaDB is fast', url: 'https://x.com/user/status/3' }],
    },
  ], competitors);

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.sourceFailures, [{ source: 'reddit', error: 'rate limited' }]);
  assert.equal(result.aggregates.bySource.x.mentions, 1);
  assert.equal(result.aggregates.byCompetitor.ScyllaDB.sentiments.positive, 1);
});
