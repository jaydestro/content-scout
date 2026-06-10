import { $, api, escapeAttr } from '../lib/core.js';
import { wireListFilter, renderDocListItem, renderDocBody } from '../lib/doc-list.js';
import { setReportsPayload } from './report-state.js';

const TOOLS_TABS = ['seo', 'ask'];
const TOOLS_KIND = { seo: ['seo'] };
let toolsActiveTab = 'seo';
let toolsEventsWired = false;
let askRunnerWired = false;

function setToolsActiveTab(tab) {
  if (!TOOLS_TABS.includes(tab)) tab = 'seo';
  toolsActiveTab = tab;
  document.querySelectorAll('#tools-tabs button').forEach((button) => {
    const on = button.dataset.tooltab === tab;
    button.classList.toggle('active', on);
    button.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const isAsk = tab === 'ask';
  document.querySelectorAll('#view-tools .tab-panel').forEach((panel) => {
    let show = false;
    if (panel.dataset.toolpanel === 'browse') show = !isAsk;
    else show = panel.dataset.toolpanel === tab;
    panel.hidden = !show;
  });
  renderToolsActionBar(tab);
  if (!isAsk) applyToolsTabFilter();
}

function applyToolsTabFilter() {
  const kinds = TOOLS_KIND[toolsActiveTab];
  if (!kinds) return;
  const lis = document.querySelectorAll('#tools-list li[data-name]');
  let firstVisible = null;
  let visibleCount = 0;
  lis.forEach((li) => {
    const kind = li.dataset.kind || '';
    const match = kinds.includes(kind);
    li.hidden = !match;
    if (match) {
      visibleCount += 1;
      if (!firstVisible) firstVisible = li;
    }
  });
  const selected = document.querySelector('#tools-list li.selected');
  if ((!selected || selected.hidden) && firstVisible) firstVisible.click();
  if (visibleCount === 0) {
    const body = $('tools-body');
    if (body) {
      body.innerHTML = `<p class="hint">No <strong>${escapeAttr(toolsActiveTab)}</strong> results yet. Use the action bar above to run one, or run <code>/scout-${toolsActiveTab}</code> in an agent chat.</p>`;
      delete body.dataset.name;
    }
  }
}

function renderToolsActionBar(tab) {
  const bar = $('tools-action-bar');
  if (!bar) return;
  if (tab === 'seo') {
    bar.innerHTML = `
      <label class="field-inline" style="flex:1;min-width:240px">URLs (one per line, max 5)
        <textarea id="seo-urls" rows="3" placeholder="https://example.com/page-1&#10;https://example.com/page-2"></textarea>
      </label>
      <label class="field-inline" style="align-self:flex-end;white-space:nowrap" title="Generate title, meta, H1s, opening paragraph & JSON-LD inline using your configured LLM (set SEO_REWRITE_PROVIDER in .env; defaults to your agent runner). Uncheck for a fast deterministic-only audit.">
        <input type="checkbox" id="seo-rewrites" checked> AI rewrites
      </label>
      <button type="button" id="btn-seo-compute">+ Audit now</button>
      <span class="hint" id="analytics-status"></span>
    `;
    $('btn-seo-compute')?.addEventListener('click', () => computeAnalytics('seo'));
  } else {
    bar.innerHTML = '';
  }
}

async function computeAnalytics(kind) {
  const slug = (window.activeRoleSlug && window.activeRoleSlug()) || '';
  const status = $('analytics-status');
  if (status) status.textContent = 'Computing…';
  try {
    let response;
    if (kind === 'seo') {
      const raw = $('seo-urls')?.value || '';
      const urls = raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (urls.length === 0) {
        if (status) status.textContent = 'enter at least one URL';
        return;
      }
      const rewrites = $('seo-rewrites') ? $('seo-rewrites').checked : true;
      if (status) status.textContent = rewrites ? 'Auditing + AI rewrites...' : 'Auditing...';
      response = await fetch('/api/analytics/seo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls, slug, rewrites }),
      });
    } else return;
    const data = await response.json();
    if (!response.ok || !data.ok) {
      if (status) status.textContent = `error: ${data.error || response.status}`;
      return;
    }
    if (status) {
      const count = data.rewriteCount || 0;
      const extra = count ? ` | ${count} AI rewrite${count === 1 ? '' : 's'}` : '';
      status.textContent = `Wrote ${data.fileName}${extra}`;
    }
    await loadTools();
    const li = document.querySelector(`#tools-list li[data-name="${data.fileName}"]`);
    if (li) li.click();
  } catch (err) {
    if (status) status.textContent = `error: ${err.message || err}`;
  }
}

export async function loadTools() {
  const payload = await api('/api/reports');
  setReportsPayload(payload);
  const { reports } = payload;
  $('tools-list').innerHTML = reports.map(renderDocListItem).join('')
    || '<li class="hint">No tool outputs yet.</li>';
  $('tools-list').querySelectorAll('li[data-name]').forEach((li, index) => {
    const meta = reports[index]?.meta || {};
    li.dataset.kind = meta.kind || 'doc';
    li.addEventListener('click', async (event) => {
      if (event.target.closest('.entry-open')) return;
      document.querySelectorAll('#tools-list li').forEach((item) => item.classList.remove('selected'));
      li.classList.add('selected');
      const report = await api(`/api/reports/${encodeURIComponent(li.dataset.name)}`);
      renderDocBody($('tools-body'), { name: li.dataset.name, html: report.html, kind: 'reports' });
      $('tools-body').dataset.name = li.dataset.name;
    });
  });
  wireListFilter({ inputId: 'tools-filter', listId: 'tools-list', kind: 'reports' });
  setToolsActiveTab(toolsActiveTab);
}

export function fillAskChip(kind) {
  const textarea = $('ask-prompt');
  if (!textarea) return;
  const slug = (window.activeRoleSlug && window.activeRoleSlug()) || '<product>';
  const prompts = {
    seo: 'Run an SEO audit on this URL: <paste URL>. Score title, description, headings, internal links, structured data, media alt text, technical signals, and LLM-readiness; suggest concrete rewrites.',
    cfp: `Find open Calls for Papers for ${slug} over the next 90 days. Prefer Sessionize / Pretalx / typeform-based CFPs over awards or "register interest" pages. Include deadline, audience fit, and submission URL.`,
    conf: `List upcoming developer-focused conferences in the next 6 months where ${slug} would land well — bias toward Linux Foundation events, KubeCon, language/runtime confs, and AI app-developer venues.`,
    summary: `Summarize the last 30 days of ${slug} mentions across reports. Group by topic tag, call out sentiment shifts, and flag any single-source spikes that need verification.`,
    recommend: `Based on the last 30 days of ${slug} activity across reports, recommend three blog or video topics we should publish in the next two weeks. For each, cite the signal that motivates it.`,
  };
  textarea.value = prompts[kind] || '';
  textarea.focus();
}

function wireAskRunner() {
  if (askRunnerWired) return;
  askRunnerWired = true;
  const sendBtn = document.getElementById('ask-send');
  const stopBtn = document.getElementById('ask-stop');
  const outEl = document.getElementById('ask-output');
  const metaEl = document.getElementById('ask-meta');
  let askSrc = null;
  sendBtn?.addEventListener('click', async () => {
    const prompt = document.getElementById('ask-prompt')?.value.trim();
    if (!prompt) { if (metaEl) metaEl.textContent = 'Enter a prompt first.'; return; }
    const slug = (window.activeRoleSlug && window.activeRoleSlug()) || '';
    if (outEl) outEl.textContent = '';
    if (metaEl) metaEl.textContent = 'Starting…';
    sendBtn.disabled = true;
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'custom', args: { slug, prompt } }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (metaEl) metaEl.textContent = data.error || 'error';
        if (outEl && data.prompt) outEl.textContent = `Prompt:\n\n${data.prompt}\n\nSet SCOUT_RUNNER to execute, or paste this into your agent chat.`;
        sendBtn.disabled = false;
        return;
      }
      if (metaEl) metaEl.textContent = `Running: ${data.command || 'ask'}`;
      if (stopBtn) stopBtn.hidden = false;
      askSrc = new EventSource(`/api/runs/${data.id}/stream`);
      askSrc.onmessage = (event) => {
        try {
          const { chunk } = JSON.parse(event.data);
          if (outEl) { outEl.textContent += chunk; outEl.scrollTop = outEl.scrollHeight; }
        } catch {}
      };
      askSrc.addEventListener('done', (event) => {
        try {
          const { status } = JSON.parse(event.data);
          if (metaEl) metaEl.textContent = `Done: ${status}`;
        } catch {}
        if (stopBtn) stopBtn.hidden = true;
        sendBtn.disabled = false;
        askSrc?.close();
        askSrc = null;
      });
      askSrc.onerror = () => { askSrc?.close(); askSrc = null; sendBtn.disabled = false; };
    } catch (err) {
      if (metaEl) metaEl.textContent = `error: ${err.message || err}`;
      sendBtn.disabled = false;
    }
  });
  stopBtn?.addEventListener('click', () => {
    askSrc?.close();
    askSrc = null;
    stopBtn.hidden = true;
    sendBtn.disabled = false;
    if (metaEl) metaEl.textContent = 'Stopped.';
  });
}

export function initToolsView() {
  if (toolsEventsWired) return;
  toolsEventsWired = true;
  document.addEventListener('click', (event) => {
    const tabBtn = event.target.closest('#tools-tabs button[data-tooltab]');
    if (tabBtn) {
      event.preventDefault();
      setToolsActiveTab(tabBtn.dataset.tooltab);
    }
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireAskRunner, { once: true });
  } else {
    wireAskRunner();
  }
}
