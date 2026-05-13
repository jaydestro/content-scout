/*
 * Dashboard tabs — reorganizes the dense dashboard into 3 tabs at load time
 * without touching app.js or index.html structure.
 *
 * Layout after this script runs:
 *   [Hero (always visible)]
 *   [At a glance stats (always visible)]
 *   [ Pulse | Activity | Intel ]  <- tabs
 *   [ tab panel content ]
 *
 *   Pulse    = Needs your attention (social activity + suggestions)
 *   Activity = Recent activity (subjects + latest artifacts)
 *   Intel    = Sentiment + creators + source health
 */
(function () {
  'use strict';

  const TABS = [
    { id: 'pulse', label: 'Pulse', heads: ['Needs your attention'] },
    { id: 'activity', label: 'Activity', heads: ['Recent activity'] },
    { id: 'intel', label: 'Intel', heads: ['Intel'] },
  ];

  let installed = false;
  let active = sessionStorage.getItem('scout-dash-tab') || 'pulse';

  function findHeadByText(host, text) {
    const heads = host.querySelectorAll('h3.dash-section-head');
    for (const h of heads) if (h.textContent.trim() === text) return h;
    return null;
  }

  // Collect siblings between this head and the next dash-section-head (or hidden legacy block).
  function collectSection(head) {
    const nodes = [head];
    let n = head.nextElementSibling;
    while (n) {
      if (n.matches && n.matches('h3.dash-section-head')) break;
      // Stop before the legacy hidden block.
      if (n.hasAttribute && n.hasAttribute('hidden')) break;
      nodes.push(n);
      n = n.nextElementSibling;
    }
    return nodes;
  }

  function install() {
    if (installed) return;
    const body = document.getElementById('dash-body');
    if (!body) return;

    // Anchor = the stats grid. We insert the tab strip after it.
    const stats = body.querySelector('.dash-stats');
    if (!stats) return;

    // Also hide the "At a glance" section head — the stats grid speaks for itself.
    const atGlance = findHeadByText(body, 'At a glance');
    if (atGlance) atGlance.style.display = 'none';

    // Build tab strip
    const strip = document.createElement('div');
    strip.className = 'dash-tabs';
    strip.setAttribute('role', 'tablist');
    strip.setAttribute('aria-label', 'Dashboard sections');
    strip.innerHTML = TABS.map(
      (t) =>
        `<button type="button" role="tab" data-tab="${t.id}" aria-selected="${
          t.id === active ? 'true' : 'false'
        }" class="${t.id === active ? 'active' : ''}">${t.label}</button>`
    ).join('');
    stats.insertAdjacentElement('afterend', strip);

    // Wrap each section's nodes in a panel div
    const panelsHost = document.createElement('div');
    panelsHost.className = 'dash-tab-panels';
    stats.insertAdjacentElement('afterend', panelsHost);
    // panelsHost is now between stats and strip; fix order: strip first, then panels.
    strip.parentNode.insertBefore(strip, panelsHost);

    for (const t of TABS) {
      const panel = document.createElement('div');
      panel.className = 'dash-tab-panel';
      panel.setAttribute('role', 'tabpanel');
      panel.dataset.tab = t.id;
      panel.hidden = t.id !== active;
      for (const headText of t.heads) {
        const head = findHeadByText(body, headText);
        if (!head) continue;
        const nodes = collectSection(head);
        for (const n of nodes) panel.appendChild(n);
      }
      panelsHost.appendChild(panel);
    }

    // Wire tab clicks
    strip.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      const id = btn.dataset.tab;
      if (id === active) return;
      active = id;
      sessionStorage.setItem('scout-dash-tab', id);
      strip.querySelectorAll('button[data-tab]').forEach((b) => {
        const on = b.dataset.tab === id;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      panelsHost.querySelectorAll('.dash-tab-panel').forEach((p) => {
        p.hidden = p.dataset.tab !== id;
      });
    });

    // Keyboard nav (arrow keys between tabs)
    strip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const buttons = Array.from(strip.querySelectorAll('button[data-tab]'));
      const idx = buttons.findIndex((b) => b.dataset.tab === active);
      if (idx < 0) return;
      const next = e.key === 'ArrowRight' ? (idx + 1) % buttons.length : (idx - 1 + buttons.length) % buttons.length;
      buttons[next].click();
      buttons[next].focus();
      e.preventDefault();
    });

    installed = true;
  }

  // Install when dashboard becomes visible. The dashboard view is rendered
  // on initial load, so try once on DOMContentLoaded and again on view changes.
  function tryInstall() {
    const view = document.getElementById('view-dashboard');
    if (view && !view.hidden && view.querySelector('.dash-stats')) install();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInstall);
  } else {
    tryInstall();
  }

  // Re-run when nav changes (app.js toggles view hidden state)
  const navObs = new MutationObserver(tryInstall);
  const v = document.getElementById('view-dashboard');
  if (v) navObs.observe(v, { attributes: true, attributeFilter: ['hidden'] });
})();
