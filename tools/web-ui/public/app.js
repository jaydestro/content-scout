// Content Scout web UI — vanilla JS SPA

// --- /api GET coalescing + short-TTL cache --------------------------
// The dashboard fires ~11 GETs across three modules (app.js loadDashboard,
// dashboard-enhancer loadAll, intel.js loadIntelCards) and several
// endpoints (/api/configs, /api/reports) are fetched twice in parallel.
// We dedupe in-flight GETs and cache OK responses for 4s so the dashboard
// renders without waiting on redundant round-trips. Streaming and
// mutation requests are passed through untouched.
(() => {
  const TTL_MS = 4000;
  const inflight = new Map(); // url -> Promise<Response>
  const cache = new Map();    // url -> { at, body, status, ct }
  const origFetch = window.fetch.bind(window);
  function cacheable(url, method) {
    if (method !== 'GET') return false;
    if (!url.startsWith('/api/')) return false;
    if (url.includes('/stream')) return false;       // SSE
    if (url.startsWith('/api/runs/') && /\/(stream|output)$/.test(url)) return false;
    return true;
  }
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = String(
      (init && init.method) ||
      (typeof input !== 'string' && input && input.method) ||
      'GET'
    ).toUpperCase();
    if (!cacheable(url, method)) return origFetch(input, init);
    const now = Date.now();
    const hit = cache.get(url);
    if (hit && now - hit.at < TTL_MS) {
      return Promise.resolve(
        new Response(hit.body, { status: hit.status, headers: { 'content-type': hit.ct } })
      );
    }
    if (inflight.has(url)) {
      return inflight.get(url).then((r) => r.clone());
    }
    const p = origFetch(input, init)
      .then(async (r) => {
        try {
          if (r.ok) {
            const text = await r.clone().text();
            cache.set(url, {
              at: Date.now(),
              body: text,
              status: r.status,
              ct: r.headers.get('content-type') || 'application/json',
            });
          }
        } catch { /* ignore caching errors */ }
        inflight.delete(url);
        return r;
      })
      .catch((e) => {
        inflight.delete(url);
        throw e;
      });
    inflight.set(url, p);
    return p.then((r) => r.clone());
  };
  // Expose a tiny invalidator so mutation handlers can drop stale entries.
  window.__apiCacheBust = (prefix) => {
    for (const k of cache.keys()) if (!prefix || k.startsWith(prefix)) cache.delete(k);
  };
})();

const $ = (id) => document.getElementById(id);
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
};

// --- Navigation ----------------------------------------------------
const KNOWN_VIEWS = ['dashboard', 'setup', 'configs', 'run', 'reports', 'social', 'conversations'];
function gotoView(view) {
  document.querySelectorAll('nav button').forEach((b) => {
    const isActive = b.dataset.view === view;
    b.classList.toggle('active', isActive);
    if (isActive) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (KNOWN_VIEWS.includes(view) && location.hash !== `#${view}`) {
    history.replaceState(null, '', `#${view}`);
  }
  if (view === 'setup') loadSetup();
  if (view === 'configs') { loadConfigList(); renderConfigsEnv(); }
  if (view === 'reports') loadReports();
  if (view === 'social') loadSocial();
  if (view === 'run') loadSlugOptions();
  if (view === 'dashboard') loadDashboard();
  if (view === 'conversations') {
    // intel.js owns this view but only auto-loads on hashchange. gotoView
    // uses history.replaceState (no hashchange fires), so we have to kick
    // it manually — otherwise the panel stays stuck on "Loading…".
    window.contentScoutIntel?.wireConversationsUI?.();
    window.contentScoutIntel?.loadConversations?.();
  }
}
document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => gotoView(btn.dataset.view));
});
window.addEventListener('hashchange', () => {
  const v = location.hash.replace(/^#/, '');
  if (KNOWN_VIEWS.includes(v)) gotoView(v);
});
document.addEventListener('click', (e) => {
  const goto = e.target.closest?.('[data-goto]');
  if (goto) {
    e.preventDefault();
    gotoView(goto.dataset.goto);
  }
});

// --- Status pill ---------------------------------------------------
let cachedStatus = null;
async function loadStatus() {
  const s = await api('/api/status');
  cachedStatus = s;
  const pill = $('status-pill');
  // External activity from another agent (Copilot Chat / `claude` CLI / etc.)
  // takes precedence over the static "agent: …" label so the user can see
  // at a glance that something is happening outside the web UI.
  if (s.externalActivity && s.externalActivity.active) {
    const a = s.externalActivity;
    const ago = a.ageSeconds < 60
      ? `${a.ageSeconds}s ago`
      : `${Math.round(a.ageSeconds / 60)}m ago`;
    pill.textContent = `🟢 agent active — wrote ${a.kind} ${ago}`;
    pill.title = `Detected external activity: ${a.file} (${ago}). This is from a CLI / Copilot Chat session, not the web UI.`;
    pill.classList.add('agent-active');
    pill.classList.remove('warn');
    return s;
  }
  pill.classList.remove('agent-active');
  if (s.runnerConfigured) {
    pill.textContent = `agent: ${s.agent || 'custom'}`;
    pill.title = `Runner: ${s.runner}${s.runnerLocked ? ' (from SCOUT_RUNNER env)' : ''}`;
    pill.classList.remove('warn');
  } else {
    pill.textContent = 'no agent — setup needed';
    pill.title = 'Open Setup to pick an agent.';
    pill.classList.add('warn');
  }
  return s;
}

// Poll status periodically so external-agent activity (Copilot Chat /
// `claude` CLI) is reflected in the pill within ~10s without a refresh.
// Skip the poll when the tab is hidden.
setInterval(() => {
  if (document.hidden) return;
  loadStatus().catch(() => {});
}, 10000);

// --- Setup ---------------------------------------------------------
let agentChoice = null;
async function loadSetup() {
  const [{ agents }, settings, status] = await Promise.all([
    api('/api/agents'),
    api('/api/settings'),
    api('/api/status'),
  ]);
  cachedStatus = status;
  agentChoice = settings.agent || status.agent || null;

  const locked = status.runnerLocked;
  $('agent-locked-note').hidden = !locked;

  const options = [...agents, { id: 'custom', label: 'Custom command', runner: settings.agent === 'custom' ? settings.runner : '', note: 'Provide any shell command; use {prompt} as placeholder.' }];
  $('agent-list').innerHTML = options.map((a) => `
    <label class="agent-option ${agentChoice === a.id ? 'selected' : ''}">
      <input type="radio" name="agent" value="${a.id}" ${agentChoice === a.id ? 'checked' : ''} ${locked ? 'disabled' : ''} />
      <div>
        <div><strong>${escape(a.label)}</strong></div>
        ${a.runner ? `<div class="hint"><code>${escape(a.runner)}</code></div>` : ''}
        ${a.note ? `<div class="hint">${escape(a.note)}</div>` : ''}
        ${a.install ? `<div class="hint"><a href="${escape(a.install)}" target="_blank" rel="noopener">Install instructions</a></div>` : ''}
      </div>
    </label>
  `).join('');

  document.querySelectorAll('input[name="agent"]').forEach((r) => {
    r.addEventListener('change', () => {
      agentChoice = r.value;
      $('agent-custom-wrap').hidden = r.value !== 'custom';
      document.querySelectorAll('.agent-option').forEach((lbl) => {
        lbl.classList.toggle('selected', lbl.querySelector('input').value === r.value);
      });
      saveAgentChoice();
    });
  });
  const customRunnerEl = $('agent-custom-runner');
  if (customRunnerEl) {
    customRunnerEl.addEventListener('blur', () => {
      if (agentChoice === 'custom') saveAgentChoice();
    });
  }
  $('agent-custom-wrap').hidden = agentChoice !== 'custom';
  if (settings.agent === 'custom') $('agent-custom-runner').value = settings.runner || '';

  // Section 2 status
  $('setup-config-status').innerHTML = status.hasConfigs
    ? `<span class="ok">${status.configCount} config${status.configCount === 1 ? '' : 's'} detected.</span>`
    : `<span class="warn-text">No configs yet — create one below.</span>`;
  const agentSaved = !!status.agent;
  $('setup-run-onboard').disabled = !agentSaved;
  $('setup-run-onboard').title = agentSaved
    ? (status.runnerConfigured
        ? 'Runs /scout-onboard in your chosen agent.'
        : 'Opens the Run view — you can copy the prompt and paste it into your editor chat.')
    : 'Pick an agent above first.';

  // Section 3: env keys — editable
  await renderEnvEditor();
}

async function renderEnvEditor() {
  try {
    const { entries, exists } = await api('/api/env');
    // Do NOT pre-populate any default keys. Users add keys explicitly via
    // "+ Add custom key". Existing .env entries are still shown so users can
    // edit/remove them.
    const rows = entries;
    $('setup-env').innerHTML = `
      <div class="env-grid">
        ${rows.map((e, i) => envRow(e.key, e.value, i, e.preset !== false)).join('')}
      </div>
      ${rows.length ? '' : '<div class="hint" style="margin-top:0.5rem">No keys yet — click <strong>+ Add custom key</strong> below to add one. Skip this step if you don\u2019t need any keys right now.</div>'}
      ${exists ? '' : '<div class="hint" style="margin-top:0.5rem">No <code>.env</code> file yet \u2014 saving will create one.</div>'}
    `;
    wireEnvRows('setup-env');
  } catch (err) {
    $('setup-env').innerHTML = `<div class="warn-text">Failed to load env: ${escape(err.message)}</div>`;
  }
}

function envRow(key, value, i, keyReadonly) {
  const meta = ENV_KEY_META[key.toUpperCase()] || null;
  const helpBtn = meta
    ? `<button type="button" class="secondary env-help" title="${escape(meta.tip)}\n\nClick for full setup walkthrough." data-anchor="${escape(meta.anchor)}" aria-label="What is ${escape(key)}?">?</button>`
    : '<span class="env-help-placeholder" aria-hidden="true"></span>';
  return `
    <div class="env-row" data-row="${i}">
      <input class="env-key" type="text" value="${escape(key)}" ${keyReadonly ? 'readonly' : ''} placeholder="KEY_NAME" />
      <input class="env-value" type="password" value="${escape(value)}" placeholder="(empty — skip this source)" autocomplete="off" />
      ${helpBtn}
      <button type="button" class="secondary env-toggle" title="Show/hide">👁</button>
      <button type="button" class="secondary env-test" title="Validate format and run a live reachability test">Test</button>
      <button type="button" class="secondary env-remove" title="Remove" ${keyReadonly ? 'hidden' : ''}>✕</button>
      <div class="env-status" role="status" aria-live="polite"></div>
    </div>
  `;
}

// Per-key help metadata. `tip` shows on hover; `anchor` deep-links into
// docs/API-KEYS.md when the user clicks the "?" button.
const ENV_KEY_META = {
  YOUTUBE_API_KEY: {
    tip: 'YouTube Data API v3 key (free). Without it, YouTube scanning is skipped.',
    anchor: 'youtube-data-api-v3',
  },
  REDDIT_CLIENT_ID: {
    tip: 'Reddit OAuth2 client ID (free, OPTIONAL). Reddit works without any creds via the layered no-auth scanner (old.reddit RSS → HTML → Google PSE → manual import). Add this only if Reddit approved your app.',
    anchor: 'reddit',
  },
  REDDIT_CLIENT_SECRET: {
    tip: 'Reddit OAuth2 client secret. Paired with REDDIT_CLIENT_ID from the same script app.',
    anchor: 'reddit',
  },
  REDDIT_USER_AGENT: {
    tip: 'User-Agent string Reddit requires on API calls. Any descriptive string works (e.g., "content-scout/1.0").',
    anchor: 'reddit',
  },
  GOOGLE_PSE_KEY: {
    tip: 'LEGACY — Google closed Custom Search JSON API to new customers in early 2026 (existing pre-2026 projects supported through Jan 1, 2027). New GCP projects get a permanent 403. Use BRAVE_SEARCH_API_KEY instead.',
    anchor: 'google-pse',
  },
  GOOGLE_PSE_CX: {
    tip: 'LEGACY — only meaningful if GOOGLE_PSE_KEY is from a pre-2026 GCP project. New projects cannot use Custom Search. Use BRAVE_SEARCH_API_KEY instead.',
    anchor: 'google-pse',
  },
  BRAVE_SEARCH_API_KEY: {
    tip: 'Brave Search API key (free tier: 2,000 queries/month, 1 query/sec). RECOMMENDED — the primary free path for Reddit Layer 3 + LinkedIn Layer 1 + X/Twitter Layer 2. Sign up at brave.com/search/api and create a key at api.search.brave.com/app/keys.',
    anchor: 'brave-search',
  },
  BLUESKY_HANDLE: {
    tip: 'Your Bluesky handle (e.g., yourname.bsky.social). Bluesky has no API keys — scans authenticate AS your user via an app password.',
    anchor: 'bluesky',
  },
  BLUESKY_APP_PASSWORD: {
    tip: 'Bluesky app-specific password (free, user-scoped). Generate at bsky.app/settings/app-passwords. Leave the "Allow access to direct messages" toggle OFF — Content Scout never needs DM access.',
    anchor: 'bluesky',
  },
  X_BEARER_TOKEN: {
    tip: 'X/Twitter API bearer token (OPTIONAL). Free PSE/RSSHub paths cover X without any token — only set this if you have the $200/mo Basic plan and want authenticated API access.',
    anchor: 'xtwitter',
  },
  GITHUB_TOKEN: {
    tip: 'Optional GitHub personal access token. Raises rate limit from 60/hr to 5,000/hr. No scopes needed for public read.',
    anchor: 'github-token',
  },
  SCOUT_WEBHOOK_URL: {
    tip: 'Optional webhook URL. Content Scout POSTs a JSON summary here when a scan completes (Slack/Teams/Discord/Zapier).',
    anchor: '',
  },
};

function wireEnvRows(scopeId) {
  const root = scopeId ? document.getElementById(scopeId) : document;
  if (!root) return;
  root.querySelectorAll('.env-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = btn.parentElement.querySelector('.env-value');
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });
  root.querySelectorAll('.env-remove').forEach((btn) => {
    btn.addEventListener('click', () => btn.parentElement.remove());
  });
  root.querySelectorAll('.env-test').forEach((btn) => {
    btn.addEventListener('click', () => testEnvRow(btn, scopeId));
  });
  root.querySelectorAll('.env-help').forEach((btn) => {
    btn.addEventListener('click', () => {
      const anchor = btn.dataset.anchor || '';
      // Open the local docs page anchored to the right section.
      const local = anchor ? `/docs/API-KEYS.md#${anchor}` : '/docs/API-KEYS.md';
      window.open(local, '_blank', 'noopener');
    });
  });
  // When user types a recognized key name into a custom row, refresh its
  // help button so the right tooltip appears.
  root.querySelectorAll('.env-row .env-key:not([readonly])').forEach((input) => {
    input.addEventListener('blur', () => {
      const row = input.closest('.env-row');
      if (!row) return;
      const meta = ENV_KEY_META[input.value.trim().toUpperCase()];
      const existing = row.querySelector('.env-help, .env-help-placeholder');
      if (!existing) return;
      const replacement = document.createElement(meta ? 'button' : 'span');
      if (meta) {
        replacement.type = 'button';
        replacement.className = 'secondary env-help';
        replacement.title = `${meta.tip}\n\nClick for full setup walkthrough.`;
        replacement.dataset.anchor = meta.anchor;
        replacement.setAttribute('aria-label', `What is ${input.value.trim()}?`);
        replacement.textContent = '?';
        replacement.addEventListener('click', () => {
          const local = meta.anchor ? `/docs/API-KEYS.md#${meta.anchor}` : '/docs/API-KEYS.md';
          window.open(local, '_blank', 'noopener');
        });
      } else {
        replacement.className = 'env-help-placeholder';
        replacement.setAttribute('aria-hidden', 'true');
      }
      existing.replaceWith(replacement);
    });
  });
}

function collectEnvEntries(scopeId = 'setup-env') {
  return [...document.querySelectorAll(`#${scopeId} .env-row`)]
    .map((row) => ({
      key: row.querySelector('.env-key').value.trim(),
      value: row.querySelector('.env-value').value,
    }))
    .filter((e) => e.key.length > 0);
}

// Validate format + (optionally) live-probe a single env row by calling
// /api/env/test. Sibling row values are sent as `extras` so multi-key sources
// (Reddit needs id+secret+UA, Bluesky needs handle+app password) test the
// values currently in the form, not whatever is persisted to .env.
async function testEnvRow(btn, scopeId) {
  const row = btn.closest('.env-row');
  if (!row) return;
  const keyInput = row.querySelector('.env-key');
  const valueInput = row.querySelector('.env-value');
  const status = row.querySelector('.env-status');
  const key = keyInput.value.trim();
  const value = valueInput.value;
  if (!key) {
    status.className = 'env-status env-status-warn';
    status.textContent = 'Enter a key name first.';
    return;
  }
  // Gather sibling values to send as extras (don't include the row under test).
  const extras = {};
  for (const e of collectEnvEntries(scopeId)) {
    if (e.key !== key && e.value) extras[e.key] = e.value;
  }
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Testing\u2026';
  status.className = 'env-status';
  status.textContent = 'Checking format and reachability\u2026';
  try {
    const res = await fetch('/api/env/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value, extras, liveTest: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      status.className = 'env-status env-status-fail';
      status.textContent = `Error: ${data.error || res.status}`;
      return;
    }
    const parts = [];
    let cls = 'env-status-ok';
    if (!data.format.ok) {
      cls = 'env-status-fail';
      parts.push(`Format: ${data.format.message}`);
    } else {
      parts.push('Format \u2713');
    }
    if (data.reachability) {
      const r = data.reachability;
      if (r.reachable === true) {
        parts.push(`Reachable \u2713 ${r.message ? '(' + r.message + ')' : ''}`);
      } else if (r.reachable === false) {
        cls = 'env-status-fail';
        parts.push(`Reachable \u2717 ${r.message || `status ${r.status}`}`);
      } else {
        parts.push(r.message || 'no reachability test');
      }
    } else if (data.format.ok && data.supported) {
      parts.push('(skipped live test)');
    } else if (!data.supported) {
      parts.push('(no live test available for this key)');
    }
    status.className = `env-status ${cls}`;
    status.textContent = parts.join(' \u2014 ');
  } catch (err) {
    status.className = 'env-status env-status-fail';
    status.textContent = `Error: ${err.message || err}`;
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// Persist the agent choice automatically whenever it changes — no Save button.
let agentSaveToken = 0;
async function saveAgentChoice() {
  if (!agentChoice) return;
  if (cachedStatus && cachedStatus.runnerLocked) return;
  const body = { agent: agentChoice };
  if (agentChoice === 'custom') {
    const runner = ($('agent-custom-runner')?.value || '').trim();
    if (!runner) {
      $('agent-status').textContent = 'Enter a custom command to save.';
      return;
    }
    body.runner = runner;
  }
  const token = ++agentSaveToken;
  $('agent-status').textContent = 'saving…';
  try {
    await api('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (token !== agentSaveToken) return; // a newer save superseded this one
    $('agent-status').textContent = 'saved ✓';
    await loadStatus();
  } catch (err) {
    if (token !== agentSaveToken) return;
    $('agent-status').textContent = `error: ${err.message}`;
  }
}

$('setup-run-onboard').addEventListener('click', async () => {
  // Jump to Run view with scout-onboard preselected.
  gotoView('run');
  $('run-command').value = 'scout-onboard';
  $('run-command').dispatchEvent(new Event('change'));
});

// --- Embedded scout-onboard CLI (inside the "Prefer guided chat wizard?" disclosure) ---
(() => {
  const details = $('onboard-cli-details');
  const startBtn = $('onboard-cli-start');
  const stopBtn = $('onboard-cli-stop');
  const sendBtn = $('onboard-cli-send');
  const input = $('onboard-cli-input');
  const output = $('onboard-cli-output');
  const statusEl = $('onboard-cli-status');
  const form = $('onboard-cli-form');
  if (!details || !startBtn) return;

  let runId = null;
  let stream = null;

  function setStatus(text, tone) {
    statusEl.textContent = text || '';
    statusEl.dataset.tone = tone || '';
  }
  function setRunning(running) {
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    input.disabled = !running;
    sendBtn.disabled = !running;
    startBtn.textContent = running ? 'Running…' : 'Start /scout-onboard';
  }
  function appendOutput(chunk) {
    output.textContent += chunk;
    output.scrollTop = output.scrollHeight;
  }

  async function startOnboard() {
    output.textContent = '';
    setStatus('Starting…');
    setRunning(true);
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'scout-onboard', args: {} }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRunning(false);
        setStatus(data.error || 'Failed to start', 'error');
        if (data.prompt) {
          appendOutput(`Prompt: ${data.prompt}\n\nSet an agent on this page (or SCOUT_RUNNER env var) to execute.\n`);
        }
        return;
      }
      runId = data.id;
      setStatus(`Running: ${data.command}`);
      stream = new EventSource(`/api/runs/${runId}/stream`);
      stream.onmessage = (e) => {
        try { appendOutput(JSON.parse(e.data).chunk || ''); } catch {}
      };
      stream.addEventListener('done', (e) => {
        try {
          const { status } = JSON.parse(e.data);
          setStatus(`Done: ${status}`, status === 'exit-0' ? 'ok' : 'error');
        } catch {
          setStatus('Done');
        }
        setRunning(false);
        stream && stream.close();
        stream = null;
      });
      stream.onerror = () => { stream && stream.close(); stream = null; setRunning(false); };
    } catch (err) {
      setRunning(false);
      setStatus(`error: ${err.message}`, 'error');
    }
  }

  async function stopOnboard() {
    if (!runId) return;
    setStatus('Stopping…');
    try {
      await fetch(`/api/runs/${runId}/stop`, { method: 'POST' });
    } catch (err) {
      setStatus(`stop failed: ${err.message}`, 'error');
    }
  }

  async function sendReply(text) {
    if (!runId || !text) return;
    try {
      const res = await fetch(`/api/runs/${runId}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStatus(data.error || 'Send failed', 'error');
      }
    } catch (err) {
      setStatus(`send failed: ${err.message}`, 'error');
    }
  }

  startBtn.addEventListener('click', startOnboard);
  stopBtn.addEventListener('click', stopOnboard);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    sendReply(text);
  });
})();

// --- New config form ------------------------------------------------
function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}
// Auto-fill slug from name until the user edits slug manually.
let cfgSlugEdited = false;
const cfgNameEl = document.querySelector('.cfg-entry [data-field="name"]');
const cfgSlugEl = document.querySelector('.cfg-entry [data-field="slug"]');
if (cfgSlugEl) cfgSlugEl.addEventListener('input', () => { cfgSlugEdited = true; });
if (cfgNameEl && cfgSlugEl) {
  cfgNameEl.addEventListener('input', () => {
    if (!cfgSlugEdited) cfgSlugEl.value = slugify(cfgNameEl.value);
  });
}

// Live "already saved" hint: warn the user if the slug they're entering
// already has a saved config so they don't get a 409 at submit time.
const cfgSlugExistsHintEl = document.getElementById('cfg-slug-exists-hint');
let cfgExistingSlugsCache = null;
let cfgExistingSlugsCacheAt = 0;
async function getExistingSlugs() {
  // Cache for 5s so we don't hammer the API on every keystroke.
  if (cfgExistingSlugsCache && Date.now() - cfgExistingSlugsCacheAt < 5000) return cfgExistingSlugsCache;
  try {
    const { configs } = await api('/api/configs');
    cfgExistingSlugsCache = (configs || []).map((c) => c.slug);
    cfgExistingSlugsCacheAt = Date.now();
  } catch {
    cfgExistingSlugsCache = [];
  }
  return cfgExistingSlugsCache;
}
async function refreshSlugExistsHint() {
  if (!cfgSlugExistsHintEl) return;
  const current = slugify(cfgSlugEl?.value || cfgNameEl?.value || '');
  if (!current) {
    cfgSlugExistsHintEl.style.display = 'none';
    return;
  }
  const slugs = await getExistingSlugs();
  if (slugs.includes(current)) {
    cfgSlugExistsHintEl.innerHTML =
      `⚠ Already saved as <strong>${current}</strong>. ` +
      `<a href="#" id="cfg-slug-edit-existing">Edit existing</a> · ` +
      `or continue here to overwrite on save.`;
    cfgSlugExistsHintEl.style.display = '';
    cfgSlugExistsHintEl.style.color = 'var(--warn, #f0b400)';
    const link = document.getElementById('cfg-slug-edit-existing');
    if (link) link.addEventListener('click', (e) => {
      e.preventDefault();
      gotoView('configs');
      setTimeout(() => {
        const li = document.querySelector(`#config-list li[data-slug="${current}"]`);
        if (li) li.click();
      }, 200);
    });
  } else {
    cfgSlugExistsHintEl.style.display = 'none';
  }
}
cfgNameEl?.addEventListener('input', () => { cfgExistingSlugsCacheAt = 0; refreshSlugExistsHint(); });
cfgSlugEl?.addEventListener('input', () => { cfgExistingSlugsCacheAt = 0; refreshSlugExistsHint(); });
// Also refresh when the user re-enters the wizard in case configs changed.
document.querySelector('nav button[data-view="setup"]')?.addEventListener('click', () => {
  cfgExistingSlugsCacheAt = 0;
  refreshSlugExistsHint();
});

// Tier picker — toggles a data-tier attribute on <body> so CSS can show/hide sections.
const TIER_DESCRIPTIONS = {
  quick: 'Just the basics: subject name, type, and your role(s). Great for a first run — everything else uses sensible defaults.',
  standard: 'Basics plus search terms, hashtags, topic tags, and which networks to scan. Recommended for most subjects.',
  full: 'Every setting: competitors, conferences, author watchlist, brand assets, custom sources, and per-feature toggles.',
};
function setTier(tier) {
  document.body.dataset.tier = tier;
  const desc = $('cfg-tier-desc');
  if (desc) desc.textContent = TIER_DESCRIPTIONS[tier] || '';
}
document.querySelectorAll('input[name="cfg-tier"]').forEach((el) => {
  el.addEventListener('change', () => { if (el.checked) setTier(el.value); });
});
setTier(document.querySelector('input[name="cfg-tier"]:checked')?.value || 'standard');

// --- Roles: dropdown + chip UI -------------------------------------
// Presets cache so we can render chip labels from ids.
let rolePresetsCache = [];
async function loadRolePresets() {
  try {
    const { presets } = await api('/api/role-presets');
    rolePresetsCache = presets;
    const sel = $('cfg-role-select');
    if (!sel) return;
    // Rebuild options while keeping "Other" and placeholder.
    sel.innerHTML =
      '<option value="">— select a preset role —</option>' +
      presets.map((p) => `<option value="${p.id}">${escape(p.label)}</option>`).join('') +
      '<option value="__custom__">Other (type your own)…</option>';
    // Update hint when selection changes.
    sel.addEventListener('change', () => {
      const val = sel.value;
      $('cfg-role-custom-wrap').hidden = val !== '__custom__';
      const preset = presets.find((p) => p.id === val);
      $('cfg-role-hint').textContent = preset ? preset.focus : '';
    });
  } catch (err) {
    console.error('failed to load roles', err);
  }
}
loadRolePresets();

// Chip list state — array of {kind:'preset'|'custom', id, label}.
const chosenRoles = [];
function renderRoleChips() {
  const host = $('cfg-roles-chosen');
  if (!host) return;
  if (chosenRoles.length === 0) {
    host.innerHTML = '<span class="hint">No roles added yet. Pick one above and press <strong>+ Add role</strong>.</span>';
    return;
  }
  host.innerHTML = chosenRoles
    .map((r, i) => `
      <span class="role-chip" data-idx="${i}">
        <span class="role-chip-label">${escape(r.label)}</span>
        <button type="button" class="role-chip-remove" data-remove="${i}" aria-label="Remove role">×</button>
      </span>
    `)
    .join('');
}
renderRoleChips();

$('cfg-role-add')?.addEventListener('click', () => {
  const sel = $('cfg-role-select');
  const val = sel.value;
  if (!val) {
    $('cfg-role-hint').textContent = 'Pick a role from the list first.';
    return;
  }
  if (val === '__custom__') {
    const text = $('cfg-role-custom-input').value.trim();
    if (!text) {
      $('cfg-role-hint').textContent = 'Type a custom role label to add it.';
      $('cfg-role-custom-input').focus();
      return;
    }
    if (chosenRoles.some((r) => r.kind === 'custom' && r.label.toLowerCase() === text.toLowerCase())) {
      $('cfg-role-hint').textContent = 'That role is already added.';
      return;
    }
    chosenRoles.push({ kind: 'custom', id: null, label: text });
    $('cfg-role-custom-input').value = '';
    $('cfg-role-hint').textContent = '';
  } else {
    if (chosenRoles.some((r) => r.id === val)) {
      $('cfg-role-hint').textContent = 'That role is already added.';
      return;
    }
    const preset = rolePresetsCache.find((p) => p.id === val);
    chosenRoles.push({ kind: 'preset', id: val, label: preset?.label || val });
  }
  sel.value = '';
  $('cfg-role-custom-wrap').hidden = true;
  renderRoleChips();
});

$('cfg-roles-chosen')?.addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-remove]');
  if (!btn) return;
  const idx = Number(btn.dataset.remove);
  chosenRoles.splice(idx, 1);
  renderRoleChips();
});

// --- Topic tag suggestions -----------------------------------------
// "✨ Suggest tags" calls a deterministic server-side heuristic that seeds a
// starter set based on subject type + search terms. Clicking a chip toggles it
// in the input.
function parseTagList(s) {
  return (s || '').split(',').map((t) => t.trim()).filter(Boolean);
}
function currentTopicTagList() { return parseTagList($('cfg-topic-tags')?.value || ''); }
function setTopicTagList(tags) {
  const el = $('cfg-topic-tags');
  if (!el) return;
  el.value = tags.join(', ');
  renderTagSuggestChips();
}
function renderTagSuggestChips() {
  const host = $('cfg-topic-suggest-chips');
  if (!host || host.hidden) return;
  const chosen = new Set(currentTopicTagList().map((t) => t.toLowerCase()));
  host.querySelectorAll('.tag-chip').forEach((chip) => {
    chip.classList.toggle('selected', chosen.has(chip.dataset.tag.toLowerCase()));
  });
}
$('cfg-topic-suggest')?.addEventListener('click', async () => {
  const btn = $('cfg-topic-suggest');
  const status = $('cfg-topic-suggest-status');
  const chips = $('cfg-topic-suggest-chips');
  const nameEl = document.querySelector('.cfg-entry [data-field="name"]');
  const typeEl = document.querySelector('.cfg-entry [data-field="type"]');
  const termsEl = document.querySelector('[data-field="terms"]');
  const name = (nameEl?.value || '').trim();
  const type = typeEl?.value || 'product';
  const searchTerms = parseTagList(termsEl?.value || '');
  if (!name && searchTerms.length === 0) {
    status.textContent = 'Add a subject name or search terms first.';
    return;
  }
  btn.disabled = true;
  status.textContent = 'Thinking…';
  try {
    const res = await fetch('/api/suggest-topic-tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, type, searchTerms }),
    });
    const data = await res.json();
    if (!res.ok) {
      status.textContent = data.error || 'Failed';
      return;
    }
    const suggestions = data.suggestions || [];
    if (suggestions.length === 0) {
      status.textContent = 'No suggestions.';
      return;
    }
    chips.hidden = false;
    chips.innerHTML = suggestions
      .map((t) => `<span class="tag-chip-wrap"><button type="button" class="tag-chip" data-tag="${escape(t)}">${escape(t)}</button><button type="button" class="tag-chip-x" data-tag="${escape(t)}" title="Remove suggestion" aria-label="Remove suggestion">×</button></span>`)
      .join('');
    status.textContent = `${suggestions.length} suggestions — click to add or remove.`;
    renderTagSuggestChips();
  } catch (err) {
    status.textContent = `error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});
$('cfg-topic-suggest-chips')?.addEventListener('click', (e) => {
  const chip = e.target.closest?.('.tag-chip');
  if (!chip) return;
  const tag = chip.dataset.tag;
  const current = currentTopicTagList();
  const idx = current.findIndex((t) => t.toLowerCase() === tag.toLowerCase());
  if (idx >= 0) current.splice(idx, 1);
  else current.push(tag);
  setTopicTagList(current);
});
$('cfg-topic-tags')?.addEventListener('input', renderTagSuggestChips);

// --- Identity suggestions (search terms + hashtags) -----------------
// Both inputs share the same /api/suggest-identity call; results are split.
// Chips behave like topic-tag chips: click to toggle in/out of the input.
function wireIdentitySuggest(inputId, btnId, statusId, chipsId, kind) {
  const inputEl = $(inputId);
  const btn = $(btnId);
  const status = $(statusId);
  const chips = $(chipsId);
  if (!btn) return;

  function render() {
    if (!chips || chips.hidden) return;
    const chosen = new Set(parseTagList(inputEl?.value || '').map((t) => t.toLowerCase()));
    chips.querySelectorAll('.tag-chip').forEach((chip) => {
      chip.classList.toggle('selected', chosen.has(chip.dataset.tag.toLowerCase()));
    });
  }

  btn.addEventListener('click', async () => {
    const name = (document.querySelector('.cfg-entry [data-field="name"]')?.value || '').trim();
    const type = document.querySelector('.cfg-entry [data-field="type"]')?.value || 'product';
    if (!name) {
      status.textContent = 'Add a subject name first (step 3).';
      return;
    }
    btn.disabled = true;
    status.textContent = 'Thinking…';
    try {
      const res = await fetch('/api/suggest-identity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, type }),
      });
      const data = await res.json();
      if (!res.ok) { status.textContent = data.error || 'Failed'; return; }
      const pool = data[kind] || [];
      if (!pool.length) { status.textContent = 'No suggestions.'; return; }
      chips.hidden = false;
      chips.innerHTML = pool
        .map((t) => `<span class="tag-chip-wrap"><button type="button" class="tag-chip" data-tag="${escape(t)}">${escape(t)}</button><button type="button" class="tag-chip-x" data-tag="${escape(t)}" title="Remove suggestion" aria-label="Remove suggestion">×</button></span>`)
        .join('');
      status.textContent = `${pool.length} suggestions — click to add or remove.`;
      render();
    } catch (err) {
      status.textContent = `error: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  chips?.addEventListener('click', (e) => {
    const chip = e.target.closest?.('.tag-chip');
    if (!chip) return;
    const tag = chip.dataset.tag;
    const current = parseTagList(inputEl.value);
    const idx = current.findIndex((t) => t.toLowerCase() === tag.toLowerCase());
    if (idx >= 0) current.splice(idx, 1);
    else current.push(tag);
    inputEl.value = current.join(', ');
    render();
  });
  inputEl?.addEventListener('input', render);
}
wireIdentitySuggest('cfg-terms', 'cfg-terms-suggest', 'cfg-terms-suggest-status', 'cfg-terms-suggest-chips', 'terms');
wireIdentitySuggest('cfg-hashtags', 'cfg-hashtags-suggest', 'cfg-hashtags-suggest-status', 'cfg-hashtags-suggest-chips', 'hashtags');

// --- Advanced step suggestions -------------------------------------
// Three flavors:
//   1) Single-select chip group → clicking a chip replaces the input value
//      (used for blog URL + YouTube channel, which are scalar fields).
//   2) Multi-select chip group → clicking toggles in/out of a comma-separated
//      list (used for social accounts, competitors, conferences).
function subjectNameForSuggest() {
  return (document.querySelector('.cfg-entry [data-field="name"]')?.value || '').trim();
}
function subjectSlugForSuggest() {
  return (document.querySelector('.cfg-entry [data-field="slug"]')?.value || '').trim();
}

function wireSingleSelectChip(inputField, chipsId) {
  const chips = document.getElementById(chipsId);
  if (!chips) return;
  chips.addEventListener('click', (e) => {
    const chip = e.target.closest?.('.tag-chip');
    if (!chip) return;
    const input = document.querySelector(`.cfg-entry [data-field="${inputField}"]`);
    if (!input) return;
    input.value = chip.dataset.tag;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // Visually mark the chosen chip.
    chips.querySelectorAll('.tag-chip').forEach((c) => c.classList.toggle('selected', c === chip));
  });
}

function wireMultiSelectChip(inputField, chipsId) {
  const chips = document.getElementById(chipsId);
  if (!chips) return;
  function render() {
    const input = document.querySelector(`.cfg-entry [data-field="${inputField}"]`);
    const chosen = new Set(parseTagList(input?.value || '').map((t) => t.toLowerCase()));
    chips.querySelectorAll('.tag-chip').forEach((chip) => {
      chip.classList.toggle('selected', chosen.has((chip.dataset.tag || '').toLowerCase()));
    });
  }
  chips.addEventListener('click', (e) => {
    const chip = e.target.closest?.('.tag-chip');
    if (!chip) return;
    const input = document.querySelector(`.cfg-entry [data-field="${inputField}"]`);
    if (!input) return;
    const tag = chip.dataset.tag;
    const current = parseTagList(input.value);
    const idx = current.findIndex((t) => t.toLowerCase() === tag.toLowerCase());
    if (idx >= 0) current.splice(idx, 1);
    else current.push(tag);
    input.value = current.join(', ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    render();
  });
  const input = document.querySelector(`.cfg-entry [data-field="${inputField}"]`);
  input?.addEventListener('input', render);
  chips._renderMulti = render;
}

function renderChips(chipsId, items) {
  const chips = document.getElementById(chipsId);
  if (!chips) return;
  if (!items || !items.length) {
    chips.hidden = true;
    chips.innerHTML = '';
    return;
  }
  chips.hidden = false;
  chips.innerHTML = items
    .map((t) => `<span class="tag-chip-wrap"><button type="button" class="tag-chip" data-tag="${escape(t)}">${escape(t)}</button><button type="button" class="tag-chip-x" data-tag="${escape(t)}" title="Remove suggestion" aria-label="Remove suggestion">×</button></span>`)
    .join('');
  if (chips._renderMulti) chips._renderMulti();
}

// Delegated handler: clicking the × on any chip removes that chip's wrapper
// from the suggestion list and also removes the matching value from the
// associated input/textarea (so "selected" chips can be deleted in one click).
document.addEventListener('click', (e) => {
  const x = e.target.closest?.('.tag-chip-x');
  if (!x) return;
  e.preventDefault();
  e.stopPropagation();
  const tag = x.dataset.tag || '';
  const wrap = x.closest('.tag-chip-wrap');
  const chips = wrap?.parentElement;
  // Remove from any matching field. Try the multi-select chip's data-input,
  // otherwise fall back to scanning all .cfg-entry textareas/inputs.
  if (chips) {
    // Find inputs whose value contains this tag (comma list or newline list).
    document.querySelectorAll('.cfg-entry [data-field]').forEach((el) => {
      if (!('value' in el) || typeof el.value !== 'string' || !el.value) return;
      const isTextarea = el.tagName === 'TEXTAREA';
      const sep = isTextarea ? /\r?\n/ : /,\s*/;
      const parts = el.value.split(sep).map((p) => p.trim());
      const idx = parts.findIndex((p) => p.toLowerCase() === tag.toLowerCase());
      if (idx >= 0) {
        parts.splice(idx, 1);
        el.value = parts.filter(Boolean).join(isTextarea ? '\n' : ', ');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }
  wrap?.remove();
  if (chips && !chips.querySelector('.tag-chip-wrap')) chips.hidden = true;
});

// Wire chip groups.
wireMultiSelectChip('exclBlog', 'cfg-blog-suggest-chips');
wireMultiSelectChip('exclYoutube', 'cfg-youtube-suggest-chips');
wireMultiSelectChip('exclHandles', 'cfg-social-suggest-chips');
wireMultiSelectChip('competitors', 'cfg-competitors-suggest-chips');
wireMultiSelectChip('conferences', 'cfg-conferences-suggest-chips');

// Suggest channels (blog + YouTube + social).
$('cfg-channels-suggest')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const name = subjectNameForSuggest();
  const status = $('cfg-channels-suggest-status');
  if (!name) { if (status) status.textContent = 'Add a subject name first (step 3).'; return; }
  e.target.disabled = true;
  if (status) status.textContent = 'Thinking…';
  try {
    const res = await fetch('/api/suggest-channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, slug: subjectSlugForSuggest() }),
    });
    const data = await res.json();
    if (!res.ok) { if (status) status.textContent = data.error || 'Failed'; return; }
    renderChips('cfg-blog-suggest-chips', data.blog || []);
    renderChips('cfg-youtube-suggest-chips', data.youtube || []);
    renderChips('cfg-social-suggest-chips', data.social || []);
    if (status) status.textContent = 'Suggestions are best-guesses — verify before saving.';
  } catch (err) {
    if (status) status.textContent = `error: ${err.message}`;
  } finally {
    e.target.disabled = false;
  }
});

// Suggest competitors + conferences (one endpoint returns both).
async function fetchRelatedSuggestions() {
  const name = subjectNameForSuggest();
  if (!name) return null;
  const res = await fetch('/api/suggest-related', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return null;
  return res.json();
}
$('cfg-competitors-suggest')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const status = $('cfg-competitors-suggest-status');
  const name = subjectNameForSuggest();
  if (!name) { if (status) status.textContent = 'Add a subject name first (step 3).'; return; }
  e.target.disabled = true;
  if (status) status.textContent = 'Thinking…';
  try {
    const data = await fetchRelatedSuggestions();
    const list = (data && data.competitors) || [];
    renderChips('cfg-competitors-suggest-chips', list);
    if (status) status.textContent = list.length ? `${list.length} suggestions — click to add or remove.` : 'No suggestions for this subject.';
  } catch (err) {
    if (status) status.textContent = `error: ${err.message}`;
  } finally {
    e.target.disabled = false;
  }
});
$('cfg-conferences-suggest')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const status = $('cfg-conferences-suggest-status');
  const name = subjectNameForSuggest();
  if (!name) { if (status) status.textContent = 'Add a subject name first (step 3).'; return; }
  e.target.disabled = true;
  if (status) status.textContent = 'Thinking…';
  try {
    const data = await fetchRelatedSuggestions();
    const list = (data && data.conferences) || [];
    renderChips('cfg-conferences-suggest-chips', list);
    if (status) status.textContent = list.length ? `${list.length} suggestions — click to add or remove.` : 'No suggestions for this subject.';
  } catch (err) {
    if (status) status.textContent = `error: ${err.message}`;
  } finally {
    e.target.disabled = false;
  }
});

// Insert whole lines into a textarea on chip click (for watchlist-style fields).
function wireTextareaLineChip(inputField, chipsId) {
  const chips = document.getElementById(chipsId);
  if (!chips) return;
  function currentLines() {
    const input = document.querySelector(`.cfg-entry [data-field="${inputField}"]`);
    return (input?.value || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  function render() {
    const chosen = new Set(currentLines().map((l) => l.toLowerCase()));
    chips.querySelectorAll('.tag-chip').forEach((chip) => {
      chip.classList.toggle('selected', chosen.has((chip.dataset.tag || '').toLowerCase()));
    });
  }
  chips.addEventListener('click', (e) => {
    const chip = e.target.closest?.('.tag-chip');
    if (!chip) return;
    const input = document.querySelector(`.cfg-entry [data-field="${inputField}"]`);
    if (!input) return;
    const line = chip.dataset.tag;
    const lines = currentLines();
    const idx = lines.findIndex((l) => l.toLowerCase() === line.toLowerCase());
    if (idx >= 0) lines.splice(idx, 1);
    else lines.push(line);
    input.value = lines.join('\n');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    render();
  });
  const input = document.querySelector(`.cfg-entry [data-field="${inputField}"]`);
  input?.addEventListener('input', render);
  chips._renderMulti = render;
}

wireTextareaLineChip('watchlist', 'cfg-watchlist-suggest-chips');
wireTextareaLineChip('influencers', 'cfg-influencers-suggest-chips');
wireTextareaLineChip('exclRepos', 'cfg-exclrepos-suggest-chips');
wireTextareaLineChip('exclDomains', 'cfg-excldomains-suggest-chips');

// "Add one at a time" lists for official channels — backed by hidden inputs
// that wireMultiSelectChip already syncs with their suggest chips. When the
// underlying value changes (Add, ✕ remove, or suggest-chip toggle), we
// re-render the visible chip list.
function wireAddOneAtATime({ field, listId, addInputId, addBtnId }) {
  const input = document.querySelector(`.cfg-entry [data-field="${field}"]`);
  const list = document.getElementById(listId);
  const addInput = document.getElementById(addInputId);
  const addBtn = document.getElementById(addBtnId);
  if (!input || !list) return () => {};
  function render() {
    const items = parseTagList(input.value);
    if (!items.length) { list.hidden = true; list.innerHTML = ''; return; }
    list.hidden = false;
    list.innerHTML = items.map((h) => {
      const safe = escape(h);
      return `<span class="chip" data-value="${safe}">${safe}<button type="button" aria-label="Remove ${safe}" data-remove="${safe}">×</button></span>`;
    }).join('');
  }
  input.addEventListener('input', render);
  list.addEventListener('click', (e) => {
    const btn = e.target.closest?.('button[data-remove]');
    if (!btn) return;
    const target = btn.dataset.remove;
    const remaining = parseTagList(input.value).filter((h) => h !== target);
    input.value = remaining.join(', ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  addBtn?.addEventListener('click', () => {
    if (!addInput) return;
    const val = addInput.value.trim();
    if (!val) return;
    const current = parseTagList(input.value);
    if (!current.some((h) => h.toLowerCase() === val.toLowerCase())) {
      current.push(val);
      input.value = current.join(', ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    addInput.value = '';
    addInput.focus();
  });
  addInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addBtn?.click(); }
  });
  render();
  return render;
}
const renderBlogList = wireAddOneAtATime({ field: 'exclBlog', listId: 'cfg-blog-list', addInputId: 'cfg-blog-add-input', addBtnId: 'cfg-blog-add-btn' });
const renderYoutubeList = wireAddOneAtATime({ field: 'exclYoutube', listId: 'cfg-youtube-list', addInputId: 'cfg-youtube-add-input', addBtnId: 'cfg-youtube-add-btn' });
const renderHandlesList = wireAddOneAtATime({ field: 'exclHandles', listId: 'cfg-handles-list', addInputId: 'cfg-handle-add-input', addBtnId: 'cfg-handle-add-btn' });

$('cfg-watchlist-suggest')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const status = $('cfg-watchlist-suggest-status');
  const name = subjectNameForSuggest();
  if (!name) { if (status) status.textContent = 'Add a subject name first (step 3).'; return; }
  e.target.disabled = true;
  if (status) status.textContent = 'Thinking…';
  try {
    const res = await fetch('/api/suggest-authors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    const list = (data && data.authors) || [];
    renderChips('cfg-watchlist-suggest-chips', list);
    if (status) {
      status.textContent = list.length
        ? `${list.length} suggestions — verify each before saving (public figures only, may be stale).`
        : 'No known community authors for this subject yet. Add your own.';
    }
  } catch (err) {
    if (status) status.textContent = `error: ${err.message}`;
  } finally {
    e.target.disabled = false;
  }
});

// --- Advanced section "Suggest" buttons ---------------------------
// Brand assets, Social post standards, Posting prefs, Language & region.
// All four call /api/suggest-brand-defaults and only fill empty fields so
// users don't lose their edits.
async function fetchBrandDefaults() {
  const name = subjectNameForSuggest();
  if (!name) return null;
  const res = await fetch('/api/suggest-brand-defaults', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return null;
  return res.json();
}
function fillIfEmpty(field, value) {
  // Brand/SPS/posting/language fields live outside `.cfg-entry`, so look in
  // the whole wizard. Prefer the cfg-entry version when both exist (e.g. for
  // future per-subject fields), then fall back to a global lookup.
  const wizard = document.getElementById('wizard') || document;
  const el = wizard.querySelector(`.cfg-entry [data-field="${field}"]`)
    || wizard.querySelector(`[data-field="${field}"]`);
  if (!el || value == null || value === '') return false;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}
function wireSectionSuggest(btnId, statusId, applyFn) {
  $(btnId)?.addEventListener('click', async (e) => {
    e.preventDefault();
    const status = $(statusId);
    const name = subjectNameForSuggest();
    if (!name) { if (status) status.textContent = 'Add a subject name first (step 3).'; return; }
    e.target.disabled = true;
    if (status) status.textContent = 'Thinking…';
    try {
      const data = await fetchBrandDefaults();
      if (!data) { if (status) status.textContent = 'Could not load suggestions.'; return; }
      const filled = applyFn(data);
      if (status) {
        status.textContent = filled
          ? `Filled ${filled} field${filled === 1 ? '' : 's'} with starter defaults — edit anything you'd like.`
          : 'No suggestions returned — try again or fill manually.';
      }
    } catch (err) {
      if (status) status.textContent = `error: ${err.message}`;
    } finally {
      e.target.disabled = false;
    }
  });
}
wireSectionSuggest('cfg-brand-suggest', 'cfg-brand-suggest-status', (d) => {
  let n = 0;
  const b = d.brand || {};
  if (fillIfEmpty('brandProductName', b.productName)) n++;
  if (fillIfEmpty('brandLogoRules', b.logoRules)) n++;
  const c = b.colors || {};
  if (fillIfEmpty('brandColorBg', c.bg)) n++;
  if (fillIfEmpty('brandColorAccent', c.accent)) n++;
  if (fillIfEmpty('brandColorHighlight', c.highlight)) n++;
  if (fillIfEmpty('brandColorText', c.text)) n++;
  if (fillIfEmpty('brandFont', b.font)) n++;
  if (fillIfEmpty('brandComposition', b.composition)) n++;
  if (fillIfEmpty('brandGuardrails', b.guardrails)) n++;
  return n;
});
wireSectionSuggest('cfg-sps-suggest', 'cfg-sps-suggest-status', (d) => {
  let n = 0;
  const s = d.socialStandards || {};
  if (fillIfEmpty('spsAudience', s.audience)) n++;
  if (fillIfEmpty('spsTone', s.tone)) n++;
  if (fillIfEmpty('spsShortName', s.shortName)) n++;
  if (fillIfEmpty('spsNeverWrite', s.neverWrite)) n++;
  if (fillIfEmpty('spsAvoidWords', s.avoidWords)) n++;
  if (fillIfEmpty('spsEmoji', s.emoji)) n++;
  if (fillIfEmpty('spsHashtag', s.hashtag)) n++;
  if (fillIfEmpty('spsThingsAvoid', s.thingsAvoid)) n++;
  if (fillIfEmpty('spsAdditional', s.additional)) n++;
  return n;
});
wireSectionSuggest('cfg-post-suggest', 'cfg-post-suggest-status', (d) => {
  let n = 0;
  const p = d.postingPrefs || {};
  if (fillIfEmpty('postFrequency', p.frequency)) n++;
  if (fillIfEmpty('postAvoid', p.avoid)) n++;
  if (fillIfEmpty('postApproval', p.approval)) n++;
  if (fillIfEmpty('postTagTeam', p.tagTeam)) n++;
  return n;
});
wireSectionSuggest('cfg-lang-suggest', 'cfg-lang-suggest-status', (d) => {
  let n = 0;
  const l = d.language || {};
  if (fillIfEmpty('langs', l.langs)) n++;
  if (fillIfEmpty('regions', l.regions)) n++;
  return n;
});

// Influencers / excluded repos / excluded domains — these populate textareas
// (one per line) and use wireTextareaLineChip for click-to-toggle behavior.
async function fetchExtras() {
  const name = subjectNameForSuggest();
  const slug = subjectSlugForSuggest();
  if (!name) return null;
  const res = await fetch('/api/suggest-extras', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, slug }),
  });
  if (!res.ok) return null;
  return res.json();
}
function wireExtraSuggest(btnId, statusId, chipsId, key, emptyMsg) {
  $(btnId)?.addEventListener('click', async (e) => {
    e.preventDefault();
    const status = $(statusId);
    const name = subjectNameForSuggest();
    if (!name) { if (status) status.textContent = 'Add a subject name first (step 3).'; return; }
    e.target.disabled = true;
    if (status) status.textContent = 'Thinking…';
    try {
      const data = await fetchExtras();
      const list = (data && data[key]) || [];
      renderChips(chipsId, list);
      if (status) {
        status.textContent = list.length
          ? `${list.length} suggestions — click to add or remove.`
          : emptyMsg;
      }
    } catch (err) {
      if (status) status.textContent = `error: ${err.message}`;
    } finally {
      e.target.disabled = false;
    }
  });
}
wireExtraSuggest('cfg-influencers-suggest', 'cfg-influencers-suggest-status', 'cfg-influencers-suggest-chips', 'influencers', 'No known influencers for this subject yet. Add your own.');
wireExtraSuggest('cfg-exclrepos-suggest', 'cfg-exclrepos-suggest-status', 'cfg-exclrepos-suggest-chips', 'repos', 'No repo suggestions for this subject — add manually.');
wireExtraSuggest('cfg-excldomains-suggest', 'cfg-excldomains-suggest-status', 'cfg-excldomains-suggest-chips', 'domains', 'No domain suggestions for this subject — add manually.');
// Lets the user pick image files; we upload each to the server which stores
// them under social-posts/images/brand/{slug}/ and fills in brandLogoDir.
function subjectSlugForLogo() {
  const slug = (document.querySelector('.cfg-entry [data-field="slug"]')?.value || '').trim();
  if (slug) return slug;
  const name = (document.querySelector('.cfg-entry [data-field="name"]')?.value || '').trim();
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

async function renderLogoPreview(dir) {
  const preview = $('cfg-logo-preview');
  if (!preview) return;
  if (!dir) { preview.hidden = true; preview.innerHTML = ''; return; }
  try {
    const res = await fetch(`/api/list-logos?dir=${encodeURIComponent(dir)}`);
    const data = await res.json();
    const files = (data && data.files) || [];
    if (!files.length) { preview.hidden = true; preview.innerHTML = ''; return; }
    // dir is like "social-posts/images/brand/slug/" → served at /brand-assets/brand/slug/
    const webBase = '/brand-assets/' + dir.replace(/^social-posts\/images\//, '').replace(/\/+$/, '') + '/';
    preview.hidden = false;
    preview.innerHTML = files
      .map((f) => `<figure class="logo-thumb"><img src="${webBase}${encodeURIComponent(f)}" alt="${escape(f)}" loading="lazy" /><figcaption>${escape(f)}</figcaption></figure>`)
      .join('');
  } catch {
    preview.hidden = true;
    preview.innerHTML = '';
  }
}

$('cfg-logo-browse')?.addEventListener('click', (e) => {
  e.preventDefault();
  $('cfg-logo-file')?.click();
});

$('cfg-logo-file')?.addEventListener('change', async (e) => {
  const input = e.target;
  const files = Array.from(input.files || []);
  const status = $('cfg-logo-status');
  const dirField = document.querySelector('.cfg-entry [data-field="brandLogoDir"]');
  if (!files.length) return;
  const slug = subjectSlugForLogo();
  if (!slug) {
    if (status) status.textContent = 'Add a subject name (step 3) before uploading logos.';
    input.value = '';
    return;
  }
  if (status) status.textContent = `Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`;
  let uploaded = 0;
  let savedDir = '';
  for (const file of files) {
    try {
      const dataBase64 = await readFileAsBase64(file);
      const res = await fetch('/api/upload-logo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, filename: file.name, dataBase64 }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (status) status.textContent = `Upload failed: ${data.error || res.statusText}`;
        break;
      }
      savedDir = data.dir;
      uploaded += 1;
    } catch (err) {
      if (status) status.textContent = `Upload error: ${err.message}`;
      break;
    }
  }
  if (uploaded && savedDir) {
    if (dirField) {
      dirField.value = savedDir;
      dirField.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (status) status.textContent = `Uploaded ${uploaded} file${uploaded === 1 ? '' : 's'} to ${savedDir}`;
    await renderLogoPreview(savedDir);
  }
  input.value = '';
});

// If the user types/pastes a directory, refresh the preview too.
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t && t.matches && t.matches('.cfg-entry [data-field="brandLogoDir"]')) {
    renderLogoPreview(t.value.trim());
  }
});

// --- Wizard controller ---------------------------------------------
// Visible steps depend on the chosen tier.
const WIZ_STEPS = [
  { id: 'agent', label: 'Agent' },
  { id: 'tier', label: 'Customize' },
  { id: 'subject', label: 'Subject' },
  { id: 'roles', label: 'Role' },
  { id: 'search', label: 'Search', tiers: ['standard', 'full'] },
  { id: 'networks', label: 'Networks', tiers: ['standard', 'full'] },
  { id: 'advanced', label: 'Advanced', tiers: ['full'] },
  { id: 'keys', label: 'Services & keys' },
  { id: 'review', label: 'Review' },
];
let wizIndex = 0;
function visibleWizSteps() {
  const tier = document.body.dataset.tier || 'standard';
  return WIZ_STEPS.filter((s) => !s.tiers || s.tiers.includes(tier));
}
function renderWizProgress() {
  const steps = visibleWizSteps();
  const host = $('wiz-progress');
  if (!host) return;
  host.innerHTML = steps
    .map((s, i) => `
      <li class="wiz-step-pill ${i === wizIndex ? 'active' : ''} ${i < wizIndex ? 'done' : ''}" data-goto-step="${i}">
        <span class="wiz-step-num">${i + 1}</span>
        <span class="wiz-step-label">${s.label}</span>
      </li>
    `)
    .join('');
}
function showWizStep(idx) {
  const steps = visibleWizSteps();
  wizIndex = Math.max(0, Math.min(idx, steps.length - 1));
  const currentId = steps[wizIndex].id;
  document.querySelectorAll('.wiz-step').forEach((el) => {
    el.classList.toggle('active', el.dataset.step === currentId);
  });
  $('wiz-prev').disabled = wizIndex === 0;
  const isLast = wizIndex === steps.length - 1;
  $('wiz-next').textContent = isLast ? 'Save config' : 'Next →';
  $('wiz-next').disabled = false;
  $('wiz-pos').textContent = `Step ${wizIndex + 1} of ${steps.length}`;
  renderWizProgress();
  if (currentId === 'review') renderWizSummary();
  if (currentId === 'subject') loadExistingSubjects();
}
function nextWizStep() {
  if (!validateWizStep()) return;
  const steps = visibleWizSteps();
  const isLast = wizIndex === steps.length - 1;
  if (isLast) {
    // On the final review step, Done == Save config.
    const saveBtn = $('cfg-create');
    if (saveBtn && !saveBtn.disabled && !saveBtn.hidden) saveBtn.click();
    return;
  }
  showWizStep(wizIndex + 1);
}
function prevWizStep() { showWizStep(wizIndex - 1); }

// Shows existing configs at the top of the Subject step so the user can see
// they already have one and add another — or remove any.
async function loadExistingSubjects() {
  const wrap = $('cfg-existing-wrap');
  const list = $('cfg-existing-list');
  const summary = $('cfg-existing-summary');
  if (!wrap || !list) return;
  try {
    const { configs } = await api('/api/configs');
    if (!configs || configs.length === 0) {
      wrap.hidden = true;
      list.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    summary.innerHTML = `You already track <strong>${configs.length}</strong> subject${configs.length === 1 ? '' : 's'}:`;
    list.innerHTML = configs
      .map((c) => `
        <li class="existing-subject" data-slug="${escape(c.slug)}">
          <span class="existing-subject-name">${escape(c.name || c.slug)}</span>
          ${c.type ? `<span class="existing-subject-type">${escape(c.type)}</span>` : ''}
          <code class="existing-subject-slug">${escape(c.slug)}</code>
          <button type="button" class="secondary existing-subject-remove" data-slug="${escape(c.slug)}">Remove</button>
        </li>
      `)
      .join('');
  } catch (err) {
    wrap.hidden = false;
    summary.textContent = `Could not list existing configs: ${err.message}`;
    list.innerHTML = '';
  }
}

// Delegated click: remove existing subject.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.existing-subject-remove');
  if (!btn) return;
  const slug = btn.dataset.slug;
  if (!slug) return;
  if (!confirm(`Remove subject "${slug}"? This deletes scout-config-${slug}.prompt.md. Reports and social posts are kept.`)) return;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/configs/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(`Remove failed: ${data.error || res.statusText}`);
      btn.disabled = false;
      return;
    }
    await loadExistingSubjects();
    await loadStatus();
  } catch (err) {
    alert(`Remove failed: ${err.message}`);
    btn.disabled = false;
  }
});

function validateWizStep() {
  const steps = visibleWizSteps();
  const id = steps[wizIndex]?.id;
  if (id === 'agent') {
    if (!agentChoice && !(cachedStatus && cachedStatus.runnerLocked)) {
      alert('Pick an agent before continuing.');
      return false;
    }
    if (agentChoice === 'custom' && !($('agent-custom-runner')?.value || '').trim()) {
      alert('Enter a custom runner command before continuing.');
      return false;
    }
    // Fire-and-forget persist in case the user never blurred the radio/input.
    saveAgentChoice();
  }
  if (id === 'subject') {
    const name = document.querySelector('.cfg-entry [data-field="name"]')?.value.trim();
    if (!name) {
      alert('Please enter a subject name before continuing.');
      return false;
    }
  }
  if (id === 'roles' && chosenRoles.length === 0) {
    if (!confirm('You haven\'t added any roles. Continue anyway?')) return false;
  }
  return true;
}
function renderWizSummary() {
  const entry = document.querySelector('.cfg-entry');
  if (!entry) return;
  const tier = document.body.dataset.tier || 'standard';
  const name = entry.querySelector('[data-field="name"]')?.value.trim() || '—';
  const slug = entry.querySelector('[data-field="slug"]')?.value.trim() || slugify(name);
  const type = entry.querySelector('[data-field="type"]')?.value || 'product';
  const roleLabels = chosenRoles.map((r) => r.label).join(', ') || '—';
  const rows = [
    ['Agent', agentChoice || '—'],
    ['Customization', tier],
    ['Name', name],
    ['Slug', slug],
    ['Type', type],
    ['Roles', roleLabels],
  ];
  if (tier === 'standard' || tier === 'full') {
    const terms = entry.querySelector('[data-field="terms"]')?.value.trim() || '—';
    const networks = Array.from(document.querySelectorAll('.cfg-network:checked')).map((el) => el.value).join(', ') || '—';
    rows.push(['Search terms', terms], ['Networks', networks]);
  }
  $('wiz-summary').innerHTML = rows
    .map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`)
    .join('');
}
$('wiz-prev')?.addEventListener('click', prevWizStep);
$('wiz-next')?.addEventListener('click', nextWizStep);
$('wiz-progress')?.addEventListener('click', (e) => {
  const pill = e.target.closest?.('[data-goto-step]');
  if (!pill) return;
  const target = Number(pill.dataset.gotoStep);
  // Allow jumping backwards freely, forward only through Next (validation).
  if (target <= wizIndex) showWizStep(target);
});
// When the tier changes, the set of visible steps changes — rerender.
document.querySelectorAll('input[name="cfg-tier"]').forEach((el) => {
  el.addEventListener('change', () => {
    if (el.checked) {
      setTier(el.value);
      // Clamp wizIndex into the new visible-steps range.
      const steps = visibleWizSteps();
      if (wizIndex >= steps.length) wizIndex = steps.length - 1;
      showWizStep(wizIndex);
    }
  });
});
// Boot the wizard.
showWizStep(0);

// --- Wizard state persistence --------------------------------------
// Retains progress across reloads so users can pause and return. Stored in
// localStorage under WIZ_STORAGE_KEY. A "Start over" button clears it.
const WIZ_STORAGE_KEY = 'contentScoutWizardState';
const WIZ_STATE_VERSION = 1;

function captureWizState() {
  const wizard = document.getElementById('wizard');
  if (!wizard) return null;
  const inputs = {};
  wizard.querySelectorAll('input, select, textarea').forEach((el) => {
    // Skip role-management scratch inputs — roles are persisted via chosenRoles.
    if (el.id === 'cfg-role-select' || el.id === 'cfg-role-custom-input') return;
    const key = el.id || el.name;
    if (!key) return;
    if (el.type === 'checkbox' || el.type === 'radio') {
      // For radios, only record the checked one (keyed by name).
      if (el.type === 'radio') {
        if (el.checked && el.name) inputs[`radio:${el.name}`] = el.value;
      } else {
        inputs[`cb:${key}`] = !!el.checked;
      }
    } else {
      inputs[key] = el.value;
    }
  });
  // Per-subject data-field inputs (share no id) — keyed by data-field.
  const entry = document.querySelector('.cfg-entry');
  const entryFields = {};
  if (entry) {
    entry.querySelectorAll('[data-field]').forEach((el) => {
      const key = el.dataset.field;
      if (el.type === 'checkbox') entryFields[`cb:${key}`] = !!el.checked;
      else entryFields[key] = el.value;
    });
  }
  return {
    v: WIZ_STATE_VERSION,
    tier: document.body.dataset.tier || 'standard',
    wizIndex,
    inputs,
    entryFields,
    roles: chosenRoles.slice(),
  };
}

function restoreWizState() {
  let raw = null;
  try { raw = localStorage.getItem(WIZ_STORAGE_KEY); } catch { return false; }
  if (!raw) return false;
  let state;
  try { state = JSON.parse(raw); } catch { return false; }
  if (!state || state.v !== WIZ_STATE_VERSION) return false;

  // Tier first — it controls which steps are visible.
  if (state.tier) {
    const tierRadio = document.querySelector(`input[name="cfg-tier"][value="${state.tier}"]`);
    if (tierRadio) tierRadio.checked = true;
    setTier(state.tier);
  }

  const wizard = document.getElementById('wizard');
  if (wizard && state.inputs) {
    for (const [key, val] of Object.entries(state.inputs)) {
      if (key.startsWith('radio:')) {
        const name = key.slice(6);
        const el = wizard.querySelector(`input[type="radio"][name="${CSS.escape(name)}"][value="${CSS.escape(val)}"]`);
        if (el) el.checked = true;
      } else if (key.startsWith('cb:')) {
        const id = key.slice(3);
        const el = wizard.querySelector(`#${CSS.escape(id)}`);
        if (el) el.checked = !!val;
      } else {
        const el = wizard.querySelector(`#${CSS.escape(key)}`) || wizard.querySelector(`[name="${CSS.escape(key)}"]`);
        if (el && el.type !== 'radio' && el.type !== 'checkbox') el.value = val;
      }
    }
  }

  const entry = document.querySelector('.cfg-entry');
  if (entry && state.entryFields) {
    for (const [key, val] of Object.entries(state.entryFields)) {
      if (key.startsWith('cb:')) {
        const el = entry.querySelector(`[data-field="${key.slice(3)}"]`);
        if (el) el.checked = !!val;
      } else {
        const el = entry.querySelector(`[data-field="${key}"]`);
        if (el) el.value = val;
      }
    }
  }

  if (Array.isArray(state.roles)) {
    chosenRoles.length = 0;
    for (const r of state.roles) chosenRoles.push(r);
    renderRoleChips();
  }

  // Jump to the saved step (but never the review step on restore — user should
  // see their work, not the save screen).
  const steps = visibleWizSteps();
  let idx = Math.min(Math.max(0, state.wizIndex || 0), steps.length - 1);
  if (steps[idx]?.id === 'review') idx = Math.max(0, idx - 1);
  showWizStep(idx);
  return true;
}

let saveTimer = null;
function scheduleSaveWizState() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const s = captureWizState();
      if (s) {
        localStorage.setItem(WIZ_STORAGE_KEY, JSON.stringify(s));
        const saved = document.getElementById('wiz-saved');
        if (saved) {
          saved.textContent = 'Progress saved';
          clearTimeout(saved._t);
          saved._t = setTimeout(() => { saved.textContent = ''; }, 1500);
        }
      }
    } catch { /* quota or serialization — ignore */ }
  }, 400);
}

// Listen for changes anywhere in the wizard.
document.getElementById('wizard')?.addEventListener('input', scheduleSaveWizState);
document.getElementById('wizard')?.addEventListener('change', scheduleSaveWizState);
// Role add/remove already calls renderRoleChips; wrap it to also save.
const _origRenderRoleChips = renderRoleChips;
renderRoleChips = function () { _origRenderRoleChips.apply(this, arguments); scheduleSaveWizState(); };
// Persist on step navigation too.
$('wiz-prev')?.addEventListener('click', scheduleSaveWizState);
$('wiz-next')?.addEventListener('click', scheduleSaveWizState);

// Start over — clear storage, reset state, reload for a pristine wizard.
$('wiz-restart')?.addEventListener('click', () => {
  if (!confirm('Clear all wizard inputs and start over? Your saved configs are not affected.')) return;
  try { localStorage.removeItem(WIZ_STORAGE_KEY); } catch { /* ignore */ }
  location.reload();
});

// Restore after DOM + other wiring have run.
try { restoreWizState(); } catch (err) { console.warn('wizard restore failed', err); }

// --- Parsers / save ------------------------------------------------
// Parse "Name | Affiliation | @handle" lines into [{name, affiliation, handle}, ...].
function parseWatchlist(text) {
  return (text || '').split(/\r?\n/).map((line) => {
    const parts = line.split('|').map((s) => s.trim());
    if (!parts[0]) return null;
    return { name: parts[0] || '', affiliation: parts[1] || '', handle: parts[2] || '' };
  }).filter(Boolean);
}
// Parse "Name | Type | URL" lines.
function parseCustomSources(text) {
  return (text || '').split(/\r?\n/).map((line) => {
    const parts = line.split('|').map((s) => s.trim());
    if (!parts[0] && !parts[2]) return null;
    return { name: parts[0] || '', type: parts[1] || '', url: parts[2] || '' };
  }).filter(Boolean);
}
function splitList(s) { return (s || '').split(',').map((x) => x.trim()).filter(Boolean); }

// Helper — read a [data-field] value inside the (single) subject entry.
function entryField(key) {
  return document.querySelector(`.cfg-entry [data-field="${key}"]`);
}

$('cfg-create').addEventListener('click', async () => {
  const name = entryField('name')?.value.trim();
  if (!name) {
    $('cfg-status').textContent = 'Subject name is required.';
    return;
  }
  const tier = document.body.dataset.tier || 'standard';
  const roleIds = chosenRoles.filter((r) => r.kind === 'preset').map((r) => r.id);
  const customRoles = chosenRoles.filter((r) => r.kind === 'custom').map((r) => r.label);
  const customRoleLabel = customRoles[0] || '';

  const body = {
    name,
    slug: entryField('slug')?.value.trim() || slugify(name),
    type: entryField('type')?.value || 'product',
    roleIds,
    customRoleLabel,
    customRoles,
    searchTerms: splitList(entryField('terms')?.value),
    hashtags: splitList(entryField('hashtags')?.value),
    topicTags: splitList(entryField('topicTags')?.value),
  };

  if (tier === 'standard' || tier === 'full') {
    body.networks = Array.from(document.querySelectorAll('.cfg-network:checked')).map((el) => el.value);
    body.socialPosts = !!entryField('social')?.checked;
    body.postingCalendar = !!entryField('calendar')?.checked;
    body.socialAccounts = {
      linkedin: entryField('socAcctLinkedin')?.value.trim() || '',
      x: entryField('socAcctX')?.value.trim() || '',
      bluesky: entryField('socAcctBluesky')?.value.trim() || '',
      youtube: entryField('socAcctYoutube')?.value.trim() || '',
    };
  }
  if (tier === 'full') {
    body.exclusions = {
      blog: splitList(entryField('exclBlog')?.value),
      youtube: splitList(entryField('exclYoutube')?.value),
      handles: splitList(entryField('exclHandles')?.value),
      repos: (entryField('exclRepos')?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      domains: (entryField('exclDomains')?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    };
    const flags = {};
    document.querySelectorAll('.cfg-flag:checked').forEach((el) => { flags[el.dataset.flag] = true; });
    body.flags = flags;
    body.brand = {
      logoDir: entryField('brandLogoDir')?.value.trim() || '',
      thumbnailStyle: entryField('brandThumb')?.value || 'text-only',
      theme: entryField('brandTheme')?.value || 'dark',
      productName: entryField('brandProductName')?.value.trim() || '',
      logoRules: entryField('brandLogoRules')?.value.trim() || '',
      colors: {
        bg: entryField('brandColorBg')?.value.trim() || '',
        accent: entryField('brandColorAccent')?.value.trim() || '',
        highlight: entryField('brandColorHighlight')?.value.trim() || '',
        text: entryField('brandColorText')?.value.trim() || '',
      },
      font: entryField('brandFont')?.value.trim() || '',
      composition: entryField('brandComposition')?.value.trim() || '',
      guardrails: entryField('brandGuardrails')?.value.trim() || '',
    };
    body.socialStandards = {
      audience: entryField('spsAudience')?.value.trim() || '',
      tone: entryField('spsTone')?.value.trim() || '',
      shortName: entryField('spsShortName')?.value.trim() || '',
      neverWrite: entryField('spsNeverWrite')?.value.trim() || '',
      avoidWords: entryField('spsAvoidWords')?.value.trim() || '',
      emoji: entryField('spsEmoji')?.value.trim() || '',
      hashtag: entryField('spsHashtag')?.value.trim() || '',
      thingsAvoid: entryField('spsThingsAvoid')?.value.trim() || '',
      additional: entryField('spsAdditional')?.value.trim() || '',
    };
    body.postingPrefs = {
      frequency: entryField('postFrequency')?.value.trim() || '',
      avoid: entryField('postAvoid')?.value.trim() || '',
      approval: entryField('postApproval')?.value.trim() || '',
      tagTeam: entryField('postTagTeam')?.value.trim() || '',
    };
    body.language = {
      langs: entryField('langs')?.value.trim() || '',
      regions: entryField('regions')?.value.trim() || '',
    };
    body.competitors = splitList(entryField('competitors')?.value);
    body.conferences = splitList(entryField('conferences')?.value);
    body.watchlist = parseWatchlist(entryField('watchlist')?.value);
    body.influencers = parseWatchlist(entryField('influencers')?.value)
      .map((i) => ({ name: i.name, platform: i.affiliation, handle: i.handle }));
    body.teamMembers = (entryField('teamMembers')?.value || '')
      .split(/\r?\n/).map((line) => {
        const parts = line.split(/[—-]/).map((s) => s.trim());
        if (!parts[0]) return null;
        return { name: parts[0], context: parts.slice(1).join(' — ') };
      }).filter(Boolean);
    body.customSources = parseCustomSources(entryField('customSources')?.value);
  }

  $('cfg-create').disabled = true;
  $('cfg-status').textContent = 'creating…';
  try {
    let res = await fetch('/api/configs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = await res.json();
    if (res.status === 409 && data.exists) {
      const choice = confirm(
        `A config already exists for slug "${data.slug}".\n\n` +
        `OK = overwrite it with the values from this wizard.\n` +
        `Cancel = open the existing config in the Configs editor instead.`,
      );
      if (choice) {
        res = await fetch('/api/configs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, overwrite: true }),
        });
        data = await res.json();
      } else {
        $('cfg-status').textContent = `Already saved — opening "${data.slug}" in Configs.`;
        gotoView('configs');
        // Best-effort: select the existing config in the configs view.
        setTimeout(() => {
          const li = document.querySelector(`#config-list li[data-slug="${data.slug}"]`);
          if (li) li.click();
        }, 200);
        return;
      }
    }
    if (!res.ok) {
      $('cfg-status').textContent = `error: ${data.error || res.statusText}`;
      return;
    }
    $('cfg-status').innerHTML = `<span class="ok">Saved ${data.file}. Opening dashboard…</span>`;
    await loadStatus();
    // Stash slug so the manual "Go to Configs" button (still rendered for
    // a moment) keeps working, then auto-jump to the dashboard.
    $('cfg-create').hidden = true;
    $('cfg-after-save').hidden = false;
    $('cfg-goto-configs').dataset.slug = data.slug;
    setTimeout(() => gotoView('dashboard'), 400);
  } catch (err) {
    $('cfg-status').textContent = `error: ${err.message}`;
  } finally {
    $('cfg-create').disabled = false;
  }
});

// "Add another subject" — reset subject-specific fields, keep agent/tier/roles,
// and jump back to the Subject step so the user can onboard another.
$('cfg-add-another')?.addEventListener('click', () => {
  // Clear subject fields in the single .cfg-entry block.
  const subjectFields = ['name', 'slug', 'type', 'terms', 'hashtags', 'topicTags',
    'exclBlog', 'exclYoutube', 'exclHandles', 'exclRepos', 'exclDomains',
    'brandLogoDir', 'brandThumb', 'brandTheme',
    'brandProductName', 'brandLogoRules',
    'brandColorBg', 'brandColorAccent', 'brandColorHighlight', 'brandColorText',
    'brandFont', 'brandComposition', 'brandGuardrails',
    'socAcctLinkedin', 'socAcctX', 'socAcctBluesky', 'socAcctYoutube',
    'spsAudience', 'spsTone', 'spsShortName', 'spsNeverWrite', 'spsAvoidWords',
    'spsEmoji', 'spsHashtag', 'spsThingsAvoid', 'spsAdditional',
    'postFrequency', 'postAvoid', 'postApproval', 'postTagTeam',
    'langs', 'regions',
    'competitors', 'conferences', 'watchlist', 'influencers', 'teamMembers', 'customSources'];
  for (const key of subjectFields) {
    const el = entryField(key);
    if (!el) continue;
    if (el.tagName === 'SELECT') el.selectedIndex = 0;
    else el.value = '';
  }
  // Reset per-subject checkboxes (feature flag overrides, social/calendar default on).
  document.querySelectorAll('.cfg-flag').forEach((el) => { el.checked = false; });
  const socEl = entryField('social'); if (socEl) socEl.checked = true;
  const calEl = entryField('calendar'); if (calEl) calEl.checked = false;
  // Reset networks to the default set.
  const defaultNetworks = new Set(['github', 'blogs', 'stackoverflow', 'reddit', 'hackernews', 'bluesky']);
  document.querySelectorAll('.cfg-network').forEach((el) => { el.checked = defaultNetworks.has(el.value); });
  // Clear any tag-suggest chip panels so they re-render fresh.
  ['cfg-terms-suggest-chips', 'cfg-hashtags-suggest-chips', 'cfg-topic-suggest-chips',
    'cfg-blog-suggest-chips', 'cfg-youtube-suggest-chips', 'cfg-social-suggest-chips',
    'cfg-competitors-suggest-chips', 'cfg-conferences-suggest-chips',
    'cfg-watchlist-suggest-chips',
    'cfg-influencers-suggest-chips', 'cfg-exclrepos-suggest-chips', 'cfg-excldomains-suggest-chips'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = ''; el.hidden = true; }
  });
  ['cfg-terms-suggest-status', 'cfg-hashtags-suggest-status', 'cfg-topic-suggest-status',
    'cfg-watchlist-suggest-status', 'cfg-competitors-suggest-status', 'cfg-conferences-suggest-status',
    'cfg-channels-suggest-status',
    'cfg-influencers-suggest-status', 'cfg-exclrepos-suggest-status', 'cfg-excldomains-suggest-status',
    'cfg-brand-suggest-status', 'cfg-sps-suggest-status', 'cfg-post-suggest-status', 'cfg-lang-suggest-status'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = '';
  });
  // Reset logo picker UI.
  const logoPreview = document.getElementById('cfg-logo-preview');
  if (logoPreview) { logoPreview.innerHTML = ''; logoPreview.hidden = true; }
  const logoStatus = document.getElementById('cfg-logo-status');
  if (logoStatus) logoStatus.textContent = 'PNG, JPG, SVG, WebP — uploaded to social-posts/images/brand/<slug>/';
  const logoFile = document.getElementById('cfg-logo-file');
  if (logoFile) logoFile.value = '';
  // Clear "add one at a time" inputs + visible chip lists (the hidden
  // exclBlog/exclYoutube/exclHandles inputs themselves are cleared via
  // subjectFields above).
  ['cfg-blog-add-input', 'cfg-youtube-add-input', 'cfg-handle-add-input'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  renderBlogList?.();
  renderYoutubeList?.();
  renderHandlesList?.();
  // Reset the Review-step UI.
  $('cfg-status').textContent = '';
  $('cfg-create').hidden = false;
  $('cfg-after-save').hidden = true;
  // Jump back to the Subject step.
  const steps = visibleWizSteps();
  const idx = steps.findIndex((s) => s.id === 'subject');
  if (idx >= 0) showWizStep(idx);
});

// "Go to Configs" — open the newly created config in the Configs view.
$('cfg-goto-configs')?.addEventListener('click', () => {
  const slug = $('cfg-goto-configs').dataset.slug;
  gotoView('configs');
  loadConfigList().then(() => { if (slug) loadConfig(slug); });
});

$('env-add').addEventListener('click', () => {
  const grid = document.querySelector('#setup-env .env-grid') || $('setup-env');
  if (!grid.classList.contains('env-grid')) {
    $('setup-env').innerHTML = '<div class="env-grid"></div>';
  }
  const container = document.querySelector('#setup-env .env-grid');
  const idx = container.children.length;
  container.insertAdjacentHTML('beforeend', envRow('', '', idx, false));
  wireEnvRows('setup-env');
  container.lastElementChild.querySelector('.env-key').focus();
});

$('env-save').addEventListener('click', async () => {
  const entries = collectEnvEntries();
  $('env-save').disabled = true;
  $('env-status').textContent = 'saving…';
  try {
    await api('/api/env', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
    $('env-status').textContent = `saved ${entries.length} key${entries.length === 1 ? '' : 's'}`;
    await loadStatus();
  } catch (err) {
    $('env-status').textContent = `error: ${err.message}`;
  } finally {
    $('env-save').disabled = false;
  }
});

// --- Dashboard -----------------------------------------------------
async function loadDashboard() {
  let status, configs, reports, runs;
  try {
    [status, configs, reports, runs] = await Promise.all([
      api('/api/status'),
      api('/api/configs'),
      api('/api/reports'),
      api('/api/runs'),
    ]);
  } catch (err) {
    // Network/server problem — still show the onboarding banner instead
    // of leaving the dashboard blank.
    $('dash-empty').hidden = false;
    $('dash-body').hidden = true;
    $('dash-empty-msg').innerHTML =
      `Couldn't reach the server (<code>${escape(err.message)}</code>). Make sure the web UI process is running, then refresh.`;
    return;
  }
  cachedStatus = status;

  const ready = status.hasConfigs && status.runnerConfigured;
  $('dash-empty').hidden = ready;
  $('dash-body').hidden = !ready;
  if (!status.runnerConfigured && !status.hasConfigs) {
    $('dash-empty-msg').innerHTML =
      'No agent configured and no configs yet. Open <a href="#" data-goto="setup">Setup</a> to get started.';
  } else if (!status.runnerConfigured) {
    $('dash-empty-msg').innerHTML =
      'No agent configured. Open <a href="#" data-goto="setup">Setup</a> to pick one so you can run commands.';
  } else if (!status.hasConfigs) {
    $('dash-empty-msg').innerHTML =
      'No configs yet. Open <a href="#" data-goto="setup">Setup</a> to run <code>/scout-onboard</code> and create one.';
  }
  if (!ready) return; // nothing else to render

  $('dash-configs').innerHTML = configs.configs.length
    ? configs.configs.map((c) => `<li><code>${escape(c.slug)}</code></li>`).join('')
    : '<li class="hint">No configs yet — see <a href="#" data-goto="setup">Setup</a>.</li>';

  const recent = reports.reports.slice(0, 5);
  $('dash-reports').innerHTML = recent.length
    ? recent.map((r) => `<li>${r.name} <span class="hint">(${r.mtime.slice(0, 10)})</span></li>`).join('')
    : '<li class="hint">No reports yet.</li>';

  $('dash-runs').innerHTML = runs.runs.length
    ? runs.runs.slice(0, 5).map((r) => `<li><code>${r.status}</code> — ${escape(r.command)}</li>`).join('')
    : '<li class="hint">No runs yet.</li>';

  const keys = status.env.keys
    .map((k) => `<div><code>${k.key}</code> ${k.hasValue ? '✓' : '<span class="hint">(empty)</span>'}</div>`)
    .join('');
  $('dash-env').innerHTML = `
    <div class="hint">Repo: <code>${escape(status.repoRoot)}</code></div>
    <div class="hint">Runner: <code>${escape(status.runner || 'not set')}</code></div>
    <hr style="border-color: var(--border)" />
    ${keys || '<div class="hint">No .env entries.</div>'}
  `;
}

// --- Configs -------------------------------------------------------
let selectedConfig = null;
let configDirty = false;
async function loadConfigList() {
  const { configs } = await api('/api/configs');
  $('config-list').innerHTML = configs
    .map((c) => `<li data-slug="${c.slug}"><code>${c.slug}</code></li>`)
    .join('') || '<li class="hint">No configs yet.</li>';
  $('config-list').querySelectorAll('li[data-slug]').forEach((li) => {
    li.addEventListener('click', () => loadConfig(li.dataset.slug));
  });
}
async function loadConfig(slug) {
  const c = await api(`/api/configs/${slug}`);
  selectedConfig = slug;
  configDirty = false;
  document.querySelectorAll('#config-list li').forEach((li) => {
    li.classList.toggle('selected', li.dataset.slug === slug);
  });
  $('config-title').textContent = c.file;
  $('config-editor').value = c.raw;
  $('config-editor').disabled = false;
  $('config-save').disabled = true;
  $('config-status').textContent = '';
  populateConfigForm(c.raw);
}
$('config-editor').addEventListener('input', () => {
  configDirty = true;
  $('config-save').disabled = false;
  $('config-status').textContent = 'unsaved changes';
});
$('config-save').addEventListener('click', async () => {
  if (!selectedConfig) return;
  // If the user is in form mode with unsaved field edits, fold those into raw first.
  let raw = $('config-editor').value;
  if (cfgMode === 'form' && cfgFormDirty) {
    raw = serializeConfigForm(raw);
    $('config-editor').value = raw;
  }
  $('config-save').disabled = true;
  $('config-status').textContent = 'saving…';
  try {
    await api(`/api/configs/${selectedConfig}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    configDirty = false;
    cfgFormDirty = false;
    $('config-status').textContent = 'saved';
    $('cfg-form-status').textContent = '';
  } catch (err) {
    $('config-status').textContent = `error: ${err.message}`;
    $('config-save').disabled = false;
  }
});

// --- Configs view: Form vs Raw mode ------------------------------
let cfgMode = 'form';
let cfgFormDirty = false;

function setCfgMode(mode) {
  cfgMode = mode;
  const formPanel = $('config-form-panel');
  const rawTa = $('config-editor');
  const tabForm = $('cfg-tab-form');
  const tabRaw = $('cfg-tab-raw');
  if (!formPanel || !rawTa) return;
  if (mode === 'form') {
    // If user edited raw, re-parse so form reflects current raw.
    if (selectedConfig && configDirty) populateConfigForm(rawTa.value);
    formPanel.style.display = '';
    rawTa.style.display = 'none';
    tabForm?.classList.add('active');
    tabRaw?.classList.remove('active');
    tabForm?.setAttribute('aria-selected', 'true');
    tabRaw?.setAttribute('aria-selected', 'false');
  } else {
    // Switching to raw — fold pending form edits into raw textarea so user sees them.
    if (cfgFormDirty) {
      rawTa.value = serializeConfigForm(rawTa.value);
      cfgFormDirty = false;
      configDirty = true;
      $('config-save').disabled = false;
      $('config-status').textContent = 'unsaved changes';
    }
    formPanel.style.display = 'none';
    rawTa.style.display = '';
    tabForm?.classList.remove('active');
    tabRaw?.classList.add('active');
    tabForm?.setAttribute('aria-selected', 'false');
    tabRaw?.setAttribute('aria-selected', 'true');
  }
}

$('cfg-tab-form')?.addEventListener('click', () => setCfgMode('form'));
$('cfg-tab-raw')?.addEventListener('click', () => setCfgMode('raw'));

['cfg-form-search-terms', 'cfg-form-search-hashtags', 'cfg-form-rss-feeds', 'cfg-form-excluded'].forEach((id) => {
  $(id)?.addEventListener('input', () => {
    cfgFormDirty = true;
    $('config-save').disabled = false;
    $('config-status').textContent = 'unsaved changes';
    $('cfg-form-status').textContent = 'unsaved field edits — click Save to write to file';
  });
});

// Extract a `## Section` body (everything until the next `## ` heading or EOF).
function getMdSection(raw, heading) {
  const re = new RegExp(`(^|\\n)##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|\\n*$)`, 'i');
  const m = raw.match(re);
  return m ? m[2] : '';
}

// Same but for a `### Subheading` under the doc.
function getMdSubsection(raw, heading) {
  const re = new RegExp(`(^|\\n)###\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|\\n###\\s|\\n*$)`, 'i');
  const m = raw.match(re);
  return m ? m[2] : '';
}

// Parse a bullet list out of a markdown body. Returns array of trimmed values
// (without the leading "- " or "* " marker).
function parseBulletList(body) {
  if (!body) return [];
  return body
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter((l) => l && !l.startsWith('<!--') && !l.startsWith('_'));
}

function bulletListBlock(items, emptyComment) {
  const cleaned = (items || []).map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return emptyComment ? `\n${emptyComment}\n\n` : '\n- none\n\n';
  }
  return '\n' + cleaned.map((s) => `- ${s}`).join('\n') + '\n\n';
}

function populateConfigForm(raw) {
  // Search Terms — `### Search Terms (text)` under `## Topic Identity`.
  const terms = parseBulletList(getMdSubsection(raw, 'Search Terms'));
  $('cfg-form-search-terms').value = terms.join('\n');

  // Search Hashtags — `### Search Hashtags`.
  const tags = parseBulletList(getMdSubsection(raw, 'Search Hashtags'));
  $('cfg-form-search-hashtags').value = tags.join('\n');

  // Custom RSS Feeds — `## Custom RSS Feeds` (may not exist yet).
  const feeds = parseBulletList(getMdSection(raw, 'Custom RSS Feeds'));
  $('cfg-form-rss-feeds').value = feeds.join('\n');

  // Excluded Domains/Authors — `### Excluded Domains/Authors`.
  const excluded = parseBulletList(getMdSubsection(raw, 'Excluded Domains/Authors'));
  // Hide the literal "none" placeholder when surfacing in the form.
  $('cfg-form-excluded').value = excluded.filter((x) => x.toLowerCase() !== 'none').join('\n');

  cfgFormDirty = false;
  $('cfg-form-status').textContent = '';
}

// Replace a `### Subheading` body in raw with new content.
function replaceMdSubsection(raw, heading, newBodyBlock) {
  const re = new RegExp(`(^|\\n)(###\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^\\n]*\\n)([\\s\\S]*?)(?=\\n##\\s|\\n###\\s|$)`, 'i');
  if (re.test(raw)) {
    return raw.replace(re, (_m, lead, head) => `${lead}${head}${newBodyBlock.replace(/^\n/, '')}`);
  }
  return raw; // subsection not present — skip silently to avoid corrupting unfamiliar configs
}

// Replace a `## Section` body in raw with new content; if missing, append at end.
function replaceMdSection(raw, heading, newBodyBlock) {
  const re = new RegExp(`(^|\\n)(##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^\\n]*\\n)([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
  if (re.test(raw)) {
    return raw.replace(re, (_m, lead, head) => `${lead}${head}${newBodyBlock.replace(/^\n/, '')}`);
  }
  // Append new section at end of file.
  const sep = raw.endsWith('\n') ? '' : '\n';
  return `${raw}${sep}\n## ${heading}\n${newBodyBlock}`;
}

function linesFromTa(id) {
  return ($(id)?.value || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

function serializeConfigForm(rawIn) {
  let raw = rawIn;
  raw = replaceMdSubsection(raw, 'Search Terms', bulletListBlock(linesFromTa('cfg-form-search-terms')));
  raw = replaceMdSubsection(raw, 'Search Hashtags', bulletListBlock(linesFromTa('cfg-form-search-hashtags')));
  raw = replaceMdSection(raw, 'Custom RSS Feeds', bulletListBlock(
    linesFromTa('cfg-form-rss-feeds'),
    '<!-- Add custom RSS/Atom feeds as `Name | URL` per line. Examples: personal blogs, RSS bridges, third-party aggregators. -->\n- none'
  ));
  const ex = linesFromTa('cfg-form-excluded');
  raw = replaceMdSubsection(raw, 'Excluded Domains/Authors', bulletListBlock(ex.length ? ex : ['none']));
  return raw;
}

// --- Configs view: API keys panel (reuses /api/env) ---------------
async function renderConfigsEnv() {
  const host = $('configs-env');
  if (!host) return;
  try {
    const { entries, exists } = await api('/api/env');
    host.innerHTML = `
      <div class="env-grid">
        ${entries.map((e, i) => envRow(e.key, e.value, i, e.preset !== false)).join('')}
      </div>
      ${entries.length ? '' : '<div class="hint" style="margin-top:0.5rem">No keys yet — click <strong>+ Add key</strong> to add one.</div>'}
      ${exists ? '' : '<div class="hint" style="margin-top:0.5rem">No <code>.env</code> file yet — saving will create one.</div>'}
    `;
    wireEnvRows('configs-env');
    $('configs-env-status').textContent = '';
  } catch (err) {
    host.innerHTML = `<div class="warn-text">Failed to load env: ${escape(err.message)}</div>`;
  }
}
$('configs-env-add')?.addEventListener('click', () => {
  const host = $('configs-env');
  let grid = host.querySelector('.env-grid');
  if (!grid) {
    host.innerHTML = '<div class="env-grid"></div>';
    grid = host.querySelector('.env-grid');
  }
  const idx = grid.children.length;
  grid.insertAdjacentHTML('beforeend', envRow('', '', idx, false));
  wireEnvRows('configs-env');
  grid.lastElementChild.querySelector('.env-key').focus();
});
$('configs-env-reload')?.addEventListener('click', () => renderConfigsEnv());
$('configs-env-save')?.addEventListener('click', async () => {
  const entries = collectEnvEntries('configs-env');
  $('configs-env-save').disabled = true;
  $('configs-env-status').textContent = 'saving…';
  try {
    await api('/api/env', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
    $('configs-env-status').textContent = `saved ${entries.length} key${entries.length === 1 ? '' : 's'}`;
    if (typeof loadStatus === 'function') await loadStatus();
  } catch (err) {
    $('configs-env-status').textContent = `error: ${err.message}`;
  } finally {
    $('configs-env-save').disabled = false;
  }
});

// --- Run -----------------------------------------------------------
let activeRunId = null;

async function loadSlugOptions() {
  const { configs: rawConfigs } = await api('/api/configs');
  // Defensive: filter out example/template configs in case a stale server still serves them.
  const configs = (rawConfigs || []).filter(
    (c) => c && c.slug && c.slug !== 'example' && !c.slug.startsWith('example-')
  );
  const list = $('run-subject-list');
  if (!list) return;

  // Preserve prior selection where possible.
  const prev = new Set(
    Array.from(list.querySelectorAll('input.subject-check:checked')).map((el) => el.value)
  );
  const allPrev = $('run-subject-all');
  const prevAll = allPrev ? allPrev.checked : true;

  const cards = configs.map((c) => `
    <label class="subject-card">
      <input type="checkbox" class="subject-check" value="${c.slug}" ${prev.has(c.slug) ? 'checked' : ''} />
      <span class="subject-name">${escape(c.name || c.slug)}</span>
      <span class="subject-desc">${escape(c.type || 'subject')} · <code>${escape(c.slug)}</code></span>
    </label>`).join('');

  list.innerHTML =
    `<label class="subject-card subject-card-all">
       <input type="checkbox" id="run-subject-all" value="" ${prevAll || prev.size === 0 ? 'checked' : ''} />
       <span class="subject-name">All subjects</span>
       <span class="subject-desc">Run against every config${configs.length ? ` (${configs.length})` : ''}</span>
     </label>` + cards;

  // Wire "All" ↔ individual mutual exclusion.
  const allBox = $('run-subject-all');
  const checks = list.querySelectorAll('input.subject-check');
  allBox.addEventListener('change', () => {
    if (allBox.checked) checks.forEach((c) => { c.checked = false; });
    else if (![...checks].some((c) => c.checked)) allBox.checked = true; // don't allow zero
    syncSlugFromChecks();
  });
  checks.forEach((c) => {
    c.addEventListener('change', () => {
      if (c.checked) allBox.checked = false;
      if (![...checks].some((x) => x.checked)) allBox.checked = true;
      syncSlugFromChecks();
    });
  });

  const hint = $('run-subject-hint');
  if (hint) {
    hint.innerHTML = configs.length
      ? 'Check one or more subjects — or leave <strong>All subjects</strong> checked to run against every config.'
      : 'No configs yet — run <code>/scout-onboard</code> first to create one.';
  }
  syncSlugFromChecks();
}

function syncSlugFromChecks() {
  const list = $('run-subject-list');
  if (!list) return;
  const checks = [...list.querySelectorAll('input.subject-check:checked')].map((c) => c.value);
  const allBox = $('run-subject-all');
  const total = list.querySelectorAll('input.subject-check').length;
  let value = '';
  if (allBox && allBox.checked) {
    value = total > 1 ? 'all' : '';
  } else if (checks.length === total && total > 1) {
    value = 'all';
  } else {
    value = checks.join(',');
  }
  $('run-slug').value = value;
  updateRunPreview();
}

function updateRunPreview() {
  const el = $('run-preview');
  if (el) el.textContent = buildPrompt();
}

$('run-command').addEventListener('change', (e) => {
  const custom = e.target.value === 'custom';
  $('run-prompt-wrap').hidden = !custom;
  $('run-extra-wrap').hidden = custom;
  const subjectWrap = $('run-subject-wrap');
  if (subjectWrap) subjectWrap.hidden = custom;
  const rangeWrap = $('run-range-wrap');
  if (rangeWrap) rangeWrap.hidden = custom || !COMMANDS_WITH_RANGE.has(e.target.value);
  const bsWrap = $('run-browser-scan-wrap');
  if (bsWrap) bsWrap.hidden = e.target.value !== 'scout-scan';
  updateRunPreview();
});
$('run-extra').addEventListener('input', updateRunPreview);

// --- Date range helper ---------------------------------------------
// Produces a natural-language phrase the prompts already understand
// (e.g., "March 2026", "today only", "from 2026-01-15 to 2026-02-10").
// Emits empty string for the default (agent uses last 30 days).
const COMMANDS_WITH_RANGE = new Set(['scout-scan', 'scout-gaps', 'scout-trends']);
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const RANGE_LS_KEY = 'cs.run.range.preset';
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function startOfWeek(now) {
  // Monday as week start.
  const d = new Date(now);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  d.setHours(0,0,0,0);
  return d;
}
function rangePreset() {
  return $('run-range-preset')?.value || 'default';
}
function dateRangePhrase() {
  const wrap = $('run-range-wrap');
  if (!wrap || wrap.hidden) return '';
  const choice = rangePreset();
  const now = new Date();
  if (choice === 'default') return '';
  if (choice === 'today') return `today only (${fmtDate(now)})`;
  if (choice === 'this-week') {
    const start = startOfWeek(now);
    return `this week so far (from ${fmtDate(start)} to ${fmtDate(now)})`;
  }
  if (choice === 'this-month') {
    return `${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()} so far (from ${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01 to ${fmtDate(now)})`;
  }
  if (choice === 'last-month') {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
  }
  if (choice === 'month') {
    const v = $('run-range-month')?.value; // "YYYY-MM"
    if (!v) return '';
    const [y, m] = v.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${y}`;
  }
  if (choice === 'custom') {
    const from = $('run-range-from')?.value;
    const to = $('run-range-to')?.value;
    if (!from && !to) return '';
    if (from && to) return `from ${from} to ${to}`;
    if (from) return `from ${from}`;
    return `until ${to}`;
  }
  return '';
}
function updateRangeSummary() {
  const el = $('run-range-summary');
  if (!el) return;
  const choice = rangePreset();
  if (choice === 'default') {
    el.textContent = 'Rolling 30-day window ending now.';
    return;
  }
  const phrase = dateRangePhrase();
  el.textContent = phrase ? `Agent will scan: ${phrase}.` : 'Pick a date to continue.';
}
const presetEl = $('run-range-preset');
if (presetEl) {
  // Restore last choice.
  try {
    const saved = localStorage.getItem(RANGE_LS_KEY);
    if (saved && presetEl.querySelector(`option[value="${saved}"]`)) {
      presetEl.value = saved;
    }
  } catch {}
  const syncDetailVisibility = () => {
    const choice = rangePreset();
    $('run-range-month-wrap').hidden = choice !== 'month';
    $('run-range-custom-wrap').hidden = choice !== 'custom';
  };
  syncDetailVisibility();
  presetEl.addEventListener('change', () => {
    try { localStorage.setItem(RANGE_LS_KEY, rangePreset()); } catch {}
    syncDetailVisibility();
    updateRangeSummary();
    updateRunPreview();
  });
}
['run-range-month', 'run-range-from', 'run-range-to'].forEach((id) => {
  $(id)?.addEventListener('input', () => { updateRangeSummary(); updateRunPreview(); });
});
updateRangeSummary();
const runPromptEl = $('run-prompt');
if (runPromptEl) runPromptEl.addEventListener('input', updateRunPreview);
$('run-copy').addEventListener('click', async () => {
  const prompt = buildPrompt();
  await navigator.clipboard.writeText(prompt);
  $('run-meta').textContent = `Copied: ${prompt}`;
});
$('run-start').addEventListener('click', startRun);

function buildPrompt() {
  const cmd = $('run-command').value;
  if (cmd === 'custom') return $('run-prompt').value.trim();
  const slug = $('run-slug').value;
  const extra = $('run-extra').value.trim();
  const range = COMMANDS_WITH_RANGE.has(cmd) ? dateRangePhrase() : '';
  // If user picked "All subjects" and there's more than one config, pass "all"
  // explicitly so the agent doesn't interactively prompt.
  const configCount = $('run-subject-list')
    ? $('run-subject-list').querySelectorAll('input[name="run-slug-choice"]').length - 1
    : 0;
  const target = slug || (configCount > 1 ? 'all' : '');
  return [`/${cmd}`, target, range, extra].filter(Boolean).join(' ');
}

async function startRun() {
  const cmd = $('run-command').value;
  const range = COMMANDS_WITH_RANGE.has(cmd) ? dateRangePhrase() : '';
  const extra = $('run-extra').value.trim();
  const combinedExtra = [range, extra].filter(Boolean).join(' ');
  const args =
    cmd === 'custom'
      ? { prompt: $('run-prompt').value.trim() }
      : { slug: $('run-slug').value, extra: combinedExtra };
  $('run-output').textContent = '';
  $('run-meta').textContent = 'Starting…';
  // Browser-scan preflight option — only meaningful for /scout-scan.
  const browserScan =
    cmd === 'scout-scan'
      ? (document.querySelector('input[name="run-browser-scan"]:checked')?.value || 'auto')
      : undefined;
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: cmd, args, options: browserScan ? { browserScan } : undefined }),
    });
    const data = await res.json();
    if (!res.ok) {
      $('run-meta').textContent = data.error || 'error';
      if (data.prompt) $('run-output').textContent = `Prompt: ${data.prompt}\n\nSet SCOUT_RUNNER env var to execute, or use "Copy prompt".`;
      return;
    }
    $('run-meta').textContent = `Running: ${data.command}`;
    streamRun(data.id);
  } catch (err) {
    $('run-meta').textContent = `error: ${err.message}`;
  }
}

function streamRun(id) {
  const out = $('run-output');
  const src = new EventSource(`/api/runs/${id}/stream`);
  src.onmessage = (e) => {
    try {
      const { chunk } = JSON.parse(e.data);
      out.textContent += chunk;
      out.scrollTop = out.scrollHeight;
    } catch {}
  };
  src.addEventListener('done', (e) => {
    try {
      const { status } = JSON.parse(e.data);
      $('run-meta').textContent = `Done: ${status}`;
    } catch {}
    src.close();
  });
  src.onerror = () => { src.close(); };
}

// --- Reports / Social ---------------------------------------------
async function loadReports() {
  const { reports } = await api('/api/reports');
  $('reports-list').innerHTML = reports
    .map((r) => `<li data-name="${r.name}">
        <span class="entry-name">${r.name}</span>
        <a class="entry-open" href="/view/reports/${encodeURIComponent(r.name)}" target="_blank" rel="noopener" title="Open in new window" aria-label="Open ${r.name} in new window">↗</a>
        <span class="mtime">${r.mtime.slice(0, 10)}</span>
      </li>`)
    .join('') || '<li class="hint">No reports yet.</li>';
  $('reports-list').querySelectorAll('li[data-name]').forEach((li) => {
    li.addEventListener('click', async (e) => {
      // Don't hijack clicks on the "open in new window" link.
      if (e.target.closest('.entry-open')) return;
      document.querySelectorAll('#reports-list li').forEach((x) => x.classList.remove('selected'));
      li.classList.add('selected');
      const r = await api(`/api/reports/${encodeURIComponent(li.dataset.name)}`);
      renderDocBody($('reports-body'), { name: li.dataset.name, html: r.html, kind: 'reports' });
    });
  });
  // Auto-open the most recent report (list is sorted desc by mtime) so the
  // page never lands on an empty viewer.
  const body = $('reports-body');
  const first = $('reports-list').querySelector('li[data-name]');
  if (first && body && !body.dataset.name) first.click();
}
async function loadSocial() {
  const { social } = await api('/api/reports');
  $('social-list').innerHTML = social
    .map((r) => `<li data-name="${r.name}">
        <span class="entry-name">${r.name}</span>
        <a class="entry-open" href="/view/social/${encodeURIComponent(r.name)}" target="_blank" rel="noopener" title="Open in new window" aria-label="Open ${r.name} in new window">↗</a>
        <span class="mtime">${r.mtime.slice(0, 10)}</span>
      </li>`)
    .join('') || '<li class="hint">No social posts yet.</li>';
  $('social-list').querySelectorAll('li[data-name]').forEach((li) => {
    li.addEventListener('click', async (e) => {
      if (e.target.closest('.entry-open')) return;
      document.querySelectorAll('#social-list li').forEach((x) => x.classList.remove('selected'));
      li.classList.add('selected');
      const r = await api(`/api/social/${encodeURIComponent(li.dataset.name)}`);
      renderDocBody($('social-body'), { name: li.dataset.name, html: r.html, kind: 'social' });
      $('social-body').dataset.name = li.dataset.name;
      enhanceSocialBody($('social-body'));
    });
  });
  // Auto-open the most recent social-posts file (list is sorted desc by mtime)
  // so the page never lands on an empty viewer.
  const body = $('social-body');
  const first = $('social-list').querySelector('li[data-name]');
  if (first && body && !body.dataset.name) first.click();
}

// Render a markdown doc into the inline article view, with a toolbar that
// includes an "Open in new window" link pointing at the standalone /view/*
// route. Used by both the Reports and Social lists.
function renderDocBody(article, { name, html, kind }) {
  if (!article) return;
  const viewPath = `/view/${kind}/${encodeURIComponent(name)}`;
  article.innerHTML = `
    <div class="doc-toolbar">
      <a href="${viewPath}" target="_blank" rel="noopener" class="doc-open-link" title="Open ${name} in a new window">Open in new window ↗</a>
    </div>
    <div class="doc-content">${html}</div>
  `;
}

// Enhance a rendered social-posts markdown view with:
//  - a "Copy" button on every <pre> code block (one per post variant)
//  - a URL chip row above the body listing every unique link found
function enhanceSocialBody(root) {
  if (!root) return;

  // 1) Copy buttons on every code block (each post variant should be
  //    in a fenced ``` block per the scout-post spec).
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector(':scope > .copy-btn')) return; // idempotent
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const text = (pre.querySelector('code')?.innerText ?? pre.innerText).trim();
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied ✓';
        btn.classList.add('copied');
        window.toast?.success?.({ title: 'Post copied to clipboard', duration: 2500 });
      } catch {
        btn.textContent = 'Copy failed';
        window.toast?.error?.({ title: 'Could not copy', description: 'Browser blocked clipboard access.' });
      }
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
    pre.appendChild(btn);
  });

  // 2) URL chip strip — collect unique http(s) links from the body.
  const links = new Set();
  root.querySelectorAll('a[href^="http"]').forEach((a) => links.add(a.href));
  const existing = root.querySelector(':scope > .post-url-strip');
  if (existing) existing.remove();
  if (links.size) {
    const strip = document.createElement('div');
    strip.className = 'post-url-strip';
    strip.innerHTML =
      '<span class="post-url-label">URLs:</span>' +
      [...links].map((href) => {
        const safe = href.replace(/"/g, '&quot;');
        const short = href.length > 60 ? href.slice(0, 57) + '…' : href;
        return `<span class="post-url"><a href="${safe}" target="_blank" rel="noopener">${short}</a>` +
          `<button type="button" class="post-url-copy" data-url="${safe}" title="Copy URL">⎘</button></span>`;
      }).join('');
    root.prepend(strip);
    strip.querySelectorAll('.post-url-copy').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        const u = b.dataset.url || '';
        try {
          await navigator.clipboard.writeText(u);
          b.textContent = '✓';
          window.toast?.success?.({ title: 'URL copied', duration: 2000 });
          setTimeout(() => { b.textContent = '⎘'; }, 1500);
        } catch {
          window.toast?.error?.({ title: 'Could not copy URL' });
        }
      });
    });
  }

  // 3) Inline thumbnails — the renderer now embeds each generated PNG
  //    directly under its matching platform variant code block, but the
  //    markdown uses repo-relative paths like `images/<batch>/<file>`.
  //    Rewrite those to the server-served `/brand-assets/...` URL and
  //    decorate each with download / copy-path controls (replacing the
  //    old separate gallery section, which duplicated the same images).
  const fileName = root.dataset.name;
  if (fileName) decorateInlineSocialImages(root, fileName);
}

function decorateInlineSocialImages(root, fileName) {
  // Idempotent: clear any previously injected actions and remove any
  // legacy top-of-page gallery (older renderings of this file).
  root.querySelectorAll(':scope .inline-thumb-actions').forEach((n) => n.remove());
  const legacyGallery = root.querySelector(':scope > .social-image-gallery');
  if (legacyGallery) legacyGallery.remove();

  const imgs = [...root.querySelectorAll('.markdown img, .doc-content img')]
    .filter((i) => !i.closest('.gallery-item'));
  if (!imgs.length) return;

  const fmtBytes = (n) => {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  };
  const safeAttr = (s) => String(s).replace(/"/g, '&quot;');

  imgs.forEach((img) => {
    // Rewrite repo-relative `images/<batch>/<name>` → `/brand-assets/<batch>/<name>`.
    const raw = img.getAttribute('src') || '';
    const m = raw.match(/^(?:\.?\/?)?images\/(.+)$/);
    if (m) {
      const newUrl = `/brand-assets/${m[1]}`;
      img.src = newUrl;
      // Wrap in a click-through anchor if not already.
      if (!img.parentElement || img.parentElement.tagName !== 'A') {
        const a = document.createElement('a');
        a.href = newUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.title = `Open ${m[1].split('/').pop()}`;
        img.parentNode.insertBefore(a, img);
        a.appendChild(img);
      }
    }
    img.classList.add('inline-thumb');
    img.loading = 'lazy';

    // Append a small actions row right after the image's containing block
    // (typically a <p>) — copy repo path + download.
    const finalUrl = img.getAttribute('src');
    const fileBase = decodeURIComponent(finalUrl.split('/').pop());
    const batch = (finalUrl.match(/^\/brand-assets\/(.+)\/[^/]+$/) || [, ''])[1];
    const repoPath = `social-posts/images/${batch ? batch + '/' : ''}${fileBase}`;
    const wrap = img.closest('p, figure, li, div') || img.parentElement;
    const row = document.createElement('div');
    row.className = 'inline-thumb-actions';
    row.innerHTML =
      `<button type="button" class="thumb-btn" data-copy-path="${safeAttr(repoPath)}" title="Copy repo path">Copy path</button>` +
      `<a class="thumb-btn" href="${safeAttr(finalUrl)}" download="${safeAttr(fileBase)}">Download</a>` +
      `<a class="thumb-btn thumb-btn-ghost" href="${safeAttr(finalUrl)}" target="_blank" rel="noopener">Open full size</a>`;
    wrap.after(row);
  });

  // Wire the copy-path buttons.
  root.querySelectorAll('.inline-thumb-actions [data-copy-path]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p = btn.dataset.copyPath || '';
      try {
        await navigator.clipboard.writeText(p);
        const label = btn.textContent;
        btn.textContent = 'Copied ✓';
        btn.classList.add('copied');
        window.toast?.success?.({ title: 'Path copied', description: p, duration: 2000 });
        setTimeout(() => { btn.textContent = label; btn.classList.remove('copied'); }, 1600);
      } catch {
        window.toast?.error?.({ title: 'Could not copy path' });
      }
    });
  });
}

async function renderSocialImageGallery(root, fileName) {
  // Remove any prior gallery (idempotent re-enhancement).
  const prior = root.querySelector(':scope > .social-image-gallery');
  if (prior) prior.remove();
  let images = [];
  try {
    const r = await fetch(`/api/social/${encodeURIComponent(fileName)}/images`);
    if (!r.ok) return;
    const data = await r.json();
    images = Array.isArray(data.images) ? data.images : [];
  } catch { return; }
  if (!images.length) return;

  const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  };
  const safeAttr = (s) => String(s).replace(/"/g, '&quot;');

  const section = document.createElement('section');
  section.className = 'social-image-gallery';
  section.innerHTML =
    `<h4>Generated images <span class="hint" style="text-transform:none;font-weight:400;letter-spacing:0;color:var(--muted-2);margin-left:0.4rem;">(${images.length})</span></h4>` +
    `<div class="gallery-grid">` +
    images.map((img) => {
      const repoPath = `social-posts/images/${img.batch ? img.batch + '/' : ''}${img.name}`;
      return `
        <figure class="gallery-item">
          <a href="${safeAttr(img.url)}" target="_blank" rel="noopener" title="Open ${safeAttr(img.name)}">
            <img src="${safeAttr(img.url)}" alt="${safeAttr(img.name)}" loading="lazy" />
          </a>
          <figcaption class="gallery-name" title="${safeAttr(repoPath)}">${escape(img.name)}</figcaption>
          <div class="gallery-actions">
            <button type="button" class="gallery-btn" data-copy-path="${safeAttr(repoPath)}" title="Copy repo path">Copy path</button>
            <a class="gallery-btn" href="${safeAttr(img.url)}" download="${safeAttr(img.name)}">Download</a>
            <span class="gallery-btn" style="cursor:default;border-style:dashed;">${fmtBytes(img.bytes)}</span>
          </div>
        </figure>`;
    }).join('') +
    `</div>`;

  // Insert just after the URL strip if present, otherwise at the top.
  const urlStrip = root.querySelector(':scope > .post-url-strip');
  if (urlStrip) urlStrip.after(section);
  else root.prepend(section);

  section.querySelectorAll('button[data-copy-path]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p = btn.dataset.copyPath || '';
      try {
        await navigator.clipboard.writeText(p);
        btn.textContent = 'Copied ✓';
        btn.classList.add('copied');
        window.toast?.success?.({ title: 'Path copied', description: p, duration: 2200 });
        setTimeout(() => { btn.textContent = 'Copy path'; btn.classList.remove('copied'); }, 1800);
      } catch {
        window.toast?.error?.({ title: 'Could not copy path' });
      }
    });
  });
}

// --- "Create posts for me" — /scout-post runner ---------------------
(() => {
  const form = $('social-generate-form');
  if (!form) return;
  const urlInput = $('social-gen-url');
  const ctxInput = $('social-gen-context');
  const startBtn = $('social-gen-start');
  const stopBtn = $('social-gen-stop');
  const status = $('social-gen-status');
  const output = $('social-gen-output');

  let runId = null;
  let stream = null;

  function setStatus(text, tone) {
    status.textContent = text || '';
    status.dataset.tone = tone || '';
  }
  function setRunning(running) {
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    urlInput.disabled = running;
    ctxInput.disabled = running;
    startBtn.textContent = running ? 'Running…' : 'Generate posts';
  }
  function appendOutput(chunk) {
    output.hidden = false;
    output.textContent += chunk;
    output.scrollTop = output.scrollHeight;
  }

  // Defensive: ensure Ctrl/Cmd+A inside these fields selects only the field's
  // own contents (some global handlers elsewhere on the page can otherwise
  // expand the selection to the whole document).
  for (const el of [urlInput, ctxInput]) {
    if (!el) continue;
    el.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.stopPropagation();
        e.preventDefault();
        el.focus();
        el.select();
      }
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    const ctx = ctxInput.value.trim();
    const notLive = !!$('social-gen-not-live')?.checked;
    if (!url && !ctx) {
      setStatus('Provide a URL, source copy, or both', 'error');
      return;
    }
    if ((!url || notLive) && ctx.length < 20) {
      setStatus('Source copy is too short — paste the announcement text, draft, or detailed notes', 'error');
      return;
    }

    // Read tuner controls (all optional — fall back to sensible defaults).
    const tone = ($('social-gen-tone')?.value || 'conversational').trim();
    const emoji = ($('social-gen-emoji')?.value || 'light').trim();
    const variants = ($('social-gen-variants')?.value || '3').trim();
    const length = ($('social-gen-length')?.value || 'tease').trim();
    const lic = $('social-gen-lic')?.checked ? 'yes' : 'no';
    const hashtags = $('social-gen-hashtags')?.checked ? 'yes' : 'no';
    const mention = $('social-gen-mention')?.checked ? 'yes' : 'no';
    const thumbStyle = ($('social-gen-thumb-style')?.value || 'auto').trim();
    // Strip brackets / control chars so freeform notes can't break the
    // bracketed-tuner contract or smuggle additional directives.
    const thumbNotes = ($('social-gen-thumb-notes')?.value || '')
      .replace(/[\x00-\x1f\x7f]+/g, ' ')
      .replace(/[\[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    const platforms = ['li', 'x', 'bsky', 'rd']
      .filter((k) => $(`social-gen-pf-${k}`)?.checked)
      .map((k) => ({ li: 'linkedin', x: 'x', bsky: 'bluesky', rd: 'reddit' }[k]))
      .join(',') || 'linkedin,x';

    // scout-post picks its own config (single = uses it; multi = asks). We
    // pass the URL (optional), free-form context/copy, the not-live flag,
    // and tuner options as one `extra` string so buildPrompt produces:
    //   /scout-post <url> [— context] [tuners]                                (URL mode, link is live)
    //   /scout-post <url> (link not live yet — use copy below, do not fetch) — <copy> [tuners]
    //   /scout-post (no URL yet — draft from copy below, use {LINK} placeholder for CTA) — <copy> [tuners]
    const tuners =
      ` [tone: ${tone}]` +
      ` [platforms: ${platforms}]` +
      ` [length: ${length}]` +
      ` [emoji: ${emoji}]` +
      ` [hashtags: ${hashtags}]` +
      ` [mention-authors: ${mention}]` +
      ` [link-in-comments: ${lic}]` +
      ` [variants: ${variants}]` +
      ` [thumbnails: ${thumbStyle}]` +
      (thumbNotes ? ` [thumbnail-notes: ${thumbNotes}]` : '');
    let extra;
    if (url && !notLive) {
      extra = ctx ? `${url} — ${ctx}${tuners}` : `${url}${tuners}`;
    } else if (url && notLive) {
      // URL is known but the page isn't live yet. Use the URL as the CTA in
      // the post, but tell the agent NOT to fetch it and to trust the copy.
      extra = `${url} (link not live yet — use copy below as source of truth, do not fetch the URL) — ${ctx}${tuners}`;
    } else {
      // No URL at all — draft from copy and use {LINK} placeholder for CTA.
      extra = `(no URL yet — draft from copy below; use {LINK} placeholder for CTA) — ${ctx}${tuners}`;
    }
    output.textContent = '';
    output.hidden = false;
    setStatus('Starting…');
    setRunning(true);
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          command: 'scout-post',
          args: { extra },
          options: { skipThumbnails: thumbStyle === 'off' },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRunning(false);
        setStatus(data.error || 'Failed to start', 'error');
        if (data.prompt) appendOutput(`Prompt:\n  ${data.prompt}\n\nSet an agent in Setup, or copy/paste this prompt into your agent manually.\n`);
        return;
      }
      runId = data.id;
      appendOutput(`▶ ${data.command}\n\n`);
      setStatus(`Running…`);
      stream = new EventSource(`/api/runs/${runId}/stream`);
      stream.onmessage = (e) => {
        try { appendOutput(JSON.parse(e.data).chunk || ''); } catch {}
      };
      stream.addEventListener('done', (e) => {
        try {
          const { status: s } = JSON.parse(e.data);
          setStatus(`Done: ${s}`, s === 'exit-0' || s === 'success' ? 'ok' : 'error');
        } catch {
          setStatus('Done');
        }
        setRunning(false);
        stream && stream.close();
        stream = null;
        // Refresh the social posts list — a new file may have been written
        loadSocial().catch(() => {});
      });
      stream.onerror = () => { stream && stream.close(); stream = null; setRunning(false); };
    } catch (err) {
      setRunning(false);
      setStatus(`error: ${err.message}`, 'error');
    }
  });

  stopBtn.addEventListener('click', async () => {
    if (!runId) return;
    setStatus('Stopping…');
    try { await fetch(`/api/runs/${runId}/stop`, { method: 'POST' }); }
    catch (err) { setStatus(`stop failed: ${err.message}`, 'error'); }
  });
})();

// --- "Generate alt text" — /scout-alt runner ------------------------
(() => {
  const form = $('alt-generate-form');
  if (!form) return;
  const imgInput = $('alt-gen-img');
  const descInput = $('alt-gen-desc');
  const startBtn = $('alt-gen-start');
  const stopBtn = $('alt-gen-stop');
  const status = $('alt-gen-status');
  const output = $('alt-gen-output');
  const dropzone = $('alt-dropzone');
  const fileInput = $('alt-gen-file');
  const dzEmpty = $('alt-dropzone-empty');
  const dzPreview = $('alt-dropzone-preview');
  const previewImg = $('alt-preview-img');
  const previewPath = $('alt-preview-path');
  const previewClear = $('alt-preview-clear');

  let uploadedPath = null; // workspace-relative path returned by the server
  let visionReport = null; // formatted text from /api/alt/describe
  let runId = null;
  let stream = null;
  let visionAvailable = false;

  const visionStatus = $('alt-vision-status');

  async function checkVision() {
    try {
      const res = await fetch('/api/alt/vision-status');
      const data = await res.json();
      visionAvailable = !!data.ok && data.provider !== 'none';
      if (data.provider === 'none') {
        visionStatus.textContent = 'Vision provider: none — agent will work from your description, or you can configure VISION_PROVIDER=ollama|openai in .env (run "scout onboard" → vision question).';
        visionStatus.dataset.tone = 'muted';
      } else if (data.ok && (data.modelInstalled !== false)) {
        visionStatus.textContent = `Vision: ${data.message}`;
        visionStatus.dataset.tone = 'ok';
      } else {
        visionStatus.textContent = `Vision: ${data.message}`;
        visionStatus.dataset.tone = 'error';
      }
    } catch (err) {
      visionStatus.textContent = `Vision status unavailable: ${err.message}`;
      visionStatus.dataset.tone = 'error';
    }
  }
  checkVision();

  function setStatus(text, tone) {
    status.textContent = text || '';
    status.dataset.tone = tone || '';
  }
  function setRunning(running) {
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    imgInput.disabled = running;
    descInput.disabled = running;
    fileInput.disabled = running;
    startBtn.textContent = running ? 'Running…' : 'Generate alt text';
  }
  function appendOutput(chunk) {
    output.hidden = false;
    output.textContent += chunk;
    output.scrollTop = output.scrollHeight;
  }
  function showPreview(previewUrl, relPath) {
    uploadedPath = relPath;
    visionReport = null;
    previewImg.src = previewUrl;
    previewPath.textContent = relPath;
    dzEmpty.hidden = true;
    dzPreview.hidden = false;
  }
  function clearPreview() {
    uploadedPath = null;
    visionReport = null;
    previewImg.removeAttribute('src');
    previewPath.textContent = '';
    dzPreview.hidden = true;
    dzEmpty.hidden = false;
    fileInput.value = '';
  }

  async function describeUploaded() {
    if (!uploadedPath || !visionAvailable) return;
    setStatus('Inspecting image with vision provider…');
    try {
      const res = await fetch('/api/alt/describe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relativePath: uploadedPath }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`Vision describe failed: ${data.error || res.status}`, 'error');
        return;
      }
      visionReport = data.formatted || '';
      const subj = data.report?.subject ? ` — ${data.report.subject}` : '';
      setStatus(`Vision OK (${data.report?.provider}/${data.report?.model || ''})${subj}`, 'ok');
    } catch (err) {
      setStatus(`Vision describe error: ${err.message}`, 'error');
    }
  }
  previewClear.addEventListener('click', clearPreview);

  // Defensive: keep Ctrl/Cmd+A scoped to this field, not the whole page.
  for (const el of [imgInput, descInput]) {
    if (!el) continue;
    el.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.stopPropagation();
        e.preventDefault();
        el.focus();
        el.select();
      }
    });
  }

  // ---- Upload helpers ----
  async function uploadFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setStatus(`Not an image: ${file.type || 'unknown type'}`, 'error');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setStatus(`Image is ${(file.size / 1024 / 1024).toFixed(1)} MB — limit is 25 MB`, 'error');
      return;
    }
    setStatus(`Uploading ${file.name} (${(file.size / 1024).toFixed(0)} KB)…`);
    const dataBase64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(r.error);
      r.onload = () => resolve(String(r.result || ''));
      r.readAsDataURL(file);
    });
    try {
      const res = await fetch('/api/alt/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: file.name, dataBase64 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`Upload failed: ${data.error || res.status}`, 'error');
        return;
      }
      showPreview(data.previewUrl, data.relativePath);
      setStatus(`Saved to ${data.relativePath}`, 'ok');
      // Fire-and-forget: ask the configured vision provider to describe the image.
      describeUploaded();
    } catch (err) {
      setStatus(`Upload error: ${err.message}`, 'error');
    }
  }

  // ---- Dropzone wiring ----
  dropzone.addEventListener('click', (e) => {
    if (e.target.closest('button')) return; // let Clear button work
    fileInput.click();
  });
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) uploadFile(f);
  });
  ['dragenter', 'dragover'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });
  dropzone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const file = dt && dt.files && dt.files[0];
    if (file) uploadFile(file);
  });

  // Paste from clipboard while focus is anywhere inside the alt card.
  const altCard = $('alt-generate-card');
  altCard?.addEventListener('paste', (e) => {
    // Don't hijack paste into the URL or description fields.
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) {
          e.preventDefault();
          uploadFile(blob);
          return;
        }
      }
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const urlOrPath = imgInput.value.trim();
    const desc = descInput.value.trim();
    const imageRef = uploadedPath || urlOrPath;

    if (!imageRef && !desc) {
      setStatus('Drop an image, paste a URL, or write a description — one of those is required', 'error');
      return;
    }
    const platform = ($('alt-gen-platform')?.value || 'generic').trim();
    const variants = ($('alt-gen-variants')?.value || '3').trim();
    const decorativeAllowed = $('alt-gen-decorative-allowed')?.checked ? 'yes' : 'no';

    const tuners = ` [platform: ${platform}] [variants: ${variants}] [decorative-allowed: ${decorativeAllowed}]`;
    const visionBlock = visionReport ? `\n\n${visionReport}\n` : '';
    let extra;
    if (imageRef && desc) {
      extra = `${imageRef} — ${desc}${tuners}${visionBlock}`;
    } else if (imageRef) {
      const fallback = visionReport
        ? '(description from vision provider — see report below)'
        : '(no description supplied; inspect the image and produce alt text, or refuse with a low-confidence note if you cannot read it)';
      extra = `${imageRef} — ${fallback}${tuners}${visionBlock}`;
    } else {
      extra = `(no image provided — description only) — ${desc}${tuners}`;
    }

    output.textContent = '';
    output.hidden = false;
    setStatus('Starting…');
    setRunning(true);
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'scout-alt', args: { extra } }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRunning(false);
        setStatus(data.error || 'Failed to start', 'error');
        if (data.prompt) appendOutput(`Prompt:\n  ${data.prompt}\n\nSet an agent in Setup, or copy/paste this prompt into your agent manually.\n`);
        return;
      }
      runId = data.id;
      appendOutput(`▶ ${data.command}\n\n`);
      setStatus(`Running…`);
      stream = new EventSource(`/api/runs/${runId}/stream`);
      stream.onmessage = (e) => {
        try { appendOutput(JSON.parse(e.data).chunk || ''); } catch {}
      };
      stream.addEventListener('done', (e) => {
        try {
          const { status: s } = JSON.parse(e.data);
          setStatus(`Done: ${s}`, s === 'exit-0' || s === 'success' ? 'ok' : 'error');
        } catch {
          setStatus('Done');
        }
        setRunning(false);
        stream && stream.close();
        stream = null;
        loadSocial().catch(() => {});
      });
      stream.onerror = () => { stream && stream.close(); stream = null; setRunning(false); };
    } catch (err) {
      setRunning(false);
      setStatus(`error: ${err.message}`, 'error');
    }
  });

  stopBtn.addEventListener('click', async () => {
    if (!runId) return;
    setStatus('Stopping…');
    try { await fetch(`/api/runs/${runId}/stop`, { method: 'POST' }); }
    catch (err) { setStatus(`stop failed: ${err.message}`, 'error'); }
  });
})();

// --- "Select all" / "Clear" bulk controls --------------------------
// Delegated click handler. Supports two modes:
//   1. data-target=CSS selector for checkboxes (Networks, Feature toggles).
//   2. data-chips=elementId for Suggest-panel chip groups (terms, hashtags,
//      topic tags) — toggles every chip on/off and syncs the linked input.
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.bulk-select');
  if (!btn) return;
  const action = btn.dataset.action; // 'all' | 'none'

  // Checkbox groups
  const sel = btn.dataset.target;
  if (sel) {
    document.querySelectorAll(sel).forEach((cb) => {
      if (cb.disabled) return;
      cb.checked = action === 'all';
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    return;
  }

  // Chip panels — btn.dataset.chips = panel id, btn.dataset.input = linked input id
  const chipsId = btn.dataset.chips;
  const inputId = btn.dataset.input;
  if (chipsId && inputId) {
    const chips = document.getElementById(chipsId);
    const input = document.getElementById(inputId);
    if (!chips || !input) return;
    const tags = Array.from(chips.querySelectorAll('.tag-chip')).map((c) => c.dataset.tag);
    if (action === 'all') {
      // Merge with any user-entered values (dedupe, preserve order).
      const existing = parseTagList(input.value);
      const existingLower = new Set(existing.map((t) => t.toLowerCase()));
      for (const t of tags) {
        if (!existingLower.has(t.toLowerCase())) {
          existing.push(t);
          existingLower.add(t.toLowerCase());
        }
      }
      input.value = existing.join(', ');
    } else {
      // Remove the suggested tags but keep user-typed ones.
      const tagsLower = new Set(tags.map((t) => t.toLowerCase()));
      const kept = parseTagList(input.value).filter((t) => !tagsLower.has(t.toLowerCase()));
      input.value = kept.join(', ');
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
});

// Inject "Select all / Clear" controls into each suggest-chips panel whenever
// chips are rendered. MutationObserver keeps it in sync with dynamic renders.
(function wireChipBulkControls() {
  const panels = [
    { chips: 'cfg-terms-suggest-chips', input: 'cfg-terms' },
    { chips: 'cfg-hashtags-suggest-chips', input: 'cfg-hashtags' },
    { chips: 'cfg-topic-suggest-chips', input: 'cfg-topic-tags' },
  ];
  for (const { chips, input } of panels) {
    const host = document.getElementById(chips);
    if (!host) continue;
    const ensureToolbar = () => {
      const hasChips = host.querySelector('.tag-chip');
      let bar = host.previousElementSibling;
      const isOurBar = bar && bar.classList?.contains('chip-bulk-bar') && bar.dataset.chips === chips;
      if (hasChips && !host.hidden) {
        if (!isOurBar) {
          const div = document.createElement('div');
          div.className = 'chip-bulk-bar';
          div.dataset.chips = chips;
          div.innerHTML = `<button type="button" class="link-btn bulk-select" data-chips="${chips}" data-input="${input}" data-action="all">Select all</button> <span class="sep">·</span> <button type="button" class="link-btn bulk-select" data-chips="${chips}" data-input="${input}" data-action="none">Clear</button>`;
          host.parentNode.insertBefore(div, host);
        } else {
          bar.hidden = false;
        }
      } else if (isOurBar) {
        bar.hidden = true;
      }
    };
    new MutationObserver(ensureToolbar).observe(host, { childList: true, attributes: true, attributeFilter: ['hidden'] });
  }
})();

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// --- Boot ----------------------------------------------------------
// Honor the URL hash across refreshes so users stay on the view they were on.
// Fall back: only land on the dashboard once setup is complete, otherwise Setup.
loadStatus().then((s) => {
  const isSetUp = s.runnerConfigured && s.hasConfigs;
  const hashView = location.hash.replace(/^#/, '');
  let target;
  if (KNOWN_VIEWS.includes(hashView)) {
    // Don't strand an unconfigured user on a view that needs setup.
    target = (!isSetUp && hashView !== 'setup') ? 'setup' : hashView;
  } else {
    target = isSetUp ? 'dashboard' : 'setup';
  }
  gotoView(target);
}).catch((err) => {
  $('status-pill').textContent = 'error';
  console.error(err);
  gotoView('setup');
});

// --- Vision provider config panel (Setup + Configs) ---------------
// Renders into any container with class .vision-config. Reads / writes
// VISION_PROVIDER, OLLAMA_HOST, OLLAMA_VISION_MODEL, OPENAI_VISION_MODEL,
// and OPENAI_API_KEY via /api/vision/config (which merges into .env without
// disturbing other keys).
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
  const id = (k) => `${instanceId}-${k}`;
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
          ${CUSTOM_PRESETS.map((p, i) => `<option value="${i}">${escape(p.label)}</option>`).join('')}
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
      ${OLLAMA_MODEL_SUGGESTIONS.map((m) => `<option value="${escape(m)}">`).join('')}
    </datalist>
    <datalist id="openai-models">
      ${OPENAI_MODEL_SUGGESTIONS.map((m) => `<option value="${escape(m)}">`).join('')}
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
    const p = providerSel.value;
    root.querySelectorAll('.vision-section').forEach((sec) => {
      sec.hidden = sec.dataset.section !== p;
    });
  }
  providerSel.addEventListener('change', syncSections);
  syncSections();

  // Preset autofill for the custom provider
  const presetSel = root.querySelector('[data-vc-preset]');
  if (presetSel) {
    presetSel.addEventListener('change', () => {
      const idx = parseInt(presetSel.value, 10);
      if (!Number.isFinite(idx)) return;
      const preset = CUSTOM_PRESETS[idx];
      if (!preset) return;
      const setVal = (k, v) => {
        const el = root.querySelector(`[data-vc="${k}"]`);
        if (el) el.value = v;
      };
      setVal('customBaseUrl', preset.baseUrl);
      setVal('customModel', preset.model);
      setVal('customAuthStyle', preset.auth);
    });
  }

  function readForm() {
    const get = (k) => {
      const el = root.querySelector(`[data-vc="${k}"]`);
      return el ? el.value : '';
    };
    return {
      provider: providerSel.value,
      ollamaHost: get('ollamaHost'),
      ollamaModel: get('ollamaModel'),
      openaiModel: get('openaiModel'),
      openaiApiKey: get('openaiApiKey'), // empty = unchanged on server
      customBaseUrl: get('customBaseUrl'),
      customModel: get('customModel'),
      customAuthStyle: get('customAuthStyle') || 'bearer',
      customApiKey: get('customApiKey'), // empty = unchanged on server
    };
  }

  function setStatus(msg, tone) {
    statusEl.textContent = msg || '';
    if (tone) statusEl.dataset.tone = tone; else delete statusEl.dataset.tone;
  }

  const banner = root.querySelector('[data-vc-banner]');
  let pullPollTimer = null;
  let recommendedModelsCache = null;

  async function loadRecommendedModels() {
    if (recommendedModelsCache) return recommendedModelsCache;
    try {
      const data = await fetch('/api/vision/ollama-models').then((r) => r.json());
      recommendedModelsCache = data.models || [];
    } catch { recommendedModelsCache = []; }
    return recommendedModelsCache;
  }

  function hideBanner() {
    if (!banner) return;
    banner.hidden = true;
    banner.innerHTML = '';
    if (pullPollTimer) { clearInterval(pullPollTimer); pullPollTimer = null; }
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
          ${models.map((m) => `
            <label class="vision-model-pick">
              <input type="radio" name="vc-pull-model" value="${escape(m.name)}"${m.name === currentModel ? ' checked' : ''} />
              <span class="vision-model-name"><code>${escape(m.name)}</code> <span class="hint">(${escape(m.size)})</span></span>
              <span class="hint">${escape(m.note)}</span>
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
    // Update the copy-paste command as the user changes the radio
    banner.querySelectorAll('input[name="vc-pull-model"]').forEach((r) => {
      r.addEventListener('change', () => {
        const cmd = banner.querySelector('[data-vc-pull-cmd]');
        if (cmd) cmd.textContent = `ollama pull ${r.value}`;
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
        const res = await fetch('/api/vision/ollama-pull', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model }),
        });
        const data = await res.json();
        if (!res.ok) { progress.textContent = `Failed: ${data.error || res.status}`; return; }
      } catch (err) {
        progress.textContent = `Failed: ${err.message}`;
        return;
      }
      // Poll progress
      if (pullPollTimer) clearInterval(pullPollTimer);
      pullPollTimer = setInterval(async () => {
        try {
          const s = await fetch(`/api/vision/ollama-pull/status?model=${encodeURIComponent(model)}`).then((r) => r.json());
          if (!s.exists) { progress.textContent = 'Not started.'; return; }
          const pct = (typeof s.percent === 'number') ? ` ${s.percent}%` : '';
          const elapsed = ` (${s.elapsedSec}s)`;
          progress.textContent = s.done
            ? (s.error ? `Pull failed: ${s.error}` : `✓ ${model} installed${elapsed}`)
            : `${s.status || 'pulling'}${pct}${elapsed}`;
          if (s.done) {
            clearInterval(pullPollTimer);
            pullPollTimer = null;
            // Re-probe to flip banner state and update the .env model field
            const modelInput = root.querySelector('[data-vc="ollamaModel"]');
            if (modelInput) modelInput.value = model;
            // Save so VISION_PROVIDER=ollama and OLLAMA_VISION_MODEL=<model>
            try {
              await fetch('/api/vision/config', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ...readForm(), provider: 'ollama', ollamaModel: model }),
              });
            } catch {}
            const probe = await fetch('/api/alt/vision-status').then((r) => r.json());
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
    // Refresh the alt card's status pill if it's mounted
    const altStatus = $('alt-vision-status');
    if (altStatus) {
      altStatus.textContent = `Vision: ${probe.message}`;
      altStatus.dataset.tone = probe.ok ? 'ok' : (probe.provider === 'none' ? 'muted' : 'error');
    }
    // Show the missing-model banner only for ollama-running-but-no-model
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
      const res = await fetch('/api/vision/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setStatus(`Save failed: ${data.error || res.status}`, 'error'); return; }
      // Clear the password fields so the placeholder reflects the new state
      const keyInput = root.querySelector('[data-vc="openaiApiKey"]');
      if (keyInput) keyInput.value = '';
      const customKeyInput = root.querySelector('[data-vc="customApiKey"]');
      if (customKeyInput) customKeyInput.value = '';
      setStatus(`Saved (provider: ${data.provider})`, 'ok');
      try {
        const probe = await fetch('/api/alt/vision-status').then((r) => r.json());
        await reflectProbe(probe);
      } catch {}
    } catch (err) {
      setStatus(`Save error: ${err.message}`, 'error');
    }
  });

  root.querySelector('[data-vc-action="test"]').addEventListener('click', async () => {
    setStatus('Testing…');
    try {
      // Save first so the test reflects current form values
      const body = readForm();
      const saveRes = await fetch('/api/vision/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!saveRes.ok) {
        const data = await saveRes.json();
        setStatus(`Save failed before test: ${data.error || saveRes.status}`, 'error');
        return;
      }
      const probe = await fetch('/api/alt/vision-status').then((r) => r.json());
      await reflectProbe(probe);
    } catch (err) {
      setStatus(`Test error: ${err.message}`, 'error');
    }
  });

  // Auto-show the banner on initial mount if the saved provider is ollama and the model is missing
  (async () => {
    if (cfg.provider === 'ollama') {
      try {
        const probe = await fetch('/api/alt/vision-status').then((r) => r.json());
        if (probe.provider === 'ollama' && probe.ok && probe.modelInstalled === false) {
          await showMissingModelBanner(probe);
        }
      } catch {}
    }
  })();
}

// Mount on Setup view (always visible) and Configs view (lazy when details opens)
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

// --- Local services auto-detect (Ollama, LM Studio, ...) ----------
// Probes /api/services/detect and renders a banner above the vision panel.
// "Use Ollama" button switches the vision panel to provider=ollama and
// prefills host/model fields without saving — the user still hits "Save".
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
  const running = services.filter((s) => s.running);
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
    const chips = running.map((s) => {
      const count = (s.models || []).length;
      const modelLabel = count ? `${count} model${count === 1 ? '' : 's'}` : 'no models pulled yet';
      const action = s.id === 'ollama'
        ? `<button type="button" data-action="use-ollama" data-host="${escape(s.host)}" data-model="${escape((s.models || [])[0] || '')}">Use Ollama</button>`
        : '';
      return `
        <div class="service-chip">
          <strong>✓ ${escape(s.name)}</strong>
          <span class="hint">${escape(s.host)} — ${escape(modelLabel)}</span>
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
  root.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'rescan') {
        mountServicesDetect(containerId);
        return;
      }
      if (btn.dataset.action === 'use-ollama') {
        const target = document.getElementById(targetId);
        if (!target) return;
        const provSel = target.querySelector('[data-vc="provider"]');
        const hostInp = target.querySelector('[data-vc="ollamaHost"]');
        const modelInp = target.querySelector('[data-vc="ollamaModel"]');
        if (provSel) {
          provSel.value = 'ollama';
          provSel.dispatchEvent(new Event('change'));
        }
        if (hostInp && btn.dataset.host) hostInp.value = btn.dataset.host;
        if (modelInp && btn.dataset.model) modelInp.value = btn.dataset.model;
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
