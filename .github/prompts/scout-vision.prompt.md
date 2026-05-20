---
mode: agent
description: "Configure the vision provider used by /scout-alt to inspect images"
---

# Content Scout — Vision Provider Setup

Interactively configure (or switch) the vision provider that `/scout-alt` uses to actually *look at* images before drafting alt text. Without a provider, alt text is generated only from the user's typed description.

Ignore VS Code frontmatter. Ask the user conversationally.

## Inputs

- (optional) Provider: `none | ollama | openai | custom`. If omitted, ask which they want and explain the trade-offs (see below). If they answer something like "Azure OpenAI", "Azure Foundry", "OpenRouter", "LM Studio", "vLLM", "llama.cpp", "Together", or "Groq", treat it as `custom` and pre-select the matching preset.

## Step 1 — Read current state

Read `.env` at workspace root. Identify and report (do not print full secrets):

- `VISION_PROVIDER` — current provider, or "(unset → none)".
- `OLLAMA_HOST`, `OLLAMA_VISION_MODEL`.
- `OPENAI_VISION_MODEL`. Report whether `OPENAI_API_KEY` is present (masked).
- `CUSTOM_VISION_BASE_URL`, `CUSTOM_VISION_MODEL`, `CUSTOM_VISION_AUTH_STYLE`. Report whether `CUSTOM_VISION_API_KEY` is present (masked).

If the web UI server is running on `http://localhost:4477`, you can also `GET /api/vision/config` for a single JSON snapshot.

## Step 2 — Pick a provider

Present the choice plainly:

| Provider | Cost | Privacy | Quality | Setup |
|----------|------|---------|---------|-------|
| **ollama** (recommended) | free | local — image never leaves your machine | very good | install Ollama + pull a vision model |
| **openai** | ~$0.0002/image with `gpt-4o-mini` | image sent to OpenAI | excellent | API key |
| **custom** | varies | depends on endpoint | depends on model | works with Azure OpenAI, Azure AI Foundry, OpenRouter, LM Studio, vLLM, llama.cpp server, Together, Groq, etc. |
| **none** | free | n/a | works only from typed description | nothing |

## Step 3 — Configure

### If `ollama`:

1. Confirm Ollama is installed and reachable. Default host: `http://localhost:11434`.
   - Quick check: `curl -s http://localhost:11434/api/tags`. If that fails, **proactively offer to walk them through installation** before continuing — do not just paste a URL. Ask: "Ollama doesn't seem to be running. Want me to walk you through installing it?" If yes, give the OS-specific command:
     - **Windows:** download the installer from <https://ollama.com/download/windows> and run it. After install, Ollama runs as a service on `http://localhost:11434`.
     - **macOS:** `brew install ollama` then `ollama serve` (or use the .dmg from ollama.com).
     - **Linux:** `curl -fsSL https://ollama.com/install.sh | sh`
   - Wait for them to confirm install succeeded, then re-probe `/api/tags`.
2. Recommend a model. Ask which to use:
   - `moondream` — small (~2 GB), fast, good enough for screenshots and simple photos.
   - `llama3.2-vision` — larger (~8 GB), better for charts/diagrams. **Default.**
   - `qwen2.5vl:7b`, `llava`, `bakllava` — alternatives.
3. If the user-chosen model isn't installed (check `/api/tags` for the model name), **offer to run `ollama pull <model>` for them** via the terminal tool. Warn that it can take several minutes and several GB of disk. Do not pull silently — confirm first.
4. Persist:
   - `VISION_PROVIDER=ollama`
   - `OLLAMA_HOST=<host>` (only if non-default)
   - `OLLAMA_VISION_MODEL=<model>`

### If `openai`:

1. Ask whether `OPENAI_API_KEY` is already set. If not, walk them to <https://platform.openai.com/api-keys>, have them create a key, and paste it. Validate format (`sk-` prefix, length > 20). Mask in echoes.
2. Recommend `gpt-4o-mini`. Other valid options: `gpt-4o`, `gpt-4.1-mini`.
3. Persist:
   - `VISION_PROVIDER=openai`
   - `OPENAI_API_KEY=<value>` (only if newly provided — never overwrite a working key with blank)
   - `OPENAI_VISION_MODEL=<model>`

### If `custom`:

The `custom` provider hits any OpenAI-compatible `/chat/completions` endpoint that supports image input. Ask which flavor they want and use the matching preset:

| Preset | Base URL | Auth | Notes |
|--------|----------|------|-------|
| **Azure OpenAI** | `https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=2024-10-21` | `api-key` | Paste the **full** deployment URL (the `api-version` query is required). The `model` field must match your deployment name. |
| **Azure AI Foundry (Models)** | `https://<resource>.services.ai.azure.com/models` | `api-key` | Use the Foundry "Inference" endpoint. `model` is the model name (e.g. `gpt-4o-mini`). |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `bearer` | `model` like `openai/gpt-4o-mini` or `anthropic/claude-3.5-sonnet`. |
| **LM Studio (local)** | `http://localhost:1234/v1` | `bearer` (any string works locally) | `model` is the loaded LM Studio model id. |
| **vLLM / llama.cpp server** | `http://localhost:8000/v1` (or your port) | `bearer` | `model` is whatever your server reports at `/v1/models`. |
| **Together.ai** | `https://api.together.xyz/v1` | `bearer` | `model` like `meta-llama/Llama-3.2-11B-Vision-Instruct-Turbo`. |
| **Groq** | `https://api.groq.com/openai/v1` | `bearer` | `model` like `llama-3.2-11b-vision-preview`. |

Then collect:

1. **Base URL** — confirm or correct the preset. If it doesn't already include `/chat/completions`, the lib appends it automatically. Azure OpenAI is the exception: paste the full deployment URL ending in `?api-version=…`.
2. **API key** — paste, validate non-empty.
3. **Model / deployment name** — required.
4. **Auth style** — `bearer` (default) or `api-key` (Azure OpenAI).

Persist:

- `VISION_PROVIDER=custom`
- `CUSTOM_VISION_BASE_URL=<url>`
- `CUSTOM_VISION_API_KEY=<key>` (only if newly provided)
- `CUSTOM_VISION_MODEL=<model>`
- `CUSTOM_VISION_AUTH_STYLE=bearer|api-key`

### If `none`:

Set `VISION_PROVIDER=` (empty) or remove the line. No other vars needed.

## Step 4 — Write `.env` safely

- Preserve all unrelated keys, comments, and ordering.
- Replace existing lines for the keys above; append in a `# Vision provider for /scout-alt` block if they don't exist.
- Never print full secret values back to the user.

> **Tip — when the web UI is running:** `POST http://localhost:4477/api/vision/config` with body `{ provider, ollamaHost?, ollamaModel?, openaiModel?, openaiApiKey?, customBaseUrl?, customModel?, customAuthStyle?, customApiKey? }` performs the same merge-write atomically. Empty `*ApiKey` fields are treated as "leave existing key alone".

## Step 5 — Verify

Probe the provider and report ✅ / ❌:

- ollama: `GET ${OLLAMA_HOST}/api/tags`. ✅ if reachable; also note whether the chosen model is in the returned list.
- openai: confirm `OPENAI_API_KEY` is present and well-formed. (Do not burn a billable request just to verify.)
- custom: confirm `CUSTOM_VISION_BASE_URL`, `CUSTOM_VISION_API_KEY`, and `CUSTOM_VISION_MODEL` are all set. Optionally `GET ${CUSTOM_VISION_BASE_URL}` (or `/v1/models` for OpenAI-style) to confirm reachability — skip if it would burn quota.
- If the web UI is running, prefer `GET /api/alt/vision-status` — it returns `{ ok, provider, model, message }`.

## Step 6 — Confirm

Print a one-line summary, e.g.:

> Vision provider set to `custom` (Azure OpenAI, model: `gpt-4o-mini-deployment`). Configured ✅. Run `/scout-alt` to try it.

## Notes

- This prompt only edits the five vision keys. It does NOT touch unrelated `.env` content. If anything else looks off, route the user to `/scout-keys` or `/scout-doctor`.
- The same fields are available in the web UI under **Setup → Vision provider** and **Configs → Vision provider**.
