// Vision providers for /scout-alt — local (Ollama), OpenAI, or any
// OpenAI-compatible endpoint (Azure OpenAI, Azure AI Foundry Inference,
// OpenRouter, LM Studio, vLLM, llama.cpp server, Together, Groq, etc.).
// Returns a structured "vision report" the agent can shape into alt text.
//
// Provider is selected via env:
//   VISION_PROVIDER=ollama|openai|custom|none   (default: none)
//   OLLAMA_HOST=http://localhost:11434   (default)
//   OLLAMA_VISION_MODEL=llama3.2-vision  (default; moondream/llava also work)
//   OPENAI_API_KEY=sk-...                (required for openai)
//   OPENAI_VISION_MODEL=gpt-4o-mini      (default)
//   CUSTOM_VISION_BASE_URL=https://...   (required for custom; chat/completions appended)
//   CUSTOM_VISION_API_KEY=...            (required for custom)
//   CUSTOM_VISION_MODEL=...              (required for custom)
//   CUSTOM_VISION_AUTH_STYLE=bearer|api-key  (default bearer; Azure OpenAI uses api-key)

import { promises as fs } from 'node:fs';
import path from 'node:path';

const VISION_PROMPT = `You are an accessibility-focused image describer. Look at this image and produce a JSON object with these fields, no commentary:

{
  "subject": "one-clause description of the primary subject",
  "kind": "photo | screenshot | chart | diagram | illustration | logo | meme | other",
  "on_image_text": "all readable text in the image, verbatim, joined with ' / '. Empty string if none.",
  "chart_details": "if a chart: type + axes + headline trend. Otherwise empty string.",
  "people_count": 0,
  "people_activity": "what they're doing, no names. Empty if no people.",
  "ui_elements": "if a screenshot: app/site name and key UI elements visible. Otherwise empty.",
  "decorative": false,
  "notes": "anything important you couldn't read clearly, low confidence items, etc."
}

Be specific. Reproduce on-image text exactly. Do not invent details.`;

export function getVisionProvider(env = process.env) {
  const provider = String(env.VISION_PROVIDER || 'none').toLowerCase();
  if (provider === 'ollama') return 'ollama';
  if (provider === 'openai') return 'openai';
  if (provider === 'custom' || provider === 'openai-compatible') return 'custom';
  return 'none';
}

export async function describeImage(absImagePath, env = process.env) {
  const provider = getVisionProvider(env);
  if (provider === 'none') {
    return { provider: 'none', error: 'No vision provider configured. Set VISION_PROVIDER=ollama|openai|custom in .env.' };
  }
  const buf = await fs.readFile(absImagePath);
  const mime = mimeFromPath(absImagePath);
  const base64 = buf.toString('base64');

  if (provider === 'ollama') return describeWithOllama(base64, mime, env);
  if (provider === 'openai') return describeWithOpenAI(base64, mime, env);
  if (provider === 'custom') return describeWithCustom(base64, mime, env);
}

function mimeFromPath(p) {
  const ext = path.extname(p).toLowerCase();
  return {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.avif': 'image/avif',
  }[ext] || 'application/octet-stream';
}

function tryParseJson(text) {
  if (!text) return null;
  // Strip markdown code fences if the model wrapped its JSON
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  // Find first {...} block
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

async function describeWithOllama(base64, _mime, env) {
  const host = (env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
  const model = env.OLLAMA_VISION_MODEL || 'llama3.2-vision';
  const url = `${host}/api/generate`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: VISION_PROMPT,
        images: [base64],
        stream: false,
        format: 'json',
      }),
    });
  } catch (err) {
    return { provider: 'ollama', error: `Ollama unreachable at ${host}: ${err.message}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { provider: 'ollama', error: `Ollama ${res.status}: ${body.slice(0, 400)}` };
  }
  const data = await res.json();
  const parsed = tryParseJson(data.response) || {};
  return { provider: 'ollama', model, raw: data.response, ...parsed };
}

async function describeWithOpenAI(base64, mime, env) {
  const key = env.OPENAI_API_KEY;
  if (!key) return { provider: 'openai', error: 'OPENAI_API_KEY not set in .env' };
  const model = env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
  const url = 'https://api.openai.com/v1/chat/completions';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
          ],
        }],
        response_format: { type: 'json_object' },
        max_tokens: 700,
      }),
    });
  } catch (err) {
    return { provider: 'openai', error: `OpenAI request failed: ${err.message}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { provider: 'openai', error: `OpenAI ${res.status}: ${body.slice(0, 400)}` };
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  const parsed = tryParseJson(text) || {};
  return { provider: 'openai', model, raw: text, ...parsed };
}

// Generic OpenAI-compatible chat/completions caller. Works for Azure OpenAI,
// Azure AI Foundry Inference, OpenRouter, LM Studio, vLLM, llama.cpp server,
// Together, Groq, Anyscale, and similar.
async function describeWithCustom(base64, mime, env) {
  const baseUrl = (env.CUSTOM_VISION_BASE_URL || '').replace(/\/+$/, '');
  const key = env.CUSTOM_VISION_API_KEY;
  const model = env.CUSTOM_VISION_MODEL;
  const authStyle = String(env.CUSTOM_VISION_AUTH_STYLE || 'bearer').toLowerCase();
  if (!baseUrl) return { provider: 'custom', error: 'CUSTOM_VISION_BASE_URL not set in .env' };
  if (!key) return { provider: 'custom', error: 'CUSTOM_VISION_API_KEY not set in .env' };
  if (!model) return { provider: 'custom', error: 'CUSTOM_VISION_MODEL not set in .env' };
  // Auto-append /chat/completions if the base URL doesn't already include it.
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
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
          ],
        }],
        response_format: { type: 'json_object' },
        max_tokens: 700,
      }),
    });
  } catch (err) {
    return { provider: 'custom', error: `Custom endpoint request failed: ${err.message}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { provider: 'custom', error: `Custom endpoint ${res.status}: ${body.slice(0, 400)}` };
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  const parsed = tryParseJson(text) || {};
  return { provider: 'custom', model, raw: text, ...parsed };
}

export function formatVisionReport(report) {
  if (!report) return '';
  if (report.error) return `[vision: ${report.provider} unavailable — ${report.error}]`;
  const lines = [`[vision report from ${report.provider}/${report.model || 'default'}]`];
  if (report.subject) lines.push(`Subject: ${report.subject}`);
  if (report.kind) lines.push(`Kind: ${report.kind}`);
  if (report.on_image_text) lines.push(`On-image text (verbatim): ${report.on_image_text}`);
  if (report.chart_details) lines.push(`Chart: ${report.chart_details}`);
  if (report.people_count) lines.push(`People: ${report.people_count} — ${report.people_activity || ''}`);
  if (report.ui_elements) lines.push(`UI: ${report.ui_elements}`);
  if (report.decorative) lines.push(`Decorative: yes`);
  if (report.notes) lines.push(`Notes: ${report.notes}`);
  return lines.join('\n');
}

export async function probeVision(env = process.env) {
  const provider = getVisionProvider(env);
  if (provider === 'none') return { provider: 'none', ok: false, message: 'No vision provider configured' };
  if (provider === 'ollama') {
    const host = (env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
    const model = env.OLLAMA_VISION_MODEL || 'llama3.2-vision';
    try {
      const res = await fetch(`${host}/api/tags`);
      if (!res.ok) return { provider, ok: false, message: `Ollama at ${host} returned ${res.status}` };
      const data = await res.json();
      const names = (data.models || []).map((m) => m.name);
      const hasModel = names.some((n) => n === model || n.startsWith(`${model}:`));
      return {
        provider, ok: true, model, host,
        modelInstalled: hasModel,
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
      model: env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
      message: key ? `OpenAI key present` : `OPENAI_API_KEY missing in .env`,
    };
  }
  if (provider === 'custom') {
    const baseUrl = (env.CUSTOM_VISION_BASE_URL || '').replace(/\/+$/, '');
    const key = env.CUSTOM_VISION_API_KEY;
    const model = env.CUSTOM_VISION_MODEL;
    const missing = [];
    if (!baseUrl) missing.push('CUSTOM_VISION_BASE_URL');
    if (!key) missing.push('CUSTOM_VISION_API_KEY');
    if (!model) missing.push('CUSTOM_VISION_MODEL');
    if (missing.length) {
      return { provider, ok: false, model, message: `missing: ${missing.join(', ')}` };
    }
    return {
      provider, ok: true, model, baseUrl,
      message: `Custom endpoint configured: ${model} at ${baseUrl}`,
    };
  }
  return { provider, ok: false, message: 'unknown provider' };
}
