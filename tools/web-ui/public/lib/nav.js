export const KNOWN_VIEWS = ['dashboard', 'setup', 'configs', 'run', 'reports', 'tools', 'social', 'conversations'];

export function isKnownView(view) {
  return KNOWN_VIEWS.includes(view);
}

export function initNavigation(handlers = {}) {
  function gotoView(view) {
    document.querySelectorAll('nav button').forEach((button) => {
      const isActive = button.dataset.view === view;
      button.classList.toggle('active', isActive);
      if (isActive) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    document.querySelectorAll('.view').forEach((viewEl) => {
      viewEl.classList.toggle('active', viewEl.id === `view-${view}`);
    });
    if (isKnownView(view) && location.hash !== `#${view}`) {
      history.replaceState(null, '', `#${view}`);
    }
    if (view === 'setup') handlers.loadSetup?.();
    if (view === 'configs') {
      handlers.loadConfigList?.();
      handlers.renderConfigsEnv?.();
    }
    if (view === 'reports') handlers.loadReports?.();
    if (view === 'tools') handlers.loadTools?.();
    if (view === 'social') handlers.loadSocial?.();
    if (view === 'run') handlers.loadSlugOptions?.();
    if (view === 'dashboard') handlers.loadDashboard?.();
    if (view === 'conversations') handlers.loadConversations?.();
  }

  document.querySelectorAll('nav button').forEach((button) => {
    button.addEventListener('click', () => gotoView(button.dataset.view));
  });
  window.addEventListener('hashchange', () => {
    const view = location.hash.replace(/^#/, '');
    if (isKnownView(view)) gotoView(view);
  });
  document.addEventListener('click', (event) => {
    const goto = event.target.closest?.('[data-goto]');
    if (!goto) return;
    event.preventDefault();
    gotoView(goto.dataset.goto);
  });

  return { gotoView };
}
