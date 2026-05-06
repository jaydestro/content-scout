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
  let lastBulks = [];
  let activeBulkId = null;
  // Track previously-seen status per run id so we can detect transitions
  // (running → success/error) and surface a toast notification on completion.
  const knownStatus = new Map();
  // Track previously-seen bulk status so we toast exactly once when the
  // whole batch finishes. Per-child completions are intentionally silent
  // because they're sub-operations of the parent bulk.
  const knownBulkStatus = new Map();
  let firstPoll = true;

  function isTerminalStatus(s) {
    if (!s) return false;
    if (s === 'running') return false;
    return true; // success, error, exited *, killed, etc.
  }
  function isSuccessStatus(s) {
    if (s === 'success') return true;
    if (typeof s === 'string' && s.startsWith('exited 0')) return true;
    return false;
  }

  function build() {
    if (launcher) return;

    launcher = document.createElement('button');
    launcher.id = 'runs-launcher';
    launcher.type = 'button';
    launcher.title = 'Show operations queue';
    launcher.setAttribute('aria-label', 'Show operations queue');
    launcher.innerHTML = `${ICONS.queue}<span class="rq-launcher-label">Operations</span><span class="rq-badge" id="runs-badge" hidden>0</span>`;
    launcher.addEventListener('click', toggleDrawer);
    document.body.appendChild(launcher);
    badge = launcher.querySelector('#runs-badge');

    drawer = document.createElement('aside');
    drawer.id = 'runs-drawer';
    drawer.setAttribute('aria-label', 'Operations queue');
    drawer.innerHTML = `
      <header class="rq-header">
        <div class="rq-title">
          ${ICONS.queue}
          <span>Operations</span>
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
      const bulks = (data && Array.isArray(data.bulks)) ? data.bulks : [];
      // Detect run completions: previously "running" or unknown → now terminal.
      // Skip on the very first poll so we don't toast for runs that were
      // already finished before the page loaded. Also skip child runs that
      // belong to a bulk — the bulk itself owns the completion notification.
      if (!firstPoll) {
        for (const r of list) {
          if (!r || !r.id) continue;
          const prev = knownStatus.get(r.id);
          if (prev === 'running' && isTerminalStatus(r.status) && !r.bulkId) {
            notifyRunFinished(r);
          }
        }
        // Bulk completion toast — fires once per bulk when it transitions
        // from running → terminal. Replaces the per-child toasts that
        // would otherwise spam the user during a parallel batch.
        for (const b of bulks) {
          if (!b || !b.bulkId) continue;
          const prev = knownBulkStatus.get(b.bulkId);
          if ((prev === 'running' || prev === undefined && b.done < b.total)
              && b.status !== 'running'
              && b.done >= b.total) {
            notifyBulkFinished(b);
          }
        }
      }
      // Update tracking maps (and prune ids no longer present).
      const seen = new Set();
      for (const r of list) {
        if (r && r.id) {
          knownStatus.set(r.id, r.status);
          seen.add(r.id);
        }
      }
      for (const id of [...knownStatus.keys()]) {
        if (!seen.has(id)) knownStatus.delete(id);
      }
      const seenBulks = new Set();
      for (const b of bulks) {
        if (b && b.bulkId) {
          knownBulkStatus.set(b.bulkId, b.status);
          seenBulks.add(b.bulkId);
        }
      }
      for (const id of [...knownBulkStatus.keys()]) {
        if (!seenBulks.has(id)) knownBulkStatus.delete(id);
      }
      firstPoll = false;

      lastSnapshot = list;
      lastBulks = bulks;
      // Badge counts an in-flight bulk as ONE operation, not N children.
      const activeBulkChildIds = new Set();
      for (const b of bulks) {
        if (b.status === 'running') {
          for (const r of list) {
            if (r.bulkId === b.bulkId) activeBulkChildIds.add(r.id);
          }
        }
      }
      const runningSolo = list.filter((r) => r.status === 'running' && !activeBulkChildIds.has(r.id)).length;
      const runningBulks = bulks.filter((b) => b.status === 'running').length;
      updateBadge(runningSolo + runningBulks);
      if (drawer.classList.contains('open') && !activeRunId && !activeBulkId) renderList();
      if (drawer.classList.contains('open') && activeBulkId) renderBulkDetail();
    } catch {
      // Silent — server may be restarting.
    }
  }

  function notifyRunFinished(run) {
    const cmd = shortCommand(run.command);
    const ok = isSuccessStatus(run.status);
    const title = ok ? `Run finished: ${cmd}` : `Run failed: ${cmd}`;
    const desc = ok
      ? 'Click the Runs button to see the output.'
      : `Status: ${run.status || 'error'} — click Runs to see details.`;
    if (window.toast) {
      const fn = ok ? window.toast.success : window.toast.error;
      try {
        fn(title, desc, { duration: ok ? 6000 : 9000 });
      } catch {
        // Fallback to plain toast.
        window.toast({ title, description: desc, type: ok ? 'success' : 'error' });
      }
    }
    // Try the browser Notification API too if the user granted permission.
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification(title, { body: desc, silent: true }); } catch { /* ignore */ }
    }
  }

  function notifyBulkFinished(bulk) {
    const cmd = bulk.command ? `/${bulk.command}` : 'bulk run';
    const ok = bulk.status === 'success';
    const title = ok
      ? `Bulk ${cmd} finished — ${bulk.done}/${bulk.total} succeeded`
      : `Bulk ${cmd} done — ${bulk.done - bulk.failed}/${bulk.total} succeeded, ${bulk.failed} failed`;
    const desc = bulk.summaryFile
      ? `Summary: ${bulk.summaryFile}`
      : 'All sub-operations completed.';
    if (window.toast) {
      const fn = ok ? window.toast.success : window.toast.warn;
      try { fn(title, desc, { duration: 9000 }); }
      catch { window.toast({ title, description: desc, type: ok ? 'success' : 'warn' }); }
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification(title, { body: desc, silent: true }); } catch { /* ignore */ }
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
    // Build a unified list: each bulk is one parent row; standalone runs
    // (no bulkId) are individual rows. Child runs of a bulk are NOT
    // rendered here — they live inside the bulk's detail view so the
    // queue stays uncluttered during parallel batches.
    const bulkMap = new Map(lastBulks.map((b) => [b.bulkId, b]));
    const childIds = new Set();
    for (const r of lastSnapshot) {
      if (r.bulkId && bulkMap.has(r.bulkId)) childIds.add(r.id);
    }
    const standalone = lastSnapshot.filter((r) => !childIds.has(r.id));
    const merged = [
      ...lastBulks.map((b) => ({ kind: 'bulk', startedAt: b.startedAt, bulk: b })),
      ...standalone.map((r) => ({ kind: 'run', startedAt: r.startedAt, run: r })),
    ].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));

    document.getElementById('rq-count').textContent = merged.length;
    if (merged.length === 0) {
      listEl.innerHTML = `<li class="rq-empty">No runs yet. Start one from the Run view.</li>`;
      return;
    }
    listEl.innerHTML = merged.map((entry) => {
      if (entry.kind === 'bulk') {
        const b = entry.bulk;
        const m = statusMeta(b.status);
        const cmd = escapeHtml(`/${b.command} (bulk)`);
        const when = relativeTime(b.startedAt);
        const sub = `${b.done}/${b.total} done${b.failed ? ` · ${b.failed} failed` : ''}${b.running ? ` · ${b.running} running` : ''} · ×${b.concurrency}`;
        return `
          <li class="rq-item ${m.cls}" data-bulk-id="${escapeHtml(b.bulkId)}">
            <span class="rq-status" aria-label="${m.label}">${m.icon}</span>
            <div class="rq-item-body">
              <div class="rq-item-cmd">${cmd}</div>
              <div class="rq-item-sub"><span class="rq-status-label">${m.label}</span> · ${sub} · ${when}</div>
            </div>
            <span class="rq-chev">${ICONS.chevron}</span>
          </li>
        `;
      }
      const r = entry.run;
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
    listEl.querySelectorAll('.rq-item[data-id]').forEach((el) => {
      el.addEventListener('click', () => attachToRun(el.dataset.id));
    });
    listEl.querySelectorAll('.rq-item[data-bulk-id]').forEach((el) => {
      el.addEventListener('click', () => openBulkDetail(el.dataset.bulkId));
    });
  }

  function openBulkDetail(bulkId) {
    activeBulkId = bulkId;
    activeRunId = null;
    detachStream();
    listEl.hidden = true;
    detailEl.hidden = false;
    renderBulkDetail();
  }

  function renderBulkDetail() {
    if (!activeBulkId) return;
    const b = lastBulks.find((x) => x.bulkId === activeBulkId);
    if (!b) { backToList(); return; }
    const m = statusMeta(b.status);
    const stopBtn = document.getElementById('rq-stop');
    stopBtn.hidden = b.status !== 'running';
    stopBtn.dataset.kind = 'bulk';
    document.getElementById('rq-detail-meta').innerHTML = `
      <div class="rq-detail-cmd">/${escapeHtml(b.command)} (bulk · ×${b.concurrency})</div>
      <div class="rq-detail-sub">
        <span class="rq-status-label ${m.cls}">${m.label}</span>
        · ${b.done}/${b.total} done${b.failed ? ` · ${b.failed} failed` : ''}${b.running ? ` · ${b.running} running` : ''}
        · started ${relativeTime(b.startedAt)}
      </div>
    `;
    const out = document.getElementById('rq-output');
    const children = lastSnapshot.filter((r) => r.bulkId === activeBulkId)
      .sort((a, b2) => (a.startedAt || '').localeCompare(b2.startedAt || ''));
    const summaryLink = b.summaryFile
      ? `\nSummary: ${b.summaryFile}\n`
      : (b.status === 'running' ? '\n(Summary will be written when all sub-operations finish.)\n' : '');
    const lines = children.map((r, i) => {
      const sm = statusMeta(r.status);
      const label = r.bulkLabel || r.id;
      return `${String(i + 1).padStart(2, ' ')}. [${sm.label.padEnd(7)}] ${label}`;
    });
    out.textContent = `Sub-operations (${children.length}/${b.total}):\n` + lines.join('\n') + '\n' + summaryLink;
    // Make children clickable to drill into their stream.
    out.classList.add('rq-bulk-children');
    out.onclick = (ev) => {
      const text = (ev.target.textContent || '');
      // crude: find the matching child by label/url substring
      const match = children.find((r) => text.includes(r.bulkLabel || ''));
      if (match) attachToRun(match.id);
    };
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
    activeBulkId = null;
    detachStream();
    listEl.hidden = true;
    detailEl.hidden = false;
    const out = document.getElementById('rq-output');
    if (out) { out.classList.remove('rq-bulk-children'); out.onclick = null; }

    const run = lastSnapshot.find((r) => r.id === id) || { id, status: 'running', command: '', startedAt: '' };
    const m = statusMeta(run.status);
    const stopBtn = document.getElementById('rq-stop');
    stopBtn.hidden = run.status !== 'running';

    document.getElementById('rq-detail-meta').innerHTML = `
      <div class="rq-detail-cmd">${escapeHtml(shortCommand(run.command))}</div>
      <div class="rq-detail-sub"><span class="rq-status-label ${m.cls}">${m.label}</span> · started ${relativeTime(run.startedAt)}</div>
    `;

    // Only stream live output for runs that are still in progress. Finished
    // runs show a brief status placeholder — their full transcript lives in
    // the Run view / report files, not in this sidebar.
    if (run.status !== 'running') {
      out.textContent = `[run ${m.label.toLowerCase()}]\nOpen the Run view or the saved report for the full transcript.\n`;
      return;
    }

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
    activeBulkId = null;
    const out = document.getElementById('rq-output');
    if (out) { out.classList.remove('rq-bulk-children'); out.onclick = null; }
    renderList();
  }

  async function stopActive() {
    // Stopping a bulk = stop every still-running child. Each child uses
    // the same /api/runs/:id/stop path, which on Windows tree-kills the
    // shell + agent grandchild and on POSIX escalates SIGINT→TERM→KILL.
    if (activeBulkId) {
      const children = lastSnapshot.filter((r) => r.bulkId === activeBulkId && r.status === 'running');
      try {
        await Promise.all(children.map((r) =>
          fetch(`/api/runs/${encodeURIComponent(r.id)}/stop`, { method: 'POST' })));
        window.toast && window.toast.info('Stop requested', `Stopping ${children.length} sub-operation${children.length === 1 ? '' : 's'} and cancelling the queue.`);
      } catch (e) {
        window.toast && window.toast.error('Could not stop bulk', String(e.message || e));
      }
      return;
    }
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
