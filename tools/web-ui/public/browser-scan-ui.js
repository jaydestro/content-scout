// browser-scan-ui.js
// Surfaces the tools/browser-scan/ tool inside the web UI.
//
// One canonical home in the Run view: the "Browser scan (Layer 0)"
// fieldset rendered by index.html inside the /scout-scan form. We
// progressively enhance it with runtime state (CDP connection pill,
// sign-in chips, force-rescan button, sidecar freshness) so the user
// sees ONE place for everything Layer-0 related when they pick
// /scout-scan. No floating cards, no duplicate launch surfaces.
//
// On the Dashboard, a small "Browser scan" status card shows whether
// Edge/Chrome is up on the CDP port and how many subjects have
// sidecars on disk.
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
  let authCache = null; // { ok, port, checkedAt, platforms: { x|linkedin|reddit: { state, ... } } }
  let wired = false;   // ensures we only attach event listeners once

  const PLATFORM_LABEL = { x: 'X', linkedin: 'LinkedIn', reddit: 'Reddit' };
  const PLATFORM_LOGIN_URL = {
    x: 'https://x.com/login',
    linkedin: 'https://www.linkedin.com/login',
    reddit: 'https://www.reddit.com/login',
  };

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

  // ===== Run view fieldset =========================================
  // The fieldset is declared in index.html (id="run-browser-scan-wrap").
  // This file wires up its runtime children: chips, buttons, status.

  function getFieldset() {
    return $('run-browser-scan-wrap');
  }

  // Show/hide is owned by app.js (it toggles `hidden` when the user
  // picks /scout-scan vs another command).
  async function wireFieldset() {
    if (wired) return;
    const wrap = getFieldset();
    if (!wrap) return;
    wired = true;

    const info = await fetchInfo();
    const launchBtn = $('bs-launch-btn');
    const scanBtn = $('bs-scan-btn');
    const refreshBtn = $('bs-refresh-btn');
    const authBtn = $('bs-auth-check-btn');
    const msg = $('bs-message');
    const sel = $('bs-browser-select');

    if (!info?.installed) {
      if (msg) {
        msg.innerHTML =
          `<span class="warn-text">tools/browser-scan/ is not installed in this checkout — Layer 0 is disabled.</span>`;
      }
      [launchBtn, scanBtn, refreshBtn, authBtn].forEach((b) => { if (b) b.disabled = true; });
      return;
    }

    // Populate browser dropdown — Chromium-family only.
    if (sel) {
      const opts = [`<option value="">Auto-detect (default browser)</option>`];
      for (const b of info.browsers || []) {
        if (b.kind !== 'chromium') continue;
        opts.push(
          `<option value="${esc(b.name)}" ${b.installed ? '' : 'disabled'}>${esc(b.name)}${b.installed ? '' : ' (not installed)'}</option>`,
        );
      }
      sel.innerHTML = opts.join('');
    }

    launchBtn?.addEventListener('click', () => onLaunchClick());
    scanBtn?.addEventListener('click', () => onScanClick());
    refreshBtn?.addEventListener('click', () => refreshState(true));
    authBtn?.addEventListener('click', () => runAuthCheck());

    // Click a chip → open that platform's login URL in a new tab so
    // the user can sign in (or finish verification) in the controlled
    // browser.
    document.querySelectorAll('#run-browser-scan-wrap .bs-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const p = chip.dataset.platform;
        const url = PLATFORM_LOGIN_URL[p];
        if (url) window.open(url, '_blank', 'noopener');
      });
    });

    // Initial paint + polling loop (only while the run view is visible).
    refreshState();
    if (!polling) {
      polling = setInterval(() => {
        if (!$('view-run')?.classList.contains('active')) return;
        if (!getFieldset() || getFieldset().hidden) return;
        refreshState();
      }, 8000);
    }
  }

  function paintAuthChips() {
    const wrap = getFieldset();
    if (!wrap) return;
    const timeEl = $('bs-auth-time');
    const platforms = authCache?.platforms || {};
    for (const p of ['x', 'linkedin', 'reddit']) {
      const chip = wrap.querySelector(`.bs-chip[data-platform="${p}"]`);
      if (!chip) continue;
      const dot = chip.querySelector('.bs-chip-dot');
      if (!dot) continue;
      const st = platforms[p]?.state;
      let glyph = '⚪'; let color = 'var(--muted)';
      let title = 'Not checked yet — click "Check sign-in".';
      if (st === 'signed-in') {
        glyph = '🟢'; color = 'var(--ok,#2ea043)';
        title = `Signed in (${platforms[p]?.finalUrl || ''}).`;
      } else if (st === 'needs-verification') {
        glyph = '🟡'; color = 'var(--warn,#bf8700)';
        title = `${PLATFORM_LABEL[p]} session is valid, but the site is asking for device / 2FA verification. Click the chip, complete the prompt in the controlled browser, then re-check. (Landing URL: ${platforms[p]?.finalUrl || ''})`;
      } else if (st === 'signed-out') {
        glyph = '🔴'; color = 'var(--danger,#cf222e)';
        title = `Not signed in. Click the chip to open ${PLATFORM_LABEL[p]} login.`;
      } else if (st === 'error') {
        glyph = '⚠️'; color = 'var(--warn,#bf8700)';
        title = `Check failed: ${platforms[p]?.raw || 'unknown error'}.`;
      } else if (st === 'unclear') {
        glyph = '❔'; color = 'var(--muted)';
        title = `Unclear: ${platforms[p]?.finalUrl || ''}.`;
      }
      dot.textContent = glyph;
      chip.style.color = color;
      chip.title = title;
    }
    if (timeEl) {
      if (authCache?.checkedAt) {
        const mins = Math.floor((Date.now() - new Date(authCache.checkedAt).getTime()) / 60000);
        timeEl.textContent = mins < 1 ? '· checked just now' : `· checked ${mins}m ago`;
      } else {
        timeEl.textContent = '';
      }
    }
  }

  let lastCdpUp = null;

  async function refreshState(force = false) {
    const wrap = getFieldset();
    if (!wrap) return;
    const status = await fetchStatus(force);
    const pill = $('bs-status-pill');
    const sidecarEl = $('bs-sidecars');
    const cdpUp = !!status?.cdp?.up;
    if (pill) {
      if (cdpUp) {
        pill.textContent = `🟢 connected — ${status.cdp.browser || 'browser'}`;
        pill.style.color = 'var(--ok, #2ea043)';
      } else {
        pill.textContent = '⚪ no browser on CDP port';
        pill.style.color = 'var(--muted)';
      }
    }
    // First time CDP comes up: kick off one auth check so the chips light up.
    if (cdpUp && lastCdpUp !== true && !authCache) {
      runAuthCheck().catch(() => {});
    }
    if (!cdpUp && lastCdpUp === true) authCache = null;
    lastCdpUp = cdpUp;
    paintAuthChips();
    // Per-active-subject sidecar freshness.
    const slug = activeSubjectSlug();
    const platforms = status?.sidecarsBySlug?.[slug];
    if (sidecarEl) {
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
        sidecarEl.innerHTML = `No browser-scan sidecars yet for <code>${esc(slug)}</code>. Click "Force-rescan active subject" after signing in.`;
      } else {
        sidecarEl.textContent = 'Pick a subject below to see its sidecar freshness.';
      }
    }
  }

  // Pull the slug the user has selected in the subject picker. Falls
  // back to the first available config if "All subjects" is checked.
  function activeSubjectSlug() {
    const checks = [...document.querySelectorAll('#run-subject-list input[type="checkbox"]:checked')]
      .map((el) => el.value)
      .filter(Boolean);
    if (checks.length === 1) return checks[0];
    const hidden = $('run-slug');
    if (hidden && hidden.value && !hidden.value.includes(',')) return hidden.value;
    const firstCard = document.querySelector('#run-subject-list input[type="checkbox"][value]:not([value=""])');
    return firstCard?.value || '';
  }

  // Read the date-range preset from the form and convert it to a
  // whole-number "days" lookback. The browser-scan CLI accepts --days N.
  // Default: 30 days. Custom ranges → max(1, days between from and to).
  function activeRangeDays() {
    const presetEl = $('run-range-preset');
    if (!presetEl) return 30;
    const choice = presetEl.value || 'default';
    if (choice === 'default') return 30;
    if (choice === 'today') return 1;
    if (choice === 'this-week') {
      const now = new Date();
      const day = now.getDay();
      const elapsed = (day === 0 ? 6 : day - 1);
      return Math.max(1, elapsed + 1);
    }
    if (choice === 'this-month') {
      return new Date().getDate();
    }
    if (choice === 'last-month') {
      const now = new Date();
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return last.getDate() + now.getDate();
    }
    if (choice === 'custom') {
      const from = $('run-range-from')?.value;
      const to = $('run-range-to')?.value;
      const now = new Date();
      const f = from ? new Date(from) : null;
      const t = to ? new Date(to) : now;
      if (!f && !t) return 30;
      const start = f || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const days = Math.ceil((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
      return Math.max(1, days);
    }
    return 30;
  }

  async function runAuthCheck() {
    const btn = $('bs-auth-check-btn');
    const msg = $('bs-message');
    if (btn?.dataset.busy === '1') return;
    if (btn) { btn.dataset.busy = '1'; btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
      const r = await fetch('/api/browser-scan/auth-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await r.json();
      if (r.status === 409) {
        authCache = null;
        if (msg) msg.innerHTML =
          `<span class="warn-text">Browser isn't running on the CDP port — click "Open browser &amp; sign in" first.</span>`;
        paintAuthChips();
        return;
      }
      if (!r.ok || !data.ok) {
        if (msg) msg.innerHTML =
          `<span class="warn-text">Sign-in check failed: ${esc(data.error || data.message || r.statusText)}</span>`;
        return;
      }
      authCache = data;
      paintAuthChips();
      const entries = Object.entries(data.platforms || {});
      const signedOut = entries.filter(([, v]) => v.state === 'signed-out').map(([k]) => PLATFORM_LABEL[k] || k);
      const needsVerify = entries.filter(([, v]) => v.state === 'needs-verification').map(([k]) => PLATFORM_LABEL[k] || k);
      const other = entries.filter(([, v]) => !['signed-in', 'signed-out', 'needs-verification'].includes(v.state)).map(([k]) => PLATFORM_LABEL[k] || k);
      if (msg) {
        if (!signedOut.length && !needsVerify.length && !other.length) {
          msg.innerHTML = `<span style="color:var(--ok,#2ea043);">Signed in to X, LinkedIn, and Reddit. Layer 0 ready.</span>`;
        } else {
          const parts = [];
          if (signedOut.length) parts.push(`Sign in to ${esc(signedOut.join(', '))} in the controlled browser.`);
          if (needsVerify.length) parts.push(`Complete the device/2FA prompt for ${esc(needsVerify.join(', '))} — you're signed in, the site just wants verification.`);
          if (other.length) parts.push(`Couldn't determine ${esc(other.join(', '))} state — hover the chip for details.`);
          parts.push(`Then click "Check sign-in" again.`);
          msg.innerHTML = parts.join(' ');
        }
      }
    } catch (err) {
      if (msg) msg.innerHTML = `<span class="warn-text">${esc(err.message)}</span>`;
    } finally {
      if (btn) { btn.dataset.busy = '0'; btn.disabled = false; btn.textContent = 'Check sign-in'; }
    }
  }

  async function onLaunchClick() {
    const btn = $('bs-launch-btn');
    const msg = $('bs-message');
    const browser = $('bs-browser-select')?.value || undefined;
    if (btn) btn.disabled = true;
    if (msg) msg.textContent = 'Opening browser…';
    try {
      const r = await fetch('/api/browser-scan/launch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ browser }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `${r.status}`);
      if (msg) {
        if (data.alreadyRunning) {
          msg.textContent = `Browser already running on CDP port (${data.browser || 'detected'}). Sign in if any tab still shows the login page.`;
        } else {
          msg.innerHTML = `Browser launched (pid ${data.pid}). Sign in to X, LinkedIn, and Reddit in the new window, then leave it open.`;
        }
      }
      let tries = 0;
      const fast = setInterval(async () => {
        tries++;
        await refreshState(true);
        if (statusCache?.cdp?.up || tries > 15) clearInterval(fast);
      }, 2000);
    } catch (err) {
      if (msg) msg.innerHTML = `<span class="warn-text">${esc(err.message)}</span>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function onScanClick() {
    const slug = activeSubjectSlug();
    const btn = $('bs-scan-btn');
    const msg = $('bs-message');
    if (!slug) {
      if (msg) msg.innerHTML = `<span class="warn-text">Pick exactly one subject in the form below first.</span>`;
      return;
    }
    if (btn) btn.disabled = true;
    if (msg) msg.textContent = `Starting browser-scan for ${slug}…`;
    try {
      const r = await fetch('/api/browser-scan/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, days: activeRangeDays() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `${r.status}`);
      if (msg) {
        msg.innerHTML = `Browser-scan running (last ${activeRangeDays()} days). Watch progress in the <button type="button" data-open-runs class="link-btn">Operations drawer</button>.`;
        msg.querySelector('[data-open-runs]')?.addEventListener('click', () => {
          window.runsQueue?.open?.();
        });
      }
      let tries = 0;
      const fast = setInterval(async () => {
        tries++;
        await refreshState(true);
        if (tries > 30) clearInterval(fast);
      }, 4000);
    } catch (err) {
      if (msg) msg.innerHTML = `<span class="warn-text">${esc(err.message)}</span>`;
    } finally {
      if (btn) btn.disabled = false;
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
      <div id="bs-dash-body" class="skeleton-stack">
        <div class="skeleton skeleton-line" style="width:70%"></div>
        <div class="skeleton skeleton-line" style="width:55%"></div>
        <div class="skeleton skeleton-line" style="width:80%"></div>
      </div>
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
      : `<div>⚪ No browser on CDP port. <a href="#run">Open the Run view</a> and pick /scout-scan to launch it.</div>`;
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
    // Run view: wire the fieldset whenever the run view becomes active.
    const runNav = document.querySelector('nav button[data-view="run"]');
    runNav?.addEventListener('click', () => setTimeout(wireFieldset, 50));
    if (location.hash === '#run' || $('view-run')?.classList.contains('active')) {
      wireFieldset();
    }
    // Wire it now too in case the form is rendered on load even when
    // the view isn't active yet (handles cold loads on #dashboard).
    wireFieldset();

    // Re-paint sidecar status when the user changes the subject picker
    // — the fieldset shows freshness for the active subject.
    document.addEventListener('change', (e) => {
      const t = e.target;
      if (t && (t.id === 'run-subject-all' || t.name === 'run-slug-choice')) {
        if (!getFieldset() || getFieldset().hidden) return;
        refreshState();
      }
    });

    // Dashboard mini-card.
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
