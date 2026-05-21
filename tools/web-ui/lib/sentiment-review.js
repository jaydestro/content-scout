// Sentiment reviewer — second opinion from the configured agent LLM.
//
// The Conversations triage inbox lets a human ask "what would my agent LLM
// call this row?" for any conversation. The reviewer returns a structured
// verdict the UI renders inline alongside the original classification, so
// the user can see when the two disagree and decide whether to keep, flip,
// or close the row.
//
// Provider is selected via env:
//   SENTIMENT_PROVIDER=agent|ollama|openai|custom|none   (default: agent)
//
// `agent` (default) reuses the CLI agent runner you already configured for
// /scout-scan (Claude Code, Copilot CLI, Codex, Gemini CLI, etc.) — the
// caller passes the resolved runner string in opts.runner. This means no
// extra local-LLM install is required: if /scout-scan works, sentiment
// review works.
//
// `ollama` / `openai` / `custom` keep the original direct-HTTP fallback
// paths for users who want to point at a separate model:
//   OLLAMA_HOST=http://localhost:11434              (shared with vision)
//   OLLAMA_SENTIMENT_MODEL=llama3.1:8b              (text-only default)
//   OPENAI_API_KEY=sk-...                           (shared with vision)
//   OPENAI_SENTIMENT_MODEL=gpt-4o-mini              (default)
//   CUSTOM_SENTIMENT_BASE_URL=...
//   CUSTOM_SENTIMENT_API_KEY=...
//   CUSTOM_SENTIMENT_MODEL=...
//   CUSTOM_SENTIMENT_AUTH_STYLE=bearer|api-key      (default bearer)
//
// The UI calls /api/sentiment/review on demand — there is no background
// batch worker, so an unreachable provider just degrades to a friendly
// "not configured" message and the original classification stays untouched.

import { spawn } from 'node:child_process';

const SENTIMENT_VALUES = new Set([
  'positive',
  'neutral',
  'negative',
  'mixed',
  'unknown',
]);
const CONFIDENCE_VALUES = new Set(['high', 'medium', 'low']);

// Default per-call timeout for spawned agent CLIs. The agent has to boot,
// load its system prompt, hit the model, and print a single JSON object.
// 180s covers Copilot CLI / Claude Code cold starts on slower machines
// without changing snappy-path behavior. Override with
// SENTIMENT_AGENT_TIMEOUT_MS (milliseconds) in .env if your runner is
// consistently slower.
const DEFAULT_AGENT_TIMEOUT_MS = 180_000;

function resolveAgentTimeoutMs(env = process.env) {
  const raw = Number(env.SENTIMENT_AGENT_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 5_000 && raw <= 30 * 60_000) return raw;
  return DEFAULT_AGENT_TIMEOUT_MS;
}

// Parse the human-readable label for a configured agent runner. The binary
// name (claude, copilot, codex, gemini, cursor-agent) is what the user
// thinks of as their agent. Handles quoted Windows paths with spaces.
function agentLabel(runner) {
  if (!runner) return '';
  const trimmed = String(runner).trim();
  const quoted = trimmed.match(/^"([^"]+)"/) || trimmed.match(/^'([^']+)'/);
  const first = quoted ? quoted[1] : (trimmed.split(/\s+/)[0] || '');
  const base = first.replace(/^.*[\\/]/, '');
  return base.replace(/\.(exe|cmd|bat)$/i, '');
}

function buildPrompt({ productName, summary, author, platform, currentSentiment, userNote }) {
  const product = productName || 'the product';
  const cur = currentSentiment && SENTIMENT_VALUES.has(currentSentiment)
    ? currentSentiment
    : 'unknown';
  const note = String(userNote || '').trim().slice(0, 500);
  const noteBlock = note
    ? [
        ``,
        `Reviewer note (context the human added when requesting this re-check —`,
        `treat as a HINT to consider, not as ground truth; the post text above is`,
        `still authoritative):`,
        `"""`,
        note,
        `"""`,
      ]
    : [];
  return [
    `You are a sentiment classifier reviewing a social post about a specific product.`,
    ``,
    `Product: ${product}`,
    `Platform: ${platform || 'unknown'}`,
    `Author: ${author || 'unknown'}`,
    `Current classification: ${cur}`,
    ``,
    `Post text (verbatim):`,
    `"""`,
    String(summary || '').slice(0, 4000),
    `"""`,
    ...noteBlock,
    ``,
    `Classify the AUTHOR'S STANCE TOWARD ${product}. Use exactly one of:`,
    `- positive: praise, success story, recommendation, "this worked great",`,
    `  OR the author is migrating FROM a competitor TO ${product},`,
    `  OR the author published a tutorial, how-to, talk, demo, book, or course`,
    `  teaching ${product} (educational content about a product is implicit advocacy`,
    `  by the author — they chose to invest time teaching it).`,
    `- neutral: question, how-to, informational, announcement, comparison`,
    `  without a verdict, retweet without commentary.`,
    `- negative: complaint, frustration, bug report about ${product},`,
    `  OR the author is migrating FROM ${product} TO a competitor.`,
    `- mixed: ONLY when the post contains BOTH an explicit positive claim AND`,
    `  an explicit reservation about ${product} in the same item (a real`,
    `  trade-off statement). Do NOT use mixed for tutorials that include a`,
    `  "common pitfalls" or "gotchas" section — that is teaching, not critique.`,
    `- unknown: not enough context, or the post is not really about ${product}.`,
    ``,
    `Common misclassification traps — DO NOT trigger on these:`,
    `- Negation phrases in body text ("are not", "is not", "do not", "n't",`,
    `  "no longer", "without") are stance signals ONLY when they negate an`,
    `  evaluative sentence whose subject is ${product}. Feature descriptions`,
    `  ("documents are not limited to X", "you do not need to provision Y")`,
    `  and rhetorical titles ("Your Entities Are Not Your Domain Objects",`,
    `  "The Hidden Tax of X") are framing devices, not critique.`,
    `- Provocative or motivational titles in tutorials ("The Mistake That`,
    `  Crashes Every Database", "Why X Is Broken") are rhetorical hooks`,
    `  setting up a teaching moment about ${product}. Read the body before`,
    `  scoring; if the body teaches ${product}, the stance is positive/neutral.`,
    `- Difficulty or learning-curve mentions in tutorials are not negative`,
    `  toward ${product} — they are why the tutorial exists.`,
    ``,
    `Directional rule (critical): "migrate from", "switch from", "moved from"`,
    `are ambiguous on their own. If ${product} is the DESTINATION, classify`,
    `positive. If ${product} is the SOURCE being abandoned, classify negative.`,
    `If migration is between two competitors without ${product} involvement,`,
    `classify unknown.`,
    ``,
    `Respond with JSON only, no commentary:`,
    `{`,
    `  "sentiment": "positive|neutral|negative|mixed|unknown",`,
    `  "confidence": "high|medium|low",`,
    `  "rationale": "one short sentence explaining your choice"`,
    `}`,
  ].join('\n');
}

function tryParseJson(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}

function normalizeVerdict(parsed) {
  const out = { sentiment: 'unknown', confidence: 'low', rationale: '' };
  if (!parsed || typeof parsed !== 'object') return out;
  const s = String(parsed.sentiment || '').toLowerCase().trim();
  if (SENTIMENT_VALUES.has(s)) out.sentiment = s;
  const c = String(parsed.confidence || '').toLowerCase().trim();
  if (CONFIDENCE_VALUES.has(c)) out.confidence = c;
  out.rationale = String(parsed.rationale || '').trim().slice(0, 400);
  return out;
}

export function getSentimentProvider(env = process.env) {
  const provider = String(env.SENTIMENT_PROVIDER || '').toLowerCase().trim();
  if (provider === 'agent') return 'agent';
  if (provider === 'ollama') return 'ollama';
  if (provider === 'openai') return 'openai';
  if (provider === 'custom' || provider === 'openai-compatible') return 'custom';
  if (provider === 'none') return 'none';
  // Default: reuse the CLI agent runner the user already configured for
  // /scout-scan. This is what "the LLM in the actual agent" means — no
  // extra install, no extra keys. If no runner is configured, the probe
  // surfaces a friendly "pick an agent on Setup" message.
  return 'agent';
}

export async function reviewSentiment(input, env = process.env, opts = {}) {
  const payload = {
    summary: String(input?.summary || ''),
    author: String(input?.author || ''),
    platform: String(input?.platform || ''),
    productName: String(input?.productName || ''),
    currentSentiment: String(input?.currentSentiment || 'unknown'),
    userNote: String(input?.userNote || '').slice(0, 500),
  };
  if (!payload.summary.trim()) {
    return {
      provider: getSentimentProvider(env),
      error: 'Cannot review an empty post — summary is required.',
    };
  }
  const provider = getSentimentProvider(env);
  if (provider === 'none') {
    return {
      provider: 'none',
      error: 'No sentiment provider configured. Set SENTIMENT_PROVIDER=agent|ollama|openai|custom in .env.',
    };
  }
  const prompt = buildPrompt(payload);
  if (provider === 'agent') return reviewWithAgent(prompt, payload, env, opts);
  if (provider === 'ollama') return reviewWithOllama(prompt, payload, env);
  if (provider === 'openai') return reviewWithOpenAI(prompt, payload, env);
  if (provider === 'custom') return reviewWithCustom(prompt, payload, env);
  return {
    provider,
    error: `Unknown sentiment provider: ${provider}`,
  };
}

// Spawn the configured agent CLI (claude, copilot, codex, gemini, ...) as
// a one-shot child process, pipe the prompt via stdin, and parse a single
// JSON object out of stdout.
//
// We always strip the `-p "{prompt}"` / `exec "{prompt}"` placeholder and
// use stdin — this mirrors the long-prompt fallback in server.js's
// startRunInternal and avoids OS command-line length / shell-escaping
// surprises with the post text. The runner is invoked with `shell: true`
// so users can keep things like `copilot --allow-all-tools ... -p` flags
// they configured for /scout-scan.
function stripPromptPlaceholder(runner) {
  return String(runner)
    .replace(/\s*(?:-p|--prompt|exec)\s+["']?\{prompt\}["']?/, '')
    .replace(/\s*["']?\{prompt\}["']?/, '')
    .trim();
}

async function reviewWithAgent(prompt, payload, env, opts) {
  const runner = opts && typeof opts.runner === 'string' ? opts.runner.trim() : '';
  if (!runner) {
    return {
      provider: 'agent',
      error: 'No agent runner configured. Pick one on the Setup view (Claude Code, Copilot CLI, Codex, …) or set SCOUT_RUNNER in .env.',
    };
  }
  const command = stripPromptPlaceholder(runner) || runner;
  const cwd = (opts && opts.cwd) || process.cwd();
  const label = agentLabel(runner);
  const timeoutMs = (opts && Number(opts.timeoutMs)) || resolveAgentTimeoutMs(env);

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let spawnError = null;
  const child = spawn(command, {
    shell: true,
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const done = new Promise((resolve) => {
    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2_000).unref();
    }, timeoutMs);
    if (typeof killer.unref === 'function') killer.unref();
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { spawnError = err; clearTimeout(killer); resolve(); });
    child.on('close', () => { clearTimeout(killer); resolve(); });
  });
  try {
    child.stdin.write(prompt);
    child.stdin.write('\n');
    child.stdin.end();
  } catch (err) {
    spawnError = err;
  }
  await done;

  if (spawnError) {
    return {
      provider: 'agent',
      model: label,
      error: `Failed to launch agent (${label || 'runner'}): ${spawnError.message}`,
    };
  }
  if (timedOut) {
    return {
      provider: 'agent',
      model: label,
      error: `Agent (${label || 'runner'}) timed out after ${Math.round(timeoutMs / 1000)}s. Raise SENTIMENT_AGENT_TIMEOUT_MS in .env (current: ${timeoutMs}), pick a faster model, or set SENTIMENT_PROVIDER=ollama for a direct local LLM.`,
    };
  }
  const parsed = tryParseJson(stdout);
  if (!parsed) {
    const tail = (stderr || stdout).trim().slice(-400);
    return {
      provider: 'agent',
      model: label,
      error: `Agent (${label || 'runner'}) did not return parseable JSON. Last output: ${tail || '(empty)'}`,
    };
  }
  const verdict = normalizeVerdict(parsed);
  return {
    provider: 'agent',
    model: label,
    raw: stdout.slice(0, 4000),
    ...verdict,
    agrees: payload.currentSentiment === verdict.sentiment,
  };
}

async function reviewWithOllama(prompt, payload, env) {
  const host = (env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
  const model = env.OLLAMA_SENTIMENT_MODEL || 'llama3.1:8b';
  const url = `${host}/api/generate`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0 },
      }),
    });
  } catch (err) {
    return { provider: 'ollama', model, error: `Ollama unreachable at ${host}: ${err.message}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { provider: 'ollama', model, error: `Ollama ${res.status}: ${body.slice(0, 400)}` };
  }
  const data = await res.json();
  const verdict = normalizeVerdict(tryParseJson(data.response));
  return {
    provider: 'ollama',
    model,
    host,
    raw: data.response,
    ...verdict,
    agrees: payload.currentSentiment === verdict.sentiment,
  };
}

async function reviewWithOpenAI(prompt, payload, env) {
  const key = env.OPENAI_API_KEY;
  if (!key) return { provider: 'openai', error: 'OPENAI_API_KEY not set in .env' };
  const model = env.OPENAI_SENTIMENT_MODEL || 'gpt-4o-mini';
  const url = 'https://api.openai.com/v1/chat/completions';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 300,
      }),
    });
  } catch (err) {
    return { provider: 'openai', model, error: `OpenAI request failed: ${err.message}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { provider: 'openai', model, error: `OpenAI ${res.status}: ${body.slice(0, 400)}` };
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  const verdict = normalizeVerdict(tryParseJson(text));
  return {
    provider: 'openai',
    model,
    raw: text,
    ...verdict,
    agrees: payload.currentSentiment === verdict.sentiment,
  };
}

async function reviewWithCustom(prompt, payload, env) {
  const baseUrl = (env.CUSTOM_SENTIMENT_BASE_URL || '').replace(/\/+$/, '');
  const key = env.CUSTOM_SENTIMENT_API_KEY;
  const model = env.CUSTOM_SENTIMENT_MODEL;
  const authStyle = String(env.CUSTOM_SENTIMENT_AUTH_STYLE || 'bearer').toLowerCase();
  if (!baseUrl) return { provider: 'custom', error: 'CUSTOM_SENTIMENT_BASE_URL not set in .env' };
  if (!key) return { provider: 'custom', error: 'CUSTOM_SENTIMENT_API_KEY not set in .env' };
  if (!model) return { provider: 'custom', error: 'CUSTOM_SENTIMENT_MODEL not set in .env' };
  const url = /\/chat\/completions(\?|$)/.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  if (authStyle === 'api-key') headers['api-key'] = key;
  else headers['authorization'] = `Bearer ${key}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 300,
      }),
    });
  } catch (err) {
    return { provider: 'custom', model, error: `Custom endpoint request failed: ${err.message}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { provider: 'custom', model, error: `Custom endpoint ${res.status}: ${body.slice(0, 400)}` };
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  const verdict = normalizeVerdict(tryParseJson(text));
  return {
    provider: 'custom',
    model,
    raw: text,
    ...verdict,
    agrees: payload.currentSentiment === verdict.sentiment,
  };
}

export async function probeSentiment(env = process.env, opts = {}) {
  const provider = getSentimentProvider(env);
  if (provider === 'none') {
    return { provider: 'none', ok: false, message: 'No sentiment provider configured' };
  }
  if (provider === 'agent') {
    const runner = opts && typeof opts.runner === 'string' ? opts.runner.trim() : '';
    const label = agentLabel(runner);
    if (!runner) {
      return {
        provider: 'agent',
        ok: false,
        message: 'No agent runner configured — pick one on the Setup view.',
      };
    }
    return {
      provider: 'agent',
      ok: true,
      model: label,
      message: `Agent runner ready: ${label}`,
    };
  }
  if (provider === 'ollama') {
    const host = (env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
    const model = env.OLLAMA_SENTIMENT_MODEL || 'llama3.1:8b';
    try {
      const res = await fetch(`${host}/api/tags`);
      if (!res.ok) {
        return { provider, ok: false, host, model, message: `Ollama at ${host} returned ${res.status}` };
      }
      const data = await res.json();
      const names = (data.models || []).map((m) => m.name);
      const hasModel = names.some((n) => n === model || n.startsWith(`${model}:`) || n.startsWith(`${model.split(':')[0]}:`));
      return {
        provider,
        ok: true,
        host,
        model,
        modelInstalled: hasModel,
        availableModels: names.slice(0, 25),
        message: hasModel
          ? `Ollama ready: ${model} at ${host}`
          : `Ollama running at ${host} but ${model} is not pulled. Run: ollama pull ${model}`,
      };
    } catch (err) {
      return { provider, ok: false, host, model, message: `Ollama unreachable: ${err.message}` };
    }
  }
  if (provider === 'openai') {
    const key = env.OPENAI_API_KEY;
    const model = env.OPENAI_SENTIMENT_MODEL || 'gpt-4o-mini';
    return {
      provider,
      ok: !!key,
      model,
      message: key ? `OpenAI key present (model: ${model})` : 'OPENAI_API_KEY missing in .env',
    };
  }
  if (provider === 'custom') {
    const baseUrl = (env.CUSTOM_SENTIMENT_BASE_URL || '').replace(/\/+$/, '');
    const key = env.CUSTOM_SENTIMENT_API_KEY;
    const model = env.CUSTOM_SENTIMENT_MODEL;
    const missing = [];
    if (!baseUrl) missing.push('CUSTOM_SENTIMENT_BASE_URL');
    if (!key) missing.push('CUSTOM_SENTIMENT_API_KEY');
    if (!model) missing.push('CUSTOM_SENTIMENT_MODEL');
    if (missing.length) {
      return { provider, ok: false, model, message: `missing: ${missing.join(', ')}` };
    }
    return {
      provider,
      ok: true,
      model,
      baseUrl,
      message: `Custom endpoint configured: ${model} at ${baseUrl}`,
    };
  }
  return { provider, ok: false, message: 'unknown provider' };
}

// Internal helpers exported for tests.
export const __test = { buildPrompt, tryParseJson, normalizeVerdict, agentLabel, stripPromptPlaceholder };
