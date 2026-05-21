import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __test,
  getSentimentProvider,
  reviewSentiment,
  probeSentiment,
} from '../lib/sentiment-review.js';

const { buildPrompt, tryParseJson, normalizeVerdict, agentLabel, stripPromptPlaceholder } = __test;

// ---- buildPrompt --------------------------------------------------

test('buildPrompt: embeds product name + directional migration rule', () => {
  const p = buildPrompt({
    productName: 'Azure Cosmos DB',
    summary: 'We migrated from MongoDB to Azure Cosmos DB and it works great.',
    author: '@dev',
    platform: 'X',
    currentSentiment: 'neutral',
  });
  assert.match(p, /Azure Cosmos DB/);
  assert.match(p, /Directional rule \(critical\)/);
  assert.match(p, /DESTINATION/);
  assert.match(p, /Current classification: neutral/);
  assert.match(p, /Azure Cosmos DB and it works great/);
});

test('buildPrompt: caps summary length to 4000 chars', () => {
  const long = 'x'.repeat(8000);
  const p = buildPrompt({ productName: 'Foo', summary: long, currentSentiment: 'unknown' });
  // Summary section is truncated at 4000 chars. The full prompt also carries
  // the classification rules, nuance/misclassification guidance, and JSON
  // schema (~2500 chars). Any value under 4000 + 3500 = 7500 confirms the
  // cap fired (a non-capped prompt would be 8000 + 2500+ ≈ 10500).
  assert.ok(p.length < 7500, `prompt length ${p.length} should be < 7500`);
  assert.ok(p.length > 4000, `prompt length ${p.length} should still include the prompt header`);
});

test('buildPrompt: falls back gracefully when fields are missing', () => {
  const p = buildPrompt({});
  assert.match(p, /Product: the product/);
  assert.match(p, /Platform: unknown/);
  assert.match(p, /Current classification: unknown/);
});

test('buildPrompt: rejects unknown current sentiment values', () => {
  const p = buildPrompt({ productName: 'Foo', summary: 'hi', currentSentiment: 'sparkly' });
  assert.match(p, /Current classification: unknown/);
});

// ---- tryParseJson -------------------------------------------------

test('tryParseJson: parses plain JSON', () => {
  const out = tryParseJson('{"sentiment":"positive","confidence":"high"}');
  assert.equal(out.sentiment, 'positive');
});

test('tryParseJson: strips ```json fences', () => {
  const out = tryParseJson('```json\n{"sentiment":"negative"}\n```');
  assert.equal(out.sentiment, 'negative');
});

test('tryParseJson: extracts first JSON-ish block from prose', () => {
  const text = 'Here is my answer: {"sentiment":"mixed","confidence":"low","rationale":"both"} hope that helps';
  const out = tryParseJson(text);
  assert.equal(out.sentiment, 'mixed');
});

test('tryParseJson: returns null on unparseable input', () => {
  assert.equal(tryParseJson(''), null);
  assert.equal(tryParseJson('not json at all'), null);
  assert.equal(tryParseJson(null), null);
});

// ---- normalizeVerdict ---------------------------------------------

test('normalizeVerdict: clamps invalid sentiment to unknown', () => {
  const v = normalizeVerdict({ sentiment: 'sparkly', confidence: 'medium', rationale: 'r' });
  assert.equal(v.sentiment, 'unknown');
  assert.equal(v.confidence, 'medium');
});

test('normalizeVerdict: clamps invalid confidence to low', () => {
  const v = normalizeVerdict({ sentiment: 'positive', confidence: 'very-high', rationale: 'r' });
  assert.equal(v.sentiment, 'positive');
  assert.equal(v.confidence, 'low');
});

test('normalizeVerdict: trims rationale to 400 chars', () => {
  const v = normalizeVerdict({
    sentiment: 'neutral',
    confidence: 'high',
    rationale: 'x'.repeat(800),
  });
  assert.equal(v.rationale.length, 400);
});

test('normalizeVerdict: handles null/undefined input', () => {
  const v = normalizeVerdict(null);
  assert.equal(v.sentiment, 'unknown');
  assert.equal(v.confidence, 'low');
  assert.equal(v.rationale, '');
});

// ---- getSentimentProvider -----------------------------------------

test('getSentimentProvider: defaults to agent when env is empty', () => {
  assert.equal(getSentimentProvider({}), 'agent');
});

test('getSentimentProvider: honors explicit override', () => {
  assert.equal(getSentimentProvider({ SENTIMENT_PROVIDER: 'agent' }), 'agent');
  assert.equal(getSentimentProvider({ SENTIMENT_PROVIDER: 'ollama' }), 'ollama');
  assert.equal(getSentimentProvider({ SENTIMENT_PROVIDER: 'openai' }), 'openai');
  assert.equal(getSentimentProvider({ SENTIMENT_PROVIDER: 'custom' }), 'custom');
  assert.equal(getSentimentProvider({ SENTIMENT_PROVIDER: 'none' }), 'none');
  assert.equal(getSentimentProvider({ SENTIMENT_PROVIDER: 'AGENT' }), 'agent');
});

test('getSentimentProvider: aliases openai-compatible to custom', () => {
  assert.equal(getSentimentProvider({ SENTIMENT_PROVIDER: 'openai-compatible' }), 'custom');
});

// ---- agentLabel / stripPromptPlaceholder --------------------------

test('agentLabel: extracts binary name from runner string', () => {
  assert.equal(agentLabel('claude -p "{prompt}"'), 'claude');
  assert.equal(agentLabel('copilot --allow-all-tools -p "{prompt}"'), 'copilot');
  assert.equal(agentLabel('codex exec "{prompt}"'), 'codex');
  assert.equal(agentLabel('gemini -p "{prompt}"'), 'gemini');
  assert.equal(agentLabel('cursor-agent -p "{prompt}"'), 'cursor-agent');
  assert.equal(agentLabel(''), '');
  assert.equal(agentLabel(undefined), '');
});

test('agentLabel: strips path and .exe suffix on Windows', () => {
  assert.equal(agentLabel('C:\\Users\\me\\claude.exe -p "{prompt}"'), 'claude');
  assert.equal(agentLabel('"C:\\Program Files\\copilot.cmd" -p "{prompt}"'), 'copilot');
});

test('stripPromptPlaceholder: removes -p "{prompt}" variants', () => {
  assert.equal(stripPromptPlaceholder('claude -p "{prompt}"'), 'claude');
  assert.equal(stripPromptPlaceholder('codex exec "{prompt}"'), 'codex');
  assert.equal(
    stripPromptPlaceholder('copilot --allow-all-tools --allow-all-paths -p "{prompt}"'),
    'copilot --allow-all-tools --allow-all-paths'
  );
  // No placeholder — returns trimmed runner unchanged.
  assert.equal(stripPromptPlaceholder('myrunner --flag'), 'myrunner --flag');
});

// ---- reviewSentiment (mock fetch) ---------------------------------

function withMockFetch(fn) {
  const original = globalThis.fetch;
  return async function wrapped(...args) {
    let captured;
    globalThis.fetch = async (url, init) => {
      captured = { url, init };
      return fn(url, init);
    };
    try {
      const result = await args[0](() => captured);
      return result;
    } finally {
      globalThis.fetch = original;
    }
  };
}

test('reviewSentiment: rejects empty summary without calling fetch', async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return new Response('{}'); };
  try {
    const out = await reviewSentiment({ summary: '   ' }, { SENTIMENT_PROVIDER: 'ollama' });
    assert.equal(out.error, 'Cannot review an empty post — summary is required.');
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('reviewSentiment: returns friendly message when provider=none', async () => {
  const out = await reviewSentiment({ summary: 'hi' }, { SENTIMENT_PROVIDER: 'none' });
  assert.equal(out.provider, 'none');
  assert.match(out.error, /No sentiment provider configured/);
});

test('reviewSentiment (agent): no runner surfaces friendly setup hint', async () => {
  const out = await reviewSentiment(
    { summary: 'hi', currentSentiment: 'neutral' },
    { SENTIMENT_PROVIDER: 'agent' },
    {} // no runner
  );
  assert.equal(out.provider, 'agent');
  assert.match(out.error, /No agent runner configured/);
});

test('reviewSentiment (agent): spawns runner, pipes prompt via stdin, parses JSON', async () => {
  // Use the current Node binary as the "agent" — it can read stdin and
  // print whatever we ask. We bake a JSON verdict into a tiny script.
  const script = "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({sentiment:'negative',confidence:'high',rationale:'mocked agent verdict'}))});";
  const runner = `"${process.execPath}" -e "${script.replace(/"/g, '\\"')}" {prompt}`;
  const out = await reviewSentiment(
    { summary: 'something is broken', currentSentiment: 'positive' },
    { SENTIMENT_PROVIDER: 'agent' },
    { runner, timeoutMs: 15_000 },
  );
  assert.equal(out.provider, 'agent');
  assert.equal(out.sentiment, 'negative');
  assert.equal(out.confidence, 'high');
  assert.equal(out.agrees, false);
  assert.match(out.rationale, /mocked agent verdict/);
});

test('reviewSentiment (agent): non-JSON stdout surfaces friendly error', async () => {
  const runner = `"${process.execPath}" -e "process.stdout.write('hello not json')" {prompt}`;
  const out = await reviewSentiment(
    { summary: 'hi', currentSentiment: 'neutral' },
    { SENTIMENT_PROVIDER: 'agent' },
    { runner, timeoutMs: 15_000 },
  );
  assert.equal(out.provider, 'agent');
  assert.match(out.error, /did not return parseable JSON/);
});

test('reviewSentiment (agent): runs that exceed timeoutMs are killed', async () => {
  // Block on stdin so the child sits idle until our timeout fires.
  const runner = `"${process.execPath}" -e "setTimeout(()=>{},60000)" {prompt}`;
  const out = await reviewSentiment(
    { summary: 'hi', currentSentiment: 'neutral' },
    { SENTIMENT_PROVIDER: 'agent' },
    { runner, timeoutMs: 500 },
  );
  assert.equal(out.provider, 'agent');
  assert.match(out.error, /timed out/);
});

test('reviewSentiment (ollama): posts to /api/generate and parses response', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        response: '{"sentiment":"positive","confidence":"high","rationale":"author praises product"}',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  try {
    const out = await reviewSentiment(
      {
        summary: 'Loving Azure Cosmos DB lately',
        author: '@x',
        platform: 'X',
        productName: 'Azure Cosmos DB',
        currentSentiment: 'neutral',
      },
      { SENTIMENT_PROVIDER: 'ollama', OLLAMA_HOST: 'http://localhost:11434' }
    );
    assert.equal(out.provider, 'ollama');
    assert.equal(out.sentiment, 'positive');
    assert.equal(out.confidence, 'high');
    assert.equal(out.agrees, false); // neutral != positive
    assert.equal(out.model, 'llama3.1:8b');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://localhost:11434/api/generate');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, 'llama3.1:8b');
    assert.equal(body.stream, false);
    assert.equal(body.format, 'json');
  } finally {
    globalThis.fetch = original;
  }
});

test('reviewSentiment (ollama): surfaces network errors as friendly message', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const out = await reviewSentiment(
      { summary: 'hi', currentSentiment: 'unknown' },
      { SENTIMENT_PROVIDER: 'ollama' }
    );
    assert.equal(out.provider, 'ollama');
    assert.match(out.error, /Ollama unreachable/);
  } finally {
    globalThis.fetch = original;
  }
});

test('reviewSentiment (openai): missing key surfaces in error', async () => {
  const out = await reviewSentiment(
    { summary: 'hi' },
    { SENTIMENT_PROVIDER: 'openai' }
  );
  assert.equal(out.provider, 'openai');
  assert.match(out.error, /OPENAI_API_KEY/);
});

test('reviewSentiment (custom): validates required env vars', async () => {
  const out = await reviewSentiment(
    { summary: 'hi' },
    { SENTIMENT_PROVIDER: 'custom' }
  );
  assert.equal(out.provider, 'custom');
  assert.match(out.error, /CUSTOM_SENTIMENT_BASE_URL/);
});

test('reviewSentiment: agrees=true when LLM matches current', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        response: '{"sentiment":"negative","confidence":"medium","rationale":"bug report"}',
      }),
      { status: 200 }
    );
  try {
    const out = await reviewSentiment(
      { summary: 'broken', currentSentiment: 'negative' },
      { SENTIMENT_PROVIDER: 'ollama' }
    );
    assert.equal(out.agrees, true);
  } finally {
    globalThis.fetch = original;
  }
});

// ---- probeSentiment ----------------------------------------------

test('probeSentiment: none returns ok=false', async () => {
  const out = await probeSentiment({ SENTIMENT_PROVIDER: 'none' });
  assert.equal(out.ok, false);
  assert.equal(out.provider, 'none');
});

test('probeSentiment (agent): runner present returns ok=true with label', async () => {
  const out = await probeSentiment({}, { runner: 'copilot --allow-all-tools -p "{prompt}"' });
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'agent');
  assert.equal(out.model, 'copilot');
  assert.match(out.message, /Agent runner ready/);
});

test('probeSentiment (agent): no runner returns ok=false with setup hint', async () => {
  const out = await probeSentiment({}, {});
  assert.equal(out.ok, false);
  assert.equal(out.provider, 'agent');
  assert.match(out.message, /pick one on the Setup view/i);
});

test('probeSentiment (ollama): model installed', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ models: [{ name: 'llama3.1:8b' }, { name: 'llava:latest' }] }),
      { status: 200 }
    );
  try {
    const out = await probeSentiment({ SENTIMENT_PROVIDER: 'ollama' });
    assert.equal(out.ok, true);
    assert.equal(out.modelInstalled, true);
    assert.equal(out.provider, 'ollama');
    assert.match(out.message, /Ollama ready/);
  } finally {
    globalThis.fetch = original;
  }
});

test('probeSentiment (ollama): model not pulled', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ models: [{ name: 'mistral:latest' }] }), { status: 200 });
  try {
    const out = await probeSentiment({
      SENTIMENT_PROVIDER: 'ollama',
      OLLAMA_SENTIMENT_MODEL: 'llama3.1:8b',
    });
    assert.equal(out.ok, true);
    assert.equal(out.modelInstalled, false);
    assert.match(out.message, /not pulled/);
  } finally {
    globalThis.fetch = original;
  }
});

test('probeSentiment (ollama): unreachable returns ok=false', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  try {
    const out = await probeSentiment({ SENTIMENT_PROVIDER: 'ollama' });
    assert.equal(out.ok, false);
    assert.match(out.message, /unreachable/);
  } finally {
    globalThis.fetch = original;
  }
});

test('probeSentiment (openai): missing key', async () => {
  const out = await probeSentiment({ SENTIMENT_PROVIDER: 'openai' });
  assert.equal(out.ok, false);
  assert.match(out.message, /missing/i);
});

test('probeSentiment (openai): key present', async () => {
  const out = await probeSentiment({ SENTIMENT_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' });
  assert.equal(out.ok, true);
  assert.match(out.message, /OpenAI key present/);
});

test('probeSentiment (custom): all vars present', async () => {
  const out = await probeSentiment({
    SENTIMENT_PROVIDER: 'custom',
    CUSTOM_SENTIMENT_BASE_URL: 'https://example.com/v1',
    CUSTOM_SENTIMENT_API_KEY: 'k',
    CUSTOM_SENTIMENT_MODEL: 'gpt-x',
  });
  assert.equal(out.ok, true);
  assert.match(out.message, /Custom endpoint configured/);
});
