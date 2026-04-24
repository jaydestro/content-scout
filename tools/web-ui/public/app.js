// Content Scout web UI — vanilla JS SPA
const $ = (id) => document.getElementById(id);
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
};

// --- Navigation ----------------------------------------------------
function gotoView(view) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'setup') loadSetup();
  if (view === 'configs') loadConfigList();
  if (view === 'reports') loadReports();
  if (view === 'social') loadSocial();
  if (view === 'run') loadSlugOptions();
  if (view === 'dashboard') loadDashboard();
}
document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => gotoView(btn.dataset.view));
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
    });
  });
  $('agent-custom-wrap').hidden = agentChoice !== 'custom';
  if (settings.agent === 'custom') $('agent-custom-runner').value = settings.runner || '';
  $('agent-save').disabled = locked;

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
    const rows = entries.length
      ? entries
      : [
          { key: 'YOUTUBE_API_KEY', value: '', preset: true },
          { key: 'REDDIT_CLIENT_ID', value: '', preset: true },
          { key: 'REDDIT_CLIENT_SECRET', value: '', preset: true },
          { key: 'BLUESKY_HANDLE', value: '', preset: true },
          { key: 'BLUESKY_APP_PASSWORD', value: '', preset: true },
          { key: 'X_BEARER_TOKEN', value: '', preset: true },
        ];
    $('setup-env').innerHTML = `
      <div class="env-grid">
        ${rows.map((e, i) => envRow(e.key, e.value, i, e.preset !== false)).join('')}
      </div>
      ${exists ? '' : '<div class="hint" style="margin-top:0.5rem">No <code>.env</code> file yet — saving will create one.</div>'}
    `;
    wireEnvRows();
  } catch (err) {
    $('setup-env').innerHTML = `<div class="warn-text">Failed to load env: ${escape(err.message)}</div>`;
  }
}

function envRow(key, value, i, keyReadonly) {
  return `
    <div class="env-row" data-row="${i}">
      <input class="env-key" type="text" value="${escape(key)}" ${keyReadonly ? 'readonly' : ''} placeholder="KEY_NAME" />
      <input class="env-value" type="password" value="${escape(value)}" placeholder="(empty — skip this source)" autocomplete="off" />
      <button type="button" class="secondary env-toggle" title="Show/hide">👁</button>
      <button type="button" class="secondary env-remove" title="Remove" ${keyReadonly ? 'hidden' : ''}>✕</button>
    </div>
  `;
}

function wireEnvRows() {
  document.querySelectorAll('.env-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = btn.parentElement.querySelector('.env-value');
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });
  document.querySelectorAll('.env-remove').forEach((btn) => {
    btn.addEventListener('click', () => btn.parentElement.remove());
  });
}

function collectEnvEntries() {
  return [...document.querySelectorAll('#setup-env .env-row')]
    .map((row) => ({
      key: row.querySelector('.env-key').value.trim(),
      value: row.querySelector('.env-value').value,
    }))
    .filter((e) => e.key.length > 0);
}

$('agent-save').addEventListener('click', async () => {
  if (!agentChoice) {
    $('agent-status').textContent = 'pick an agent first';
    return;
  }
  const body = { agent: agentChoice };
  if (agentChoice === 'custom') body.runner = $('agent-custom-runner').value.trim();
  $('agent-save').disabled = true;
  $('agent-status').textContent = 'saving…';
  try {
    await api('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    $('agent-status').textContent = 'saved';
    await loadStatus();
    await loadSetup();
  } catch (err) {
    $('agent-status').textContent = `error: ${err.message}`;
  } finally {
    $('agent-save').disabled = false;
  }
});

$('setup-run-onboard').addEventListener('click', async () => {
  // Jump to Run view with scout-onboard preselected.
  gotoView('run');
  $('run-command').value = 'scout-onboard';
  $('run-command').dispatchEvent(new Event('change'));
});

// --- New config form ------------------------------------------------
function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}
let cfgSlugEdited = false;
$('cfg-slug').addEventListener('input', () => { cfgSlugEdited = true; });
$('cfg-name').addEventListener('input', () => {
  if (!cfgSlugEdited) $('cfg-slug').value = slugify($('cfg-name').value);
});

// Tier picker — toggles a data-tier attribute on <body> so CSS can show/hide sections.
function setTier(tier) {
  document.body.dataset.tier = tier;
}
document.querySelectorAll('input[name="cfg-tier"]').forEach((el) => {
  el.addEventListener('change', () => { if (el.checked) setTier(el.value); });
});
setTier(document.querySelector('input[name="cfg-tier"]:checked')?.value || 'standard');

// Role presets — fetch and render as checkable cards.
async function loadRolePresets() {
  try {
    const { presets } = await api('/api/role-presets');
    const container = $('cfg-roles');
    container.innerHTML = presets.map((p) => `
      <label class="role-card">
        <span><input type="checkbox" class="cfg-role" value="${p.id}" /> <span class="role-name">${p.label}</span></span>
        <span class="role-desc">${p.focus}</span>
      </label>
    `).join('');
  } catch (err) {
    console.error('failed to load roles', err);
  }
}
loadRolePresets();

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

$('cfg-create').addEventListener('click', async () => {
  const name = $('cfg-name').value.trim();
  if (!name) {
    $('cfg-status').textContent = 'Product name is required.';
    return;
  }
  const tier = document.body.dataset.tier || 'standard';
  const roleIds = Array.from(document.querySelectorAll('.cfg-role:checked')).map((el) => el.value);
  const customRoleLabel = $('cfg-custom-role').value.trim();

  const body = {
    name,
    slug: $('cfg-slug').value.trim() || slugify(name),
    type: $('cfg-type').value,
    roleIds,
    customRoleLabel,
    searchTerms: splitList($('cfg-terms').value),
    hashtags: splitList($('cfg-hashtags').value),
    topicTags: splitList($('cfg-topic-tags').value),
  };

  // Tier-gated fields.
  if (tier === 'standard' || tier === 'full') {
    body.networks = Array.from(document.querySelectorAll('.cfg-network:checked')).map((el) => el.value);
    body.socialPosts = $('cfg-social').checked;
    body.postingCalendar = $('cfg-calendar').checked;
  }
  if (tier === 'full') {
    body.exclusions = {
      blog: $('cfg-excl-blog').value.trim(),
      youtube: $('cfg-excl-youtube').value.trim(),
      handles: splitList($('cfg-excl-handles').value),
    };
    // Feature-toggle overrides — only include flags the user explicitly checked.
    const flags = {};
    document.querySelectorAll('.cfg-flag:checked').forEach((el) => { flags[el.dataset.flag] = true; });
    body.flags = flags;
    body.brand = {
      logoDir: $('cfg-brand-logodir').value.trim(),
      thumbnailStyle: $('cfg-brand-thumb').value,
      theme: $('cfg-brand-theme').value,
    };
    body.competitors = splitList($('cfg-competitors').value);
    body.conferences = splitList($('cfg-conferences').value);
    body.watchlist = parseWatchlist($('cfg-watchlist').value);
    body.customSources = parseCustomSources($('cfg-custom-sources').value);
  }

  $('cfg-create').disabled = true;
  $('cfg-status').textContent = 'creating…';
  try {
    const res = await fetch('/api/configs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      $('cfg-status').textContent = `error: ${data.error || res.statusText}`;
      return;
    }
    $('cfg-status').innerHTML = `<span class="ok">Created ${data.file}. Opening in Configs…</span>`;
    await loadStatus();
    setTimeout(() => {
      gotoView('configs');
      loadConfigList().then(() => loadConfig(data.slug));
    }, 400);
  } catch (err) {
    $('cfg-status').textContent = `error: ${err.message}`;
  } finally {
    $('cfg-create').disabled = false;
  }
});

$('env-add').addEventListener('click', () => {
  const grid = document.querySelector('#setup-env .env-grid') || $('setup-env');
  if (!grid.classList.contains('env-grid')) {
    $('setup-env').innerHTML = '<div class="env-grid"></div>';
  }
  const container = document.querySelector('#setup-env .env-grid');
  const idx = container.children.length;
  container.insertAdjacentHTML('beforeend', envRow('', '', idx, false));
  wireEnvRows();
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
  const [status, configs, reports, runs] = await Promise.all([
    api('/api/status'),
    api('/api/configs'),
    api('/api/reports'),
    api('/api/runs'),
  ]);
  cachedStatus = status;

  $('dash-empty').hidden = status.hasConfigs && status.runnerConfigured;
  if (!status.runnerConfigured && !status.hasConfigs) {
    $('dash-empty').querySelector('p').innerHTML =
      'No agent configured and no configs yet. Open <a href="#" data-goto="setup">Setup</a> to get started.';
  } else if (!status.runnerConfigured) {
    $('dash-empty').querySelector('p').innerHTML =
      'No agent configured. Open <a href="#" data-goto="setup">Setup</a> to pick one so you can run commands.';
  } else if (!status.hasConfigs) {
    $('dash-empty').querySelector('p').innerHTML =
      'No configs yet. Open <a href="#" data-goto="setup">Setup</a> to run <code>/scout-onboard</code> and create one.';
  }

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
}
$('config-editor').addEventListener('input', () => {
  configDirty = true;
  $('config-save').disabled = false;
  $('config-status').textContent = 'unsaved changes';
});
$('config-save').addEventListener('click', async () => {
  if (!selectedConfig) return;
  $('config-save').disabled = true;
  $('config-status').textContent = 'saving…';
  try {
    await api(`/api/configs/${selectedConfig}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: $('config-editor').value }),
    });
    configDirty = false;
    $('config-status').textContent = 'saved';
  } catch (err) {
    $('config-status').textContent = `error: ${err.message}`;
    $('config-save').disabled = false;
  }
});

// --- Run -----------------------------------------------------------
async function loadSlugOptions() {
  const { configs } = await api('/api/configs');
  const sel = $('run-slug');
  sel.innerHTML = '<option value="">— all —</option>' +
    configs.map((c) => `<option value="${c.slug}">${c.slug}</option>`).join('');

  // Render subject cards (radio buttons). Keep the hidden <select> in sync.
  const list = $('run-subject-list');
  if (list) {
    const currentVal = sel.value;
    const cardsHtml =
      `<label class="subject-card">
         <input type="radio" name="run-slug-choice" value="" ${!currentVal ? 'checked' : ''} />
         <span class="subject-name">All subjects</span>
         <span class="subject-desc">Run against every config${configs.length ? ` (${configs.length})` : ''}</span>
       </label>` +
      configs.map((c) => `
        <label class="subject-card">
          <input type="radio" name="run-slug-choice" value="${c.slug}" ${currentVal === c.slug ? 'checked' : ''} />
          <span class="subject-name">${c.name || c.slug}</span>
          <span class="subject-desc">${c.type || 'subject'} · <code>${c.slug}</code></span>
        </label>`).join('');
    list.innerHTML = cardsHtml;
    list.querySelectorAll('input[name="run-slug-choice"]').forEach((el) => {
      el.addEventListener('change', () => {
        if (el.checked) {
          sel.value = el.value;
          updateRunPreview();
        }
      });
    });
    // Hint text — nudge user if they have no configs yet.
    const hint = $('run-subject-hint');
    if (hint) {
      hint.innerHTML = configs.length
        ? 'Pick one to scan a single subject, or choose <strong>All subjects</strong>.'
        : 'No configs yet — run <code>/scout-onboard</code> first to create one.';
    }
  }
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
  updateRunPreview();
});
$('run-extra').addEventListener('input', updateRunPreview);
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
  // If user picked "All subjects" and there's more than one config, pass "all"
  // explicitly so the agent doesn't interactively prompt.
  const configCount = $('run-subject-list')
    ? $('run-subject-list').querySelectorAll('input[name="run-slug-choice"]').length - 1
    : 0;
  const target = slug || (configCount > 1 ? 'all' : '');
  return [`/${cmd}`, target, extra].filter(Boolean).join(' ');
}

async function startRun() {
  const cmd = $('run-command').value;
  const args =
    cmd === 'custom'
      ? { prompt: $('run-prompt').value.trim() }
      : { slug: $('run-slug').value, extra: $('run-extra').value.trim() };
  $('run-output').textContent = '';
  $('run-meta').textContent = 'Starting…';
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: cmd, args }),
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
    .map((r) => `<li data-name="${r.name}">${r.name}<span class="mtime">${r.mtime.slice(0, 10)}</span></li>`)
    .join('') || '<li class="hint">No reports yet.</li>';
  $('reports-list').querySelectorAll('li[data-name]').forEach((li) => {
    li.addEventListener('click', async () => {
      document.querySelectorAll('#reports-list li').forEach((x) => x.classList.remove('selected'));
      li.classList.add('selected');
      const r = await api(`/api/reports/${encodeURIComponent(li.dataset.name)}`);
      $('reports-body').innerHTML = r.html;
    });
  });
}
async function loadSocial() {
  const { social } = await api('/api/reports');
  $('social-list').innerHTML = social
    .map((r) => `<li data-name="${r.name}">${r.name}<span class="mtime">${r.mtime.slice(0, 10)}</span></li>`)
    .join('') || '<li class="hint">No social posts yet.</li>';
  $('social-list').querySelectorAll('li[data-name]').forEach((li) => {
    li.addEventListener('click', async () => {
      document.querySelectorAll('#social-list li').forEach((x) => x.classList.remove('selected'));
      li.classList.add('selected');
      const r = await api(`/api/social/${encodeURIComponent(li.dataset.name)}`);
      $('social-body').innerHTML = r.html;
    });
  });
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// --- Boot ----------------------------------------------------------
// Only land on the dashboard once the user has actually finished setup:
// both an agent runner AND at least one config must exist. Otherwise,
// send them straight to Setup.
loadStatus().then((s) => {
  const isSetUp = s.runnerConfigured && s.hasConfigs;
  gotoView(isSetUp ? 'dashboard' : 'setup');
}).catch((err) => {
  $('status-pill').textContent = 'error';
  console.error(err);
  gotoView('setup');
});
