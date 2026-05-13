// Shared utilities for the Content Scout web UI.
// Loaded as a classic script (no module) and exposed on window.scout.
// Existing IIFE modules can opt-in incrementally; nothing is replaced.
(function () {
  const win = window;
  const scout = (win.scout = win.scout || {});

  // DOM lookup
  scout.$ = (id) => document.getElementById(id);
  scout.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // HTML escape
  const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  scout.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ENT[c]);

  // fetch wrapper with auto-toast on error
  scout.api = async function api(path, opts) {
    let res;
    try {
      res = await fetch(path, opts);
    } catch (err) {
      const msg = `Network error: ${err && err.message ? err.message : err}`;
      if (win.toast && win.toast.error) win.toast.error(msg);
      throw err;
    }
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch (_) { /* ignore */ }
      const msg = `${res.status} ${res.statusText}${body ? ': ' + body.slice(0, 200) : ''}`;
      if (win.toast && win.toast.error) win.toast.error(msg);
      const err = new Error(msg);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  };

  // Focus trap helper. Returns a release() function.
  scout.trapFocus = function trapFocus(root) {
    if (!root) return () => {};
    const SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = () => Array.from(root.querySelectorAll(SEL)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    const previously = document.activeElement;
    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', onKey);
    // Auto-focus first focusable
    setTimeout(() => {
      const first = focusables()[0];
      if (first) first.focus();
    }, 0);
    return function release() {
      root.removeEventListener('keydown', onKey);
      if (previously && typeof previously.focus === 'function') {
        try { previously.focus(); } catch (_) { /* ignore */ }
      }
    };
  };

  // Escape key handler. Returns release().
  scout.onEscape = function onEscape(handler) {
    const fn = (e) => { if (e.key === 'Escape') handler(e); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  };

  // Format a relative time (e.g. "3m ago").
  scout.relTime = function relTime(ts) {
    const d = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!d || Number.isNaN(d)) return '';
    const sec = Math.round((Date.now() - d) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
    return `${Math.round(sec / 86400)}d ago`;
  };

  // Debounce
  scout.debounce = function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  };
})();
