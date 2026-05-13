// Auto-wire focus trap + Escape close for dialogs and modal-like containers.
// Targets:
//   * Native <dialog open> elements
//   * Anything with [role="dialog"] or .modal that is currently visible
// Lightweight, no framework deps. Skips if scout.trapFocus is missing.
(function () {
  const win = window;
  if (!win.scout || !win.scout.trapFocus) return;

  const tracked = new WeakMap();

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function attach(el) {
    if (tracked.has(el)) return;
    const release = win.scout.trapFocus(el);
    const offEsc = win.scout.onEscape(() => close(el));
    tracked.set(el, () => { release(); offEsc(); });
  }

  function detach(el) {
    const fn = tracked.get(el);
    if (fn) { fn(); tracked.delete(el); }
  }

  function close(el) {
    if (typeof el.close === 'function') {
      try { el.close(); return; } catch (_) { /* ignore */ }
    }
    // Fall back to common patterns: aria-hidden, .open class, or hide
    if (el.hasAttribute('open')) el.removeAttribute('open');
    el.classList.remove('open', 'is-open', 'show', 'visible');
    el.setAttribute('aria-hidden', 'true');
    // Allow custom close handlers
    el.dispatchEvent(new CustomEvent('scout:close', { bubbles: true }));
  }

  function scan() {
    const candidates = document.querySelectorAll('dialog[open], [role="dialog"], .modal, .scout-modal');
    candidates.forEach((el) => {
      if (isVisible(el)) attach(el);
      else detach(el);
    });
  }

  // Initial pass + observe for dynamic dialogs
  scan();
  const mo = new MutationObserver(() => scan());
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['open', 'aria-hidden', 'class', 'style'],
  });
})();
