import { $, api, escape, escapeAttr } from '../lib/core.js';
import { wireListFilter, renderDocListItem, renderDocBody } from '../lib/doc-list.js';
import { setReportsPayload } from './report-state.js';

const REPORTS_TABS = ['content', 'mindshare', 'cfp', 'roundup', 'competitors'];
const TAB_SECTION_MATCH = {
  mindshare: /^mindshare\b/i,
  cfp: /^(open calls for papers|cfps?\b|calls? for papers\b|conferences?\b)/i,
  competitors: /^(competitor|competitive)\b/i,
};
const REPORT_SECTIONS = [
  { key: 'all', label: 'All', match: null },
  { key: 'mindshare', label: 'Mindshare', match: /^mindshare\b/i },
  { key: 'cfps', label: 'CFPs', match: /^(open calls for papers|cfps?\b|calls? for papers\b)/i },
  { key: 'conferences', label: 'Conferences', match: /^conferences?\b/i },
];
let reportsActiveTab = 'content';

function rowMatchesTab(li, tab) {
  const kind = li.dataset.kind || '';
  switch (tab) {
    case 'content':
      return kind === 'content';
    case 'mindshare':
      return kind === 'mindshare'
        || (kind === 'content' && li.dataset.hasMindshare === '1');
    case 'cfp':
      return kind === 'cfp' || kind === 'conference'
        || (kind === 'content' && li.dataset.hasCfp === '1');
    case 'roundup':
      return kind === 'roundup';
    case 'competitors':
      return kind === 'competitors'
        || (kind === 'content' && li.dataset.hasCompetitors === '1');
    default:
      return false;
  }
}

function setReportsRowTabBadge(li, tab, match) {
  const badge = li.querySelector('.entry-kind');
  if (!badge) return;
  if (!li.dataset.baseKindLabel) li.dataset.baseKindLabel = badge.textContent.trim();
  if (!match) {
    badge.textContent = li.dataset.baseKindLabel;
    return;
  }

  let label = li.dataset.baseKindLabel;
  let kindClass = `kind-${li.dataset.kind || 'doc'}`;
  if (tab === 'content' && li.dataset.kind === 'content') {
    label = 'Full Report';
    kindClass = 'kind-content';
  } else if (tab === 'mindshare' && (li.dataset.kind === 'content' || li.dataset.kind === 'mindshare')) {
    label = 'Mindshare';
    kindClass = 'kind-mindshare';
  } else if (tab === 'cfp' && ['content', 'cfp', 'conference'].includes(li.dataset.kind || '')) {
    label = 'CFPs & Events';
    kindClass = 'kind-cfp';
  } else if (tab === 'roundup' && li.dataset.kind === 'roundup') {
    label = 'Roundup';
    kindClass = 'kind-roundup';
  } else if (tab === 'competitors' && ['content', 'competitors'].includes(li.dataset.kind || '')) {
    label = 'Competitors';
    kindClass = 'kind-competitors';
  }
  badge.textContent = label;
  for (const cls of [...badge.classList]) {
    if (cls.startsWith('kind-')) badge.classList.remove(cls);
  }
  badge.classList.add(kindClass);
}

function extractSectionsHtml(fullHtml, regex) {
  if (!fullHtml || !regex) return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = fullHtml;
  const nodes = Array.from(tpl.content.childNodes);
  const out = [];
  let capturing = false;
  for (const node of nodes) {
    const isH2 = node.nodeType === 1 && node.tagName === 'H2';
    if (isH2) {
      capturing = regex.test((node.textContent || '').trim());
    }
    if (capturing) out.push(node);
  }
  if (!out.length) return '';
  const wrap = document.createElement('div');
  out.forEach((node) => wrap.appendChild(node.cloneNode(true)));
  return wrap.innerHTML;
}

export function setReportsActiveTab(tab) {
  if (!REPORTS_TABS.includes(tab)) tab = 'content';
  reportsActiveTab = tab;
  document.querySelectorAll('#reports-tabs button').forEach((button) => {
    const on = button.dataset.tab === tab;
    button.classList.toggle('active', on);
    button.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  renderReportsActionBar(tab);
  applyReportsTabFilter();
}

function findReportHeading(body, section) {
  if (!body || !section || !section.match) return null;
  for (const heading of body.querySelectorAll('h2, h3')) {
    if (section.match.test(heading.textContent.trim())) return heading;
  }
  return null;
}

export function buildReportSectionNav(kind) {
  const nav = $('reports-section-nav');
  const body = $('reports-body');
  if (!nav) return;
  if (kind !== 'content' || !body) {
    nav.hidden = true;
    nav.innerHTML = '';
    return;
  }
  const present = REPORT_SECTIONS.filter(
    (section) => section.key === 'all' || findReportHeading(body, section)
  );
  if (present.length <= 1) {
    nav.hidden = true;
    nav.innerHTML = '';
    return;
  }
  nav.innerHTML = present
    .map(
      (section, index) =>
        `<button type="button" data-section="${escapeAttr(section.key)}" class="${index === 0 ? 'active' : ''}">${escape(section.label)}</button>`
    )
    .join('');
  nav.hidden = false;
}

export function scrollReportToSection(key) {
  const body = $('reports-body');
  if (!body) return;
  const section = REPORT_SECTIONS.find((item) => item.key === key);
  if (!section || !section.match) {
    body.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    const heading = findReportHeading(body, section);
    if (heading) heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  document.querySelectorAll('#reports-section-nav button').forEach((button) =>
    button.classList.toggle('active', button.dataset.section === key)
  );
}

async function openReportRow(li) {
  if (!li) return;
  document.querySelectorAll('#reports-list li').forEach((item) => item.classList.remove('selected'));
  li.classList.add('selected');
  const name = li.dataset.name;
  const kind = li.dataset.kind || '';
  const body = $('reports-body');
  const sectionRe = TAB_SECTION_MATCH[reportsActiveTab];
  const report = await api(`/api/reports/${encodeURIComponent(name)}`);
  if (sectionRe && kind === 'content') {
    const sliced = extractSectionsHtml(report.html, sectionRe);
    if (sliced) {
      const label = reportsActiveTab === 'cfp' ? 'CFPs & Events'
        : reportsActiveTab === 'competitors' ? 'Competitor & Market Signals'
        : 'Mindshare';
      renderDocBody(body, {
        name,
        html: `<p class="hint">${escape(label)} section of <code>${escape(name)}</code> — open the <strong>Full Report</strong> tab for the full report.</p>${sliced}`,
        kind: 'reports',
      });
    } else {
      body.innerHTML = `<p class="hint">This scan report has no ${reportsActiveTab === 'cfp' ? 'CFP/Conferences' : reportsActiveTab === 'competitors' ? 'Competitor' : 'Mindshare'} section. Open the <strong>Full Report</strong> tab for the full report.</p>`;
    }
  } else {
    renderDocBody(body, { name, html: report.html, kind: 'reports' });
  }
  body.dataset.name = name;
  const nav = $('reports-section-nav');
  if (nav) { nav.hidden = true; nav.innerHTML = ''; }
}

function reportsSplitEl() {
  return document.querySelector('#view-reports .tab-panel[data-panel="browse"] .split');
}

let reportsControlsWired = false;
// Wire the rail show/hide toggle exactly once.
function wireReportsControls() {
  if (reportsControlsWired) return;
  reportsControlsWired = true;
  const toggle = $('reports-list-toggle');
  if (toggle) {
    const collapsed = localStorage.getItem('scout-reports-list-collapsed') === '1';
    const split = reportsSplitEl();
    if (split) split.classList.toggle('list-collapsed', collapsed);
    toggle.textContent = collapsed ? 'Show list' : 'Hide list';
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.addEventListener('click', () => {
      const s = reportsSplitEl();
      if (!s) return;
      const now = !s.classList.contains('list-collapsed');
      s.classList.toggle('list-collapsed', now);
      localStorage.setItem('scout-reports-list-collapsed', now ? '1' : '0');
      toggle.textContent = now ? 'Show list' : 'Hide list';
      toggle.setAttribute('aria-expanded', now ? 'false' : 'true');
    });
  }
}

function applyReportsTabFilter() {
  const lis = document.querySelectorAll('#reports-list li[data-name]');
  let firstVisible = null;
  let visibleCount = 0;
  lis.forEach((li) => {
    const match = rowMatchesTab(li, reportsActiveTab);
    setReportsRowTabBadge(li, reportsActiveTab, match);
    li.hidden = !match;
    if (match) {
      visibleCount += 1;
      if (!firstVisible) firstVisible = li;
    }
  });
  const selected = document.querySelector('#reports-list li.selected');
  const target = selected && !selected.hidden ? selected : firstVisible;
  if (visibleCount > 0 && target) {
    openReportRow(target);
  } else if (visibleCount === 0) {
    const body = $('reports-body');
    if (body) {
      body.innerHTML = `<p class="hint">No <strong>${escapeAttr(reportsActiveTab)}</strong> content yet. Run <code>/scout-scan</code> to populate it.</p>`;
      delete body.dataset.name;
    }
  }
}

function renderReportsActionBar(tab) {
  const bar = $('reports-action-bar');
  if (!bar) return;
  if (tab === 'content') {
    bar.innerHTML = `<span class="hint">The complete scan report. Its Mindshare and CFPs &amp; Events sections also get a focused view under their own tabs. New scans land here after <code>/scout-scan</code> completes.</span>`;
  } else if (tab === 'mindshare') {
    bar.innerHTML = `<span class="hint">Mindshare only — the Mindshare section of each scan report, plus any standalone monthly mindshare docs.</span>`;
  } else if (tab === 'cfp') {
    bar.innerHTML = `<span class="hint">CFPs &amp; Events only — the Calls for Papers and Conferences sections of each scan report.</span>`;
  } else if (tab === 'roundup') {
    renderRoundupActionBar(bar);
  } else if (tab === 'competitors') {
    bar.innerHTML = `<span class="hint">Competitor signals only — the Competitor &amp; Market Signals section of each scan report, plus any standalone competitor reports. Tracks the products listed under <code>## Competitors</code> in your config.</span>`;
  } else {
    bar.innerHTML = '';
  }
}

// Resolve the active product slug. Prefer the Scan view's picker, fall back to
// the first configured product so the Roundup tab works without visiting Scan.
let cachedRoundupSlug = '';
async function resolveRoundupSlug() {
  const picked = (window.activeRoleSlug && window.activeRoleSlug()) || '';
  if (picked) { cachedRoundupSlug = picked; return picked; }
  if (cachedRoundupSlug) return cachedRoundupSlug;
  try {
    const { configs } = await api('/api/configs');
    if (Array.isArray(configs) && configs.length) cachedRoundupSlug = configs[0].slug || '';
  } catch {}
  return cachedRoundupSlug;
}

// Build the Roundup tab's action bar: a month picker + Generate button. The
// roundup files themselves appear in the shared report list (filtered to the
// roundup kind), just like Mindshare docs — so there is no separate list here.
async function renderRoundupActionBar(bar) {
  bar.innerHTML = `
    <div class="roundup-controls">
      <span class="hint">One regenerable index per month — videos, blogs, articles, and code samples from that month's scans. Generating overwrites the month's file in place.</span>
      <label class="field roundup-month-field">
        <span>Month</span>
        <select id="roundup-month" aria-label="Roundup month"></select>
      </label>
      <button type="button" id="btn-roundup-generate">Generate monthly roundup</button>
      <span class="hint" id="roundup-status"></span>
    </div>`;
  const slug = await resolveRoundupSlug();
  const select = $('roundup-month');
  if (!slug) {
    if ($('roundup-status')) $('roundup-status').textContent = 'No product configured yet — create one on the Configs view.';
    return;
  }
  try {
    const payload = await api(`/api/roundups?slug=${encodeURIComponent(slug)}`);
    const months = payload.months || [];
    if (!months.some((m) => m.month === payload.currentMonth)) {
      months.unshift({ month: payload.currentMonth, label: payload.currentMonthLabel });
    }
    if (select) {
      select.innerHTML = months
        .map((m) => `<option value="${escapeAttr(m.month)}">${escape(m.label)}</option>`)
        .join('');
      select.value = payload.currentMonth;
    }
  } catch (err) {
    if ($('roundup-status')) $('roundup-status').textContent = `error: ${err.message || err}`;
  }
  $('btn-roundup-generate')?.addEventListener('click', generateRoundup);
}

async function generateRoundup() {
  const slug = await resolveRoundupSlug();
  const status = $('roundup-status');
  if (!slug) {
    if (status) status.textContent = 'No product configured yet — create one on the Configs view.';
    return;
  }
  const month = ($('roundup-month') && $('roundup-month').value) || '';
  const btn = $('btn-roundup-generate');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Generating…';
  try {
    const res = await fetch('/api/roundup/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, month }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      if (status) status.textContent = `error: ${data.error || res.status}`;
      return;
    }
    const c = data.counts || {};
    if (status) {
      status.textContent =
        `Wrote ${data.fileName} — ${c.total || 0} items ` +
        `(${c.official || 0} official · ${c.videos || 0} videos · ` +
        `${c.articles || 0} blogs · ${c.repos || 0} samples) from ${c.sourceReports || 0} reports`;
    }
    // Refresh the report list so the new/updated roundup row appears, then
    // open it.
    await loadReports();
    setReportsActiveTab('roundup');
    const li = document.querySelector(`#reports-list li[data-name="${CSS.escape(data.fileName)}"]`);
    if (li) openReportRow(li);
  } catch (err) {
    if (status) status.textContent = `error: ${err.message || err}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function loadReports() {
  const payload = await api('/api/reports');
  setReportsPayload(payload);
  const { reports } = payload;
  $('reports-list').innerHTML = reports.map(renderDocListItem).join('')
    || '<li class="hint">No reports yet.</li>';
  $('reports-list').querySelectorAll('li[data-name]').forEach((li, index) => {
    const meta = reports[index]?.meta || {};
    li.dataset.kind = meta.kind || 'doc';
    const sections = meta.sections || {};
    li.dataset.hasMindshare = sections.mindshare ? '1' : '';
    li.dataset.hasCfp = sections.cfp ? '1' : '';
    li.dataset.hasCompetitors = sections.competitors ? '1' : '';
    li.addEventListener('click', (event) => {
      if (event.target.closest('.entry-open')) return;
      openReportRow(li);
    });
  });
  wireListFilter({
    inputId: 'reports-filter',
    listId: 'reports-list',
    kind: 'reports',
    includeItem: (li) => rowMatchesTab(li, reportsActiveTab),
  });
  setReportsActiveTab(reportsActiveTab);
  wireReportsControls();
}
