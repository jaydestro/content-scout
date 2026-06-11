import { $, api, escape } from '../lib/core.js';

const OLLAMA_MODEL_SUGGESTIONS = ['llama3.2-vision', 'llama3.2-vision:11b', 'moondream', 'llava', 'qwen2.5vl:7b', 'bakllava'];
const OPENAI_MODEL_SUGGESTIONS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'];
const CUSTOM_PRESETS = [
  { label: 'Azure OpenAI', baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT/chat/completions?api-version=2024-10-21', auth: 'api-key', model: 'gpt-4o-mini' },
  { label: 'Azure AI Foundry (Models)', baseUrl: 'https://YOUR-RESOURCE.services.ai.azure.com/models', auth: 'api-key', model: 'gpt-4o-mini' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', auth: 'bearer', model: 'openai/gpt-4o-mini' },
  { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', auth: 'bearer', model: 'lmstudio-community/llava' },
  { label: 'vLLM / llama.cpp server', baseUrl: 'http://localhost:8000/v1', auth: 'bearer', model: 'your-model' },
  { label: 'Together.ai', baseUrl: 'https://api.together.xyz/v1', auth: 'bearer', model: 'meta-llama/Llama-3.2-11B-Vision-Instruct-Turbo' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', auth: 'bearer', model: 'llama-3.2-11b-vision-preview' },
];

export function mountVisionIntegrations() {
  mountVisionPanel('vision-config-panel');
  mountServicesDetect('services-detect');
  const configsVisionCard = document.getElementById('configs-vision-card');
  if (configsVisionCard) {
    let mounted = false;
    configsVisionCard.addEventListener('toggle', () => {
      if (configsVisionCard.open && !mounted) {
        mounted = true;
        mountVisionPanel('configs-vision-panel');
        mountServicesDetect('configs-services-detect');
      }
    });
  }
}

function visionPanelHtml(cfg, instanceId) {
  const provider = cfg.provider || 'none';
  const ollamaHost = cfg.ollamaHost || 'http://localhost:11434';
  const ollamaModel = cfg.ollamaModel || 'llama3.2-vision';
  const openaiModel = cfg.openaiModel || 'gpt-4o-mini';
  const hasKey = !!cfg.hasOpenaiKey;
  const customBaseUrl = cfg.customBaseUrl || '';
  const customModel = cfg.customModel || '';
  const customAuthStyle = cfg.customAuthStyle || 'bearer';
  const hasCustomKey = !!cfg.hasCustomKey;
  const id = (key) => `${instanceId}-${key}`;
  return `
    <div class="vision-grid">
      <label for="${id('provider')}"><strong>Provider</strong></label>
      <select id="${id('provider')}" data-vc="provider">
        <option value="none"${provider === 'none' ? ' selected' : ''}>none — work from typed description only</option>
        <option value="ollama"${provider === 'ollama' ? ' selected' : ''}>ollama — local, free, private (recommended)</option>
        <option value="openai"${provider === 'openai' ? ' selected' : ''}>openai — cloud, ~$0.0002/image</option>
        <option value="custom"${provider === 'custom' ? ' selected' : ''}>custom — Azure OpenAI / Foundry / any OpenAI-compatible endpoint</option>
      </select>
    </div>

    <div class="vision-section" data-section="ollama" hidden>
      <p class="hint">
        Local vision via <a href="https://ollama.com" target="_blank" rel="noreferrer noopener">Ollama</a>.
        After install: <code>ollama pull moondream</code> (fast, ~2 GB) or <code>ollama pull llama3.2-vision</code> (better, ~8 GB).
      </p>
      <details class="vision-install-help">
        <summary>Don't have Ollama? Show install instructions</summary>
        <ul class="hint">
          <li><strong>Windows:</strong> download from <a href="https://ollama.com/download/windows" target="_blank" rel="noreferrer noopener">ollama.com/download/windows</a> and run the installer.</li>
          <li><strong>macOS:</strong> <code>brew install ollama</code> then <code>ollama serve</code>.</li>
          <li><strong>Linux:</strong> <code>curl -fsSL https://ollama.com/install.sh | sh</code></li>
          <li>Then run: <code>ollama pull llama3.2-vision</code> (or <code>moondream</code>) and click <strong>Test connection</strong>.</li>
        </ul>
      </details>
      <div class="vision-grid">
        <label for="${id('ollama-host')}">Host URL</label>
        <input id="${id('ollama-host')}" data-vc="ollamaHost" type="url" value="${escape(ollamaHost)}" placeholder="http://localhost:11434" />
        <label for="${id('ollama-model')}">Model</label>
        <input id="${id('ollama-model')}" data-vc="ollamaModel" list="ollama-models" value="${escape(ollamaModel)}" placeholder="llama3.2-vision" />
      </div>
    </div>

    <div class="vision-section" data-section="openai" hidden>
      <p class="hint">
        OpenAI cloud. <code>gpt-4o-mini</code> is the cheapest and works fine for most images.
        Get an API key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer noopener">platform.openai.com/api-keys</a>.
      </p>
      <div class="vision-grid">
        <label for="${id('openai-key')}">API key</label>
        <input id="${id('openai-key')}" data-vc="openaiApiKey" type="password" autocomplete="off" placeholder="${hasKey ? '••• key set in .env (leave blank to keep)' : 'sk-…'}" />
        <label for="${id('openai-model')}">Model</label>
        <input id="${id('openai-model')}" data-vc="openaiModel" list="openai-models" value="${escape(openaiModel)}" placeholder="gpt-4o-mini" />
      </div>
    </div>

    <div class="vision-section" data-section="custom" hidden>
      <p class="hint">
        Any OpenAI-compatible <code>/chat/completions</code> endpoint with vision support.
        Pick a preset to autofill, then paste your key + adjust the deployment/model name.
      </p>
      <div class="vision-grid">
        <label for="${id('custom-preset')}">Preset</label>
        <select id="${id('custom-preset')}" data-vc-preset>
          <option value="">— pick one —</option>
          ${CUSTOM_PRESETS.map((preset, index) => `<option value="${index}">${escape(preset.label)}</option>`).join('')}
        </select>
        <label for="${id('custom-base')}">Base URL</label>
        <input id="${id('custom-base')}" data-vc="customBaseUrl" type="url" value="${escape(customBaseUrl)}" placeholder="https://api.example.com/v1 or full /chat/completions URL" />
        <label for="${id('custom-key')}">API key</label>
        <input id="${id('custom-key')}" data-vc="customApiKey" type="password" autocomplete="off" placeholder="${hasCustomKey ? '••• key set in .env (leave blank to keep)' : 'paste key'}" />
        <label for="${id('custom-model')}">Model / deployment</label>
        <input id="${id('custom-model')}" data-vc="customModel" value="${escape(customModel)}" placeholder="e.g. gpt-4o-mini" />
        <label for="${id('custom-auth')}">Auth header</label>
        <select id="${id('custom-auth')}" data-vc="customAuthStyle">
          <option value="bearer"${customAuthStyle === 'bearer' ? ' selected' : ''}>Authorization: Bearer (OpenAI / Foundry / OpenRouter / most)</option>
          <option value="api-key"${customAuthStyle === 'api-key' ? ' selected' : ''}>api-key header (Azure OpenAI)</option>
        </select>
      </div>
      <p class="hint">
        Tip: for Azure OpenAI, paste the full deployment URL (ending in <code>?api-version=…</code>) into Base URL and pick <strong>api-key</strong>.
        For everything else, paste the base (e.g. <code>https://openrouter.ai/api/v1</code>) — <code>/chat/completions</code> is appended automatically.
      </p>
    </div>

    <datalist id="ollama-models">
      ${OLLAMA_MODEL_SUGGESTIONS.map((model) => `<option value="${escape(model)}">`).join('')}
    </datalist>
    <datalist id="openai-models">
      ${OPENAI_MODEL_SUGGESTIONS.map((model) => `<option value="${escape(model)}">`).join('')}
    </datalist>

    <div class="toolbar" style="margin-top:0.75rem">
      <button type="button" data-vc-action="save">Save vision config</button>
      <button type="button" class="secondary" data-vc-action="test">Test connection</button>
      <span class="hint" data-vc-status></span>
    </div>
    <div class="vision-banner" data-vc-banner hidden></div>
  `;
}

async function mountVisionPanel(containerId) {
  const root = $(containerId);
  if (!root) return;
  root.innerHTML = '<p class="hint">Loading…</p>';
  let cfg;
  try {
    cfg = await api('/api/vision/config');
  } catch (err) {
    root.innerHTML = `<div class="warn-text">Failed to load vision config: ${escape(err.message)}</div>`;
    return;
  }
  root.innerHTML = visionPanelHtml(cfg, containerId);

  const providerSel = root.querySelector('[data-vc="provider"]');
  const statusEl = root.querySelector('[data-vc-status]');

  function syncSections() {
    const provider = providerSel.value;
    root.querySelectorAll('.vision-section').forEach((section) => {
      section.hidden = section.dataset.section !== provider;
    });
  }
  providerSel.addEventListener('change', syncSections);
  syncSections();

  const presetSel = root.querySelector('[data-vc-preset]');
  if (presetSel) {
    presetSel.addEventListener('change', () => {
      const index = parseInt(presetSel.value, 10);
      if (!Number.isFinite(index)) return;
      const preset = CUSTOM_PRESETS[index];
      if (!preset) return;
      const setVal = (key, value) => {
        const el = root.querySelector(`[data-vc="${key}"]`);
        if (el) el.value = value;
      };
      setVal('customBaseUrl', preset.baseUrl);
      setVal('customModel', preset.model);
      setVal('customAuthStyle', preset.auth);
    });
  }

  function readForm() {
    const get = (key) => {
      const el = root.querySelector(`[data-vc="${key}"]`);
      return el ? el.value : '';
    };
    return {
      provider: providerSel.value,
      ollamaHost: get('ollamaHost'),
      ollamaModel: get('ollamaModel'),
      openaiModel: get('openaiModel'),
      openaiApiKey: get('openaiApiKey'),
      customBaseUrl: get('customBaseUrl'),
      customModel: get('customModel'),
      customAuthStyle: get('customAuthStyle') || 'bearer',
      customApiKey: get('customApiKey'),
    };
  }

  function setStatus(message, tone) {
    statusEl.textContent = message || '';
    if (tone) statusEl.dataset.tone = tone;
    else delete statusEl.dataset.tone;
  }

  const banner = root.querySelector('[data-vc-banner]');
  let pullPollTimer = null;
  let recommendedModelsCache = null;

  async function loadRecommendedModels() {
    if (recommendedModelsCache) return recommendedModelsCache;
    try {
      const data = await fetch('/api/vision/ollama-models').then((response) => response.json());
      recommendedModelsCache = data.models || [];
    } catch { recommendedModelsCache = []; }
    return recommendedModelsCache;
  }

  function hideBanner() {
    if (!banner) return;
    banner.hidden = true;
    banner.innerHTML = '';
    if (pullPollTimer) {
      clearInterval(pullPollTimer);
      pullPollTimer = null;
    }
  }

  async function showMissingModelBanner(probe) {
    if (!banner) return;
    const models = await loadRecommendedModels();
    const currentModel = probe.model || 'llama3.2-vision';
    banner.hidden = false;
    banner.innerHTML = `
      <div class="vision-banner-card warn-card">
        <div class="vision-banner-title">⚠ Vision model not installed</div>
        <p>Ollama is running at <code>${escape(probe.host || '')}</code> but <code>${escape(currentModel)}</code> isn't pulled yet. Pick a model below and I'll pull it for you — or copy the command and run it yourself.</p>
        <div class="vision-model-grid">
          ${models.map((model) => `
            <label class="vision-model-pick">
              <input type="radio" name="vc-pull-model" value="${escape(model.name)}"${model.name === currentModel ? ' checked' : ''} />
              <span class="vision-model-name"><code>${escape(model.name)}</code> <span class="hint">(${escape(model.size)})</span></span>
              <span class="hint">${escape(model.note)}</span>
            </label>
          `).join('')}
        </div>
        <div class="toolbar" style="margin-top:0.5rem">
          <button type="button" data-vc-action="pull">Pull selected model now</button>
          <button type="button" class="secondary" data-vc-action="dismiss-banner">Dismiss</button>
        </div>
        <p class="hint">Or run in a terminal: <code data-vc-pull-cmd>ollama pull ${escape(currentModel)}</code></p>
        <div class="vision-pull-progress" data-vc-pull-progress hidden></div>
      </div>
    `;
    banner.querySelectorAll('input[name="vc-pull-model"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        const command = banner.querySelector('[data-vc-pull-cmd]');
        if (command) command.textContent = `ollama pull ${radio.value}`;
      });
    });
    banner.querySelector('[data-vc-action="dismiss-banner"]').addEventListener('click', hideBanner);
    banner.querySelector('[data-vc-action="pull"]').addEventListener('click', async () => {
      const picked = banner.querySelector('input[name="vc-pull-model"]:checked');
      if (!picked) return;
      const model = picked.value;
      const progress = banner.querySelector('[data-vc-pull-progress]');
      progress.hidden = false;
      progress.textContent = `Starting pull of ${model}…`;
      try {
        const response = await fetch('/api/vision/ollama-pull', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model }),
        });
        const data = await response.json();
        if (!response.ok) {
          progress.textContent = `Failed: ${data.error || response.status}`;
          return;
        }
      } catch (err) {
        progress.textContent = `Failed: ${err.message}`;
        return;
      }
      if (pullPollTimer) clearInterval(pullPollTimer);
      pullPollTimer = setInterval(async () => {
        try {
          const status = await fetch(`/api/vision/ollama-pull/status?model=${encodeURIComponent(model)}`).then((response) => response.json());
          if (!status.exists) {
            progress.textContent = 'Not started.';
            return;
          }
          const percent = (typeof status.percent === 'number') ? ` ${status.percent}%` : '';
          const elapsed = ` (${status.elapsedSec}s)`;
          progress.textContent = status.done
            ? (status.error ? `Pull failed: ${status.error}` : `✓ ${model} installed${elapsed}`)
            : `${status.status || 'pulling'}${percent}${elapsed}`;
          if (status.done) {
            clearInterval(pullPollTimer);
            pullPollTimer = null;
            const modelInput = root.querySelector('[data-vc="ollamaModel"]');
            if (modelInput) modelInput.value = model;
            try {
              await fetch('/api/vision/config', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ...readForm(), provider: 'ollama', ollamaModel: model }),
              });
            } catch {}
            const probe = await fetch('/api/alt/vision-status').then((response) => response.json());
            if (probe.ok && probe.modelInstalled) {
              hideBanner();
              setStatus(probe.message, 'ok');
            } else {
              await reflectProbe(probe);
            }
          }
        } catch (err) {
          progress.textContent = `Status error: ${err.message}`;
        }
      }, 1500);
    });
  }

  async function reflectProbe(probe) {
    setStatus(probe.message, probe.ok ? 'ok' : 'error');
    const altStatus = $('alt-vision-status');
    if (altStatus) {
      altStatus.textContent = `Vision: ${probe.message}`;
      altStatus.dataset.tone = probe.ok ? 'ok' : (probe.provider === 'none' ? 'muted' : 'error');
    }
    if (probe.provider === 'ollama' && probe.ok && probe.modelInstalled === false) {
      await showMissingModelBanner(probe);
    } else {
      hideBanner();
    }
  }

  root.querySelector('[data-vc-action="save"]').addEventListener('click', async () => {
    setStatus('Saving…');
    try {
      const body = readForm();
      const response = await fetch('/api/vision/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        setStatus(`Save failed: ${data.error || response.status}`, 'error');
        return;
      }
      const keyInput = root.querySelector('[data-vc="openaiApiKey"]');
      if (keyInput) keyInput.value = '';
      const customKeyInput = root.querySelector('[data-vc="customApiKey"]');
      if (customKeyInput) customKeyInput.value = '';
      setStatus(`Saved (provider: ${data.provider})`, 'ok');
      try {
        const probe = await fetch('/api/alt/vision-status').then((response) => response.json());
        await reflectProbe(probe);
      } catch {}
    } catch (err) {
      setStatus(`Save error: ${err.message}`, 'error');
    }
  });

  root.querySelector('[data-vc-action="test"]').addEventListener('click', async () => {
    setStatus('Testing…');
    try {
      const body = readForm();
      const saveResponse = await fetch('/api/vision/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!saveResponse.ok) {
        const data = await saveResponse.json();
        setStatus(`Save failed before test: ${data.error || saveResponse.status}`, 'error');
        return;
      }
      const probe = await fetch('/api/alt/vision-status').then((response) => response.json());
      await reflectProbe(probe);
    } catch (err) {
      setStatus(`Test error: ${err.message}`, 'error');
    }
  });

  (async () => {
    if (cfg.provider === 'ollama') {
      try {
        const probe = await fetch('/api/alt/vision-status').then((response) => response.json());
        if (probe.provider === 'ollama' && probe.ok && probe.modelInstalled === false) {
          await showMissingModelBanner(probe);
        }
      } catch {}
    }
  })();
}

async function mountServicesDetect(containerId) {
  const root = document.getElementById(containerId);
  if (!root) return;
  const targetId = root.dataset.target || 'vision-config-panel';
  root.innerHTML = '<p class="hint">Looking for local AI services on your machine…</p>';
  let data;
  try {
    data = await api('/api/services/detect');
  } catch (err) {
    root.innerHTML = `<p class="hint warn-text">Couldn't probe local services: ${escape(err.message)}</p>`;
    return;
  }
  const services = data.services || [];
  const running = services.filter((service) => service.running);
  if (!running.length) {
    root.innerHTML = `
      <p class="hint">
        No local AI services detected. Install <a href="https://ollama.com" target="_blank" rel="noreferrer noopener">Ollama</a>
        (or <a href="https://lmstudio.ai" target="_blank" rel="noreferrer noopener">LM Studio</a>) and click Re-scan.
        Or pick OpenAI / a custom endpoint below.
      </p>
      <button type="button" class="secondary" data-action="rescan">Re-scan</button>
    `;
  } else {
    const chips = running.map((service) => {
      const count = (service.models || []).length;
      const modelLabel = count ? `${count} model${count === 1 ? '' : 's'}` : 'no models pulled yet';
      const action = service.id === 'ollama'
        ? `<button type="button" data-action="use-ollama" data-host="${escape(service.host)}" data-model="${escape((service.models || [])[0] || '')}">Use Ollama</button>`
        : '';
      return `
        <div class="service-chip">
          <strong>✓ ${escape(service.name)}</strong>
          <span class="hint">${escape(service.host)} — ${escape(modelLabel)}</span>
          ${action}
        </div>
      `;
    }).join('');
    root.innerHTML = `
      <div class="services-banner">
        <p class="hint" style="margin:0 0 0.5rem">Detected on this machine:</p>
        ${chips}
        <button type="button" class="secondary" data-action="rescan" style="margin-top:0.5rem">Re-scan</button>
      </div>
    `;
  }
  root.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.action === 'rescan') {
        mountServicesDetect(containerId);
        return;
      }
      if (button.dataset.action === 'use-ollama') {
        const target = document.getElementById(targetId);
        if (!target) return;
        const providerSelect = target.querySelector('[data-vc="provider"]');
        const hostInput = target.querySelector('[data-vc="ollamaHost"]');
        const modelInput = target.querySelector('[data-vc="ollamaModel"]');
        if (providerSelect) {
          providerSelect.value = 'ollama';
          providerSelect.dispatchEvent(new Event('change'));
        }
        if (hostInput && button.dataset.host) hostInput.value = button.dataset.host;
        if (modelInput && button.dataset.model) modelInput.value = button.dataset.model;
        const status = target.querySelector('[data-vc-status]');
        if (status) {
          status.textContent = 'Ollama prefilled — click Save vision config to apply.';
          status.dataset.tone = 'ok';
        }
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });
}
