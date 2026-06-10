// Core DOM + fetch helpers shared across the web UI front-end modules.
//
// Extracted verbatim from app.js so that page modules (pages/*.js) and app.js
// can import one foundation instead of each redeclaring these. app.js is loaded
// as type="module", so these were already module-scoped locals (never exposed
// on window); importing them here is behavior-preserving and changes no call
// sites.

// document.getElementById shorthand.
export const $ = (id) => document.getElementById(id);

// JSON fetch wrapper that throws on a non-2xx response. Uses the global fetch,
// which app.js patches with its /api GET coalescer at startup — calls made
// through here still go through that cache because the patch is installed
// before any of these run.
export const api = async (path, opts) => {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
};

// HTML escaping for text-node insertion via innerHTML.
export function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Like escape() but tolerant of null/undefined (renders ''); used in attribute
// contexts where a missing value should collapse to an empty string.
export function escapeAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
