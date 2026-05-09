// browser-scan-ui.js
// Surfaces the tools/browser-scan/ tool inside the web UI:
//   * Run view: "Browser scan (Layer 0)" panel above the existing form,
//     visible whenever the selected command is scout-scan. Lets the user
//     open the Edge/Chrome window with CDP enabled, refresh sidecars for
//     the active subject(s), and see when each platform last got fresh
//     data.
//   * Dashboard: a small "Browser scan" status card showing whether
//     Edge/Chrome is up on the CDP port.
//
// All additive — does not touch app.js or dashboard-enhancer.js.

(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);

  function relativeMin(ms) {
    if (!ms) return 'never';
    const mins = Math.floor((Date.now() - ms) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  let infoCache = null;
  let statusCache = null;
  let statusLastFetched = 0;
  let polling = null;

  async function fetchInfo() {
    if (infoCache) return infoCache;
    try {
      const r = await fetch('/api/browser-scan/info');
      infoCache = await r.json();
    } catch (err) {
      infoCache = { installed: false, error: err.message };
    }
    return infoCache;
  }

  async function fetchStatus(force = false) {
    if (!force && statusCache && Date.now() - statusLastFetched < 5000) return statusCache;
    try {
      const r = await fetch('/api/browser-scan/status');
      statusCache = await r.json();
      statusLastFetched = Date.now();
    } catch (err) {
      statusCache = { installed: false, error: err.message };
    }
    return statusCache;
  }

  // ===== Run view panel =============================================

  function ensureRunPanel() {
    if ($('browser-scan-panel')) return $('browser-scan-panel');
    const view = $('view-run');
    if (!view) return null;
    // Insert after the H2 heading, before the .run-form so it sits at
    // the top of the run page.
    const heading = view.querySelector('h2');
    const form = view.querySelector('.run-form');
    const panel = document.createElement('div');
    panel.id = 'browser-scan-panel';
    panel.className = 'card';
    panel.style.marginBottom = '1rem';
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">
        <h3 style="margin:0;flex:1;">🌐 Browser scan (Layer 0)</h3>
        <span id="bs-status-pill" class="hint" aria-live="polite">checking…</span>
      </div>
      <p class="hint" style="margin-top:0.5rem;">
        Drives your real browser via the Chrome DevTools Protocol so X / LinkedIn / Reddit
        return logged-in results. <a href="/docs/SOURCES.md" target="_blank" rel="noopener">Why?</a>
      </p>
      <div class="toolbar" style="margin-top:0.5rem;flex-wrap:wrap;gap:0.5rem;">
        <label style="display:flex;align-items:center;gap:0.4rem;font-size:0.9rem;">
          Browser
          <select id="bs-browser-select" style="min-width:180px;"></select>
        </label>
        <button type="button" id="bs-launch-btn">Open browser &amp; sign in</button>
        <button type="button" id="bs-scan-btn" class="secondary">Scan now (active subject)</button>
        <button type="button" id="bs-refresh-btn" class="link-btn" title="Refresh status">↻</button>
      </div>
      <div id="bs-sidecars" class="hint" style="margin-top:0.5rem;"></div>
      <div id="bs-message" class="hint" style="margin-top:0.5rem;" aria-live="polite"></div>
    `;
    if (form && form.parentNode === view) {
      view.insertBefore(panel, form);
    } else {
      heading?.insertAdjacentElement('afterend', panel);
    }
    wireRunPanel(panel);
    return panel;
  }

  async function wireRunPanel(panel) {
    const info = await fetchInfo();
    if (!info?.installed) {
      panel.querySelector('#bs-message').innerHTML =
        `<span class="warn-text">browser-scan tool not installed in this checkout — Layer 0 disabled.</span>`;
      panel.querySelector('#bs-launch-btn').disabled = true;
      panel.querySelector('#bs-scan-btn').disabled = true;
      return;
    }
    // Populate browser dropdown — chromium-family only, marked installed/missing.
    const sel = panel.querySelector('#bs-browser-select');
    const opts = [`<option value="">Auto-detect (default browser)</option>`];
    for (const b of info.browsers || []) {
      if (b.kind !== 'chromium') continue;
      opts.push(
        `<option value="${esc(b.name)}" ${b.installed ? '' : 'disabled'}>${esc(b.name)}${b.installed ? '' : ' (not installed)'}</option>`,
      );
    }
    sel.innerHTML = opts.join('');

    panel.querySelector('#bs-launch-btn').addEventListener('click', () => onLaunchClick(panel));
    panel.querySelector('#bs-scan-btn').addEventListener('click', () => onScanClick(panel));
    panel.querySelector('#bs-refresh-btn').addEventListener('click', () => refreshPanel(panel, true));

    // Initial paint + start polling while the run view is visible.
    refreshPanel(panel);
    if (!polling) {
      polling = setInterval(() => {
        if (!document.getElementById('view-run')?.classList.contains('active')) return;
        refreshPanel(panel);
      }, 8000);
    }
  }

  async function refreshPanel(panel, force = false) {
    const status = await fetchStatus(force);
    const pill = panel.querySelector('#bs-status-pill');
    const sidecarEl = panel.querySelector('#bs-sidecars');
    if (status?.cdp?.up) {
      pill.textContent = `🟢 connected — ${status.cdp.browser || 'browser'}`;
      pill.style.color = 'var(--ok, #2ea043)';
    } else {
      pill.textContent = '⚪ no browser running on CDP port';
      pill.style.color = 'var(--muted)';
    }
    // Per-active-subject sidecar freshness.
    const slug = activeSubjectSlug();
    const platforms = status?.sidecarsBySlug?.[slug];
    if (slug && platforms) {
      sidecarEl.innerHTML = `Sidecars for <code>${esc(slug)}</code>: ` +
        ['x', 'linkedin', 'reddit']
          .map((p) => {
            const sc = platforms[p];
            if (!sc) return `<strong>${p}</strong>: <span style="color:var(--muted)">none</span>`;
            return `<strong>${p}</strong>: ${esc(relativeMin(sc.mtime))}`;
          })
          .join(' · ');
    } else if (slug) {
      sidecarEl.innerHTML = `No browser-scan sidecars yet for <code>${esc(slug)}</code>. Click "Scan now" after opening the browser.`;
    } else {
      sidecarEl.textContent = 'Pick a subject below to see its sidecar status.';
    }
  }

  // Pull the slug the user has selected in the run view's subject picker.
  // Falls back to the first available config if "All subjects" is checked.
  function activeSubjectSlug() {
    const checks = [...document.querySelectorAll('#run-subject-list input[type="checkbox"]:checked')]
      .map((el) => el.value)
      .filter(Boolean);
    if (checks.length === 1) return checks[0];
    // Hidden run-slug input is the source of truth app.js maintains.
    const hidden = $('run-slug');
    if (hidden && hidden.value && !hidden.value.includes(',')) return hidden.value;
    // Fallback: first config in the picker.
    const firstCard = document.querySelector('#run-subject-list input[type="checkbox"][value]:not([value=""])');
    return firstCard?.value || '';
  }

  async function onLaunchClick(panel) {
    const btn = panel.querySelector('#bs-launch-btn');
    const msg = panel.querySelector('#bs-message');
    const browser = panel.querySelector('#bs-browser-select').value || undefined;
    btn.disabled = true;
    msg.textContent = 'Opening browser…';
    try {
      const r = await fetch('/api/browser-scan/launch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ browser }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `${r.status}`);
      if (data.alreadyRunning) {
        msg.textContent = `Browser already running on CDP port (${data.browser || 'detected'}). Sign in if any tab still shows the login page.`;
      } else {
        msg.innerHTML = `Browser launched (pid ${data.pid}). Sign in to X, LinkedIn, and Reddit in the new window, then leave it open.`;
      }
      // Poll status faster for the next 30s so the pill flips to green
      // when the CDP port comes up.
      let tries = 0;
      const fast = setInterval(async () => {
        tries++;
        await refreshPanel(panel, true);
        if (statusCache?.cdp?.up || tries > 15) clearInterval(fast);
      }, 2000);
    } catch (err) {
      msg.innerHTML = `<span class="warn-text">${esc(err.message)}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  async function onScanClick(panel) {
    const slug = activeSubjectSlug();
    const btn = panel.querySelector('#bs-scan-btn');
    const msg = panel.querySelector('#bs-message');
    if (!slug) {
      msg.innerHTML = `<span class="warn-text">Pick exactly one subject in the form below first.</span>`;
      return;
    }
    btn.disabled = true;
    msg.textContent = `Starting browser-scan for ${slug}…`;
    try {
      const r = await fetch('/api/browser-scan/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `${r.status}`);
      msg.innerHTML = `Browser-scan running. Watch progress in the <button type="button" data-open-runs class="link-btn">Operations drawer</button> on the right.`;
      msg.querySelector('[data-open-runs]')?.addEventListener('click', () => {
        window.runsQueue?.open?.();
      });
      // Refresh status more often while the scan is running.
      let tries = 0;
      const fast = setInterval(async () => {
        tries++;
        await refreshPanel(panel, true);
        if (tries > 30) clearInterval(fast);
      }, 4000);
    } catch (err) {
      msg.innerHTML = `<span class="warn-text">${esc(err.message)}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  // ===== Dashboard mini-card ========================================

  function ensureDashCard() {
    if ($('bs-dash-card')) return;
    const intel = $('dash-intel-cards');
    if (!intel) return;
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'bs-dash-card';
    card.innerHTML = `
      <h3>Browser scan</h3>
      <div id="bs-dash-body" class="hint">Loading…</div>
    `;
    intel.appendChild(card);
  }

  async function paintDashCard() {
    ensureDashCard();
    const body = $('bs-dash-body');
    if (!body) return;
    const [info, status] = await Promise.all([fetchInfo(), fetchStatus(true)]);
    if (!info?.installed) {
      body.innerHTML = `<span class="warn-text">tools/browser-scan/ not installed.</span>`;
      return;
    }
    const recommended = info.recommended ? `${info.recommended.name}${info.recommended.notice ? ' (fallback)' : ''}` : '—';
    const cdpLine = status?.cdp?.up
      ? `<div>🟢 <strong>${esc(status.cdp.browser || 'browser')}</strong> running on CDP port ${status.port}</div>`
      : `<div>⚪ No browser on CDP port. <a href="#run">Open Run view → Browser scan</a> to launch.</div>`;
    const slugCount = Object.keys(status?.sidecarsBySlug || {}).length;
    const sidecarLine = slugCount
      ? `<div>Sidecars for ${slugCount} subject${slugCount === 1 ? '' : 's'} on disk.</div>`
      : `<div>No sidecars yet for any subject.</div>`;
    body.innerHTML = `
      ${cdpLine}
      <div style="margin-top:0.25rem;">Default: <code>${esc(recommended)}</code></div>
      ${sidecarLine}
    `;
  }

  // ===== Boot ========================================================

  function boot() {
    // Run view panel: build/refresh whenever the run view becomes active.
    const runNav = document.querySelector('nav button[data-view="run"]');
    runNav?.addEventListener('click', () => setTimeout(ensureRunPanel, 50));
    // Also build immediately if the page loads on #run.
    if (location.hash === '#run' || $('view-run')?.classList.contains('active')) {
      ensureRunPanel();
    }
    // Dashboard mini-card: build/refresh whenever the dashboard becomes active.
    const dashNav = document.querySelector('nav button[data-view="dashboard"]');
    dashNav?.addEventListener('click', () => setTimeout(paintDashCard, 100));
    if (location.hash === '' || location.hash === '#dashboard' || $('view-dashboard')?.classList.contains('active')) {
      setTimeout(paintDashCard, 200);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
