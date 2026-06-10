// dashboard-enhancer.js
// Populates the new dashboard sections (Quick start actions, At-a-glance stats,
// Subjects/last-scan list, Stack card) without touching app.js.
//
// Strategy: load data from the existing /api/* endpoints + the new /api/stack,
// observe app.js's writes to legacy IDs (#dash-reports, #dash-runs) so the
// "Recent reports" / "Recent runs" cards stay in sync, and wire hero buttons
// to navigate the existing nav.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);

  function relativeDay(iso) {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (!t) return '—';
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  }

  // --- Hero actions: re-use existing nav + run command select ---
  function wireHero() {
    document.querySelectorAll('#dash-body [data-run-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cmd = btn.dataset.runCmd;
        const sel = $('run-command');
        if (sel) {
          sel.value = cmd;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    });
    document.addEventListener('click', (e) => {
      const reportBtn = e.target.closest?.('[data-open-report]');
      if (reportBtn) {
        e.preventDefault();
        openReportInReportsView(reportBtn.dataset.openReport, reportBtn.dataset.reportTab || 'content');
        return;
      }
      const tabBtn = e.target.closest?.('[data-open-report-tab]');
      if (tabBtn) {
        e.preventDefault();
        openReportInReportsView('', tabBtn.dataset.openReportTab || 'content');
      }
    });
  }

  // --- Stats + subjects + stack ---
  async function fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }

  async function loadAll() {
    let configs = { configs: [] }, reports = { reports: [] };
    let activity = null;
    try {
      [configs, reports, activity] = await Promise.all([
        fetchJSON('/api/configs'),
        fetchJSON('/api/reports'),
        fetchJSON('/api/activity'),
      ]);
    } catch { /* keep defaults */ }

    const social = (reports.social || []);
    const configList = configs.configs || [];
    const reportList = reports.reports || [];
    const subjectCount = configList.length;
    renderStats(activity, subjectCount);
    renderActivity(activity);
    renderSubjects({ configs: configList, reports: reportList });
    renderSuggestions({ configs: configList, reports: reportList, social });
    renderLatestReport(reportList);
    renderAnalyticsSummary(reportList);
    loadCfpEvents(configList);
    // Social activity / sentiment / creators / source health are owned by
    // intel.js. Do not add loaders for #dash-social-activity, #dash-sentiment,
    // #dash-creators, or #dash-source-health here — two writers on the same
    // node will race and can leave "Loading…" stuck.
  }

  function openReportInReportsView(name, tab) {
    const navBtn = document.querySelector('nav button[data-view="reports"]');
    if (navBtn) navBtn.click();
    setTimeout(() => {
      const tabBtn = document.querySelector(`#reports-tabs button[data-tab="${tab}"]`);
      if (tabBtn) tabBtn.click();
      if (name) {
        setTimeout(() => {
          const row = document.querySelector(`#reports-list li[data-name="${CSS.escape(name)}"]`);
          if (row) row.click();
        }, 120);
      }
    }, 120);
  }

  function sortedByMtime(items) {
    return [...(items || [])].sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
  }

  function renderLatestReport(reports) {
    const body = $('dash-latest-report');
    const meta = $('dash-latest-report-meta');
    if (!body) return;
    const latest = sortedByMtime(reports).find((r) => r.meta?.kind === 'content' || /-content\.md$/i.test(r.name));
    if (!latest) {
      body.innerHTML = '<p class="hint">No full reports yet. Run a scan to create the first one.</p>';
      if (meta) meta.textContent = '';
      return;
    }
    const m = latest.meta || {};
    if (meta) meta.textContent = m.dateRange || relativeDay(latest.mtime);
    body.innerHTML = `
      <p><strong>${esc(m.title || latest.name)}</strong></p>
      ${m.subjectLabel ? `<p class="hint">${esc(m.subjectLabel)}</p>` : ''}
      ${m.summary ? `<p>${esc(m.summary)}</p>` : ''}
      <div class="toolbar" style="margin-top:0.6rem">
        <button type="button" data-open-report="${esc(latest.name)}" data-report-tab="content">Open full report</button>
        <button type="button" data-goto="run" data-run-cmd="scout-scan">Run new scan</button>
      </div>
    `;
  }

  function renderAnalyticsSummary(reports) {
    const body = $('dash-analytics-summary');
    const meta = $('dash-analytics-meta');
    if (!body) return;
    const gaps = sortedByMtime(reports).find((r) => r.meta?.kind === 'gaps' || /-gaps\.md$/i.test(r.name));
    const trends = sortedByMtime(reports).find((r) => r.meta?.kind === 'trends' || /-trends\.md$/i.test(r.name));
    const lines = [];
    if (gaps) {
      lines.push(`<li><strong>Latest gaps:</strong> ${esc(gaps.meta?.summary || gaps.meta?.title || gaps.name)} <button type="button" data-open-report="${esc(gaps.name)}" data-report-tab="gaps">Open</button></li>`);
    }
    if (trends) {
      lines.push(`<li><strong>Latest trends:</strong> ${esc(trends.meta?.summary || trends.meta?.title || trends.name)} <button type="button" data-open-report="${esc(trends.name)}" data-report-tab="trends">Open</button></li>`);
    }
    if (meta) meta.textContent = [gaps ? 'gaps ready' : '', trends ? 'trends ready' : ''].filter(Boolean).join(' · ');
    if (!lines.length) {
      body.innerHTML = `<p class="hint">No gaps or trends reports yet.</p><div class="toolbar" style="margin-top:0.6rem"><button type="button" data-open-report-tab="gaps">Compute gaps</button><button type="button" data-open-report-tab="trends">Compute trends</button></div>`;
      return;
    }
    body.innerHTML = `<ul class="dash-compact-list">${lines.join('')}</ul>`;
  }

  async function loadCfpEvents(configs) {
    const body = $('dash-cfp-events');
    const meta = $('dash-cfp-meta');
    if (!body) return;
    const slug = configs[0]?.slug || (window.activeRoleSlug && window.activeRoleSlug()) || '';
    if (!slug) {
      body.innerHTML = '<p class="hint">Add a subject to track CFPs and events.</p>';
      if (meta) meta.textContent = '';
      return;
    }
    try {
      const data = await fetchJSON(`/api/cfp-conferences?slug=${encodeURIComponent(slug)}`);
      const cfps = (data.cfps || []).slice(0, 3);
      const conferences = (data.conferences || []).slice(0, 3);
      const rows = [];
      for (const c of cfps) {
        const url = c.cfp || c.site || '';
        rows.push(`<li><strong>${esc(c.name || 'CFP')}</strong>${c.dateLoc ? ` <span class="hint">${esc(c.dateLoc)}</span>` : ''}${url ? ` <a href="${esc(url)}" target="_blank" rel="noopener">Submit</a>` : ''}</li>`);
      }
      for (const c of conferences) {
        rows.push(`<li><strong>${esc(c.name || 'Event')}</strong>${c.dates ? ` <span class="hint">${esc(c.dates)}</span>` : ''}${c.location ? ` <span class="hint">${esc(c.location)}</span>` : ''}</li>`);
      }
      if (meta) meta.textContent = `${cfps.length} CFP${cfps.length === 1 ? '' : 's'} · ${conferences.length} event${conferences.length === 1 ? '' : 's'}`;
      body.innerHTML = rows.length
        ? `<ul class="dash-compact-list">${rows.join('')}</ul><div class="toolbar" style="margin-top:0.6rem"><button type="button" data-open-report-tab="cfp">Open CFPs &amp; Events</button></div>`
        : `<p class="hint">No current CFPs or events found for <code>${esc(slug)}</code>.</p><div class="toolbar" style="margin-top:0.6rem"><button type="button" data-open-report-tab="cfp">Open CFPs &amp; Events</button></div>`;
    } catch (err) {
      body.innerHTML = `<p class="hint">Couldn\u2019t load CFPs/events: ${esc(err.message || err)}</p>`;
      if (meta) meta.textContent = '';
    }
  }

  function renderStats(activity, subjectCount) {
    const totals = (activity && activity.totals) || {};
    const last = (activity && activity.last) || {};
    // Use real numbers / human strings rather than "—" so the empty state
    // communicates a value instead of looking like an unfinished load.
    const subj = $('stat-subjects');
    if (subj) subj.textContent = subjectCount ?? totals.subjects ?? totals.configs ?? 0;
    const r = $('stat-reports'); if (r) r.textContent = totals.reports ?? 0;
    const s = $('stat-social');
    if (s) {
      const n = (totals.socialBulk ?? 0) + (totals.socialSolo ?? 0);
      s.textContent = n;
    }
    // Legacy id kept in case other code still queries it; harmless if absent.
    const t = $('stat-thumbnails');
    if (t) t.textContent = totals.thumbnailImages ?? 0;
    const ls = $('stat-last-scan');
    if (ls) ls.textContent = last.scan ? relativeDay(last.scan) : 'Never';
    wireStatLinks();
  }

  // The At-a-glance tiles look interactive (hover lift, gradient outline) but
  // didn't actually go anywhere. Wire each tile to the matching view so the
  // affordance pays off: Subjects → Configs, Reports → Reports, Social → Social,
  // Last scan → opens the latest report. Idempotent via dataset.wired.
  function wireStatLinks() {
    const targets = [
      { id: 'stat-subjects', view: 'configs', label: 'Open configs' },
      { id: 'stat-reports', view: 'reports', label: 'Open reports' },
      { id: 'stat-social', view: 'social', label: 'Open social posts' },
      { id: 'stat-last-scan', view: null, label: 'Open latest report' },
    ];
    for (const t of targets) {
      const num = $(t.id);
      if (!num) continue;
      const tile = num.closest('.stat');
      if (!tile || tile.dataset.wired) continue;
      tile.dataset.wired = '1';
      tile.classList.add('is-clickable');
      tile.setAttribute('role', 'button');
      tile.setAttribute('tabindex', '0');
      tile.setAttribute('aria-label', t.label);
      const activate = () => {
        if (t.view) {
          const navBtn = document.querySelector(`nav button[data-view="${t.view}"]`);
          if (navBtn) navBtn.click();
          return;
        }
        // Last scan tile: reuse the existing "Open latest report" flow.
        if (typeof window.contentScoutOpenLatestReport === 'function') {
          window.contentScoutOpenLatestReport();
        } else {
          const navBtn = document.querySelector('nav button[data-view="reports"]');
          if (navBtn) navBtn.click();
          setTimeout(() => document.querySelector('#reports-list li')?.click(), 200);
        }
      };
      tile.addEventListener('click', activate);
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });
    }
  }

  // Unified timeline: reports + social posts + calendars + thumbnails + runs.
  // This is the answer to "doesn't truly represent what's been done" — every
  // category of artifact and every recent run shows up here, in time order.
  function renderActivity(activity) {
    const ul = $('dash-activity');
    const meta = $('dash-activity-meta');
    if (!ul) return;
    const items = (activity && activity.activity) || [];
    if (!items.length) {
      ul.innerHTML = `<li><div class="empty-state" style="margin:0.5rem 0">
        <div class="empty-icon" aria-hidden="true">✨</div>
        <p class="empty-title">No activity yet</p>
        <p class="empty-body">Run a scan to surface reports, social posts, and creator signals here.</p>
        <div class="empty-actions"><button type="button" class="btn-primary" data-goto="run" data-run-cmd="scout-scan">Run a scan</button></div>
      </div></li>`;
      if (meta) meta.textContent = '';
      return;
    }
    if (meta) {
      const totals = activity.totals || {};
      const parts = [];
      if (totals.reports) parts.push(`${totals.reports} report${totals.reports === 1 ? '' : 's'}`);
      const sp = (totals.socialBulk || 0) + (totals.socialSolo || 0);
      if (sp) parts.push(`${sp} post file${sp === 1 ? '' : 's'}`);
      if (totals.calendars) parts.push(`${totals.calendars} calendar${totals.calendars === 1 ? '' : 's'}`);
      if (totals.thumbnailImages) parts.push(`${totals.thumbnailImages} thumbnail${totals.thumbnailImages === 1 ? '' : 's'}`);
      meta.textContent = parts.join(' · ');
    }
    const KIND = {
      'report':       { icon: '📄', cls: 'kind-report' },
      'social-bulk':  { icon: '✉️', cls: 'kind-social' },
      'social-solo':  { icon: '✉️', cls: 'kind-social' },
      'social-other': { icon: '✉️', cls: 'kind-social' },
      'calendar':     { icon: '🗓', cls: 'kind-calendar' },
      'thumbnails':   { icon: '🖼', cls: 'kind-thumbs' },
      'trends':       { icon: '📈', cls: 'kind-trends' },
      'alt':          { icon: '♿', cls: 'kind-alt' },
      'run':          { icon: '▶', cls: 'kind-run' },
    };
    ul.innerHTML = items.map((it) => {
      const k = KIND[it.kind] || { icon: '•', cls: '' };
      const when = it.mtime ? relativeDay(it.mtime) : '—';
      let title;
      if (it.kind === 'thumbnails') {
        title = `${esc(it.count || 0)} PNG${(it.count || 0) === 1 ? '' : 's'} <span class="hint">(${esc(it.name)})</span>`;
      } else if (it.kind === 'run') {
        const status = esc(it.status || '');
        title = `<code>${esc(it.name || 'run')}</code> <span class="badge badge-${status}">${status}</span>`;
      } else if (it.href) {
        title = `<a href="${esc(it.href)}" target="_blank" rel="noopener">${esc(it.name)}</a>`;
      } else {
        title = esc(it.name);
      }
      const sub = it.slug ? `<span class="hint"> · <code>${esc(it.slug)}</code></span>` : '';
      return `<li class="activity-row ${k.cls}">
        <span class="activity-icon" aria-hidden="true">${k.icon}</span>
        <span class="activity-body">
          <span class="activity-label">${esc(it.label)}</span>${sub}
          <span class="activity-title">${title}</span>
        </span>
        <span class="activity-when hint">${esc(when)}</span>
      </li>`;
    }).join('');
  }

  function renderSubjects({ configs, reports }) {
    const ul = $('dash-subjects');
    if (!ul) return;
    if (!configs.length) {
      ul.innerHTML = `<li><div class="empty-state" style="margin:0.5rem 0">
        <div class="empty-icon" aria-hidden="true">🎯</div>
        <p class="empty-title">No subjects yet</p>
        <p class="empty-body">Add a product, technology, or project to start tracking.</p>
        <div class="empty-actions"><button type="button" class="btn-primary" data-goto="setup">Open Setup</button></div>
      </div></li>`;
      return;
    }
    // For each config, find the most recent report whose name contains the slug.
    const lines = configs.map((c) => {
      const slug = c.slug;
      const last = reports
        .filter((r) => r.name.includes(`-${slug}-`) || r.name.includes(`-${slug}.`))
        .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''))[0];
      const when = last ? relativeDay(last.mtime) : 'never';
      return `<li class="dash-subject">
        <span><code>${esc(slug)}</code></span>
        <span class="hint">${esc(when)}</span>
        <button type="button" class="dash-subject-run" data-slug="${esc(slug)}">Scan</button>
      </li>`;
    });
    ul.innerHTML = lines.join('');
    ul.querySelectorAll('.dash-subject-run').forEach((btn) => {
      btn.addEventListener('click', () => {
        // Set scan command, check the subject card matching this slug, then go to Run.
        const sel = $('run-command');
        if (sel) { sel.value = 'scout-scan'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        // Uncheck "All", check matching card.
        const all = $('run-subject-all');
        if (all) { all.checked = false; all.dispatchEvent(new Event('change', { bubbles: true })); }
        const card = document.querySelector(`#run-subject-list input[value="${btn.dataset.slug}"]`);
        if (card) { card.checked = true; card.dispatchEvent(new Event('change', { bubbles: true })); }
        const navBtn = document.querySelector('nav button[data-view="run"]');
        if (navBtn) navBtn.click();
      });
    });
  }

  function renderStack() { /* removed — replaced with renderSuggestions */ }

  // Friendly, actionable nudges built from state we already have.
  function renderSuggestions({ configs, reports, social }) {
    const ul = $('dash-suggestions');
    if (!ul) return;
    const tips = [];
    const now = Date.now();
    const daysSince = (iso) => iso ? Math.floor((now - new Date(iso).getTime()) / 86400000) : Infinity;

    if (!configs.length) {
      tips.push({
        text: 'Add a subject to start tracking content.',
        action: 'Open Setup',
        nav: 'setup',
      });
    }

    // Stale scans (>14d) per subject
    for (const c of configs) {
      const last = reports
        .filter((r) => /-content\.md$/.test(r.name) && (r.name.includes(`-${c.slug}-`) || r.name.includes(`-${c.slug}.`)))
        .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''))[0];
      const age = daysSince(last?.mtime);
      if (!last) {
        tips.push({ text: `<code>${esc(c.slug)}</code> has no scans yet.`, action: 'Run first scan', runCmd: 'scout-scan', slug: c.slug });
      } else if (age > 14) {
        tips.push({ text: `<code>${esc(c.slug)}</code> hasn't been scanned in ${age} days.`, action: 'Scan now', runCmd: 'scout-scan', slug: c.slug });
      }
    }

    // Reports without companion social posts
    const socialNames = new Set(social.map((s) => s.name || s));
    const recentReports = reports
      .filter((r) => /-content\.md$/.test(r.name))
      .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''))
      .slice(0, 3);
    for (const r of recentReports) {
      const stem = r.name.replace(/-content\.md$/, '');
      const hasSocial = [...socialNames].some((n) => n.startsWith(stem));
      if (!hasSocial) {
        tips.push({ text: `New report <code>${esc(r.name)}</code> has no social posts.`, action: 'Generate posts', runCmd: 'scout-post' });
      }
    }

    // No posting calendar in the last 7 days
    const latestCalendar = social
      .filter((s) => /-posting-calendar\.md$/.test(s.name || s))
      .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''))[0];
    if (configs.length && (!latestCalendar || daysSince(latestCalendar.mtime) > 7)) {
      tips.push({ text: 'No posting calendar this week.', action: 'Build calendar', runCmd: 'scout-calendar' });
    }

    if (!tips.length) {
      ul.innerHTML = '<li class="hint">All caught up — nice work.</li>';
      return;
    }

    ul.innerHTML = tips.slice(0, 5).map((t, i) => `
      <li class="dash-suggestion">
        <span class="suggestion-text">${t.text}</span>
        <button type="button" class="suggestion-act" data-i="${i}">${esc(t.action)}</button>
      </li>
    `).join('');

    // The Run (Scan) view only drives /scout-scan; its <select> has no
    // option for other commands, so setting sel.value = 'scout-calendar'
    // silently fails and leaves it on scan. Each non-scan command lives in
    // its owning view — launch it via the wired [data-launch-cmd] modal
    // button when one exists, else just navigate to that view.
    const cmdView = {
      'scout-post': 'social',
      'scout-calendar': 'social',
      'scout-gaps': 'reports',
      'scout-trends': 'reports',
      'scout-seo': 'tools',
      'scout-creators': 'conversations',
    };
    ul.querySelectorAll('.suggestion-act').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = tips[Number(btn.dataset.i)];
        if (t.runCmd === 'scout-scan') {
          const sel = $('run-command');
          if (sel) { sel.value = t.runCmd; sel.dispatchEvent(new Event('change', { bubbles: true })); }
          if (t.slug) {
            const all = $('run-subject-all');
            if (all) { all.checked = false; all.dispatchEvent(new Event('change', { bubbles: true })); }
            const card = document.querySelector(`#run-subject-list input[value="${t.slug}"]`);
            if (card) { card.checked = true; card.dispatchEvent(new Event('change', { bubbles: true })); }
          }
          const navBtn = document.querySelector('nav button[data-view="run"]');
          if (navBtn) navBtn.click();
        } else if (t.runCmd) {
          const launchBtn = document.querySelector(`[data-launch-cmd="${t.runCmd}"]`);
          if (launchBtn) { launchBtn.click(); return; }
          const view = cmdView[t.runCmd];
          const navBtn = view && document.querySelector(`nav button[data-view="${view}"]`);
          if (navBtn) navBtn.click();
        } else if (t.nav) {
          const navBtn = document.querySelector(`nav button[data-view="${t.nav}"]`);
          if (navBtn) navBtn.click();
        }
      });
    });
  }

  // --- Action items: parsed from latest content reports per subject ---
  async function loadActionItems() {
    const host = $('dash-action-items');
    const meta = $('dash-action-items-meta');
    if (!host) return;
    let data;
    try {
      data = await fetchJSON('/api/action-items');
    } catch {
      host.innerHTML = '<p class="hint">Couldn\u2019t load action items.</p>';
      return;
    }
    const groups = (data && data.groups) || [];
    if (!groups.length) {
      host.innerHTML =
        '<p class="hint">No reports yet \u2014 run a scan to surface action items.</p>';
      if (meta) meta.textContent = '';
      return;
    }
    // Drop syntactically-bad URLs up front (cheap, no network). Liveness is
    // probed in the background AFTER render via intel.js's data-check-url
    // pruning — pre-validating here used to fire up to 80 /api/check-url
    // calls that saturated the browser's 6-per-host HTTP/1.1 pool and
    // starved /api/conversations until its 8s timeout fired.
    const check = window.csUrlCheck;
    if (check && typeof check.isValidPostUrl === 'function') {
      const sanitize = (u) => (check.isValidPostUrl(u) ? u : '');
      for (const g of groups) {
        for (const it of g.topItems || []) it.url = sanitize(it.url);
        for (const c of g.cfps || []) {
          if (typeof c === 'string') continue;
          c.site = sanitize(c.site);
          c.cfp = sanitize(c.cfp);
          c.links = (c.links || []).map((ln) => ({ ...ln, url: sanitize(ln.url) })).filter((ln) => ln.url);
        }
      }
    }
    if (meta) {
      const total = groups.reduce(
        (n, g) => n + (g.topItems?.length || 0) + (g.cfps?.length || 0),
        0
      );
      meta.textContent = `${total} item${total === 1 ? '' : 's'} across ${groups.length} subject${
        groups.length === 1 ? '' : 's'
      }`;
    }
    host.innerHTML = groups
      .map((g) => {
        const top = (g.topItems || [])
          .map(
            (it) => `
          <li class="action-item">
            <div class="action-title">
              ${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>` : esc(it.title)}
              <span class="ep-badge ep-${it.ep}">EP ${it.ep}</span>
            </div>
            <div class="action-meta">
              ${it.date ? `<span class="hint">${esc(it.date)}</span>` : ''}
              ${
                it.url
                  ? `<button type="button" class="action-post" data-url="${esc(
                      it.url
                    )}" data-slug="${esc(g.slug)}">Draft post</button>`
                  : ''
              }
            </div>
          </li>`
          )
          .join('');
        const cfps = (g.cfps || [])
          .map((c) => {
            // Backward compat: server now sends objects; legacy strings still render.
            if (typeof c === 'string') {
              return `<li class="cfp-item">${esc(c).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')}</li>`;
            }
            const linkBits = [];
            if (c.site) {
              linkBits.push(
                `<a href="${esc(c.site)}" target="_blank" rel="noopener" class="cfp-link">Site</a>`
              );
            }
            if (c.cfp && c.cfp !== c.site) {
              linkBits.push(
                `<a href="${esc(c.cfp)}" target="_blank" rel="noopener" class="cfp-link cfp-link-primary">CFP / Submit</a>`
              );
            }
            for (const ln of c.links || []) {
              linkBits.push(
                `<a href="${esc(ln.url)}" target="_blank" rel="noopener" class="cfp-link">${esc(
                  ln.label
                )}</a>`
              );
            }
            if (!linkBits.length) {
              const q = encodeURIComponent(`${c.name} call for papers`);
              linkBits.push(
                `<a href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener" class="cfp-link cfp-link-search">Search CFP</a>`
              );
            }
            return `
              <li class="cfp-item">
                <div class="cfp-head">
                  <strong>${esc(c.name)}</strong>
                  ${c.dateLoc ? `<span class="hint">${esc(c.dateLoc)}</span>` : ''}
                </div>
                ${c.note ? `<div class="cfp-note">${esc(c.note)}</div>` : ''}
                <div class="cfp-links">${linkBits.join(' ')}</div>
              </li>`;
          })
          .join('');
        const socialBadge = g.hasSocial
          ? '<span class="badge badge-ok">posts drafted</span>'
          : `<button type="button" class="action-bulk-post" data-slug="${esc(
              g.slug
            )}">Generate posts for this report</button>`;
        return `
        <section class="action-group">
          <header class="action-group-head">
            <h4><code>${esc(g.slug)}</code></h4>
            <span class="hint">${esc(g.report)}</span>
            ${socialBadge}
          </header>
          ${
            top
              ? `<div class="action-block"><h5>High-priority items (EP \u2265 4)</h5><ul class="action-list">${top}</ul></div>`
              : '<p class="hint">No EP \u2265 4 items in this report.</p>'
          }
          ${
            cfps
              ? `<div class="action-block"><h5>Open CFPs / events</h5><ul class="cfp-list">${cfps}</ul></div>`
              : ''
          }
        </section>`;
      })
      .join('');

    // Wire "Draft post" buttons to /scout-post for that URL.
    host.querySelectorAll('.action-post').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sel = $('run-command');
        if (sel) {
          sel.value = 'scout-post';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const extra = $('run-extra');
        if (extra) extra.value = btn.dataset.url || '';
        const all = $('run-subject-all');
        const slug = btn.dataset.slug;
        if (all && slug) {
          all.checked = false;
          all.dispatchEvent(new Event('change', { bubbles: true }));
          const card = document.querySelector(`#run-subject-list input[value="${slug}"]`);
          if (card) {
            card.checked = true;
            card.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        const navBtn = document.querySelector('nav button[data-view="run"]');
        if (navBtn) navBtn.click();
      });
    });
    // Bulk: generate posts for the whole report.
    host.querySelectorAll('.action-bulk-post').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sel = $('run-command');
        if (sel) {
          sel.value = 'scout-post';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const all = $('run-subject-all');
        const slug = btn.dataset.slug;
        if (all && slug) {
          all.checked = false;
          all.dispatchEvent(new Event('change', { bubbles: true }));
          const card = document.querySelector(`#run-subject-list input[value="${slug}"]`);
          if (card) {
            card.checked = true;
            card.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        const navBtn = document.querySelector('nav button[data-view="run"]');
        if (navBtn) navBtn.click();
      });
    });
  }

  // Re-render when the user revisits the dashboard.
  function onHashChange() {
    if ((location.hash || '#dashboard').replace(/^#/, '') === 'dashboard') {
      loadAll();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      wireHero();
      loadAll();
      window.addEventListener('hashchange', onHashChange);
    });
  } else {
    wireHero();
    loadAll();
    window.addEventListener('hashchange', onHashChange);
  }
})();
