import { $, api, escape, escapeAttr } from '../lib/core.js';
import { wireListFilter, renderDocListItem, renderDocBody } from '../lib/doc-list.js';
import { setReportsPayload } from './report-state.js';

const REPORTS_TABS = ['content', 'mindshare', 'cfp'];
const TAB_SECTION_MATCH = {
  mindshare: /^mindshare\b/i,
  cfp: /^(open calls for papers|cfps?\b|calls? for papers\b|conferences?\b)/i,
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
      const label = reportsActiveTab === 'cfp' ? 'CFPs & Events' : 'Mindshare';
      renderDocBody(body, {
        name,
        html: `<p class="hint">${escape(label)} section of <code>${escape(name)}</code> — open the <strong>Full Report</strong> tab for the full report.</p>${sliced}`,
        kind: 'reports',
      });
    } else {
      body.innerHTML = `<p class="hint">This scan report has no ${reportsActiveTab === 'cfp' ? 'CFP/Conferences' : 'Mindshare'} section. Open the <strong>Full Report</strong> tab for the full report.</p>`;
    }
  } else {
    renderDocBody(body, { name, html: report.html, kind: 'reports' });
  }
  body.dataset.name = name;
  const nav = $('reports-section-nav');
  if (nav) { nav.hidden = true; nav.innerHTML = ''; }
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
  } else {
    bar.innerHTML = '';
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
}
