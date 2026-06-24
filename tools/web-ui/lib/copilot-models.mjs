// Live Copilot model discovery via the CLI's Agent Client Protocol (ACP).
//
// The standalone `copilot` CLI has no offline "list models" command, but its
// ACP server mode (`copilot --acp`) advertises the account/plan-specific model
// list in the `session/new` result (`result.models.availableModels`). We do a
// minimal JSON-RPC handshake over stdio, read that list, and shut the process
// down. This lets the web UI picker inherit the exact models the coding agent
// can use, instead of a hand-maintained guess.
//
// Results are cached briefly and any failure (CLI missing, not logged in,
// timeout) resolves to null so callers can fall back to a static list.

import { spawn } from 'node:child_process';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const HANDSHAKE_TIMEOUT_MS = 20000; // session/new can take ~10s (agent loads skills/MCP/env)

let cache = { ts: 0, data: null };
let inFlight = null;

// Map an ACP availableModels[] entry to the picker's suggestion shape.
function toSuggestion(m) {
  const id = m.modelId;
  if (!id) return null;
  const label = m.name || id;
  let reasoning = m.description && m.description !== label ? m.description : '';
  const meta = m._meta || {};
  if (id === 'auto') {
    reasoning = m.description || 'Let Copilot pick the best model';
  } else if (meta.copilotUsage || meta.copilotPriceCategory) {
    const parts = [];
    if (meta.copilotUsage) parts.push(`${meta.copilotUsage} requests`);
    if (meta.copilotPriceCategory) parts.push(`${meta.copilotPriceCategory} cost`);
    reasoning = parts.join(' · ');
  }
  const out = { id, label };
  if (reasoning) out.reasoning = reasoning;
  return out;
}

// Run the ACP handshake once and resolve the mapped suggestion list (or null).
function fetchViaAcp() {
  return new Promise((resolve) => {
    let child;
    try {
      // Static args only — no user input — so shell:true is safe here and lets
      // the platform resolve the `copilot` shim (e.g. WinGet .cmd on Windows).
      child = spawn('copilot', ['--acp'], { stdio: ['pipe', 'pipe', 'ignore'], shell: true });
    } catch {
      resolve(null);
      return;
    }

    let buf = '';
    let sessionSent = false;
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), HANDSHAKE_TIMEOUT_MS);

    child.on('error', () => finish(null));

    child.stdout.on('data', (d) => {
      buf += d.toString();
      // Kick off session/new once the agent has finished initializing.
      if (!sessionSent && buf.includes('agentInfo')) {
        sessionSent = true;
        const sessionNew = {
          jsonrpc: '2.0', id: 2, method: 'session/new',
          params: { cwd: process.cwd().replace(/\\/g, '/'), mcpServers: [] },
        };
        try { child.stdin.write(JSON.stringify(sessionNew) + '\n'); } catch { /* ignore */ }
      }
      // Parse complete newline-delimited JSON messages; look for the
      // session/new result (id 2) carrying models.availableModels.
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const models = msg?.result?.models?.availableModels;
        if (Array.isArray(models)) {
          const suggestions = models
            .filter((m) => !m._meta || m._meta.copilotEnablement !== 'disabled')
            .map(toSuggestion)
            .filter(Boolean);
          finish(suggestions.length ? suggestions : null);
          return;
        }
      }
    });

    const init = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
    };
    try { child.stdin.write(JSON.stringify(init) + '\n'); } catch { finish(null); }
  });
}

// Public: cached live Copilot model suggestions, or null if not (yet) known.
//
// This never blocks the caller. If the cache is fresh it returns immediately;
// otherwise it kicks off a background ACP handshake and returns the current
// (possibly stale or null) value. Callers fall back to a static list when this
// is null. Call warmCopilotModels() at startup so the first real request is hot.
export function getCopilotModels() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL_MS) return cache.data;
  if (!inFlight) {
    inFlight = fetchViaAcp()
      .then((data) => {
        if (data) cache = { ts: Date.now(), data };
        return data;
      })
      .finally(() => { inFlight = null; });
  }
  return cache.data; // stale or null while the refresh runs
}

// Kick off (and await) a cache warm. Safe to call fire-and-forget at startup.
export function warmCopilotModels() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL_MS) return Promise.resolve(cache.data);
  if (!inFlight) {
    inFlight = fetchViaAcp()
      .then((data) => {
        if (data) cache = { ts: Date.now(), data };
        return data;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}
