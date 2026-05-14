/* Content Scout — Command palette (Ctrl/Cmd+K)
 * Loads in addition to app.js. Drives navigation by simulating clicks
 * on existing nav buttons, so it never depends on app.js internals.
 */
(function () {
  const I = (name, path) =>
    `<svg class="icon" data-name="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

  const ICONS = {
    search:  '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    home:    '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-5h-2v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    cog:     '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
    files:   '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    play:    '<polygon points="6 3 20 12 6 21 6 3"/>',
    report:  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    share:   '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/>',
    book:    '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    keyboard:'<rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><line x1="6" y1="8" x2="6" y2="8"/><line x1="10" y1="8" x2="10" y2="8"/><line x1="14" y1="8" x2="14" y2="8"/><line x1="18" y1="8" x2="18" y2="8"/><line x1="6" y1="12" x2="6" y2="12"/><line x1="10" y1="12" x2="10" y2="12"/><line x1="14" y1="12" x2="14" y2="12"/><line x1="18" y1="12" x2="18" y2="12"/><line x1="7" y1="16" x2="17" y2="16"/>',
  };

  // Inject icons into nav buttons (one-time decoration).
  function decorateNav() {
    const map = {
      dashboard: 'home',
      setup: 'cog',
      configs: 'files',
      run: 'play',
      reports: 'report',
      social: 'share',
    };
    document.querySelectorAll('.header-bar nav button[data-view]').forEach((btn) => {
      if (btn.querySelector('.icon')) return;
      const name = map[btn.dataset.view];
      if (!name) return;
      btn.insertAdjacentHTML('afterbegin', I(name, ICONS[name]));
    });
  }

  // Inject a compact "⌘K" chip as the last item INSIDE the nav pill, so the
  // nav row is the single, unified entry point. No competing search bar.
  function injectHint() {
    const nav = document.querySelector('.header-bar nav');
    if (!nav) return;
    if (document.getElementById('kbd-hint')) return;

    const isMac = /Mac|iPhone|iPad/i.test(navigator.platform);
    const modKey = isMac ? '⌘' : 'Ctrl';

    const hint = document.createElement('button');
    hint.id = 'kbd-hint';
    hint.className = 'kbd-hint nav-kbd';
    hint.type = 'button';
    hint.title = `Search & jump (${isMac ? '⌘K' : 'Ctrl+K'})`;
    hint.setAttribute('aria-label', 'Open command palette');
    hint.innerHTML = `
      ${I('search', ICONS.search)}
      <span class="kbd-hint-keys"><kbd>${modKey}</kbd><kbd>K</kbd></span>
    `;
    hint.addEventListener('click', open);

    // Append a separator + the chip as the last children of the nav.
    const sep = document.createElement('span');
    sep.className = 'nav-sep';
    sep.setAttribute('aria-hidden', 'true');
    nav.appendChild(sep);
    nav.appendChild(hint);
  }

  // --- Palette UI ---------------------------------------------------
  const COMMANDS = [
    { section: 'Actions',  label: 'Start a content scan', icon: 'play',   keywords: 'scout-scan scan run new report',    run: () => { navigate('run'); flash('#run-start'); } },
    { section: 'Actions',  label: 'Generate social post', icon: 'share',  keywords: 'scout-post post draft generate',    run: () => navigate('social') },
    { section: 'Actions',  label: 'Browse conversations', icon: 'share', keywords: 'conversations mentions sentiment reddit hn bluesky reply', run: () => navigate('conversations') },
    { section: 'Actions',  label: 'Needs-reply inbox',   icon: 'share',  keywords: 'needs reply inbox negative critical mixed', run: () => {
        navigate('conversations');
        setTimeout(() => {
          const cb = document.getElementById('conv-needs-reply');
          if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        }, 150);
      } },
    { section: 'Actions',  label: 'Show runs queue',     icon: 'play',    keywords: 'queue runs running jobs background', run: () => window.runsQueue && window.runsQueue.open() },
    { section: 'Actions',  label: 'Open most recent report', icon: 'report', keywords: 'latest recent report',           run: openLatestReport },
    { section: 'Actions',  label: 'Reload page',          icon: 'refresh',keywords: 'refresh reload',                    run: () => location.reload() },
    { section: 'Help',     label: 'Open README',          icon: 'book',   keywords: 'docs help readme',                  run: () => window.open('https://github.com/Azure-Samples/content-scout', '_blank') },
  ];

  let panel, input, list, footer;
  let filtered = [];
  let activeIdx = 0;

  function buildUI() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'command-palette';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Command palette');
    panel.innerHTML = `
      <div class="cp-panel" role="document">
        <div class="cp-input-wrap">
          ${I('search', ICONS.search)}
          <input id="cp-input" type="text" placeholder="Type a command or search…" autocomplete="off" spellcheck="false" />
          <span class="cp-hint">Esc</span>
        </div>
        <ul class="cp-list" id="cp-list" role="listbox"></ul>
        <div class="cp-footer">
          <span><span class="cp-hint">↑↓</span> navigate</span>
          <span><span class="cp-hint">↵</span> select</span>
          <span><span class="cp-hint">esc</span> close</span>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    input = panel.querySelector('#cp-input');
    list = panel.querySelector('#cp-list');
    footer = panel.querySelector('.cp-footer');

    panel.addEventListener('click', (e) => { if (e.target === panel) close(); });
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKey);
  }

  let _searchSeq = 0;
  let _searchTimer = null;
  let _liveResults = []; // dynamic commands from /api/search

  function onInput() {
    render();
    const q = (input.value || '').trim();
    if (_searchTimer) clearTimeout(_searchTimer);
    if (q.length < 2) {
      _liveResults = [];
      return;
    }
    _searchTimer = setTimeout(() => fetchLive(q), 140);
  }

  async function fetchLive(q) {
    const seq = ++_searchSeq;
    try {
      const r = await fetch('/api/search?q=' + encodeURIComponent(q));
      if (!r.ok) return;
      const data = await r.json();
      if (seq !== _searchSeq) return; // stale
      const out = [];
      (data.items || []).slice(0, 8).forEach((it) => {
        out.push({
          section: 'Items',
          label: it.title,
          sub: [it.author, it.source, it.ep != null ? 'EP ' + it.ep : '', it.kind]
            .filter(Boolean)
            .join(' · '),
          icon: it.kind === 'video' ? 'play' : it.kind === 'blog' ? 'book' : 'report',
          run: () => {
            if (it.url) window.open(it.url, '_blank');
          },
        });
      });
      (data.conversations || []).slice(0, 5).forEach((c) => {
        out.push({
          section: 'Conversations',
          label: c.summary || c.author || '(conversation)',
          sub: [c.author, c.platform, c.sentiment, c.date].filter(Boolean).join(' · '),
          icon: 'share',
          run: () => {
            if (c.url) window.open(c.url, '_blank');
            else navigate('conversations');
          },
        });
      });
      (data.authors || []).slice(0, 4).forEach((a) => {
        out.push({
          section: 'Authors',
          label: a.name,
          sub: `${a.items} items · ${a.conversations} conversations · last ${a.lastSeen || 'n/a'}`,
          icon: 'home',
          run: () => {
            navigate('conversations');
            setTimeout(() => {
              const ai = document.getElementById('conv-q');
              if (ai) {
                ai.value = a.name;
                ai.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }, 200);
          },
        });
      });
      (data.reports || []).slice(0, 4).forEach((rep) => {
        out.push({
          section: 'Reports',
          label: rep.name,
          sub: `${rep.itemCount || 0} items · ${rep.convoCount || 0} conversations`,
          icon: 'report',
          run: () => {
            navigate('reports');
            setTimeout(() => {
              document
                .querySelectorAll('#reports-list li')
                .forEach((el) => {
                  if (el.textContent.includes(rep.name)) el.click();
                });
            }, 200);
          },
        });
      });
      // File-content matches from reports/*.md and social-posts/*.md
      // (full-text grep — surfaces hits inside item bodies, social drafts,
      // posting calendars, etc.). Up to 8 files; first snippet shown inline.
      (data.files || []).slice(0, 8).forEach((f) => {
        const firstSnippet = (f.snippets && f.snippets[0]) || null;
        const subParts = [
          f.kind,
          `${f.hits} hit${f.hits === 1 ? '' : 's'}`,
          firstSnippet ? `L${firstSnippet.line}: ${firstSnippet.text}` : '',
        ].filter(Boolean);
        out.push({
          section: 'In files',
          label: f.name,
          sub: subParts.join(' · '),
          icon: f.kind === 'reports' ? 'report' : 'share',
          run: () => {
            if (f.kind === 'reports') {
              navigate('reports');
              setTimeout(() => {
                document
                  .querySelectorAll('#reports-list li')
                  .forEach((el) => {
                    if (el.textContent.includes(f.name)) el.click();
                  });
              }, 200);
            } else {
              navigate('social');
              setTimeout(() => {
                document
                  .querySelectorAll('#social-list li')
                  .forEach((el) => {
                    if (el.textContent.includes(f.name)) el.click();
                  });
              }, 200);
            }
          },
        });
      });
      _liveResults = out;
      render(true);
    } catch {
      /* ignore */
    }
  }

  function render(_isLiveUpdate) {
    const q = (input.value || '').trim().toLowerCase();
    const staticCmds = !q
      ? COMMANDS.slice()
      : COMMANDS
          .map((c) => ({ c, score: scoreMatch(q, c) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.c);
    filtered = q.length >= 2 ? [..._liveResults, ...staticCmds] : staticCmds;

    activeIdx = 0;
    if (filtered.length === 0) {
      list.innerHTML = `<li class="cp-empty">No matches for "${escapeHtml(q)}"</li>`;
      return;
    }

    let html = '';
    let lastSection = '';
    filtered.forEach((cmd, i) => {
      if (cmd.section !== lastSection) {
        html += `<li class="cp-section-title">${cmd.section}</li>`;
        lastSection = cmd.section;
      }
      html += `<li class="cp-item${i === 0 ? ' active' : ''}" data-idx="${i}" role="option">
        ${I(cmd.icon, ICONS[cmd.icon] || ICONS.search)}
        <span class="cp-label">${escapeHtml(cmd.label)}${
          cmd.sub ? `<span class="cp-sub">${escapeHtml(cmd.sub)}</span>` : ''
        }</span>
      </li>`;
    });
    list.innerHTML = html;

    list.querySelectorAll('.cp-item').forEach((el) => {
      el.addEventListener('mouseenter', () => setActive(Number(el.dataset.idx)));
      el.addEventListener('click', () => execute(Number(el.dataset.idx)));
    });
  }

  function scoreMatch(q, cmd) {
    const hay = (cmd.label + ' ' + (cmd.keywords || '')).toLowerCase();
    if (hay.includes(q)) return 100 + (cmd.label.toLowerCase().startsWith(q) ? 20 : 0);
    // Fuzzy: every char of q must appear in order in hay.
    let i = 0, j = 0, hits = 0;
    while (i < q.length && j < hay.length) {
      if (q[i] === hay[j]) { hits++; i++; }
      j++;
    }
    return i === q.length ? hits : 0;
  }

  function setActive(i) {
    activeIdx = Math.max(0, Math.min(filtered.length - 1, i));
    list.querySelectorAll('.cp-item').forEach((el) => {
      const isActive = Number(el.dataset.idx) === activeIdx;
      el.classList.toggle('active', isActive);
      if (isActive) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(activeIdx - 1); return; }
    if (e.key === 'Enter')     { e.preventDefault(); execute(activeIdx); return; }
  }

  function execute(i) {
    const cmd = filtered[i];
    if (!cmd) return;
    close();
    try { cmd.run(); }
    catch (err) {
      console.error(err);
      if (window.toast) window.toast.error('Command failed', String(err.message || err));
    }
  }

  function open() {
    buildUI();
    panel.classList.add('open');
    input.value = '';
    render();
    setTimeout(() => input.focus(), 0);
  }
  function close() {
    if (!panel) return;
    panel.classList.remove('open');
  }
  function isOpen() { return panel && panel.classList.contains('open'); }

  // --- Helpers ------------------------------------------------------
  function navigate(view) {
    const btn = document.querySelector(`.header-bar nav button[data-view="${view}"]`);
    if (btn) btn.click();
  }
  function flash(selector) {
    const el = document.querySelector(selector);
    if (!el) return;
    el.style.transition = 'box-shadow 0.4s ease';
    el.style.boxShadow = '0 0 0 4px rgba(129,140,248,0.45)';
    setTimeout(() => { el.style.boxShadow = ''; }, 700);
  }
  async function openLatestReport() {
    try {
      const r = await fetch('/api/reports');
      if (!r.ok) throw new Error('No reports');
      const data = await r.json();
      const reports = (data && data.reports) || [];
      if (!reports.length) {
        window.toast && window.toast.warn('No reports yet', 'Run a scan first.');
        return;
      }
      // /api/reports already returns mtime-desc ordering — pick the freshest by mtime.
      const latest = reports.slice().sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))[0];
      navigate('reports');
      // After the reports list renders, click the matching <li>.
      const tryClick = (attempt = 0) => {
        const li = document.querySelector(`#reports-list li[data-name="${CSS.escape(latest.name)}"]`);
        if (li) {
          document.querySelectorAll('#reports-list li').forEach((x) => x.classList.remove('selected'));
          li.classList.add('selected');
          li.click();
          li.scrollIntoView({ block: 'nearest' });
        } else if (attempt < 8) {
          setTimeout(() => tryClick(attempt + 1), 120);
        }
      };
      setTimeout(() => tryClick(0), 120);
    } catch (e) {
      window.toast && window.toast.error('Could not load reports', String(e.message || e));
    }
  }
  // Expose so other UI can reuse (dashboard "Open latest report" button).
  window.contentScoutOpenLatestReport = openLatestReport;
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // --- Global hotkey ------------------------------------------------
  document.addEventListener('keydown', (e) => {
    const isMod = e.ctrlKey || e.metaKey;
    if (isMod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      isOpen() ? close() : open();
    }
  });

  // --- Vim-style "g X" jump shortcuts -------------------------------
  // g d → dashboard, g r → reports, g c → conversations, g s → social,
  // g u → run, g f → setup. Ignored when typing in inputs/textareas.
  let _gPending = 0;
  const GO_MAP = {
    d: 'dashboard',
    r: 'reports',
    c: 'conversations',
    s: 'social',
    u: 'run',
    f: 'setup',
    o: 'configs',
  };
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
    const now = Date.now();
    if (e.key === 'g' || e.key === 'G') {
      _gPending = now;
      return;
    }
    if (_gPending && now - _gPending < 1200) {
      const target = GO_MAP[e.key.toLowerCase()];
      _gPending = 0;
      if (target) {
        e.preventDefault();
        navigate(target);
      }
    }
    if (e.key === '/' && !isOpen()) {
      e.preventDefault();
      open();
    }
  });

  // Bootstrap once DOM is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { decorateNav(); injectHint(); });
  } else {
    decorateNav(); injectHint();
  }

  // Expose for debugging / programmatic use.
  window.commandPalette = { open, close };
})();
