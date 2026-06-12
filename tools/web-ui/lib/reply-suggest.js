// Reply suggester — turns a flagged "needs reply" conversation into a short
// AI explanation plus a ready-to-use, on-brand reply the user can copy.
//
// Same provider model as the sentiment reviewer and SEO rewriter, so by
// default it reuses the CLI agent runner you already configured for
// /scout-scan: no extra install, no separate chat, no extra keys.
//
// Provider is selected via env:
//   REPLY_SUGGEST_PROVIDER=agent|ollama|openai|custom|none   (default: agent)
//
// `agent` (default) reuses the CLI agent runner (Claude Code, Copilot CLI,
// Codex, Gemini CLI, etc.). The caller passes the resolved runner string in
// opts.runner. If no runner is configured the call degrades to a friendly
// "reply suggestions unavailable" note.
//
// `ollama` / `openai` / `custom` are direct-HTTP paths for a separate model:
//   OLLAMA_HOST=http://localhost:11434            (shared with vision/sentiment)
//   OLLAMA_REPLY_MODEL=llama3.1:8b                 (text-only default)
//   OPENAI_API_KEY=sk-...                          (shared)
//   OPENAI_REPLY_MODEL=gpt-4o-mini                 (default)
//   CUSTOM_REPLY_BASE_URL=...                      (chat/completions appended)
//   CUSTOM_REPLY_API_KEY=...
//   CUSTOM_REPLY_MODEL=...
//   CUSTOM_REPLY_AUTH_STYLE=bearer|api-key         (default bearer; Azure uses api-key)
//
// suggestReply is called on demand by /api/reply/suggest. An unreachable
// provider returns a structured { error } the dashboard turns into a one-line
// note instead of a broken navigation.

import { spawn } from 'node:child_process';

// Default per-call timeout for spawned agent CLIs. Mirrors the sentiment
// reviewer + SEO rewriter. Override with REPLY_SUGGEST_AGENT_TIMEOUT_MS.
const DEFAULT_AGENT_TIMEOUT_MS = 180_000;

function resolveAgentTimeoutMs(env = process.env) {
  const raw = Number(env.REPLY_SUGGEST_AGENT_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 5_000 && raw <= 30 * 60_000) return raw;
  return DEFAULT_AGENT_TIMEOUT_MS;
}

// Human-readable label for a configured agent runner (claude, copilot, codex,
// gemini, cursor-agent). Handles quoted Windows paths with spaces.
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

function buildPrompt({ summary, author, platform, productName, sentiment }) {
  const product = productName || 'the product';
  const tone = sentiment === 'negative'
    ? 'The author is critical or frustrated — acknowledge the issue honestly, do not get defensive.'
    : 'The author is mixed or ambivalent — affirm what they got right and gently fill the gap.';
  return [
    `You are a developer-relations specialist for ${product}. A social post was`,
    `flagged for a response. Help the human decide how to engage.`,
    ``,
    `Platform: ${platform || 'unknown'}`,
    `Author: ${author || 'unknown'}`,
    `Detected stance: ${sentiment || 'mixed'}`,
    `${tone}`,
    ``,
    `Post text (verbatim):`,
    `"""`,
    clampStr(summary, 3000),
    `"""`,
    ``,
    `Produce a short, practical engagement brief. Rules:`,
    `- explanation: 1-2 sentences in plain English on what the author is saying`,
    `  about ${product} and WHY it is worth a reply now.`,
    `- talkingPoints: 2-3 short bullet strings — the key facts or angles the`,
    `  human should hit. Be specific to the post; no generic filler.`,
    `- reply: one ready-to-post reply, <= 60 words, in a warm, credible,`,
    `  non-marketing voice. First person as the ${product} team. No hashtags`,
    `  unless natural, no emoji spam, never invent features or metrics. If the`,
    `  post is critical, lead with genuine acknowledgement.`,
    `- caution: one short sentence on anything to avoid or verify before posting`,
    `  (e.g. "confirm the bug is fixed before promising a timeline"), or "" if none.`,
    ``,
    `Respond with JSON only, no commentary:`,
    `{`,
    `  "explanation": "...",`,
    `  "talkingPoints": ["...", "..."],`,
    `  "reply": "...",`,
    `  "caution": "..."`,
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

function normalizeSuggestion(parsed) {
  const out = { explanation: '', talkingPoints: [], reply: '', caution: '' };
  if (!parsed || typeof parsed !== 'object') return out;
  out.explanation = clampStr(parsed.explanation ?? parsed.summary ?? '', 600).trim();
  let tp = parsed.talkingPoints ?? parsed.talking_points ?? parsed.points ?? [];
  if (typeof tp === 'string') tp = [tp];
  if (Array.isArray(tp)) {
    out.talkingPoints = tp.map((t) => clampStr(t, 240).trim()).filter(Boolean).slice(0, 5);
  }
  out.reply = clampStr(parsed.reply ?? parsed.suggestedReply ?? parsed.draft ?? '', 1200).trim();
  out.caution = clampStr(parsed.caution ?? parsed.warning ?? '', 400).trim();
  return out;
}

export function hasSuggestion(s) {
  if (!s || typeof s !== 'object') return false;
  return Boolean(s.explanation || s.reply || (Array.isArray(s.talkingPoints) && s.talkingPoints.length));
}

export function getReplyProvider(env = process.env) {
  const provider = String(env.REPLY_SUGGEST_PROVIDER || '').toLowerCase().trim();
  if (provider === 'agent') return 'agent';
  if (provider === 'ollama') return 'ollama';
  if (provider === 'openai') return 'openai';
  if (provider === 'custom' || provider === 'openai-compatible') return 'custom';
  if (provider === 'none') return 'none';
  // Default: reuse the CLI agent runner already configured for /scout-scan.
  return 'agent';
}

export async function suggestReply(input, env = process.env, opts = {}) {
  const payload = {
    summary: String(input?.summary || ''),
    author: String(input?.author || ''),
    platform: String(input?.platform || ''),
    productName: String(input?.productName || ''),
    sentiment: String(input?.sentiment || 'mixed').toLowerCase(),
  };
  if (!payload.summary.trim()) {
    return {
      provider: getReplyProvider(env),
      error: 'Cannot suggest a reply for an empty post — summary is required.',
    };
  }
  const provider = getReplyProvider(env);
  if (provider === 'none') {
    return {
      provider: 'none',
      error: 'No reply provider configured. Set REPLY_SUGGEST_PROVIDER=agent|ollama|openai|custom in .env.',
    };
  }
  const prompt = buildPrompt(payload);
  if (provider === 'agent') return suggestWithAgent(prompt, env, opts);
  if (provider === 'ollama') return suggestWithOllama(prompt, env);
  if (provider === 'openai') return suggestWithOpenAI(prompt, env);
  if (provider === 'custom') return suggestWithCustom(prompt, env);
  return { provider, error: `Unknown reply provider: ${provider}` };
}

// Strip the `-p "{prompt}"` / `exec "{prompt}"` placeholder so we can pipe the
// prompt over stdin — avoids OS command-line length / shell-escaping issues
// with long post text. Mirrors the sentiment reviewer + server runner.
function stripPromptPlaceholder(runner) {
  return String(runner)
    .replace(/\s*(?:-p|--prompt|exec)\s+["']?\{prompt\}["']?/, '')
    .replace(/\s*["']?\{prompt\}["']?/, '')
    .trim();
}

async function suggestWithAgent(prompt, env, opts) {
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
      error: `Agent (${label || 'runner'}) timed out after ${Math.round(timeoutMs / 1000)}s. Raise REPLY_SUGGEST_AGENT_TIMEOUT_MS in .env (current: ${timeoutMs}), pick a faster model, or set REPLY_SUGGEST_PROVIDER=ollama for a direct local LLM.`,
    };
  }
  const parsed = tryParseJson(stdout);
  if (!parsed) {
    const tail = (stderr || stdout).trim().slice(-400);
    return { provider: 'agent', model: label, error: `Agent (${label || 'runner'}) did not return parseable JSON. Last output: ${tail || '(empty)'}` };
  }
  return { provider: 'agent', model: label, raw: stdout.slice(0, 4000), ...normalizeSuggestion(parsed) };
}

async function suggestWithOllama(prompt, env) {
  const host = (env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
  const model = env.OLLAMA_REPLY_MODEL || 'llama3.1:8b';
  const url = `${host}/api/generate`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, format: 'json', options: { temperature: 0.4 } }),
    });
  } catch (err) {
    return { provider: 'ollama', model, error: `Ollama unreachable at ${host}: ${err.message}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { provider: 'ollama', model, error: `Ollama ${res.status}: ${body.slice(0, 400)}` };
  }
  const data = await res.json();
  return { provider: 'ollama', model, host, raw: data.response, ...normalizeSuggestion(tryParseJson(data.response)) };
}

async function suggestWithOpenAI(prompt, env) {
  const key = env.OPENAI_API_KEY;
  if (!key) return { provider: 'openai', error: 'OPENAI_API_KEY not set in .env' };
  const model = env.OPENAI_REPLY_MODEL || 'gpt-4o-mini';
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
        temperature: 0.4,
        max_tokens: 700,
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
  return { provider: 'openai', model, raw: text, ...normalizeSuggestion(tryParseJson(text)) };
}

async function suggestWithCustom(prompt, env) {
  const baseUrl = (env.CUSTOM_REPLY_BASE_URL || '').replace(/\/+$/, '');
  const key = env.CUSTOM_REPLY_API_KEY;
  const model = env.CUSTOM_REPLY_MODEL;
  const authStyle = String(env.CUSTOM_REPLY_AUTH_STYLE || 'bearer').toLowerCase();
  if (!baseUrl) return { provider: 'custom', error: 'CUSTOM_REPLY_BASE_URL not set in .env' };
  if (!key) return { provider: 'custom', error: 'CUSTOM_REPLY_API_KEY not set in .env' };
  if (!model) return { provider: 'custom', error: 'CUSTOM_REPLY_MODEL not set in .env' };
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
        temperature: 0.4,
        max_tokens: 700,
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
  return { provider: 'custom', model, raw: text, ...normalizeSuggestion(tryParseJson(text)) };
}
