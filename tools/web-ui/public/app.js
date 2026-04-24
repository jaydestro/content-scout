// Content Scout web UI — vanilla JS SPA
const $ = (id) => document.getElementById(id);
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
};

// --- Navigation ----------------------------------------------------
document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $(`view-${btn.dataset.view}`).classList.add('active');
    if (btn.dataset.view === 'configs') loadConfigList();
    if (btn.dataset.view === 'reports') loadReports();
    if (btn.dataset.view === 'social') loadSocial();
    if (btn.dataset.view === 'run') loadSlugOptions();
    if (btn.dataset.view === 'dashboard') loadDashboard();
  });
});

// --- Status pill ---------------------------------------------------
async function loadStatus() {
  const s = await api('/api/status');
  const runner = s.runnerConfigured ? 'runner ready' : 'no runner';
  $('status-pill').textContent = runner;
  $('status-pill').title = s.runner || 'SCOUT_RUNNER not set — run buttons will show copyable prompt only.';
  return s;
}

// --- Dashboard -----------------------------------------------------
async function loadDashboard() {
  const [status, configs, reports, runs] = await Promise.all([
    api('/api/status'),
    api('/api/configs'),
    api('/api/reports'),
    api('/api/runs'),
  ]);

  $('dash-configs').innerHTML = configs.configs.length
    ? configs.configs.map((c) => `<li><code>${c.slug}</code></li>`).join('')
    : '<li class="hint">No configs yet — run <code>/scout-onboard</code>.</li>';

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
  sel.innerHTML = '<option value="">— none —</option>' +
    configs.map((c) => `<option value="${c.slug}">${c.slug}</option>`).join('');
}
$('run-command').addEventListener('change', (e) => {
  const custom = e.target.value === 'custom';
  $('run-prompt-wrap').hidden = !custom;
  $('run-extra-wrap').hidden = custom;
});
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
  return [`/${cmd}`, slug, extra].filter(Boolean).join(' ');
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
loadStatus().then(loadDashboard).catch((err) => {
  $('status-pill').textContent = 'error';
  console.error(err);
});
