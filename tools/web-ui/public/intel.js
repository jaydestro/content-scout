/* Content Scout — Intelligence layer
 * - Conversations view (filter, sentiment, needs-reply inbox)
 * - Dashboard cards: Sentiment pulse, Top creators, Source health
 * Backed by /api/conversations, /api/authors, /api/source-health, /api/sentiment-summary.
 */
(function () {
  const SENTIMENT_DOT = {
    positive: '🟢',
    neutral: '⚪',
    mixed: '🟡',
    negative: '🔴',
    unknown: '·',
  };

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    }[c]));

  // ============================================================
  // Conversations view
  // ============================================================
  let _allConvs = [];
  let _platforms = new Set();
  // Keys of conversations the user has checkbox-selected. Cleared on each
  // re-render so it tracks the currently visible set.
  let _selectedKeys = new Set();
  // Currently chosen `include` mode for /api/conversations.
  function _currentInclude() {
    return document.getElementById('conv-show')?.value || 'open';
  }

  const REASON_LABELS = {
    'not-relevant': 'Not relevant',
    'contacted': 'Contacted',
    'follow-up-pm': 'Follow up with PM',
    'spam': 'Spam / job post',
    'duplicate': 'Duplicate',
    'other': 'Other',
  };

  async function loadConversations() {
    const list = document.getElementById('conv-list');
    if (!list) return;
    try {
      const include = _currentInclude();
      const data = await fetch('/api/conversations?include=' + encodeURIComponent(include)).then((r) => r.json());
      _allConvs = Array.isArray(data.conversations) ? data.conversations : [];
      _platforms = new Set(_allConvs.map((c) => c.platform).filter(Boolean));
      _selectedKeys = new Set();
      const sel = document.getElementById('conv-platform');
      if (sel) {
        const cur = sel.value;
        sel.innerHTML =
          '<option value="">All platforms</option>' +
          [..._platforms]
            .sort()
            .map((p) => `<option value="${esc(p)}">${esc(p)}</option>`)
            .join('');
        if (cur) sel.value = cur;
      }
      renderConversations();
    } catch (err) {
      list.innerHTML = `<p class="hint">Failed to load conversations: ${esc(err.message || err)}</p>`;
    }
  }

  // Default visible window: most recent 14 days. Anything older is bucketed
  // by ISO week (Mon-anchored) into collapsible <details> dropdowns. When
  // the user types a search query (conv-q), the date window is dropped so
  // the search hits the full archive — that's what "searchable if needed"
  // means here.
  const RECENT_WINDOW_DAYS = 14;
  // Persist which weekly buckets the user expanded across re-renders.
  const _expandedWeeks = new Set();

  function _parseDate(d) {
    if (!d) return null;
    const t = Date.parse(d);
    return Number.isFinite(t) ? new Date(t) : null;
  }

  // ISO week-of-year key like "2026-W18". Mon-anchored.
  function _isoWeekKey(d) {
    const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = dt.getUTCDay() || 7;
    dt.setUTCDate(dt.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
    return `${dt.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }

  // "Mon Apr 20 – Sun Apr 26, 2026" style label for a week-key bucket.
  function _weekLabel(d) {
    const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = dt.getUTCDay() || 7;
    const monday = new Date(dt);
    monday.setUTCDate(dt.getUTCDate() - (day - 1));
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    const fmt = (x) =>
      x.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return `${fmt(monday)} – ${fmt(sunday)}, ${sunday.getUTCFullYear()}`;
  }

  // Heuristic: does a conversation row look like a recruiter / job-search
  // post? Mirrors the patterns in tools/browser-scan/lib/hiring-filter.mjs
  // so the UI filter behaves consistently with the scan-time hard ban.
  // Stylized Unicode letters (e.g. 𝗮𝗿𝗮𝗧) are folded via NFKD before matching.
  const _HIRING_PHRASES = [
    'hiring', '[hiring]', "we're hiring", 'we are hiring', 'now hiring',
    'is hiring', 'looking to hire', 'apply now', 'open position', 'open positions',
    'open role', 'open roles', 'open opportunity', 'open opportunities',
    'open to work', 'opentowork', '#opentowork',
    'open to new opportunities', 'open for new opportunities',
    'open to opportunities', 'open for opportunities', 'open to remote',
    'available for remote', 'available for global', 'available for new',
    'seeking new opportunities', 'seeking opportunities', 'seeking a new',
    'seeking new role', 'seeking new opportunity',
    'looking for new opportunities', 'looking for opportunities',
    'looking for a new role', 'looking for my next', 'looking for new role',
    'on the job market', 'actively looking', 'actively seeking',
    'seeking candidates', 'interested candidates', 'please share resume',
    'please share resumes', 'share your resume', 'send your resume',
    'send me your resume', 'send your cv', 'dm your resume',
    'dm me your resume', 'dm for details',
    'hr@', 'recruiting@', 'talent@', 'careers@', 'recruitment@', 'jobs@',
    'position 1:', 'urgent requirement', 'urgent hiring', 'urgent opening',
    'immediate joiner', 'immediate joiners', 'immediate hiring',
    'c2c', 'c2h', 'w2 only', 'usc only', 'gc only',
    'job opportunity', 'job opportunities', 'job opening', 'job openings', 'recruiter',
    'looking to take on', 'critical role in a high-impact', 'are you an experienced',
    'oportunidade:', 'oportunidade de', 'estamos em busca', 'em busca de uma referência',
    'vaga:', 'vaga de', 'vagas de',
    'búsqueda de', 'búsqueda laboral', 'busco trabajo', 'busco empleo',
  ];
  const _HIRING_SUBS = [
    'r/forhire', 'r/hiring', 'r/jobs', 'r/jobsearch', 'r/indiajobs',
    'r/recruitinghell', 'r/cscareerquestions',
  ];
  function _looksLikeJob(c) {
    if (!c) return false;
    const norm = (s) => String(s || '').normalize('NFKD').toLowerCase();
    const sub = norm(c.communityRaw || c.community || '');
    for (const s of _HIRING_SUBS) {
      if (sub === s || sub.startsWith(s + ' ') || sub.includes(' ' + s)) return true;
    }
    const hay = norm(`${c.summary || ''}\n${c.author || ''}`);
    if (!hay.trim()) return false;
    for (const p of _HIRING_PHRASES) {
      if (hay.includes(p)) return true;
    }
    return false;
  }

  function _convRowHtml(c) {
    const dot = SENTIMENT_DOT[c.sentiment] || '·';
    const link = c.url
      ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">Open ↗</a>`
      : '';
    const replyBtn =
      c.url && (c.sentiment === 'negative' || c.sentiment === 'mixed') && !c.isClosed
        ? `<button type="button" class="conv-reply-btn" data-url="${esc(
            c.url
          )}" data-author="${esc(c.author || '')}">Draft reply post</button>`
        : '';
    const key = c.key || '';
    const checked = _selectedKeys.has(key) ? ' checked' : '';
    const checkbox = key
      ? `<label class="conv-select"><input type="checkbox" class="conv-cb" data-key="${esc(key)}"${checked} aria-label="Select conversation"></label>`
      : '';
    const closedClass = c.isClosed ? ' conv-closed' : '';
    let closedBanner = '';
    let actionBtn = '';
    if (c.isClosed && c.closedInfo) {
      const reasonLabel = REASON_LABELS[c.closedInfo.reason] || c.closedInfo.reason || 'Closed';
      const note = c.closedInfo.note ? ` — ${esc(c.closedInfo.note)}` : '';
      const when = c.closedInfo.closedAt ? ` · ${esc(c.closedInfo.closedAt.slice(0, 10))}` : '';
      closedBanner = `<div class="conv-closed-banner">Closed: <strong>${esc(reasonLabel)}</strong>${note}${when}</div>`;
      actionBtn = key
        ? `<button type="button" class="conv-reopen-btn" data-key="${esc(key)}">Reopen</button>`
        : '';
    } else if (key) {
      actionBtn = `<button type="button" class="conv-close-btn" data-key="${esc(key)}">Close…</button>`;
    }
    return `<div class="conv-row sent-${esc(c.sentiment)}${closedClass}" data-key="${esc(key)}">
      <div class="conv-row-head">
        ${checkbox}
        <span class="conv-dot" title="${esc(c.sentiment)}">${dot}</span>
        <strong>${esc(c.author || '(unknown)')}</strong>
        <span class="conv-platform">${esc(c.platform || '')}</span>
        <span class="conv-date">${esc(c.date || '')}</span>
        <span class="conv-spacer"></span>
        ${link}
      </div>
      <div class="conv-summary">${esc(c.summary || '')}</div>
      ${closedBanner}
      <div class="conv-actions">${replyBtn}${actionBtn}</div>
    </div>`;
  }

  function renderConversations() {
    const list = document.getElementById('conv-list');
    if (!list) return;
    const q = (document.getElementById('conv-q')?.value || '').toLowerCase().trim();
    const sentiment = document.getElementById('conv-sentiment')?.value || '';
    const platform = document.getElementById('conv-platform')?.value || '';
    const timeframe = document.getElementById('conv-timeframe')?.value || '';
    const jobsMode = document.getElementById('conv-jobs')?.value ?? 'hide';
    const needsReply = document.getElementById('conv-needs-reply')?.checked || false;

    let convs = _allConvs.slice();
    let jobsHidden = 0;
    if (jobsMode === 'hide') {
      const before = convs.length;
      convs = convs.filter((c) => !_looksLikeJob(c));
      jobsHidden = before - convs.length;
    } else if (jobsMode === 'only') {
      convs = convs.filter((c) => _looksLikeJob(c));
    }
    if (sentiment) convs = convs.filter((c) => c.sentiment === sentiment);
    if (platform) convs = convs.filter((c) => c.platform === platform);
    if (timeframe) {
      const days = parseInt(timeframe, 10);
      if (Number.isFinite(days) && days > 0) {
        const cutoffMs = Date.now() - days * 86400000;
        convs = convs.filter((c) => {
          const dt = _parseDate(c.date);
          return dt && dt.getTime() >= cutoffMs;
        });
      }
    }
    if (needsReply) convs = convs.filter((c) => c.sentiment === 'negative' || c.sentiment === 'mixed');
    if (q) {
      convs = convs.filter(
        (c) =>
          (c.summary || '').toLowerCase().includes(q) ||
          (c.author || '').toLowerCase().includes(q) ||
          (c.platform || '').toLowerCase().includes(q)
      );
    }

    // Split into recent (≤14d) vs older (bucketed by ISO week). When the
    // user is searching, skip the date split so the query hits everything.
    const cutoff = Date.now() - RECENT_WINDOW_DAYS * 86400000;
    const recent = [];
    const older = []; // { key, label, items }
    const olderMap = new Map();
    const isSearching = !!q;

    for (const c of convs) {
      const dt = _parseDate(c.date);
      if (isSearching || !dt || dt.getTime() >= cutoff) {
        recent.push(c);
        continue;
      }
      const key = _isoWeekKey(dt);
      if (!olderMap.has(key)) {
        const bucket = { key, label: _weekLabel(dt), sortDate: dt.getTime(), items: [] };
        olderMap.set(key, bucket);
        older.push(bucket);
      }
      olderMap.get(key).items.push(c);
    }
    older.sort((a, b) => b.sortDate - a.sortDate);

    const meta = document.getElementById('conv-meta');
    if (meta) {
      const jobNote =
        jobsMode === 'hide' && jobsHidden
          ? ` · ${jobsHidden} job post${jobsHidden === 1 ? '' : 's'} hidden`
          : jobsMode === 'only'
            ? ' · job posts only'
            : '';
      const windowNote = isSearching
        ? `${convs.length} of ${_allConvs.length} matched (full archive)${jobNote}`
        : `${recent.length} in last ${RECENT_WINDOW_DAYS}d · ${convs.length - recent.length} older across ${older.length} week${older.length === 1 ? '' : 's'} · ${_allConvs.length} total${jobNote}`;
      meta.textContent = windowNote;
    }

    if (!convs.length) {
      list.innerHTML = `<p class="hint">No conversations matched. Try clearing filters or running a fresh scan to surface community chatter.</p>`;
      return;
    }

    const recentHtml = recent.length
      ? recent.map(_convRowHtml).join('')
      : `<p class="hint">No conversations in the last ${RECENT_WINDOW_DAYS} days. Older weeks are listed below.</p>`;

    const olderHtml = older
      .map((bucket) => {
        const open = _expandedWeeks.has(bucket.key) ? ' open' : '';
        return `<details class="conv-week"${open} data-week="${esc(bucket.key)}">
          <summary><span class="conv-week-label">${esc(bucket.label)}</span> <span class="conv-week-count">${bucket.items.length} item${bucket.items.length === 1 ? '' : 's'}</span></summary>
          <div class="conv-week-body">${bucket.items.map(_convRowHtml).join('')}</div>
        </details>`;
      })
      .join('');

    list.innerHTML =
      (isSearching
        ? `<div class="conv-recent">${recentHtml}</div>`
        : `<div class="conv-recent">${recentHtml}</div>` +
          (older.length
            ? `<div class="conv-archive"><h3 class="conv-archive-head">Older — by week</h3>${olderHtml}</div>`
            : ''));

    list.querySelectorAll('details.conv-week').forEach((d) => {
      d.addEventListener('toggle', () => {
        const key = d.dataset.week;
        if (!key) return;
        if (d.open) _expandedWeeks.add(key);
        else _expandedWeeks.delete(key);
      });
    });

    list.querySelectorAll('.conv-reply-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.url;
        // Send to Run view with scout-post pre-filled targeting this URL.
        const cmd = document.getElementById('run-command');
        const extra = document.getElementById('run-extra');
        if (cmd) cmd.value = 'scout-post';
        if (extra) extra.value = `Draft a thoughtful, on-brand reply post for: ${url}`;
        const navBtn = document.querySelector('nav button[data-view="run"]');
        if (navBtn) navBtn.click();
      });
    });

    list.querySelectorAll('.conv-cb').forEach((cb) => {
      cb.addEventListener('change', () => {
        const key = cb.dataset.key;
        if (!key) return;
        if (cb.checked) _selectedKeys.add(key);
        else _selectedKeys.delete(key);
        _updateBulkBar();
      });
    });
    list.querySelectorAll('.conv-close-btn').forEach((btn) => {
      btn.addEventListener('click', () => _promptCloseSingle(btn.dataset.key));
    });
    list.querySelectorAll('.conv-reopen-btn').forEach((btn) => {
      btn.addEventListener('click', () => _reopen([btn.dataset.key]));
    });
    _updateBulkBar();
  }

  // ----- Close / reopen plumbing ---------------------------------

  function _findConvByKey(key) {
    return _allConvs.find((c) => c.key === key) || null;
  }

  function _updateBulkBar() {
    const bar = document.getElementById('conv-bulk-bar');
    if (!bar) return;
    const count = _selectedKeys.size;
    bar.hidden = count === 0;
    const lbl = document.getElementById('conv-bulk-count');
    if (lbl) lbl.textContent = count === 1 ? '1 selected' : `${count} selected`;
  }

  function _promptCloseSingle(key) {
    if (!key) return;
    const conv = _findConvByKey(key);
    if (!conv) return;
    const reasons = Object.entries(REASON_LABELS)
      .map(([id, label], i) => `${i + 1}. ${label}`)
      .join('\n');
    const pick = window.prompt(
      `Close this conversation. Choose a reason (1-${Object.keys(REASON_LABELS).length}):\n\n${reasons}\n\nEnter number:`,
      '1'
    );
    if (pick == null) return;
    const idx = parseInt(String(pick).trim(), 10) - 1;
    const ids = Object.keys(REASON_LABELS);
    if (!(idx >= 0 && idx < ids.length)) {
      alert('Invalid choice.');
      return;
    }
    const reason = ids[idx];
    let note = '';
    if (reason === 'other') {
      note = window.prompt('Note (required for "Other"):', '') || '';
      if (!note.trim()) return;
    } else {
      note = window.prompt('Optional note (leave blank to skip):', '') || '';
    }
    _close([{ key, conv }], reason, note);
  }

  function _bulkClose() {
    if (!_selectedKeys.size) return;
    const reason = document.getElementById('conv-bulk-reason')?.value || 'not-relevant';
    const note = (document.getElementById('conv-bulk-note')?.value || '').trim();
    if (reason === 'other' && !note) {
      alert('"Other" requires a note.');
      return;
    }
    const entries = [...(_selectedKeys)].map((key) => ({ key, conv: _findConvByKey(key) || { key } }));
    _close(entries, reason, note);
  }

  async function _close(entries, reason, note) {
    try {
      const res = await fetch('/api/conversations/close', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: entries, reason, note }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      _selectedKeys.clear();
      const noteEl = document.getElementById('conv-bulk-note');
      if (noteEl) noteEl.value = '';
      await loadConversations();
    } catch (err) {
      alert('Close failed: ' + (err.message || err));
    }
  }

  async function _reopen(keys) {
    try {
      const res = await fetch('/api/conversations/reopen', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await loadConversations();
    } catch (err) {
      alert('Reopen failed: ' + (err.message || err));
    }
  }

  function wireConversationsUI() {
    ['conv-q', 'conv-sentiment', 'conv-platform', 'conv-timeframe', 'conv-jobs', 'conv-needs-reply'].forEach((id) => {
      const el = document.getElementById(id);
      if (el && !el.dataset.wired) {
        el.dataset.wired = '1';
        // Restore persisted value
        try {
          const saved = localStorage.getItem('cs.conv.' + id);
          if (saved != null) {
            if (el.type === 'checkbox') el.checked = saved === '1';
            else el.value = saved;
          }
        } catch {}
        const persist = () => {
          try {
            const v = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value;
            localStorage.setItem('cs.conv.' + id, v);
          } catch {}
          renderConversations();
        };
        el.addEventListener('input', persist);
        el.addEventListener('change', persist);
      }
    });
    // conv-show changes `include` mode and requires a refetch.
    const showSel = document.getElementById('conv-show');
    if (showSel && !showSel.dataset.wired) {
      showSel.dataset.wired = '1';
      try {
        const saved = localStorage.getItem('cs.conv.conv-show');
        if (saved) showSel.value = saved;
      } catch {}
      showSel.addEventListener('change', () => {
        try { localStorage.setItem('cs.conv.conv-show', showSel.value); } catch {}
        loadConversations();
      });
    }
    // Bulk bar buttons
    const closeBtn = document.getElementById('conv-bulk-close');
    if (closeBtn && !closeBtn.dataset.wired) {
      closeBtn.dataset.wired = '1';
      closeBtn.addEventListener('click', _bulkClose);
    }
    const clearBtn = document.getElementById('conv-bulk-clear');
    if (clearBtn && !clearBtn.dataset.wired) {
      clearBtn.dataset.wired = '1';
      clearBtn.addEventListener('click', () => {
        _selectedKeys.clear();
        renderConversations();
      });
    }
  }

  // ============================================================
  // Dashboard intel cards
  // ============================================================
  async function loadIntelCards() {
    if (!document.getElementById('dash-sentiment')) return;
    await Promise.all([loadSentiment(), loadCreators(), loadSourceHealth(), loadSocialActivity()]);
  }

  // ----- Social activity (community + product, multi-platform) ----
  // Buckets every conversation into Community vs Product per platform so the
  // dashboard surfaces both sides of social activity (Reddit, Bluesky,
  // LinkedIn, X, plus HN / Stack Overflow / YouTube). Negative + mixed items
  // are still flagged for response in a "Needs reply" sub-card.
  const SOCIAL_PLATFORMS = [
    { key: 'reddit',         label: 'Reddit',        match: /reddit/i,                       icon: '👽' },
    { key: 'bluesky',        label: 'Bluesky',       match: /bluesky|bsky/i,                  icon: '🦋' },
    { key: 'linkedin',       label: 'LinkedIn',      match: /linkedin/i,                      icon: '💼' },
    { key: 'x',              label: 'X',             match: /^x$|x\/twitter|twitter|x\.com/i, icon: '𝕏'  },
    { key: 'hackernews',     label: 'Hacker News',   match: /hacker\s*news|news\.ycombinator/i, icon: '🟧' },
    { key: 'stackoverflow',  label: 'Stack Overflow',match: /stack\s*overflow/i,              icon: '📚' },
    { key: 'youtube',        label: 'YouTube',       match: /youtube|youtu\.be/i,             icon: '▶️' },
  ];

  function platformKey(name) {
    const s = String(name || '');
    for (const p of SOCIAL_PLATFORMS) if (p.match.test(s)) return p.key;
    return 'other';
  }

  async function loadSocialActivity() {
    const host = document.getElementById('dash-social-activity');
    const summary = document.getElementById('dash-social-summary');
    const meta = document.getElementById('dash-social-activity-meta');
    if (!host) return;
    host.innerHTML = '<p class="hint">Loading…</p>';
    try {
      const data = await fetch('/api/conversations').then((r) => r.json());
      const allEver = Array.isArray(data.conversations) ? data.conversations : [];
      // Dashboard card is intentionally scoped to the most recent 30 days.
      // Anything older lives in the Conversations view, which has its own
      // searchable timeframe filter (30d / 90d / 6m / 1y / all time).
      const WINDOW_DAYS = 30;
      const cutoffMs = Date.now() - WINDOW_DAYS * 86400000;
      const all = allEver.filter((c) => {
        const dt = _parseDate(c.date);
        // Keep undated items so they don't silently disappear.
        return !dt || dt.getTime() >= cutoffMs;
      });
      const olderCount = allEver.length - all.length;

      // Sentiment pills (top of card)
      const totals = { positive: 0, neutral: 0, mixed: 0, negative: 0, unknown: 0 };
      all.forEach((c) => { totals[c.sentiment] = (totals[c.sentiment] || 0) + 1; });
      if (summary) {
        summary.innerHTML = all.length
          ? `<div class="dash-sent-pills">
              <span class="pill pill-pos" title="Advocates">🟢 ${totals.positive} advocate${totals.positive === 1 ? '' : 's'}</span>
              <span class="pill pill-neu" title="Neutral">⚪ ${totals.neutral} neutral</span>
              <span class="pill pill-mix" title="Mixed — worth a thoughtful reply">🟡 ${totals.mixed} mixed</span>
              <span class="pill pill-neg" title="Critical — respond first">🔴 ${totals.negative} critical</span>
            </div>`
          : `<p class="hint">No conversations tracked yet. Run a scan to surface community chatter.</p>`;
      }

      if (!all.length) {
        host.innerHTML = '';
        if (meta) meta.textContent = '';
        return;
      }

      // Bucket by platform → community/product
      const byPlatform = new Map();
      for (const c of all) {
        const k = platformKey(c.platform);
        const bucket = byPlatform.get(k) || { community: [], product: [] };
        const side = c.community === 'product' ? 'product' : 'community';
        bucket[side].push(c);
        byPlatform.set(k, bucket);
      }

      const needs = all
        .filter((c) => c.sentiment === 'negative' || c.sentiment === 'mixed')
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

      if (meta) {
        const platformsSeen = byPlatform.size;
        const olderNote = olderCount > 0
          ? ` · ${olderCount} older in Conversations`
          : '';
        meta.textContent =
          `Last 30d · ${all.length} conversation${all.length === 1 ? '' : 's'} across ${platformsSeen} platform${platformsSeen === 1 ? '' : 's'}` +
          (needs.length ? ` · ${needs.length} flagged for response` : '') +
          olderNote;
      }

      // Render: per-platform breakdown
      const platformRows = SOCIAL_PLATFORMS
        .map((p) => {
          const b = byPlatform.get(p.key);
          if (!b) return null;
          const c = b.community.length;
          const pr = b.product.length;
          if (!c && !pr) return null;
          const sample = (b.community[0] || b.product[0]);
          const sampleHtml = sample
            ? `<div class="dash-plat-sample">
                ${sample.url ? `<a href="${esc(sample.url)}" target="_blank" rel="noopener">${esc(trim(sample.summary || sample.author || '(post)', 100))}</a>` : esc(trim(sample.summary || sample.author || '(post)', 100))}
                <div class="hint">${esc(sample.author || '')}${sample.author && sample.date ? ' · ' : ''}${esc(sample.date || '')}</div>
              </div>`
            : '';
          return `<div class="dash-plat-row" data-platform="${p.key}">
            <div class="dash-plat-head">
              <span class="dash-plat-icon" aria-hidden="true">${p.icon}</span>
              <strong>${esc(p.label)}</strong>
              <span class="dash-plat-counts">
                <span class="dash-plat-chip dash-plat-community" title="Community-generated posts">${c} community</span>
                <span class="dash-plat-chip dash-plat-product" title="Product / official posts">${pr} official</span>
              </span>
            </div>
            ${sampleHtml}
          </div>`;
        })
        .filter(Boolean)
        .join('');

      // Needs-reply sub-card (only if any flagged)
      const needsHtml = needs.length
        ? `<details class="dash-needs-card" ${needs.length <= 3 ? 'open' : ''}>
            <summary><strong>Needs reply</strong> <span class="hint">${needs.length} item${needs.length === 1 ? '' : 's'}</span></summary>
            ${needs.slice(0, 5).map((c) => {
              const dot = c.sentiment === 'negative' ? '🔴' : '🟡';
              const tone = c.sentiment === 'negative' ? 'critical' : 'mixed';
              const link = c.url
                ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">Source ↗</a>`
                : '';
              const replyBtn = c.url
                ? `<button type="button" class="dash-reply-btn" data-url="${esc(c.url)}">Draft reply</button>`
                : '';
              return `<div class="dash-needs-row sent-${esc(c.sentiment)}">
                <div class="dash-needs-head">
                  <span class="dash-needs-dot">${dot}</span>
                  <strong>${esc(c.author || '(unknown)')}</strong>
                  <span class="hint">on ${esc(c.platform || '—')} · ${esc(c.date || '')}</span>
                  <span class="dash-needs-tone tone-${tone}">${tone}</span>
                </div>
                <div class="dash-needs-summary">${esc(c.summary || '')}</div>
                <div class="dash-needs-actions">${replyBtn} ${link}</div>
              </div>`;
            }).join('')}
            ${needs.length > 5 ? `<button type="button" class="dash-needs-viewall">View all ${needs.length} →</button>` : ''}
          </details>`
        : '';

      host.innerHTML =
        (platformRows ? `<div class="dash-plat-grid">${platformRows}</div>` : '') +
        needsHtml ||
        '<p class="hint">No platform-specific conversations parsed yet.</p>';

      host.querySelectorAll('.dash-reply-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const url = btn.dataset.url;
          const cmd = document.getElementById('run-command');
          const extra = document.getElementById('run-extra');
          if (cmd) cmd.value = 'scout-post';
          if (extra) extra.value = `Draft a thoughtful, on-brand reply post for: ${url}`;
          const navBtn = document.querySelector('nav button[data-view="run"]');
          if (navBtn) navBtn.click();
        });
      });
      host.querySelector('.dash-needs-viewall')?.addEventListener('click', () => {
        const navBtn = document.querySelector('nav button[data-view="conversations"]');
        if (navBtn) navBtn.click();
        setTimeout(() => {
          const cb = document.getElementById('conv-needs-reply');
          if (cb) {
            cb.checked = true;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, 150);
      });
      host.querySelectorAll('.dash-plat-row').forEach((row) => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('a, button')) return;
          const navBtn = document.querySelector('nav button[data-view="conversations"]');
          if (!navBtn) return;
          navBtn.click();
          setTimeout(() => {
            const sel = document.getElementById('conv-platform');
            if (sel) {
              const opt = [...sel.options].find((o) => o.value.toLowerCase().includes(row.dataset.platform));
              if (opt) {
                sel.value = opt.value;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
          }, 150);
        });
      });
    } catch (err) {
      host.innerHTML = `<p class="hint">Failed to load conversations: ${esc(err.message || err)}</p>`;
    }
  }

  function trim(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  async function loadSentiment() {
    const host = document.getElementById('dash-sentiment');
    if (!host) return;
    try {
      const data = await fetch('/api/sentiment-summary').then((r) => r.json());
      const groups = data.groups || [];
      if (!groups.length) {
        host.innerHTML = `<p class="hint">No reports yet. Run a scan to see sentiment trends.</p>`;
        return;
      }
      host.innerHTML = groups
        .map((g) => {
          const t = g.latest?.totals || {};
          const total =
            (t.positive || 0) + (t.neutral || 0) + (t.mixed || 0) + (t.negative || 0);
          if (!total)
            return `<div class="sent-row">
              <strong>${esc(g.slug)}</strong>
              <span class="hint">No conversations in latest scan</span>
            </div>`;
          const bar = (n, cls) => {
            const pct = Math.round((n / total) * 100);
            return pct
              ? `<span class="sent-seg ${cls}" style="width:${pct}%" title="${cls}: ${n}"></span>`
              : '';
          };
          const prior = g.prior?.totals;
          let delta = '';
          if (prior) {
            const dp = (t.positive || 0) - (prior.positive || 0);
            const dn = (t.negative || 0) - (prior.negative || 0);
            if (dp || dn) {
              delta = `<span class="sent-delta">Δ +${dp >= 0 ? dp : dp} 🟢, ${
                dn >= 0 ? '+' + dn : dn
              } 🔴</span>`;
            }
          }
          return `<div class="sent-row">
            <div class="sent-head">
              <strong>${esc(g.slug)}</strong>
              <span class="hint">${total} conv${total === 1 ? '' : 's'}</span>
              ${delta}
            </div>
            <div class="sent-bar">
              ${bar(t.positive || 0, 'pos')}
              ${bar(t.neutral || 0, 'neu')}
              ${bar(t.mixed || 0, 'mix')}
              ${bar(t.negative || 0, 'neg')}
            </div>
            <div class="sent-legend">
              ${t.positive ? `🟢 ${t.positive}` : ''}
              ${t.neutral ? `⚪ ${t.neutral}` : ''}
              ${t.mixed ? `🟡 ${t.mixed}` : ''}
              ${t.negative ? `🔴 ${t.negative}` : ''}
            </div>
          </div>`;
        })
        .join('');
    } catch (err) {
      host.innerHTML = `<p class="hint">Failed: ${esc(err.message || err)}</p>`;
    }
  }

  async function loadCreators() {
    const host = document.getElementById('dash-creators');
    if (!host) return;
    try {
      const data = await fetch('/api/authors').then((r) => r.json());
      const top = (data.authors || [])
        .filter((a) => a.name && a.name !== '(unknown)' && a.name.length < 80)
        .slice(0, 8);
      if (!top.length) {
        host.innerHTML = `<li class="hint">No creators tracked yet.</li>`;
        return;
      }
      host.innerHTML = top
        .map((a) => {
          const total = a.items + a.conversations;
          const pos = a.sentiments?.positive || 0;
          const neg = a.sentiments?.negative || 0;
          const skew =
            pos > neg ? `🟢 +${pos - neg}` : neg > pos ? `🔴 -${neg - pos}` : '';
          return `<li class="creator-row" data-author="${esc(a.name)}">
            <div class="creator-name">${esc(a.name)}</div>
            <div class="creator-meta">
              <span>${total} ${total === 1 ? 'mention' : 'mentions'}</span>
              <span class="hint">${a.items} items · ${a.conversations} conv</span>
              ${skew ? `<span class="creator-skew">${skew}</span>` : ''}
            </div>
          </li>`;
        })
        .join('');
      host.querySelectorAll('.creator-row').forEach((el) => {
        el.addEventListener('click', () => {
          const name = el.dataset.author;
          const navBtn = document.querySelector('nav button[data-view="conversations"]');
          if (navBtn) navBtn.click();
          setTimeout(() => {
            const q = document.getElementById('conv-q');
            if (q) {
              q.value = name;
              q.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }, 100);
        });
      });
    } catch (err) {
      host.innerHTML = `<li class="hint">Failed: ${esc(err.message || err)}</li>`;
    }
  }

  async function loadSourceHealth() {
    const host = document.getElementById('dash-source-health');
    if (!host) return;
    try {
      const data = await fetch('/api/source-health').then((r) => r.json());
      const skipped = data.lastSkipped || [];
      const sources = (data.sources || []).slice(0, 6);
      const skippedHtml = skipped.length
        ? `<div class="src-skipped">
            <strong>Last scan skipped:</strong>
            <ul>${skipped
              .slice(0, 6)
              .map(
                (s) =>
                  `<li><span class="src-name">${esc(s.name)}</span> <span class="hint">${esc(
                    s.reason
                  )}</span></li>`
              )
              .join('')}</ul>
            <button type="button" class="src-doctor-btn">Run scout doctor</button>
          </div>`
        : `<p class="hint">No skipped sources in the latest scan. 🎉</p>`;
      const topHtml = sources.length
        ? `<div class="src-top">
            <strong>Top contributing sources:</strong>
            <ul>${sources
              .map(
                (s) =>
                  `<li><span class="src-name">${esc(s.source)}</span> <span class="hint">${
                    s.items
                  } items · last ${esc(s.lastSeen || 'n/a')}</span></li>`
              )
              .join('')}</ul>
          </div>`
        : '';
      host.innerHTML = skippedHtml + topHtml;
      host.querySelector('.src-doctor-btn')?.addEventListener('click', () => {
        const cmd = document.getElementById('run-command');
        if (cmd) cmd.value = 'scout-doctor';
        const navBtn = document.querySelector('nav button[data-view="run"]');
        if (navBtn) navBtn.click();
      });
    } catch (err) {
      host.innerHTML = `<p class="hint">Failed: ${esc(err.message || err)}</p>`;
    }
  }

  // ============================================================
  function wireOpenLatestReportBtn() {
    const btn = document.getElementById('dash-open-latest-report');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      if (typeof window.contentScoutOpenLatestReport === 'function') {
        window.contentScoutOpenLatestReport();
      } else {
        // Fallback: navigate, then click first item.
        const navBtn = document.querySelector('nav button[data-view="reports"]');
        if (navBtn) navBtn.click();
        setTimeout(() => document.querySelector('#reports-list li')?.click(), 200);
      }
    });
  }

  // Hash routing hook
  // ============================================================
  function onHashChange() {
    const v = location.hash.replace(/^#/, '');
    if (v === 'conversations') {
      wireConversationsUI();
      loadConversations();
    } else if (v === 'dashboard' || v === '') {
      // intel cards reload alongside dashboard
      loadIntelCards();
      wireOpenLatestReportBtn();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      onHashChange();
      window.addEventListener('hashchange', onHashChange);
    });
  } else {
    onHashChange();
    window.addEventListener('hashchange', onHashChange);
  }

  window.contentScoutIntel = { loadConversations, loadIntelCards, wireConversationsUI };
})();
/* ============================================================
 * Reports view enhancer — auto-build TOC + heading anchors
 * ============================================================ */
(function () {
  function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function buildToc() {
    const body = document.getElementById('reports-body');
    if (!body) return;
    const headings = body.querySelectorAll('h2, h3');
    if (!headings.length) {
      const old = document.getElementById('report-toc');
      if (old) old.remove();
      return;
    }
    headings.forEach((h) => {
      if (!h.id) h.id = 'sec-' + slugify(h.textContent || '');
    });
    let toc = document.getElementById('report-toc');
    if (!toc) {
      toc = document.createElement('nav');
      toc.id = 'report-toc';
      const aside = document.querySelector('#view-reports .split aside');
      if (aside) aside.appendChild(toc);
    }
    toc.innerHTML =
      '<div class="toc-head">On this page</div><ul>' +
      [...headings]
        .map(
          (h) =>
            '<li class="toc-' +
            h.tagName.toLowerCase() +
            '"><a href="#' +
            h.id +
            '">' +
            (h.textContent || '').replace(/[<>]/g, '') +
            '</a></li>'
        )
        .join('') +
      '</ul>';
    toc.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const id = a.getAttribute('href').slice(1);
        const target = document.getElementById(id);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }
  // Watch reports-body for changes (it gets innerHTML set on click)
  const obs = new MutationObserver(() => buildToc());
  document.addEventListener('DOMContentLoaded', () => {
    const body = document.getElementById('reports-body');
    if (body) obs.observe(body, { childList: true, subtree: false });
  });
})();
