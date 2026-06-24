import { $, escapeAttr } from './core.js';

// Wire a list-filter input that hides <li> rows whose text doesn't match,
// and (for queries >= 2 chars) calls /api/search to mark/show files whose
// CONTENT matches even when the name doesn't. Idempotent: safe to call
// every time the list is rebuilt.
export function wireListFilter({ inputId, listId, kind, includeItem }) {
  const input = $(inputId);
  const list = $(listId);
  if (!input || !list) return;
  let timer = null;
  let lastSeq = 0;
  const apply = async () => {
    const q = (input.value || '').trim().toLowerCase();
    const items = list.querySelectorAll('li[data-name]');
    let visible = 0;
    items.forEach((li) => {
      const name = (li.dataset.name || '').toLowerCase();
      // Also match the visible title + summary text, so a user typing
      // "cosmos" matches even when the rail row is now showing the H1
      // title instead of the raw filename.
      const titleEl = li.querySelector('.entry-title');
      const summaryEl = li.querySelector('.entry-summary');
      const haystack = [name, titleEl?.textContent || '', summaryEl?.textContent || '']
        .join(' ')
        .toLowerCase();
      const allowed = typeof includeItem === 'function' ? includeItem(li) : true;
      const matchName = allowed && (!q || haystack.includes(q));
      li.hidden = !matchName;
      li.classList.remove('content-match');
      if (matchName) visible++;
    });
    const ph = list.querySelector('li.filter-empty');
    if (ph) ph.remove();
    if (q.length >= 2) {
      const seq = ++lastSeq;
      try {
        const r = await fetch('/api/search?q=' + encodeURIComponent(q));
        if (!r.ok) return;
        const data = await r.json();
        if (seq !== lastSeq) return;
        const files = (data.files || []).filter((f) => f.kind === kind);
        files.forEach((f) => {
          const li = list.querySelector(`li[data-name="${CSS.escape(f.name)}"]`);
          if (!li) return;
          if (typeof includeItem === 'function' && !includeItem(li)) return;
          if (li.hidden) {
            li.hidden = false;
            visible++;
          }
          li.classList.add('content-match');
          const firstSnippet = (f.snippets && f.snippets[0]) || null;
          li.title = firstSnippet ? `Content match — L${firstSnippet.line}: ${firstSnippet.text}` : 'Content match';
        });
      } catch { /* ignore */ }
    }
    if (q && visible === 0) {
      const li = document.createElement('li');
      li.className = 'hint filter-empty';
      li.textContent = 'No matches.';
      list.appendChild(li);
    }
  };
  input.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(apply, 140);
  });
  if (input.value) apply();
}

// Render a single list row for a report or social-posts file. Uses the
// `meta` blob the server attaches to each /api/reports entry.
export function renderDocListItem(r) {
  const meta = r.meta || {};
  const title = escapeAttr(meta.title || r.name);
  const subject = meta.subjectLabel ? escapeAttr(meta.subjectLabel) : '';
  const kind = meta.kindLabel ? escapeAttr(meta.kindLabel) : '';
  const summary = meta.summary ? escapeAttr(meta.summary) : '';
  const range = meta.dateRange ? escapeAttr(meta.dateRange) : '';
  let stamp = '';
  if (meta.date && meta.time) {
    const hh = meta.time.slice(0, 2);
    const mm = meta.time.slice(2, 4);
    stamp = `${meta.date} ${hh}:${mm}`;
  } else {
    stamp = (r.mtime || '').slice(0, 10);
  }
  const subtitleBits = [];
  if (subject && !meta.title?.toLowerCase().includes(subject.toLowerCase())) {
    subtitleBits.push(subject);
  }
  if (range) subtitleBits.push(range);
  const subtitle = subtitleBits.join(' · ');
  return `<li data-name="${escapeAttr(r.name)}" title="${escapeAttr(r.name)}">
        <div class="entry-row">
          ${kind ? `<span class="entry-kind kind-${escapeAttr(meta.kind || 'doc')}">${kind}</span>` : ''}
          <span class="entry-title">${title}</span>
          <a class="entry-open" href="/view/reports/${encodeURIComponent(r.name)}" target="_blank" rel="noopener" title="Open in new window" aria-label="Open ${escapeAttr(r.name)} in new window">↗</a>
        </div>
        ${subtitle ? `<div class="entry-subtitle">${subtitle}</div>` : ''}
        ${summary ? `<div class="entry-summary">${summary}</div>` : ''}
        <div class="entry-meta"><span class="mtime">${escapeAttr(stamp)}</span></div>
      </li>`;
}

// Render a markdown doc into the inline article view, with a toolbar that
// includes an "Open in new window" link pointing at the standalone /view/*
// route. Used by both the Reports and Social lists.
export function renderDocBody(article, { name, html, kind }) {
  if (!article) return;
  const viewPath = `/view/${kind}/${encodeURIComponent(name)}`;
  article.innerHTML = `
    <div class="doc-toolbar">
      <a href="${viewPath}" target="_blank" rel="noopener" class="doc-open-link" title="Open ${name} in a new window">Open in new window ↗</a>
    </div>
    <div class="doc-content">${html}</div>
  `;
  if (kind === 'reports') wireReportPostLinks(article.querySelector('.doc-content'));
}

// In rendered reports the "Posts" column uses a bare in-page anchor
// (`[posts](#N)`, where N is the item number). Left alone, clicking one just
// pushes a junk hash onto the SPA URL (e.g. /#11) and does nothing. Intercept
// those numeric `#N` anchors and route to the Social view's "Create posts for
// me" form, pre-filled with the row's source link + title so the user can
// generate posts in one click. Non-numeric in-page anchors (e.g. a table of
// contents like `#partitioning`) are left untouched.
function wireReportPostLinks(content) {
  if (!content) return;
  content.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || !content.contains(a)) return;
    if (!/^#\d+$/.test(a.getAttribute('href') || '')) return;
    e.preventDefault();
    const { url, title } = extractReportRowContext(a);
    routeToSocialGenerate(url, title);
  });
}

// Pull the source URL + a human title out of the table row that owns the
// clicked "posts" link. The first http(s) link in the row is the canonical
// content URL; the title is the longest cell that isn't a date or pure number.
function extractReportRowContext(a) {
  const row = a.closest('tr');
  if (!row) return { url: '', title: '' };
  const url =
    [...row.querySelectorAll('a[href^="http"]')]
      .map((el) => el.getAttribute('href'))
      .find(Boolean) || '';
  const title =
    [...row.children]
      .map((td) => td.textContent.trim())
      .filter((t) => t && !/^\d{4}-\d{2}-\d{2}$/.test(t) && !/^\d+$/.test(t))
      .sort((x, y) => y.length - x.length)[0] || '';
  return { url, title };
}

// Switch to the Social view and pre-fill the "Create posts for me" form.
function routeToSocialGenerate(url, title) {
  const navBtn = document.querySelector('nav button[data-view="social"]');
  if (navBtn) navBtn.click();
  else window.location.hash = '#social';
  // Let the view render, then prefill the generate form.
  setTimeout(() => {
    const urlInput = document.getElementById('social-gen-url');
    const ctxInput = document.getElementById('social-gen-context');
    if (urlInput) {
      urlInput.value = url || '';
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (ctxInput && title && !ctxInput.value.trim()) ctxInput.value = `Source: ${title}`;
    const card = document.querySelector('#view-social .social-generate');
    card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    (urlInput || card)?.focus?.();
  }, 150);
}
