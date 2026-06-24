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
  let authCache = null; // { ok, port, checkedAt, platforms: { x|linkedin|reddit|google: { state, ... } } }
  let wired = false;   // ensures we only attach event listeners once

  const PLATFORM_LABEL = { x: 'X', linkedin: 'LinkedIn', reddit: 'Reddit', google: 'Google News' };
  const PLATFORM_LOGIN_URL = {
    x: 'https://x.com/login',
    linkedin: 'https://www.linkedin.com/login',
    reddit: 'https://www.reddit.com/login',
    google: 'https://news.google.com/',
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
    const refreshBtn = $('bs-refresh-btn');
    const authBtn = $('bs-auth-check-btn');
    const msg = $('bs-message');
    const sel = $('bs-browser-select');

    if (!info?.installed) {
      if (msg) {
        msg.innerHTML =
          `<span class="warn-text">tools/browser-scan/ is not installed in this checkout — Layer 0 is disabled.</span>`;
      }
      [launchBtn, refreshBtn, authBtn].forEach((b) => { if (b) b.disabled = true; });
      return;
    }

    // Populate browser dropdown — Chromium-family only. Preselect Edge when
    // it's installed so launches use a dedicated, isolated profile instead
    // of attaching to the user's everyday default browser (a heavily-loaded
    // default Chrome is the usual cause of CDP "couldn't read tabs" hangs).
    if (sel) {
      const browsers = info.browsers || [];
      const edgeInstalled = browsers.some((b) => b.kind === 'chromium' && b.installed && /edge/i.test(b.name));
      const opts = [`<option value="">Auto-detect (default browser)</option>`];
      for (const b of browsers) {
        if (b.kind !== 'chromium') continue;
        const isEdge = /edge/i.test(b.name);
        const selected = edgeInstalled && isEdge && b.installed ? ' selected' : '';
        opts.push(
          `<option value="${esc(b.name)}"${selected} ${b.installed ? '' : 'disabled'}>${esc(b.name)}${b.installed ? '' : ' (not installed)'}</option>`,
        );
      }
      sel.innerHTML = opts.join('');
    }

    launchBtn?.addEventListener('click', () => onLaunchClick());
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
    for (const p of ['x', 'linkedin', 'reddit', 'google']) {
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
    // Do NOT auto-fire an auth check here. `runAuthCheck()` spawns
    // Playwright via /api/browser-scan/auth-check, which opens fresh
    // tabs in the user's controlled browser for X / LinkedIn / Reddit /
    // Google News. Firing it on every page load (whenever the CDP port
    // happens to be up) made the browser sprout 4 tabs every time the
    // web UI was opened — even if the user hadn't asked to scan
    // anything yet. The chips stay ⚪ ("not checked") until the user
    // clicks "Check sign-in" explicitly.
    if (!cdpUp && lastCdpUp === true) authCache = null;
    lastCdpUp = cdpUp;
    paintAuthChips();
    // Per-active-subject sidecar freshness.
    const slug = activeSubjectSlug();
    const platforms = status?.sidecarsBySlug?.[slug];
    if (sidecarEl) {
      if (slug && platforms) {
        sidecarEl.innerHTML = `Sidecars for <code>${esc(slug)}</code>: ` +
          ['x', 'linkedin', 'reddit', 'google']
            .map((p) => {
              const sc = platforms[p];
              if (!sc) return `<strong>${p}</strong>: <span style="color:var(--muted)">none</span>`;
              return `<strong>${p}</strong>: ${esc(relativeMin(sc.mtime))}`;
            })
            .join(' · ');
      } else if (slug) {
        sidecarEl.innerHTML = `No browser-scan sidecars yet for <code>${esc(slug)}</code>. Run /scout-scan (with Force selected) after signing in to populate them.`;
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
          msg.innerHTML = `<span style="color:var(--ok,#2ea043);">Signed in to X, LinkedIn, Reddit, and Google News. Layer 0 ready.</span>`;
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
          msg.innerHTML = `Browser launched (pid ${data.pid}). Sign in to X, LinkedIn, and Reddit in the new window, then leave it open. (Google News works without sign-in.)`;
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

  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
