// SEO rewriter: turns the deterministic in-browser SEO snapshot into the
// LLM-judgment rewrites (new <title>, meta description, alternative H1s,
// opening paragraph, JSON-LD) inside the same web UI audit. Same provider
// model as the sentiment reviewer, so by default it reuses the CLI agent
// runner you already configured for /scout-scan: no extra install, no separate
// chat, no extra keys.
//
// Provider is selected via env:
//   SEO_REWRITE_PROVIDER=agent|ollama|openai|custom|none   (default: agent)
//
// `agent` (default) reuses the CLI agent runner (Claude Code, Copilot CLI,
// Codex, Gemini CLI, etc.). The caller passes the resolved runner string in
// opts.runner. If no runner is configured the call degrades to a friendly
// "rewrites unavailable" note and the deterministic audit stays intact.
//
// `ollama` / `openai` / `custom` are direct-HTTP paths for a separate model:
//   OLLAMA_HOST=http://localhost:11434           (shared with vision/sentiment)
//   OLLAMA_SEO_MODEL=llama3.1:8b                  (text-only default)
//   OPENAI_API_KEY=sk-...                         (shared)
//   OPENAI_SEO_MODEL=gpt-4o-mini                  (default)
//   CUSTOM_SEO_BASE_URL=...                       (chat/completions appended)
//   CUSTOM_SEO_API_KEY=...
//   CUSTOM_SEO_MODEL=...
//   CUSTOM_SEO_AUTH_STYLE=bearer|api-key          (default bearer; Azure uses api-key)
//
// generateSeoRewrites is called on demand by /api/analytics/seo. An
// unreachable provider returns a structured { error } the SEO renderer turns
// into a one-line note while keeping the deterministic audit above it.

import { spawn } from 'node:child_process';

// Default per-call timeout for spawned agent CLIs. Mirrors the sentiment
// reviewer: the agent has to boot, load its system prompt, hit the model, and
// print one JSON object. Override with SEO_REWRITE_AGENT_TIMEOUT_MS in .env.
const DEFAULT_AGENT_TIMEOUT_MS = 180_000;

function resolveAgentTimeoutMs(env = process.env) {
  const raw = Number(env.SEO_REWRITE_AGENT_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 5_000 && raw <= 30 * 60_000) return raw;
  return DEFAULT_AGENT_TIMEOUT_MS;
}

// Human-readable label for a configured agent runner. The binary name
// (claude, copilot, codex, gemini, cursor-agent) is what the user thinks of
// as their agent. Handles quoted Windows paths with spaces.
function agentLabel(runner) {
  if (!runner) return '';
  const trimmed = String(runner).trim();
  const quoted = trimmed.match(/^"([^"]+)"/) || trimmed.match(/^'([^']+)'/);
  const first = quoted ? quoted[1] : (trimmed.split(/\s+/)[0] || '');
  const base = first.replace(/^.*[\\/]/, '');
  return base.replace(/\.(exe|cmd|bat)$/i, '');
}

function clampStr(s, n) {
  return String(s == null ? '' : s).slice(0, n);
}

function buildPrompt({ url, snapshot, excerpt, productName, keywords, audience, goal }) {
  const s = snapshot || {};
  const h1 = Array.isArray(s.h1) ? s.h1 : [];
  const h2 = Array.isArray(s.h2) ? s.h2 : [];
  const jsonLdTypes = Array.isArray(s.jsonLdTypes) ? s.jsonLdTypes : [];
  const out = [];
  out.push(`You are a senior technical + content SEO editor. Rewrite the key on-page SEO elements for the page below. Answer only from the data provided; do not use tools or fetch the page.`);
  out.push('');
  out.push(`URL: ${url || 'unknown'}`);
  if (productName) out.push(`Product context: ${productName}`);
  if (keywords) out.push(`Target keyword(s): ${clampStr(keywords, 200)}`);
  if (audience) out.push(`Audience: ${clampStr(audience, 200)}`);
  out.push(`Goal: ${clampStr(goal, 200) || 'organic discoverability + LLM/AI answer-engine surfacing'}`);
  out.push('');
  out.push(`Current title (${s.titleLength || 0} chars): "${clampStr(s.title, 300) || '(missing)'}"`);
  out.push(`Current meta description (${s.descriptionLength || 0} chars): "${clampStr(s.description, 400) || '(missing)'}"`);
  out.push(`Current H1(s): ${h1.length ? h1.map((h) => `"${clampStr(h, 200)}"`).join(' | ') : '(none)'}`);
  out.push(`H2 outline: ${h2.length ? h2.slice(0, 12).map((h) => clampStr(h, 120)).join(' | ') : '(none)'}`);
  out.push(`Existing JSON-LD types: ${jsonLdTypes.length ? jsonLdTypes.join(', ') : '(none)'}`);
  out.push(`Word count: ${s.wordCount || 0}`);
  out.push('');
  out.push(`Page text excerpt (verbatim, may be truncated):`);
  out.push(`"""`);
  out.push(clampStr(excerpt, 1500));
  out.push(`"""`);
  out.push('');
  out.push(`Produce improved, copy-pasteable rewrites. Rules:`);
  out.push(`- title: 30-60 characters, includes the primary keyword, compelling for CTR.`);
  out.push(`- metaDescription: 120-160 characters, action-oriented, includes the keyword naturally.`);
  out.push(`- h1s: exactly 3 distinct alternative H1 options.`);
  out.push(`- openingParagraph: <= 80 words, leads with a one-sentence definition or direct answer, no fluff.`);
  out.push(`- jsonLd: one valid schema.org JSON-LD object suited to the page (Article/BlogPosting; add FAQ fields only if the page truly has Q&A). Use real values from the page; omit author/date/URL fields you cannot see rather than inventing them.`);
  out.push(`- Do not keyword-stuff. Do not fabricate metrics, ratings, or reviews.`);
  out.push('');
  out.push(`Respond with JSON only, no commentary:`);
  out.push(`{`);
  out.push(`  "title": "...",`);
  out.push(`  "metaDescription": "...",`);
  out.push(`  "h1s": ["...", "...", "..."],`);
  out.push(`  "openingParagraph": "...",`);
  out.push(`  "jsonLd": { "@context": "https://schema.org" }`);
  out.push(`}`);
  return out.join('\n');
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

function normalizeRewrites(parsed) {
  const out = { title: '', metaDescription: '', h1s: [], openingParagraph: '', jsonLd: null };
  if (!parsed || typeof parsed !== 'object') return out;
  out.title = clampStr(parsed.title, 200).trim();
  out.metaDescription = clampStr(
    parsed.metaDescription ?? parsed.meta_description ?? parsed.description,
    400,
  ).trim();
  let h1s = parsed.h1s ?? parsed.h1 ?? parsed.alternativeH1s ?? [];
  if (typeof h1s === 'string') h1s = [h1s];
  if (Array.isArray(h1s)) {
    out.h1s = h1s.map((h) => clampStr(h, 200).trim()).filter(Boolean).slice(0, 5);
  }
  out.openingParagraph = clampStr(
    parsed.openingParagraph ?? parsed.opening_paragraph ?? parsed.opening,
    1200,
  ).trim();
  const jl = parsed.jsonLd ?? parsed.json_ld ?? parsed.jsonld ?? null;
  if (jl && typeof jl === 'object') {
    out.jsonLd = jl;
  } else if (typeof jl === 'string' && jl.trim()) {
    try { out.jsonLd = JSON.parse(jl); } catch { out.jsonLd = jl.trim(); }
  }
  return out;
}

export function hasAnyRewrite(rw) {
  if (!rw || typeof rw !== 'object') return false;
  return Boolean(
    rw.title ||
    rw.metaDescription ||
    (Array.isArray(rw.h1s) && rw.h1s.length) ||
    rw.openingParagraph ||
    rw.jsonLd,
  );
}

export function getSeoRewriteProvider(env = process.env) {
  const provider = String(env.SEO_REWRITE_PROVIDER || '').toLowerCase().trim();
  if (provider === 'agent') return 'agent';
  if (provider === 'ollama') return 'ollama';
  if (provider === 'openai') return 'openai';
  if (provider === 'custom' || provider === 'openai-compatible') return 'custom';
  if (provider === 'none') return 'none';
  // Default: reuse the CLI agent runner already configured for /scout-scan,
  // so rewrites work inline with zero extra setup. If no runner is configured
  // the call degrades to a friendly note.
  return 'agent';
}

export async function generateSeoRewrites(input, env = process.env, opts = {}) {
  const snapshot = input?.snapshot || null;
  if (!snapshot || (!snapshot.title && !snapshot.description && !input?.excerpt)) {
    return {
      provider: getSeoRewriteProvider(env),
      error: 'Not enough page content to rewrite (no title, description, or body text).',
    };
  }
  const provider = getSeoRewriteProvider(env);
  if (provider === 'none') {
    return {
      provider: 'none',
      error: 'No SEO rewrite provider configured. Set SEO_REWRITE_PROVIDER=agent|ollama|openai|custom in .env.',
    };
  }
  const payload = {
    url: String(input?.url || ''),
    snapshot,
    excerpt: String(input?.excerpt || ''),
    productName: String(input?.productName || ''),
    keywords: String(input?.keywords || ''),
    audience: String(input?.audience || ''),
    goal: String(input?.goal || ''),
  };
  const prompt = buildPrompt(payload);
  if (provider === 'agent') return generateWithAgent(prompt, env, opts);
  if (provider === 'ollama') return generateWithOllama(prompt, env);
  if (provider === 'openai') return generateWithOpenAI(prompt, env);
  if (provider === 'custom') return generateWithCustom(prompt, env);
  return { provider, error: `Unknown SEO rewrite provider: ${provider}` };
}

// Strip the `-p "{prompt}"` / `exec "{prompt}"` placeholder so we can pipe the
// prompt over stdin — avoids OS command-line length / shell-escaping issues
// with long page excerpts. Mirrors the sentiment reviewer + server runner.
function stripPromptPlaceholder(runner) {
  return String(runner)
    .replace(/\s*(?:-p|--prompt|exec)\s+["']?\{prompt\}["']?/, '')
    .replace(/\s*["']?\{prompt\}["']?/, '')
    .trim();
}

async function generateWithAgent(prompt, env, opts) {
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
    return { provider: 'agent', model: label, error: `Failed to launch agent (${label || 'runner'}): ${spawnError.message}` };
  }
  if (timedOut) {
    return {
      provider: 'agent',
      model: label,
      error: `Agent (${label || 'runner'}) timed out after ${Math.round(timeoutMs / 1000)}s. Raise SEO_REWRITE_AGENT_TIMEOUT_MS in .env (current: ${timeoutMs}), pick a faster model, or set SEO_REWRITE_PROVIDER=ollama for a direct local LLM.`,
    };
  }
  const parsed = tryParseJson(stdout);
  if (!parsed) {
    const tail = (stderr || stdout).trim().slice(-400);
    return { provider: 'agent', model: label, error: `Agent (${label || 'runner'}) did not return parseable JSON. Last output: ${tail || '(empty)'}` };
  }
  return { provider: 'agent', model: label, raw: stdout.slice(0, 4000), ...normalizeRewrites(parsed) };
}

async function generateWithOllama(prompt, env) {
  const host = (env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
  const model = env.OLLAMA_SEO_MODEL || 'llama3.1:8b';
  const url = `${host}/api/generate`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, format: 'json', options: { temperature: 0.2 } }),
    });
  } catch (err) {
    return { provider: 'ollama', model, error: `Ollama unreachable at ${host}: ${err.message}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { provider: 'ollama', model, error: `Ollama ${res.status}: ${body.slice(0, 400)}` };
  }
  const data = await res.json();
  return { provider: 'ollama', model, host, raw: data.response, ...normalizeRewrites(tryParseJson(data.response)) };
}

async function generateWithOpenAI(prompt, env) {
  const key = env.OPENAI_API_KEY;
  if (!key) return { provider: 'openai', error: 'OPENAI_API_KEY not set in .env' };
  const model = env.OPENAI_SEO_MODEL || 'gpt-4o-mini';
  const url = 'https://api.openai.com/v1/chat/completions';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 900,
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
  return { provider: 'openai', model, raw: text, ...normalizeRewrites(tryParseJson(text)) };
}

async function generateWithCustom(prompt, env) {
  const baseUrl = (env.CUSTOM_SEO_BASE_URL || '').replace(/\/+$/, '');
  const key = env.CUSTOM_SEO_API_KEY;
  const model = env.CUSTOM_SEO_MODEL;
  const authStyle = String(env.CUSTOM_SEO_AUTH_STYLE || 'bearer').toLowerCase();
  if (!baseUrl) return { provider: 'custom', error: 'CUSTOM_SEO_BASE_URL not set in .env' };
  if (!key) return { provider: 'custom', error: 'CUSTOM_SEO_API_KEY not set in .env' };
  if (!model) return { provider: 'custom', error: 'CUSTOM_SEO_MODEL not set in .env' };
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
        temperature: 0.2,
        max_tokens: 900,
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
  return { provider: 'custom', model, raw: text, ...normalizeRewrites(tryParseJson(text)) };
}

export async function probeSeoRewrite(env = process.env, opts = {}) {
  const provider = getSeoRewriteProvider(env);
  if (provider === 'none') {
    return { provider: 'none', ok: false, message: 'No SEO rewrite provider configured' };
  }
  if (provider === 'agent') {
    const runner = opts && typeof opts.runner === 'string' ? opts.runner.trim() : '';
    const label = agentLabel(runner);
    if (!runner) {
      return { provider: 'agent', ok: false, message: 'No agent runner configured — pick one on the Setup view.' };
    }
    return { provider: 'agent', ok: true, model: label, message: `Reuses your agent runner: ${label}` };
  }
  if (provider === 'ollama') {
    const host = (env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
    const model = env.OLLAMA_SEO_MODEL || 'llama3.1:8b';
    try {
      const res = await fetch(`${host}/api/tags`);
      if (!res.ok) return { provider, ok: false, message: `Ollama at ${host} returned ${res.status}` };
      const data = await res.json();
      const names = (data.models || []).map((m) => m.name);
      const hasModel = names.some((n) => n === model || n.startsWith(`${model}:`));
      return {
        provider, ok: true, model, host, modelInstalled: hasModel,
        message: hasModel
          ? `Ollama ready: ${model} at ${host}`
          : `Ollama running at ${host} but ${model} not installed. Run: ollama pull ${model}`,
      };
    } catch (err) {
      return { provider, ok: false, message: `Ollama unreachable: ${err.message}` };
    }
  }
  if (provider === 'openai') {
    const key = env.OPENAI_API_KEY;
    return {
      provider, ok: !!key,
      model: env.OPENAI_SEO_MODEL || 'gpt-4o-mini',
      message: key ? 'OpenAI key present' : 'OPENAI_API_KEY missing in .env',
    };
  }
  if (provider === 'custom') {
    const baseUrl = (env.CUSTOM_SEO_BASE_URL || '').replace(/\/+$/, '');
    const key = env.CUSTOM_SEO_API_KEY;
    const model = env.CUSTOM_SEO_MODEL;
    const missing = [];
    if (!baseUrl) missing.push('CUSTOM_SEO_BASE_URL');
    if (!key) missing.push('CUSTOM_SEO_API_KEY');
    if (!model) missing.push('CUSTOM_SEO_MODEL');
    if (missing.length) return { provider, ok: false, model, message: `missing: ${missing.join(', ')}` };
    return { provider, ok: true, model, baseUrl, message: `Custom endpoint configured: ${model} at ${baseUrl}` };
  }
  return { provider, ok: false, message: 'unknown provider' };
}

// Exposed for unit tests.
export const __test = {
  buildPrompt,
  tryParseJson,
  normalizeRewrites,
  agentLabel,
  stripPromptPlaceholder,
  clampStr,
};
