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
    const dropzone = $('bulk-urls-dropzone');
    const preview = $('bulk-urls-preview');
    const cmdHint = $('bulk-urls-cmd-hint');
    const dialogCmd = $('bulk-urls-command');
    if (!dialog || !submitBtn) return;

    let parsedUrls = [];

    // Snapshot the full set of bulk-eligible commands at init time so we can
    // rebuild the dropdown when locked/unlocked. This is more defensive than
    // toggling `hidden` on the picker (which can be defeated by a stray CSS
    // rule) — if we lock to scout-post, the <select> literally contains only
    // that <option> and the user has nothing else to pick.
    const ALL_CMD_OPTIONS = dialogCmd
      ? [...dialogCmd.options].map((o) => ({ value: o.value, label: o.textContent }))
      : [];

    function setCommandOptions(lockedCommand) {
      if (!dialogCmd) return;
      const opts = lockedCommand
        ? ALL_CMD_OPTIONS.filter((o) => o.value === lockedCommand)
        : ALL_CMD_OPTIONS;
      dialogCmd.innerHTML = '';
      for (const o of opts) {
        const el = document.createElement('option');
        el.value = o.value;
        el.textContent = o.label;
        dialogCmd.appendChild(el);
      }
      if (lockedCommand) dialogCmd.value = lockedCommand;
    }

    function chosenCommand() {
      if (dialogCmd && dialogCmd.value) return dialogCmd.value;
      if (cmdSelect && BULK_COMMANDS.has(cmdSelect.value)) return cmdSelect.value;
      return 'scout-post';
    }

    function refreshHint() {
      if (cmdHint) cmdHint.textContent = `Each URL becomes its own /${chosenCommand()} run, executed one at a time.`;
      refreshInherited();
    }
    if (dialogCmd) dialogCmd.addEventListener('change', refreshHint);

    // Build the same tuner string that app.js's single-post form produces
    // so bulk runs inherit tone, platforms, length, emoji, hashtags,
    // link-in-comments, mention-authors, and variants. Returns '' when no
    // controls are present (defensive against partial DOMs).
    // Strip characters that would break the bracketed tuner contract or
    // smuggle additional directives into the prompt. Mirrors the sanitizer
    // applied to bulk-run notes server-side.
    function sanitizeFreeformTuner(raw) {
      if (typeof raw !== 'string') return '';
      return raw
        .replace(/[\x00-\x1f\x7f]+/g, ' ')
        .replace(/[\[\]]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
    }

    function buildSocialTuners() {
      if (!$('social-gen-tone')) return '';
      const tone = ($('social-gen-tone')?.value || 'conversational').trim();
      const emoji = ($('social-gen-emoji')?.value || 'light').trim();
      const variants = ($('social-gen-variants')?.value || '3').trim();
      const length = ($('social-gen-length')?.value || 'tease').trim();
      const lic = $('social-gen-lic')?.checked ? 'yes' : 'no';
      const hashtags = $('social-gen-hashtags')?.checked ? 'yes' : 'no';
      const mention = $('social-gen-mention')?.checked ? 'yes' : 'no';
      const thumbStyle = ($('social-gen-thumb-style')?.value || 'auto').trim();
      const thumbNotes = sanitizeFreeformTuner($('social-gen-thumb-notes')?.value || '');
      const platforms = ['li', 'x', 'bsky', 'rd']
        .filter((k) => $(`social-gen-pf-${k}`)?.checked)
        .map((k) => ({ li: 'linkedin', x: 'x', bsky: 'bluesky', rd: 'reddit' }[k]))
        .join(',') || 'linkedin,x';
      return (
        ` [tone: ${tone}]` +
        ` [platforms: ${platforms}]` +
        ` [length: ${length}]` +
        ` [emoji: ${emoji}]` +
        ` [hashtags: ${hashtags}]` +
        ` [mention-authors: ${mention}]` +
        ` [link-in-comments: ${lic}]` +
        ` [variants: ${variants}]` +
        ` [thumbnails: ${thumbStyle}]` +
        (thumbNotes ? ` [thumbnail-notes: ${thumbNotes}]` : '')
      );
    }

    // Expose so the bulk submit handler can also forward the skip flag.
    function bulkThumbnailsOff() {
      const v = ($('social-gen-thumb-style')?.value || 'auto').trim();
      return v === 'off';
    }

    // Populate the "Options inherited from the form above" panel so users
    // can see exactly what every queued run will get. Tuners only apply to
    // /scout-post; hide the row for the other bulk commands.
    function refreshInherited() {
      const subjEl = $('bulk-opt-subject');
      const rangeEl = $('bulk-opt-range');
      const extraEl = $('bulk-opt-extra');
      const tunersEl = $('bulk-opt-tuners');
      const tunersRow = $('bulk-opt-tuners-row');
      if (subjEl) {
        const slug = ($('run-slug') && $('run-slug').value) || '';
        subjEl.textContent = slug || '(none — server picks active config)';
      }
      if (rangeEl) {
        const range = (typeof window.dateRangePhrase === 'function')
          ? window.dateRangePhrase()
          : '';
        rangeEl.textContent = range || '(default)';
      }
      if (extraEl) {
        const extra = ($('run-extra') && $('run-extra').value.trim()) || '';
        extraEl.textContent = extra || '(none)';
      }
      if (tunersRow && tunersEl) {
        if (chosenCommand() === 'scout-post') {
          const tuners = buildSocialTuners().trim();
          if (tuners) {
            tunersEl.textContent = tuners;
            tunersRow.hidden = false;
          } else {
            tunersRow.hidden = true;
          }
        } else {
          tunersRow.hidden = true;
        }
      }
    }

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

    // Append raw text (from a dropped/picked file or a text drop) to the
    // textarea, then re-parse. Shared by the file input and the dropzone.
    function appendText(txt) {
      if (!txt) return;
      const sep = textarea.value && !textarea.value.endsWith('\n') ? '\n' : '';
      textarea.value = (textarea.value || '') + sep + txt;
      recompute();
    }

    async function ingestFiles(files) {
      for (const f of files) {
        // Only read text-ish files; skip binaries silently.
        const okType = /^text\//.test(f.type) || /\.(txt|csv)$/i.test(f.name);
        if (!okType) continue;
        try {
          appendText(await f.text());
        } catch (err) {
          preview.textContent = `Could not read ${f.name}: ${err.message}`;
        }
      }
    }

    fileInput.addEventListener('change', async () => {
      const files = fileInput.files ? [...fileInput.files] : [];
      if (!files.length) return;
      await ingestFiles(files);
      fileInput.value = '';
    });

    // --- Drag-and-drop --------------------------------------------------
    // Mirrors the alt-text dropzone: click/keyboard to pick, drag to drop a
    // file, or drop selected text straight in.
    if (dropzone) {
      dropzone.addEventListener('click', (e) => {
        if (e.target.closest('a')) return; // let the template download link work
        fileInput.click();
      });
      dropzone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          fileInput.click();
        }
      });
      ['dragenter', 'dragover'].forEach((ev) => {
        dropzone.addEventListener(ev, (e) => {
          e.preventDefault(); e.stopPropagation();
          dropzone.classList.add('dragover');
        });
      });
      ['dragleave', 'drop'].forEach((ev) => {
        dropzone.addEventListener(ev, (e) => {
          e.preventDefault(); e.stopPropagation();
          dropzone.classList.remove('dragover');
        });
      });
      dropzone.addEventListener('drop', async (e) => {
        const dt = e.dataTransfer;
        if (!dt) return;
        const files = dt.files ? [...dt.files] : [];
        if (files.length) {
          await ingestFiles(files);
          return;
        }
        // No file — accept dropped text (e.g. a list of URLs).
        const text = dt.getData('text');
        if (text) appendText(text);
      });
    }

    function openDialog(opts = {}) {
      // When the caller pins a command (e.g. "Bulk URLs…" from the Social
      // view always means /scout-post), hide the picker entirely AND rebuild
      // the <select> so the only option in it is the locked command. Belt +
      // suspenders so the user can't accidentally pick scout-seo / scout-alt /
      // etc. even if a stray CSS rule defeats the hidden attribute.
      const lockedCommand = opts.lockedCommand || null;
      const cmdField = dialogCmd ? dialogCmd.closest('label.field') : null;
      const title = dialog.querySelector('.bulk-dialog-head h3');
      setCommandOptions(lockedCommand);
      if (lockedCommand) {
        if (cmdField) {
          cmdField.hidden = true;
          cmdField.style.display = 'none';
        }
        if (title) title.textContent = `Bulk /${lockedCommand} from URL list`;
      } else {
        if (cmdField) {
          cmdField.hidden = false;
          cmdField.style.display = '';
        }
        if (title) title.textContent = 'Bulk run from URL list';
        // Pre-select the picker from the Run-view form's current command if eligible.
        if (dialogCmd && cmdSelect && BULK_COMMANDS.has(cmdSelect.value)) {
          dialogCmd.value = cmdSelect.value;
        }
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
    if (openBtn) openBtn.addEventListener('click', () => openDialog());
    const socialOpen = $('social-bulk-open');
    if (socialOpen) {
      socialOpen.addEventListener('click', () => {
        openDialog({ lockedCommand: 'scout-post' });
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
        const extraBase = ($('run-extra') && $('run-extra').value.trim()) || '';
        // For /scout-post, append the same tuner string the single-post form
        // produces so bulk runs honor tone/platforms/length/emoji/hashtags/
        // link-in-comments/mention-authors/variants. Server concatenates
        // `extra` after each item URL, so the tuners ride along on every run.
        const tuners = chosenCommand() === 'scout-post' ? buildSocialTuners() : '';
        const extra = (extraBase + (tuners || '')).trim();
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
            // Forward the same skipThumbnails flag the single-post form sets,
            // so the post-run renderer is short-circuited for bulk batches
            // when the user picked "Thumbnail style: Off".
            options: chosenCommand() === 'scout-post'
              ? { skipThumbnails: bulkThumbnailsOff() }
              : {},
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
