/* Content Scout — Toast notifications
 * Lightweight, dependency-free. Exposes window.toast({ title, description, type, duration }).
 * type: 'info' (default) | 'success' | 'error' | 'warn'
 */
(function () {
  const ICONS = {
    info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><circle cx="12" cy="8" r="0.5" fill="currentColor"/></svg>',
    success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>',
    error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
    warn: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><circle cx="12" cy="17" r="0.5" fill="currentColor"/></svg>',
  };

  function getStack() {
    let stack = document.getElementById('toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toast-stack';
      stack.setAttribute('role', 'status');
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    return stack;
  }

  function show({ title = '', description = '', type = 'info', duration = 4500 } = {}) {
    const stack = getStack();
    const el = document.createElement('div');
    el.className = 'toast';
    el.dataset.type = type;
    el.innerHTML = `
      ${ICONS[type] || ICONS.info}
      <div class="toast-body">
        ${title ? `<div class="toast-title"></div>` : ''}
        ${description ? `<div class="toast-desc"></div>` : ''}
      </div>
      <button class="toast-close" aria-label="Dismiss">×</button>
    `;
    if (title) el.querySelector('.toast-title').textContent = title;
    if (description) el.querySelector('.toast-desc').textContent = description;

    const dismiss = () => {
      el.classList.add('leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    };
    el.querySelector('.toast-close').addEventListener('click', dismiss);
    if (duration > 0) setTimeout(dismiss, duration);

    stack.appendChild(el);
    return { dismiss };
  }

  window.toast = show;
  window.toast.success = (title, description, opts = {}) => show({ title, description, ...opts, type: 'success' });
  window.toast.error   = (title, description, opts = {}) => show({ title, description, ...opts, type: 'error' });
  window.toast.warn    = (title, description, opts = {}) => show({ title, description, ...opts, type: 'warn' });
  window.toast.info    = (title, description, opts = {}) => show({ title, description, ...opts, type: 'info' });
})();
