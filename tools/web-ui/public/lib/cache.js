// Short-lived /api GET coalescing for the browser UI.

const TTL_MS = 4000;
const inflight = new Map();
const cache = new Map();
const origFetch = window.fetch.bind(window);

function cacheable(url, method) {
  if (method !== 'GET') return false;
  if (!url.startsWith('/api/')) return false;
  if (url.includes('/stream')) return false;
  if (url.startsWith('/api/runs/') && /\/(stream|output)$/.test(url)) return false;
  return true;
}

window.fetch = function fetchWithApiCache(input, init) {
  if (init && init.signal) return origFetch(input, init);
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const method = String(
    (init && init.method) ||
    (typeof input !== 'string' && input && input.method) ||
    'GET'
  ).toUpperCase();
  if (!cacheable(url, method)) return origFetch(input, init);
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && now - hit.at < TTL_MS) {
    return Promise.resolve(
      new Response(hit.body, { status: hit.status, headers: { 'content-type': hit.ct } })
    );
  }
  if (inflight.has(url)) {
    return inflight.get(url).then((r) => r.clone());
  }
  const promise = origFetch(input, init)
    .then(async (response) => {
      try {
        if (response.ok) {
          const text = await response.clone().text();
          cache.set(url, {
            at: Date.now(),
            body: text,
            status: response.status,
            ct: response.headers.get('content-type') || 'application/json',
          });
        }
      } catch { /* ignore caching errors */ }
      inflight.delete(url);
      return response;
    })
    .catch((error) => {
      inflight.delete(url);
      throw error;
    });
  inflight.set(url, promise);
  return promise.then((response) => response.clone());
};

window.__apiCacheBust = (prefix) => {
  for (const key of cache.keys()) {
    if (!prefix || key.startsWith(prefix)) cache.delete(key);
  }
};
