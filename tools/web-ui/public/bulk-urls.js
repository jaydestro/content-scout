/* Content Scout — Bulk URL submitter
 * Adds a "Bulk URLs…" button (visible only for URL-oriented commands) and a
 * dialog that accepts a pasted list, .txt file, or .csv file. Submits to
 * POST /api/runs/bulk which queues one run per URL.
 */
(function () {
  const BULK_COMMANDS = new Set(['scout-post', 'scout-seo', 'scout-reddit-import', 'scout-alt']);

  const $ = (id) => document.getElementById(id);

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  ready(() => {
    const cmdSelect = $('run-command');
    const wrap = $('run-bulk-wrap');
    const dialog = $('bulk-urls-dialog');
    const openBtn = $('run-bulk-open');
    const submitBtn = $('bulk-urls-submit');
    const textarea = $('bulk-urls-text');
    const fileInput = $('bulk-urls-file');
    const preview = $('bulk-urls-preview');
    const cmdHint = $('bulk-urls-cmd-hint');
    const dialogCmd = $('bulk-urls-command');
    if (!wrap || !dialog || !openBtn || !submitBtn) return;

    let parsedUrls = [];

    function chosenCommand() {
      if (dialogCmd && dialogCmd.value) return dialogCmd.value;
      if (cmdSelect && BULK_COMMANDS.has(cmdSelect.value)) return cmdSelect.value;
      return 'scout-post';
    }

    function refreshHint() {
      if (cmdHint) cmdHint.textContent = `Each URL becomes its own /${chosenCommand()} run, executed one at a time.`;
    }
    if (dialogCmd) dialogCmd.addEventListener('change', refreshHint);

    function extractFromText(text) {
      // Accept one URL per line OR CSV with a header row that includes "url".
      // CSVs may also include a `notes` column whose value is forwarded to
      // the server and appended to the per-URL prompt as guidance for the
      // generated post (tone, audience, angle, things to avoid, etc.).
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return [];
      const first = lines[0].toLowerCase();
      const looksCsv = first.includes(',') && /(^|,)\s*url\s*(,|$)/.test(first);
      const out = new Map();
      if (looksCsv) {
        const headers = splitCsv(lines[0]).map((h) => h.toLowerCase().trim());
        const urlCol = headers.indexOf('url');
        const notesCol = headers.indexOf('notes');
        if (urlCol === -1) return [];
        for (let i = 1; i < lines.length; i++) {
          const row = lines[i];
          if (row.startsWith('#')) continue;
          const cols = splitCsv(row);
          const u = (cols[urlCol] || '').trim();
          if (!/^https?:\/\//i.test(u)) continue;
          const notes = notesCol !== -1 ? (cols[notesCol] || '').trim() : '';
          if (!out.has(u)) out.set(u, notes);
        }
      } else {
        for (const l of lines) {
          if (l.startsWith('#')) continue;
          // Take first token if line has whitespace or a comma.
          const tok = l.split(/[\s,]/)[0].trim();
          if (/^https?:\/\//i.test(tok) && !out.has(tok)) out.set(tok, '');
        }
      }
      return [...out.entries()].map(([url, notes]) => ({ url, notes }));
    }

    // Minimal CSV row splitter — handles double-quoted fields and embedded commas.
    function splitCsv(row) {
      const out = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        if (inQuotes) {
          if (ch === '"' && row[i + 1] === '"') { cur += '"'; i++; }
          else if (ch === '"') { inQuotes = false; }
          else { cur += ch; }
        } else {
          if (ch === '"') inQuotes = true;
          else if (ch === ',') { out.push(cur); cur = ''; }
          else cur += ch;
        }
      }
      out.push(cur);
      return out;
    }

    function recompute() {
      const fromText = extractFromText(textarea.value || '');
      // File contents are merged in via fileInput change handler (it appends
      // to the textarea), so this single source of truth is enough.
      parsedUrls = fromText;
      if (!parsedUrls.length) {
        preview.textContent = 'No URLs detected yet.';
        submitBtn.disabled = true;
      } else {
        const head = parsedUrls.slice(0, 3).map((e) => e.url).join(', ');
        const more = parsedUrls.length > 3 ? `, +${parsedUrls.length - 3} more` : '';
        const withNotes = parsedUrls.filter((e) => e.notes).length;
        const notesNote = withNotes
          ? ` — ${withNotes} with notes (will shape the generated post)`
          : '';
        preview.textContent = `${parsedUrls.length} URL${parsedUrls.length === 1 ? '' : 's'} detected: ${head}${more}${notesNote}`;
        submitBtn.disabled = false;
      }
    }
    textarea.addEventListener('input', recompute);

    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      try {
        const txt = await f.text();
        const sep = textarea.value && !textarea.value.endsWith('\n') ? '\n' : '';
        textarea.value = (textarea.value || '') + sep + txt;
        recompute();
      } catch (err) {
        preview.textContent = `Could not read file: ${err.message}`;
      } finally {
        fileInput.value = '';
      }
    });

    function openDialog() {
      // Pre-select the picker from the form's current command if eligible.
      if (dialogCmd && cmdSelect && BULK_COMMANDS.has(cmdSelect.value)) {
        dialogCmd.value = cmdSelect.value;
      }
      refreshHint();
      textarea.value = '';
      parsedUrls = [];
      preview.textContent = 'No URLs detected yet.';
      submitBtn.disabled = true;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    function closeDialog() {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
    openBtn.addEventListener('click', openDialog);
    const socialOpen = $('social-bulk-open');
    if (socialOpen) {
      socialOpen.addEventListener('click', () => {
        if (dialogCmd) dialogCmd.value = 'scout-post';
        openDialog();
      });
    }
    dialog.querySelectorAll('[data-bulk-close]').forEach((b) => {
      b.addEventListener('click', closeDialog);
    });

    submitBtn.addEventListener('click', async () => {
      if (!parsedUrls.length) return;
      submitBtn.disabled = true;
      const prevLabel = submitBtn.textContent;
      submitBtn.textContent = 'Queuing…';
      try {
        const slug = ($('run-slug') && $('run-slug').value) || '';
        const extra = ($('run-extra') && $('run-extra').value.trim()) || '';
        const range = (typeof window.dateRangePhrase === 'function')
          ? window.dateRangePhrase()
          : '';
        const concEl = $('bulk-urls-concurrency');
        const concurrency = concEl ? Number(concEl.value) || 1 : 1;
        const res = await fetch('/api/runs/bulk', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            command: chosenCommand(),
            slug,
            extra,
            range,
            concurrency,
            // Send { url, notes } objects so the server can append each
            // note to that URL's prompt as guidance for the generated post.
            urls: parsedUrls,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          preview.textContent = data.error || 'failed to queue';
          submitBtn.disabled = false;
          submitBtn.textContent = prevLabel;
          if (window.toast && window.toast.error) {
            window.toast.error('Bulk queue failed', data.error || 'failed to queue');
          }
          return;
        }
        if (window.toast && window.toast.success) {
          const conc = data.concurrency || 1;
          const mode = conc === 1
            ? 'Each URL runs sequentially.'
            : `Running up to ${conc} subagents in parallel.`;
          window.toast.success(
            `Bulk /${chosenCommand()} started — ${data.queued} sub-operation${data.queued === 1 ? '' : 's'}`,
            `${mode} The Operations queue will show one row for the whole bulk; you'll get a single notification when every sub-operation finishes.`,
          );
        }
        closeDialog();
      } catch (err) {
        preview.textContent = err.message;
        submitBtn.disabled = false;
        submitBtn.textContent = prevLabel;
        if (window.toast && window.toast.error) {
          window.toast.error('Bulk submit failed', err.message);
        }
      }
    });
  });

  // Bulk completion is announced centrally by runs-queue.js, which polls
  // /api/runs (now including a `bulks` array) and toasts exactly once
  // when the whole batch transitions from running → terminal. That
  // matches the "single operation" model: one start toast, one finish
  // toast, no per-child noise.
})();
