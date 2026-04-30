/* Content Scout — Runs queue drawer
 * Additive overlay: polls /api/runs, shows a floating launcher with a live
 * count of running jobs, and a slide-out drawer that lets you re-attach to
 * any run via SSE and watch live output, even after navigating away from
 * the Run view. Does NOT touch app.js.
 */
(function () {
  const POLL_MS = 3000;

  const ICONS = {
    queue:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    close:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    play:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    stop:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
    check:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    warn:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  };

  const STATUS_META = {
    running: { label: 'Running', icon: ICONS.play,  cls: 'rq-running' },
    success: { label: 'Done',    icon: ICONS.check, cls: 'rq-success' },
    error:   { label: 'Error',   icon: ICONS.warn,  cls: 'rq-error' },
  };
  function statusMeta(status) {
    if (status === 'running') return STATUS_META.running;
    if (status === 'success') return STATUS_META.success;
    if (status && status.startsWith('exited 0')) return STATUS_META.success;
    return STATUS_META.error;
  }

  // --- DOM ----------------------------------------------------------
  let launcher, badge, drawer, listEl, detailEl;
  let activeStream = null;
  let activeRunId = null;
  let lastSnapshot = [];

  function build() {
    if (launcher) return;

    launcher = document.createElement('button');
    launcher.id = 'runs-launcher';
    launcher.type = 'button';
    launcher.title = 'Show run queue';
    launcher.setAttribute('aria-label', 'Show run queue');
    launcher.innerHTML = `${ICONS.queue}<span class="rq-launcher-label">Runs</span><span class="rq-badge" id="runs-badge" hidden>0</span>`;
    launcher.addEventListener('click', toggleDrawer);
    document.body.appendChild(launcher);
    badge = launcher.querySelector('#runs-badge');

    drawer = document.createElement('aside');
    drawer.id = 'runs-drawer';
    drawer.setAttribute('aria-label', 'Run queue');
    drawer.innerHTML = `
      <header class="rq-header">
        <div class="rq-title">
          ${ICONS.queue}
          <span>Runs</span>
          <span class="rq-count" id="rq-count">0</span>
        </div>
        <button class="rq-close" id="rq-close" aria-label="Close">${ICONS.close}</button>
      </header>
      <div class="rq-body">
        <ul class="rq-list" id="rq-list"></ul>
        <div class="rq-detail" id="rq-detail" hidden>
          <div class="rq-detail-head">
            <button class="rq-back" id="rq-back" aria-label="Back to list">${ICONS.chevron}<span>Back</span></button>
            <div class="rq-detail-meta" id="rq-detail-meta"></div>
            <button class="rq-stop" id="rq-stop" hidden>${ICONS.stop}<span>Stop</span></button>
          </div>
          <pre class="rq-output" id="rq-output"></pre>
        </div>
      </div>
    `;
    document.body.appendChild(drawer);

    drawer.querySelector('#rq-close').addEventListener('click', closeDrawer);
    drawer.querySelector('#rq-back').addEventListener('click', backToList);
    drawer.querySelector('#rq-stop').addEventListener('click', stopActive);

    listEl = drawer.querySelector('#rq-list');
    detailEl = drawer.querySelector('#rq-detail');
  }

  function toggleDrawer() {
    drawer.classList.contains('open') ? closeDrawer() : openDrawer();
  }
  function openDrawer() {
    drawer.classList.add('open');
    refresh(true);
  }
  function closeDrawer() {
    drawer.classList.remove('open');
    detachStream();
  }

  // --- Polling & rendering -----------------------------------------
  async function pollOnce() {
    try {
      const res = await fetch('/api/runs');
      if (!res.ok) return;
      const data = await res.json();
      const list = (data && Array.isArray(data.runs)) ? data.runs : [];
      lastSnapshot = list;
      const runningCount = list.filter((r) => r.status === 'running').length;
      updateBadge(runningCount);
      if (drawer.classList.contains('open') && !activeRunId) renderList();
    } catch {
      // Silent — server may be restarting.
    }
  }

  function updateBadge(n) {
    if (n > 0) {
      badge.hidden = false;
      badge.textContent = String(n);
      launcher.classList.add('has-running');
    } else {
      badge.hidden = true;
      launcher.classList.remove('has-running');
    }
  }

  async function refresh(force = false) {
    if (force) await pollOnce();
    if (!activeRunId) renderList();
  }

  function renderList() {
    detailEl.hidden = true;
    listEl.hidden = false;
    document.getElementById('rq-count').textContent = lastSnapshot.length;
    if (lastSnapshot.length === 0) {
      listEl.innerHTML = `<li class="rq-empty">No runs yet. Start one from the Run view.</li>`;
      return;
    }
    listEl.innerHTML = lastSnapshot.map((r) => {
      const m = statusMeta(r.status);
      const cmd = escapeHtml(shortCommand(r.command));
      const when = relativeTime(r.startedAt);
      return `
        <li class="rq-item ${m.cls}" data-id="${escapeHtml(r.id)}">
          <span class="rq-status" aria-label="${m.label}">${m.icon}</span>
          <div class="rq-item-body">
            <div class="rq-item-cmd">${cmd}</div>
            <div class="rq-item-sub"><span class="rq-status-label">${m.label}</span> · ${when}</div>
          </div>
          <span class="rq-chev">${ICONS.chevron}</span>
        </li>
      `;
    }).join('');
    listEl.querySelectorAll('.rq-item').forEach((el) => {
      el.addEventListener('click', () => attachToRun(el.dataset.id));
    });
  }

  function shortCommand(cmd) {
    if (!cmd) return '(unknown command)';
    // Try to surface the /scout-* slash-command from the prompt argument.
    const m = cmd.match(/\/scout-[a-z]+/);
    if (m) return m[0];
    return cmd.length > 80 ? cmd.slice(0, 77) + '…' : cmd;
  }

  function relativeTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    const diff = Math.max(0, Date.now() - then) / 1000;
    if (diff < 60) return `${Math.round(diff)}s ago`;
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
    return new Date(iso).toLocaleString();
  }

  // --- Detail / streaming -------------------------------------------
  async function attachToRun(id) {
    activeRunId = id;
    detachStream();
    listEl.hidden = true;
    detailEl.hidden = false;

    const run = lastSnapshot.find((r) => r.id === id) || { id, status: 'running', command: '', startedAt: '' };
    const m = statusMeta(run.status);
    const stopBtn = document.getElementById('rq-stop');
    stopBtn.hidden = run.status !== 'running';

    document.getElementById('rq-detail-meta').innerHTML = `
      <div class="rq-detail-cmd">${escapeHtml(shortCommand(run.command))}</div>
      <div class="rq-detail-sub"><span class="rq-status-label ${m.cls}">${m.label}</span> · started ${relativeTime(run.startedAt)}</div>
    `;

    const out = document.getElementById('rq-output');
    out.textContent = 'Connecting…\n';

    activeStream = new EventSource(`/api/runs/${encodeURIComponent(id)}/stream`);
    activeStream.onopen = () => { out.textContent = ''; };
    activeStream.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (typeof data.chunk === 'string') {
          out.textContent += data.chunk;
          out.scrollTop = out.scrollHeight;
        }
      } catch { /* ignore malformed */ }
    };
    activeStream.addEventListener('done', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        out.textContent += `\n[run ended: ${data.status}]\n`;
      } catch {
        out.textContent += `\n[run ended]\n`;
      }
      stopBtn.hidden = true;
      detachStream();
      // Refresh the list snapshot so re-opening shows the right status.
      pollOnce();
    });
    activeStream.onerror = () => {
      // Connection dropped — likely run finished. We'll fall back to polling.
      detachStream();
    };
  }

  function detachStream() {
    if (activeStream) {
      try { activeStream.close(); } catch {}
      activeStream = null;
    }
  }

  function backToList() {
    detachStream();
    activeRunId = null;
    renderList();
  }

  async function stopActive() {
    if (!activeRunId) return;
    try {
      await fetch(`/api/runs/${encodeURIComponent(activeRunId)}/stop`, { method: 'POST' });
      window.toast && window.toast.info('Stop requested', 'Sent SIGINT to the runner.');
    } catch (e) {
      window.toast && window.toast.error('Could not stop run', String(e.message || e));
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // --- Bootstrap ----------------------------------------------------
  function init() {
    build();
    pollOnce();
    setInterval(pollOnce, POLL_MS);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for the command palette and other scripts.
  window.runsQueue = { open: openDrawer, close: closeDrawer, refresh: () => pollOnce() };
})();
