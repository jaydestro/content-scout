// Theme toggle — light/dark. Persisted to localStorage as `scout-theme`.
// Initial theme is applied inline in <head> to avoid FOUC; this script
// only wires the header button and keeps it in sync.
(function () {
  const root = document.documentElement;
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const labelEl = btn.querySelector('.theme-toggle-label');

  function render(theme) {
    // Icons (sun + moon SVG) live in the DOM; CSS toggles which is visible.
    // Label describes the *action* the click will take (the destination
    // theme), not the current state — clearer than just "Dark"/"Light"
    // which users read as a status indicator.
    const next = theme === 'light' ? 'dark' : 'light';
    const nextLabel = next === 'light' ? 'Light mode' : 'Dark mode';
    if (labelEl) labelEl.textContent = nextLabel;
    btn.setAttribute('aria-label', `Switch to ${nextLabel.toLowerCase()}`);
    btn.setAttribute('title', `Switch to ${nextLabel.toLowerCase()}`);
    btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
  }

  render(root.getAttribute('data-theme') || 'dark');

  btn.addEventListener('click', () => {
    const current = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('scout-theme', next); } catch {}
    render(next);
  });

  // Follow OS changes only if user has not explicitly chosen.
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener?.('change', (e) => {
      try {
        if (localStorage.getItem('scout-theme')) return; // explicit choice — leave it
      } catch {}
      const next = e.matches ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      render(next);
    });
  }
})();
