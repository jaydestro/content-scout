/* Content Scout — Run button enhancer
 * Additive: watches #run-meta (which app.js already updates with
 * "Starting…" / "Running: ..." / "Done: ..." / "error: ...") and
 * keeps the #run-start button in a sane state so users can't
 * accidentally double-click and launch concurrent runs on the same
 * subject. Also auto-links any "Report saved: <path>" / "Social
 * posts saved: <path>" lines that show up in the run output.
 */
(function () {
  const SAVED_RE = /\b(Report saved|Social posts saved|Calendar saved):\s*([^\s`'"]+\.(?:md|json))/gi;

  let startBtn, meta, outputEl;
  let originalLabel = 'Start run';
  let lastState = 'idle';

  function init() {
    startBtn = document.getElementById('run-start');
    meta = document.getElementById('run-meta');
    outputEl = document.getElementById('run-output');
    if (!startBtn || !meta || !outputEl) return;

    originalLabel = startBtn.textContent.trim() || 'Start run';

    // Optimistic state flip the moment the user clicks — capture phase
    // so we run before app.js's own click handler.
    startBtn.addEventListener('click', onStartClick, true);

    // Drive button state from #run-meta updates emitted by app.js.
    new MutationObserver(syncFromMeta).observe(meta, {
      childList: true, characterData: true, subtree: true,
    });

    // Linkify saved-file paths as they stream in.
    new MutationObserver(linkifyPaths).observe(outputEl, {
      childList: true, characterData: true, subtree: true,
    });
  }

  function onStartClick() {
    setState('starting');
  }

  function syncFromMeta() {
    const text = (meta.textContent || '').trim();
    if (!text) return setState('idle');
    if (/^Starting/i.test(text)) return setState('starting');
    if (/^Running/i.test(text)) return setState('running');
    if (/^Done/i.test(text))    return setState('done');
    if (/^error/i.test(text))   return setState('error');
  }

  function setState(state) {
    if (state === lastState) return;
    lastState = state;
    startBtn.classList.remove('is-running', 'is-done', 'is-error');

    switch (state) {
      case 'starting':
        startBtn.disabled = true;
        startBtn.textContent = 'Starting…';
        startBtn.classList.add('is-running');
        break;
      case 'running':
        startBtn.disabled = true;
        startBtn.textContent = 'Run in progress…';
        startBtn.classList.add('is-running');
        break;
      case 'done':
        startBtn.disabled = false;
        startBtn.textContent = 'Start another run';
        startBtn.classList.add('is-done');
        if (window.toast && window.toast.success) {
          window.toast.success('Run finished', 'Click "Start another run" to launch a new one.');
        }
        break;
      case 'error':
        startBtn.disabled = false;
        startBtn.textContent = 'Try again';
        startBtn.classList.add('is-error');
        break;
      case 'idle':
      default:
        startBtn.disabled = false;
        startBtn.textContent = originalLabel;
        break;
    }
  }

  // --- Linkify saved-file paths in the run output ------------------
  // Replace plain-text "Report saved: foo.md" with an anchor that the
  // app's existing report viewer can pick up. We rewrite a <pre>'s
  // contents into a fragment of text + <a> nodes; harmless because the
  // <pre> is otherwise just appended-to as text by app.js.
  let linkifyScheduled = false;
  function linkifyPaths() {
    if (linkifyScheduled) return;
    linkifyScheduled = true;
    requestAnimationFrame(() => {
      linkifyScheduled = false;
      const pre = outputEl;
      const raw = pre.textContent || '';
      if (!SAVED_RE.test(raw)) return;
      // Avoid clobbering on every keystroke — only rebuild if we
      // actually find new unlinked matches.
      if (pre.dataset.linkifiedHash === String(raw.length)) return;
      pre.dataset.linkifiedHash = String(raw.length);

      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      raw.replace(SAVED_RE, (match, label, path, idx) => {
        if (idx > lastIndex) {
          frag.appendChild(document.createTextNode(raw.slice(lastIndex, idx)));
        }
        frag.appendChild(document.createTextNode(label + ': '));
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'run-saved-link';
        a.textContent = path;
        a.addEventListener('click', (e) => {
          e.preventDefault();
          openSavedPath(path);
        });
        frag.appendChild(a);
        lastIndex = idx + match.length;
        return match;
      });
      if (lastIndex < raw.length) {
        frag.appendChild(document.createTextNode(raw.slice(lastIndex)));
      }
      pre.replaceChildren(frag);
      pre.scrollTop = pre.scrollHeight;
    });
  }

  function openSavedPath(path) {
    const name = path.split('/').pop();
    if (path.startsWith('reports/')) {
      go('reports', () => clickListItem('#reports-list', name));
    } else if (path.startsWith('social-posts/')) {
      go('social', () => clickListItem('#social-list', name));
    }
  }
  function go(view, after) {
    const navBtn = document.querySelector(`nav button[data-view="${view}"]`);
    if (navBtn) navBtn.click();
    setTimeout(after, 180);
  }
  function clickListItem(selector, name) {
    const list = document.querySelector(selector);
    if (!list) return;
    const li = Array.from(list.querySelectorAll('li')).find((el) => el.dataset.name === name);
    if (li) li.click();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
