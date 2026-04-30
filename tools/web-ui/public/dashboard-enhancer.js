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
  }

  // --- Stats + subjects + stack ---
  async function fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }

  async function loadAll() {
    let configs = { configs: [] }, reports = { reports: [] }, runs = { runs: [] };
    let social = [];
    try { [configs, reports, runs] = await Promise.all([
      fetchJSON('/api/configs'),
      fetchJSON('/api/reports'),
      fetchJSON('/api/runs'),
    ]); } catch { /* keep defaults */ }
    try {
      const r = await fetch('/api/social');
      if (r.ok) social = (await r.json()).posts || [];
    } catch { /* no endpoint, fine */ }

    renderStats({ reports, runs, social });
    renderSubjects({ configs: configs.configs || [], reports: reports.reports || [] });
    renderSuggestions({ configs: configs.configs || [], reports: reports.reports || [], social });
    loadActionItems();
  }

  function renderStats({ reports, runs, social }) {
    const r = $('stat-reports'); if (r) r.textContent = (reports.reports || []).length;
    const s = $('stat-social'); if (s) s.textContent = (social || []).length || 0;
    const ru = $('stat-runs'); if (ru) ru.textContent = (runs.runs || []).length;
    const ls = $('stat-last-scan');
    if (ls) {
      const latest = (reports.reports || [])
        .filter((x) => /-content\.md$/.test(x.name))
        .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''))[0];
      ls.textContent = latest ? relativeDay(latest.mtime) : '—';
    }
  }

  function renderSubjects({ configs, reports }) {
    const ul = $('dash-subjects');
    if (!ul) return;
    if (!configs.length) {
      ul.innerHTML = '<li class="hint">No subjects yet — open <a href="#" data-goto="setup">Setup</a> to add one.</li>';
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

    ul.querySelectorAll('.suggestion-act').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = tips[Number(btn.dataset.i)];
        if (t.runCmd) {
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
