import { $, api, escape } from '../lib/core.js';

export async function loadDashboard({ setCachedStatus } = {}) {
  let status, configs, reports, runs;
  try {
    [status, configs, reports, runs] = await Promise.all([
      api('/api/status'),
      api('/api/configs'),
      api('/api/reports'),
      api('/api/runs'),
    ]);
  } catch (err) {
    $('dash-empty').hidden = false;
    $('dash-body').hidden = true;
    $('dash-empty-msg').innerHTML =
      `Couldn't reach the server (<code>${escape(err.message)}</code>). Make sure the web UI process is running, then refresh.`;
    return;
  }
  setCachedStatus?.(status);

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
  if (!ready) return;

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
