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

  // Switch to the Conversations view and scroll/highlight the row that
  // matches `key`. If the row isn't in the current view (filtered out
  // by include/platform), broaden filters and reload before scrolling.
  // Called from Social pulse links so users can read the post inline
  // instead of being kicked out to the external site.
  async function _navigateToConversation(key) {
    if (!key) return;
    const navBtn = document.querySelector('nav button[data-view="conversations"]');
    if (navBtn) navBtn.click();
    const findRow = () => document.querySelector(`#conv-list .conv-row[data-key="${CSS.escape(key)}"]`);
    const flash = (row) => {
      if (!row) return;
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('conv-row-flash');
      setTimeout(() => row.classList.remove('conv-row-flash'), 2200);
      try { row.focus({ preventScroll: true }); } catch {}
    };
    // Wait one tick for the view swap to render the existing list.
    await new Promise((r) => setTimeout(r, 60));
    let row = findRow();
    if (row) { flash(row); return; }
    // Not in current view — broaden filters: include=all, clear platform.
    const show = document.getElementById('conv-show');
    const plat = document.getElementById('conv-platform');
    let mutated = false;
    if (show && show.value !== 'all') { show.value = 'all'; mutated = true; }
    if (plat && plat.value) { plat.value = ''; mutated = true; }
    if (mutated) {
      (show || plat).dispatchEvent(new Event('change', { bubbles: true }));
      // loadConversations is async — poll briefly for the row to land.
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 80));
        row = findRow();
        if (row) break;
      }
    }
    if (row) flash(row);
  }

  const REASON_LABELS = {
    'not-relevant': 'Not relevant',
    'contacted': 'Contacted',
    'follow-up-pm': 'Follow up with PM',
    'spam': 'Spam / job post',
    'duplicate': 'Duplicate',
    'other': 'Other',
  };
  const NO_TRIAGE_REASON = 'microsoft-employee';

  async function loadConversations() {
    const list = document.getElementById('conv-list');
    if (!list) return;
    try {
      const include = _currentInclude();
      // "all" means show literally everything (open + closed + muted).
      // "muted" already implies show-muted on the server. For "open" /
      // "closed", muted authors are filtered out unless the user picks
      // "all" explicitly.
      const params = new URLSearchParams({ include });
      if (include === 'all') params.set('includeMuted', '1');
      const data = await fetch('/api/conversations?' + params.toString()).then((r) => r.json());
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
      // Keep the toolbar mute-count pill fresh without forcing the
      // modal open.
      _refreshMutedCountSilent();
    } catch (err) {
      list.innerHTML = `<p class="hint">Failed to load conversations: ${esc(err.message || err)}</p>`;
    }
  }
  async function _refreshMutedCountSilent() {
    try {
      const data = await fetch('/api/muted-accounts').then((r) => r.json());
      const n = Array.isArray(data.items) ? data.items.length : 0;
      const pill = document.getElementById('conv-muted-count-pill');
      if (pill) {
        pill.textContent = String(n);
        pill.style.display = n ? '' : 'none';
      }
      _mutedItemsCache = Array.isArray(data.items) ? data.items : _mutedItemsCache;
    } catch {}
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
    'estamos contratando',
    'vaga:', 'vaga de', 'vagas de',
    'búsqueda de', 'búsqueda laboral', 'busco trabajo', 'busco empleo',
    'nous recrutons', 'nous cherchons',
    // US contracting / vendor-list recruiter posts — Title/Duration/
    // Location/Rate body format ("***W2,1099 requirement*** Title: …
    // Duration: 1 year Location: Boston MA").
    'w2/1099', 'w-2/1099', 'w2,1099', 'w-2,1099',
    '1099 requirement', 'w2 requirement', 'w2/c2c', 'w2/c2h',
    'corp to corp', 'corp-to-corp', 'no h1b', 'h1b transfer', 'h-1b transfer',
    'visa status:', 'visa sponsorship',
    'mandatory skills', 'required skills:', 'must-have skills', 'must have skills', 'must have skill',
    'pay rate:', 'bill rate:', 'hourly rate:',
    'job description:', 'job title:', 'job summary:', 'job role:',
    'looking for consultants', 'looking for candidates',
    'consultant required', 'consultant requirement',
    'send resumes to', 'send resumes at', 'send cvs to',
    'kindly share resumes', 'kindly share profiles', 'please share profiles', 'please share matching',
    'shortlist', 'shortlisting',
    'interested please share', 'interested candidates can',
    'walk in interview', 'walk-in interview',
    'remote ok', 'remote contract',
  ];
  // Recruiter-form-style body markers. 3+ markers in one post is
  // almost always a vendor-list contractor job spec sheet.
  const _HIRING_FIELDS = [
    'title:', 'role:', 'position:', 'location:', 'duration:',
    'rate:', 'pay rate:', 'bill rate:', 'client:',
    'work mode:', 'work location:',
    'experience:', 'skills:', 'mandatory skills',
    'visa:', 'visa status', 'job description', 'must have',
    'nice to have', 'tax term', 'work authorization',
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
    // Structural fallback: 3+ recruiter-form markers in one body
    // (Title: / Duration: / Location: / Rate: / Skills: …) means
    // it's a vendor-list job spec sheet, even without an explicit
    // phrase hit.
    let n = 0;
    for (const m of _HIRING_FIELDS) {
      if (hay.includes(m)) {
        n++;
        if (n >= 3) return true;
      }
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
    const author = c.author || '';
    const noTriageBanner = c.isNoTriage
      ? `<div class="conv-closed-banner conv-no-triage-banner">No triage: <strong>verified Microsoft / owned account</strong>${
          c.mutedInfo?.note ? ` — ${esc(c.mutedInfo.note)}` : ''
        }</div>`
      : '';
    const mutedBanner = c.isMuted
      ? c.isNoTriage
        ? ''
        : `<div class="conv-closed-banner">Muted: <strong>@${esc(_cleanHandle(author))}</strong></div>`
      : '';
    const noTriageBtn = author && !c.isNoTriage
      ? `<button type="button" class="conv-no-triage-btn" data-author="${esc(author)}" data-platform="${esc(c.platform || '')}" title="Hide this verified Microsoft employee or owned account from the triage inbox">No triage</button>`
      : '';
    const muteBtn = author && !c.isMuted
      ? `<button type="button" class="conv-mute-btn" data-author="${esc(author)}" data-platform="${esc(c.platform || '')}" title="Hide every conversation from this account">Mute @…</button>`
      : c.isMuted
        ? `<button type="button" class="conv-unmute-btn" data-author="${esc(author)}" data-platform="${esc(c.platform || '')}">Unmute</button>`
        : '';
    const recheckBtn = !c.isClosed && (c.summary || '').trim()
      ? `<button type="button" class="conv-recheck-btn" data-key="${esc(key)}" title="Ask the local agent LLM to re-classify this row's sentiment">🤖 Re-check sentiment</button>`
      : '';
    const selectedClass = key && _selectedKeys.has(key) ? ' is-selected' : '';
    const rowAttrs = key ? ` data-key="${esc(key)}" tabindex="0" role="button" aria-pressed="${_selectedKeys.has(key) ? 'true' : 'false'}"` : '';
    return `<div class="conv-row sent-${esc(c.sentiment)}${closedClass}${c.isMuted ? ' conv-muted' : ''}${selectedClass}"${rowAttrs}>
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
      ${closedBanner}${noTriageBanner}${mutedBanner}
      <div class="conv-actions">${replyBtn}${actionBtn}${noTriageBtn}${muteBtn}${recheckBtn}</div>
      <div class="conv-sentiment-verdict" data-key="${esc(key)}" hidden></div>
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
      // Checkbox = additive multi-select. Don't let the click bubble up
      // to the row handler (which would treat it as a single-select click).
      cb.addEventListener('click', (ev) => ev.stopPropagation());
      cb.addEventListener('change', (ev) => {
        ev.stopPropagation();
        const key = cb.dataset.key;
        if (!key) return;
        if (cb.checked) _selectedKeys.add(key);
        else _selectedKeys.delete(key);
        _syncRowSelected(key);
        _updateBulkBar();
      });
    });
    // Click anywhere on the card = single-select (radio-style). Ignore
    // clicks on interactive children (links, buttons, inputs, labels).
    list.querySelectorAll('.conv-row').forEach((row) => {
      const key = row.dataset.key;
      if (!key) return;
      const select = (ev) => {
        if (ev.target.closest('a, button, input, label, textarea, select')) return;
        if (window.getSelection && String(window.getSelection())) return; // user is text-selecting
        const wasOnly = _selectedKeys.size === 1 && _selectedKeys.has(key);
        const prev = [..._selectedKeys];
        _selectedKeys = new Set(wasOnly ? [] : [key]);
        prev.forEach((k) => _syncRowSelected(k));
        _syncRowSelected(key);
        _updateBulkBar();
      };
      row.addEventListener('click', select);
      row.addEventListener('keydown', (ev) => {
        if (ev.key === ' ' || ev.key === 'Enter') {
          if (ev.target !== row) return;
          ev.preventDefault();
          select(ev);
        }
      });
    });
    list.querySelectorAll('.conv-close-btn').forEach((btn) => {
      btn.addEventListener('click', () => _promptCloseSingle(btn.dataset.key));
    });
    list.querySelectorAll('.conv-reopen-btn').forEach((btn) => {
      btn.addEventListener('click', () => _reopen([btn.dataset.key]));
    });
    list.querySelectorAll('.conv-mute-btn').forEach((btn) => {
      btn.addEventListener('click', () => _promptMute(btn.dataset.author, btn.dataset.platform));
    });
    list.querySelectorAll('.conv-no-triage-btn').forEach((btn) => {
      btn.addEventListener('click', () => _markNoTriage(btn.dataset.author, btn.dataset.platform));
    });
    list.querySelectorAll('.conv-unmute-btn').forEach((btn) => {
      btn.addEventListener('click', () => _unmute(btn.dataset.platform, btn.dataset.author));
    });
    list.querySelectorAll('.conv-recheck-btn').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        _recheckSentiment(btn.dataset.key, btn);
      });
    });
    _updateBulkBar();
  }

  // ----- Sentiment re-check (local-LLM second opinion) -----------

  // Extract the slug from a report filename like
  // "2026-05-11-2236-azure-cosmos-db-content.md" -> "azure-cosmos-db".
  function _slugFromReport(reportName) {
    if (!reportName) return '';
    const m = String(reportName).match(/^\d{4}-\d{2}-\d{2}-\d{4}-(.+?)-(?:content|mindshare|supplemental|trends)\.(?:md|json)$/);
    return m ? m[1] : '';
  }

  let _sentimentStatusCache = null;
  async function _refreshSentimentStatus() {
    const btn = document.getElementById('conv-sentiment-status');
    if (!btn) return;
    const lbl = btn.querySelector('.conv-sentiment-status-label');
    btn.dataset.state = 'checking';
    if (lbl) lbl.textContent = 'checking…';
    try {
      const data = await fetch('/api/sentiment/status').then((r) => r.json());
      _sentimentStatusCache = data;
      const ok = !!data?.ok;
      const provider = data?.provider || 'none';
      const model = data?.model || '';
      btn.dataset.state = ok ? 'ok' : 'fail';
      btn.title = data?.message || (ok ? 'Reviewer ready' : 'Reviewer not configured');
      if (lbl) {
        if (provider === 'none') lbl.textContent = 'not configured';
        else if (provider === 'agent' && ok) lbl.textContent = `agent${model ? ' · ' + model : ''}`;
        else if (provider === 'agent') lbl.textContent = 'agent (not configured)';
        else if (ok && data?.modelInstalled === false) lbl.textContent = `${provider} (pull ${model})`;
        else if (ok) lbl.textContent = `${provider}${model ? ' · ' + model : ''}`;
        else lbl.textContent = `${provider} unreachable`;
      }
    } catch (err) {
      _sentimentStatusCache = { ok: false, message: err.message };
      btn.dataset.state = 'fail';
      btn.title = err.message || 'status check failed';
      if (lbl) lbl.textContent = 'status error';
    }
  }

  async function _recheckSentiment(key, btn) {
    if (!key) return;
    const c = _findConvByKey(key);
    if (!c) return;
    const verdictEl = document.querySelector(`.conv-sentiment-verdict[data-key="${CSS.escape(key)}"]`);
    if (!verdictEl) return;
    const origLabel = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = '🤖 Reviewing…'; }
    verdictEl.hidden = false;
    verdictEl.classList.add('is-loading');
    const provider = _sentimentStatusCache?.provider || 'agent';
    const waitMsg = provider === 'agent'
      ? 'Asking your agent LLM… (this can take 10–30s on first call)'
      : 'Asking the LLM…';
    verdictEl.innerHTML = `<span class="hint">${esc(waitMsg)}</span>`;
    try {
      const slug = _slugFromReport(c.report);
      const payload = {
        summary: c.summary || '',
        author: c.author || '',
        platform: c.platform || '',
        slug,
        currentSentiment: c.sentiment || 'unknown',
      };
      const res = await fetch('/api/sentiment/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      verdictEl.classList.remove('is-loading');
      if (!res.ok || data?.error) {
        verdictEl.innerHTML = `<span class="conv-verdict-error">⚠️ ${esc(data?.error || data?.message || `HTTP ${res.status}`)}</span>`;
        return;
      }
      _renderVerdict(verdictEl, c, data);
    } catch (err) {
      verdictEl.classList.remove('is-loading');
      verdictEl.innerHTML = `<span class="conv-verdict-error">⚠️ ${esc(err.message || err)}</span>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = origLabel || '🤖 Re-check sentiment'; }
    }
  }

  function _renderVerdict(el, conv, data) {
    const llmSent = (data.sentiment || 'unknown').toLowerCase();
    const llmDot = SENTIMENT_DOT[llmSent] || '·';
    const curSent = (conv.sentiment || 'unknown').toLowerCase();
    const curDot = SENTIMENT_DOT[curSent] || '·';
    const agrees = data.agrees === true || llmSent === curSent;
    const confLabel = data.confidence ? `confidence: ${esc(data.confidence)}` : '';
    const model = data.model ? ` · ${esc(data.provider)}/${esc(data.model)}` : data.provider ? ` · ${esc(data.provider)}` : '';
    const verdictClass = agrees ? 'agrees' : 'disagrees';
    const headline = agrees
      ? `<span class="conv-verdict-agrees">✓ LLM agrees</span>`
      : `<span class="conv-verdict-disagrees">⚠ LLM disagrees</span>`;
    el.innerHTML = `
      <div class="conv-verdict-row conv-verdict-${verdictClass}">
        ${headline}
        <span class="conv-verdict-compare">
          report says <span class="conv-dot sent-${esc(curSent)}" title="${esc(curSent)}">${curDot}</span> <span class="conv-verdict-sent">${esc(curSent)}</span>
          → LLM says <span class="conv-dot sent-${esc(llmSent)}" title="${esc(llmSent)}">${llmDot}</span> <span class="conv-verdict-sent">${esc(llmSent)}</span>
        </span>
        <span class="conv-verdict-meta hint">${confLabel}${model}</span>
      </div>
      ${data.rationale ? `<div class="conv-verdict-rationale">${esc(data.rationale)}</div>` : ''}
    `;
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

  // Toggle the .is-selected class + checkbox state on a single row
  // without re-rendering the full list.
  function _syncRowSelected(key) {
    if (!key) return;
    const sel = _selectedKeys.has(key);
    const list = document.getElementById('conv-list');
    if (!list) return;
    const row = list.querySelector(`.conv-row[data-key="${CSS.escape(key)}"]`);
    if (row) {
      row.classList.toggle('is-selected', sel);
      row.setAttribute('aria-pressed', sel ? 'true' : 'false');
      const cb = row.querySelector('.conv-cb');
      if (cb && cb.checked !== sel) cb.checked = sel;
    }
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

  // ----- Mute / unmute plumbing ---------------------------------

  function _cleanHandle(h) {
    return String(h || '').trim().replace(/^@+/, '').replace(/^u\//i, '').toLowerCase();
  }

  // --- Mute modal (replaces 3× window.prompt) ----------------------
  let _muteModalEl = null;
  function _ensureMuteModal() {
    if (_muteModalEl) return _muteModalEl;
    const dlg = document.createElement('dialog');
    dlg.className = 'cs-modal cs-mute-modal';
    dlg.innerHTML = `
      <form method="dialog" class="cs-modal-form">
        <header class="cs-modal-head">
          <h3>Mute account</h3>
          <button type="button" class="cs-modal-close" aria-label="Close" data-action="cancel">×</button>
        </header>
        <div class="cs-modal-body">
          <label class="cs-field">
            <span>Handle</span>
            <input type="text" name="handle" autocomplete="off" required placeholder="e.g. nirav-mungara" />
          </label>
          <label class="cs-field">
            <span>Scope</span>
            <select name="scope">
              <option value="platform">Only on this platform</option>
              <option value="all">All platforms</option>
            </select>
          </label>
          <input type="hidden" name="platform" />
          <label class="cs-field">
            <span>Reason</span>
            <select name="reason">
              <option value="">— None —</option>
              <option value="recruiter">Recruiter / job post</option>
              <option value="spam">Spam</option>
              <option value="irrelevant">Irrelevant</option>
              <option value="competitor">Competitor</option>
              <option value="owned">Owned account</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label class="cs-field">
            <span>Note <span class="hint">(optional)</span></span>
            <input type="text" name="note" maxlength="200" placeholder="Anything worth remembering" />
          </label>
          <p class="cs-modal-hint" data-role="ctx"></p>
        </div>
        <footer class="cs-modal-foot">
          <button type="button" class="secondary" data-action="cancel">Cancel</button>
          <button type="button" class="primary" data-action="confirm">Mute</button>
        </footer>
      </form>`;
    document.body.appendChild(dlg);
    _muteModalEl = dlg;
    return dlg;
  }
  function _promptMute(author, platform) {
    const handle = _cleanHandle(author);
    if (!handle) {
      _toast('No handle to mute.', 'error');
      return;
    }
    const dlg = _ensureMuteModal();
    const form = dlg.querySelector('form');
    form.handle.value = handle;
    form.platform.value = platform || '';
    form.scope.value = platform ? 'platform' : 'all';
    form.reason.value = '';
    form.note.value = '';
    const ctx = dlg.querySelector('[data-role="ctx"]');
    ctx.textContent = platform
      ? `From ${author || handle} on ${platform}.`
      : `From ${author || handle} (no platform — defaults to all).`;
    const onClick = (e) => {
      const action = e.target?.dataset?.action;
      if (!action) return;
      if (action === 'cancel') {
        dlg.close('cancel');
        return;
      }
      if (action === 'confirm') {
        const useGlobal = form.scope.value === 'all';
        const h = _cleanHandle(form.handle.value);
        if (!h) {
          _toast('Handle is required.', 'error');
          return;
        }
        _mute(useGlobal ? '' : (form.platform.value || ''), h, form.reason.value, form.note.value);
        dlg.close('ok');
      }
    };
    dlg.removeEventListener('click', dlg._csClick || (() => {}));
    dlg._csClick = onClick;
    dlg.addEventListener('click', onClick);
    // Submit on Enter inside any text field
    form.onsubmit = (ev) => {
      ev.preventDefault();
      onClick({ target: { dataset: { action: 'confirm' } } });
    };
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    setTimeout(() => form.handle.focus(), 30);
  }
  function _toast(msg, tone) {
    try {
      if (window.csToast) {
        window.csToast(msg, tone || 'info');
        return;
      }
    } catch {}
    if (tone === 'error') alert(msg);
  }

  async function _mute(platform, handle, reason, note) {
    try {
      const res = await fetch('/api/muted-accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: platform || '', handle, reason: reason || '', note: note || '' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await loadConversations();
      await _refreshMutedPanel();
    } catch (err) {
      alert('Mute failed: ' + (err.message || err));
    }
  }

  async function _markNoTriage(author, platform) {
    const handle = _cleanHandle(author);
    if (!handle) {
      _toast('No handle to mark no-triage.', 'error');
      return;
    }
    const ok = window.confirm(
      `Mark @${handle} as no-triage?\n\nUse this only for verified Microsoft employees or owned accounts. Microsoft MVP/MCT status alone is community, not employee.`
    );
    if (!ok) return;
    await _mute(platform || '', handle, NO_TRIAGE_REASON, 'Verified Microsoft employee or owned account; no community triage needed.');
  }

  async function _unmute(platform, handle) {
    try {
      const res = await fetch('/api/muted-accounts', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: platform || '', handle: _cleanHandle(handle) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await loadConversations();
      await _refreshMutedPanel();
    } catch (err) {
      alert('Unmute failed: ' + (err.message || err));
    }
  }

  async function _unmuteByKey(key) {
    try {
      const res = await fetch('/api/muted-accounts', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys: [key] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await loadConversations();
      await _refreshMutedPanel();
    } catch (err) {
      alert('Unmute failed: ' + (err.message || err));
    }
  }

  let _mutedItemsCache = [];
  let _mutedFilter = '';
  async function _refreshMutedPanel() {
    const list = document.getElementById('conv-muted-list');
    if (!list) return;
    try {
      const data = await fetch('/api/muted-accounts').then((r) => r.json());
      _mutedItemsCache = Array.isArray(data.items) ? data.items : [];
      _renderMutedList();
    } catch (err) {
      list.innerHTML = `<p class="hint">Failed to load muted accounts: ${esc(err.message || err)}</p>`;
    }
  }
  function _platformGlyph(p) {
    const k = String(p || '').toLowerCase();
    if (k === 'linkedin') return 'in';
    if (k === 'x' || k === 'twitter') return '𝕏';
    if (k === 'reddit') return 'r/';
    if (k === 'bluesky') return 'bsky';
    if (k === 'youtube') return '▶';
    if (k === 'github') return 'gh';
    if (k === '*') return '∗';
    return (k[0] || '?').toUpperCase();
  }
  function _renderMutedList() {
    const list = document.getElementById('conv-muted-list');
    const countEl = document.getElementById('conv-muted-count');
    if (!list) return;
    const items = _mutedItemsCache.slice();
    if (countEl) countEl.textContent = String(items.length);
    const pill = document.getElementById('conv-muted-count-pill');
    if (pill) {
      pill.textContent = String(items.length);
      pill.style.display = items.length ? '' : 'none';
    }
    if (!items.length) {
      list.innerHTML = `
        <div class="cs-empty">
          <div class="cs-empty-icon">🔇</div>
          <h4>No muted accounts</h4>
          <p>Use <strong>Mute @…</strong> on any conversation row, or
          add one manually above. Owned accounts can also be imported
          from a subject config.</p>
        </div>`;
      return;
    }
    const filter = (_mutedFilter || '').toLowerCase().trim();
    const filtered = filter
      ? items.filter(
          (it) =>
            (it.handle || '').toLowerCase().includes(filter) ||
            (it.platform || '').toLowerCase().includes(filter) ||
            (it.reason || '').toLowerCase().includes(filter) ||
            (it.note || '').toLowerCase().includes(filter)
        )
      : items;
    if (!filtered.length) {
      list.innerHTML = `<p class="hint">No muted accounts match “${esc(_mutedFilter)}”.</p>`;
      return;
    }
    list.innerHTML = filtered
      .map((it) => {
        const when = it.mutedAt ? esc(it.mutedAt.slice(0, 10)) : '';
        const platform = it.platform === '*' ? 'all' : esc(it.platform || '?');
        const reason = it.reason ? `<span class="cs-muted-tag cs-tag-reason">${esc(it.reason)}</span>` : '';
        const noTriage = it.noTriage || it.reason === NO_TRIAGE_REASON
          ? `<span class="cs-muted-tag cs-tag-no-triage">no triage</span>`
          : '';
        const note = it.note ? `<span class="cs-muted-note">${esc(it.note)}</span>` : '';
        const ownedBadge = it.owned ? `<span class="cs-muted-tag cs-tag-owned" title="Imported from config">owned</span>` : '';
        return `<div class="cs-muted-card${it.owned ? ' is-owned' : ''}" data-key="${esc(it.key)}">
          <div class="cs-muted-avatar" data-platform="${esc(it.platform || '')}" aria-hidden="true">${esc(_platformGlyph(it.platform))}</div>
          <div class="cs-muted-main">
            <div class="cs-muted-title">
              <strong>@${esc(it.handle)}</strong>
              <span class="cs-muted-plat">${platform}</span>
              ${ownedBadge}${noTriage}${reason}
            </div>
            ${note}
            ${when ? `<div class="cs-muted-when">Muted ${when}</div>` : ''}
          </div>
          <button type="button" class="cs-muted-unmute" data-key="${esc(it.key)}" title="Unmute">Unmute</button>
        </div>`;
      })
      .join('');
    list.querySelectorAll('.cs-muted-unmute').forEach((btn) => {
      btn.addEventListener('click', () => _unmuteByKey(btn.dataset.key));
    });
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
    // Muted accounts manage panel (now a <dialog> modal)
    const manageBtn = document.getElementById('conv-manage-muted');
    if (manageBtn && !manageBtn.dataset.wired) {
      manageBtn.dataset.wired = '1';
      manageBtn.addEventListener('click', () => {
        const panel = document.getElementById('conv-muted-panel');
        if (!panel) return;
        if (typeof panel.showModal === 'function') {
          if (!panel.open) panel.showModal();
        } else {
          panel.hidden = false;
          panel.setAttribute('open', '');
        }
        _refreshMutedPanel();
      });
    }
    // Sentiment reviewer status pill (click to re-probe).
    const sentStatusBtn = document.getElementById('conv-sentiment-status');
    if (sentStatusBtn && !sentStatusBtn.dataset.wired) {
      sentStatusBtn.dataset.wired = '1';
      sentStatusBtn.addEventListener('click', () => _refreshSentimentStatus());
      _refreshSentimentStatus();
    }
    const mutedCloseBtn = document.getElementById('conv-muted-close');
    if (mutedCloseBtn && !mutedCloseBtn.dataset.wired) {
      mutedCloseBtn.dataset.wired = '1';
      mutedCloseBtn.addEventListener('click', () => {
        const panel = document.getElementById('conv-muted-panel');
        if (!panel) return;
        if (typeof panel.close === 'function' && panel.open) panel.close();
        else {
          panel.hidden = true;
          panel.removeAttribute('open');
        }
      });
    }
    // Click on backdrop closes the dialog
    const mutedDlg = document.getElementById('conv-muted-panel');
    if (mutedDlg && !mutedDlg.dataset.wiredBackdrop) {
      mutedDlg.dataset.wiredBackdrop = '1';
      mutedDlg.addEventListener('click', (e) => {
        if (e.target === mutedDlg && typeof mutedDlg.close === 'function') mutedDlg.close();
      });
    }
    // Search filter
    const searchEl = document.getElementById('conv-muted-search');
    if (searchEl && !searchEl.dataset.wired) {
      searchEl.dataset.wired = '1';
      searchEl.addEventListener('input', () => {
        _mutedFilter = searchEl.value || '';
        _renderMutedList();
      });
    }
    // Manual add
    const addBtn = document.getElementById('conv-add-mute');
    if (addBtn && !addBtn.dataset.wired) {
      addBtn.dataset.wired = '1';
      addBtn.addEventListener('click', async () => {
        const handle = _cleanHandle(document.getElementById('conv-add-handle')?.value);
        const platform = document.getElementById('conv-add-platform')?.value || '';
        const reason = document.getElementById('conv-add-reason')?.value || '';
        const note = document.getElementById('conv-add-note')?.value || '';
        const status = document.getElementById('conv-add-status');
        if (!handle) {
          if (status) status.textContent = 'Handle is required.';
          return;
        }
        if (status) status.textContent = 'Muting…';
        try {
          await _mute(platform, handle, reason, note);
          const inp = document.getElementById('conv-add-handle');
          const n = document.getElementById('conv-add-note');
          if (inp) inp.value = '';
          if (n) n.value = '';
          if (status) status.textContent = `Muted @${handle}.`;
        } catch (err) {
          if (status) status.textContent = 'Failed: ' + (err.message || err);
        }
      });
    }
    // "Mute owned accounts from config" controls inside the muted panel.
    const ownedSel = document.getElementById('conv-owned-slug');
    if (ownedSel && !ownedSel.dataset.wired) {
      ownedSel.dataset.wired = '1';
      _populateOwnedSlugSelect();
    }
    const ownedBtn = document.getElementById('conv-owned-import');
    if (ownedBtn && !ownedBtn.dataset.wired) {
      ownedBtn.dataset.wired = '1';
      ownedBtn.addEventListener('click', _importOwnedAccounts);
    }
    const teamBtn = document.getElementById('conv-team-import');
    if (teamBtn && !teamBtn.dataset.wired) {
      teamBtn.dataset.wired = '1';
      teamBtn.addEventListener('click', _importTeamNoTriageAccounts);
    }
  }

  async function _populateOwnedSlugSelect() {
    const sel = document.getElementById('conv-owned-slug');
    if (!sel) return;
    try {
      const data = await fetch('/api/configs').then((r) => r.json());
      const configs = Array.isArray(data.configs) ? data.configs : [];
      if (!configs.length) {
        sel.innerHTML = '<option value="">(no configs)</option>';
        return;
      }
      sel.innerHTML = configs
        .map((c) => `<option value="${esc(c.slug)}">${esc(c.slug)}</option>`)
        .join('');
    } catch {
      sel.innerHTML = '<option value="">(failed to load)</option>';
    }
  }

  async function _importOwnedAccounts() {
    const sel = document.getElementById('conv-owned-slug');
    const status = document.getElementById('conv-owned-status');
    const slug = sel && sel.value;
    if (!slug) {
      if (status) status.textContent = 'Pick a config first.';
      return;
    }
    if (status) status.textContent = 'Importing…';
    try {
      const res = await fetch('/api/muted-accounts/import-owned', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const added = (data.added || []).length;
      const parsed = data.parsed || 0;
      if (status) {
        status.textContent = parsed
          ? `Muted ${added} of ${parsed} owned account(s).`
          : 'No owned accounts found in this config.';
      }
      await _refreshMutedPanel();
      await loadConversations();
    } catch (err) {
      if (status) status.textContent = 'Import failed: ' + (err.message || err);
    }
  }

  async function _importTeamNoTriageAccounts() {
    const sel = document.getElementById('conv-owned-slug');
    const status = document.getElementById('conv-team-status') || document.getElementById('conv-owned-status');
    const slug = sel && sel.value;
    if (!slug) {
      if (status) status.textContent = 'Pick a config first.';
      return;
    }
    if (status) status.textContent = 'Importing team…';
    try {
      const res = await fetch('/api/muted-accounts/import-team-members', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const added = (data.added || []).length;
      const parsed = data.parsed || 0;
      if (status) {
        status.textContent = parsed
          ? `Marked ${added} of ${parsed} team handle(s) no-triage.`
          : 'No team handles found. Add platform aliases like (linkedin: name) to Product Team Members.';
      }
      await _refreshMutedPanel();
      await loadConversations();
    } catch (err) {
      if (status) status.textContent = 'Import failed: ' + (err.message || err);
    }
  }

  // ============================================================
  // Dashboard intel cards
  // ============================================================
  async function loadIntelCards() {
    if (!document.getElementById('dash-sentiment')) return;
    await Promise.all([loadSentiment(), loadCreators(), loadSourceHealth(), loadSocialActivity()]);
  }

  // ----- Post URL validation ---------------------------------------
  // Syntactic + live check used by the social-activity card to hide dead
  // links. Results cached client-side; the server has its own 1h cache.
  function isValidPostUrl(u) {
    if (!u || typeof u !== 'string') return false;
    let parsed;
    try { parsed = new URL(u); } catch { return false; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (!parsed.hostname || !parsed.hostname.includes('.')) return false;
    return true;
  }
  const _urlLiveCache = new Map(); // url -> Promise<{ok,status}>
  const URL_CHECK_TIMEOUT_MS = 1500;
  function checkUrlLive(u, timeoutMs = URL_CHECK_TIMEOUT_MS) {
    if (!isValidPostUrl(u)) return Promise.resolve({ ok: false, status: 0, reason: 'malformed' });
    if (_urlLiveCache.has(u)) return _urlLiveCache.get(u);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const p = fetch(`/api/check-url?u=${encodeURIComponent(u)}`, { signal: ac.signal })
      .then((r) => r.json())
      .catch((err) => ({ ok: false, status: 0, reason: err?.name === 'AbortError' ? 'timeout' : 'fetch-failed' }))
      .finally(() => clearTimeout(t));
    _urlLiveCache.set(u, p);
    return p;
  }
  // Expose so dashboard-enhancer.js (and any other dashboard module) can
  // honor the "never put dead links in the dashboard" rule.
  window.csUrlCheck = { isValidPostUrl, checkUrlLive };

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
      const data = await fetch('/api/conversations?includeProduct=1').then((r) => r.json());
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

      // Pre-validate every URL we might render so dead links never reach the
      // dashboard. Items whose URL is malformed or unreachable get their
      // url stripped — the item itself stays (as plain text / no-link form)
      // so we don't silently lose conversation context. Server caches probe
      // results for 1h, so repeat loads are effectively free.
      const urlSet = new Set();
      for (const c of all) {
        if (c && isValidPostUrl(c.url)) urlSet.add(c.url);
      }
      const urls = [...urlSet].slice(0, 24); // hard cap on per-load probes
      const liveMap = new Map();
      const PROBE_CONC = 6;
      const PROBE_BUDGET_MS = 4000;
      const deadline = Date.now() + PROBE_BUDGET_MS;
      let pi = 0;
      async function probeWorker() {
        while (pi < urls.length) {
          if (Date.now() > deadline) break;
          const u = urls[pi++];
          try {
            const r = await checkUrlLive(u);
            liveMap.set(u, !!(r && r.ok));
          } catch {
            liveMap.set(u, false);
          }
        }
      }
      await Promise.all(Array.from({ length: PROBE_CONC }, probeWorker));
      // Strip URLs that failed the probe (or that we didn't probe due to the
      // cap — treat those as unknown/dead to honor "never put dead links").
      for (const c of all) {
        if (!c) continue;
        if (!isValidPostUrl(c.url)) { c.url = ''; continue; }
        if (liveMap.get(c.url) !== true) c.url = '';
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
          const sample =
            b.community.find((x) => isValidPostUrl(x.url)) ||
            b.product.find((x) => isValidPostUrl(x.url)) ||
            b.community[0] ||
            b.product[0];
          const sampleHasUrl = sample && isValidPostUrl(sample.url);
          const sampleHtml = sample
            ? `<div class="dash-plat-sample">
                ${sampleHasUrl ? `<a href="${esc(sample.url)}" class="dash-link" data-check-url="${esc(sample.url)}" data-conv-key="${esc(sample.key || '')}" target="_blank" rel="noopener" title="Open in Conversations (Ctrl/Cmd-click for source)">${esc(trim(sample.summary || sample.author || '(post)', 100))}</a>` : esc(trim(sample.summary || sample.author || '(post)', 100))}
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
              const hasUrl = isValidPostUrl(c.url);
              const link = hasUrl
                ? `<a href="${esc(c.url)}" class="dash-link" data-check-url="${esc(c.url)}" data-conv-key="${esc(c.key || '')}" target="_blank" rel="noopener" title="Open in Conversations (Ctrl/Cmd-click for source)">Source ↗</a>`
                : '';
              const replyBtn = hasUrl
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

      // Social pulse links go to the Conversations view by default so
      // users can read the post inline. Ctrl/Cmd/middle-click still
      // opens the external source in a new tab.
      host.querySelectorAll('a.dash-link[data-conv-key]').forEach((a) => {
        const k = a.dataset.convKey;
        if (!k) return;
        a.addEventListener('click', (e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
          e.preventDefault();
          _navigateToConversation(k);
        });
      });
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
              delta = `<span class="sent-delta">Δ ${dp >= 0 ? '+' + dp : dp} 🟢, ${
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
