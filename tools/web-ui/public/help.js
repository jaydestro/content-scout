// help.js — In-UI help system.
// Adds a "Help" button to the nav that opens a slide-out drawer with a
// glossary of every view, plus injects small "?" icons next to known
// section headings that pop a one-line explanation.
(() => {
  'use strict';

  // --- Glossary content -------------------------------------------------
  // Keyed by exact heading text. Used both for the drawer table-of-contents
  // and for the inline "?" tooltips.
  const TOPICS = {
    'Dashboard': {
      what: 'Your home screen. Shows what\'s new, what needs attention, and quick links to start a run.',
      tips: ['Use the action buttons at the top to jump straight into a scan or post-generation.'],
    },
    'Subjects & last scan': {
      what: 'A "subject" is one product, project, or topic you track (e.g. azure-cosmos-db). This card lists every subject you\'ve set up and when it was last scanned.',
      tips: ['Click "Scan" on a subject to start a fresh scan for just that one.'],
    },
    'Recent reports': {
      what: 'The most recent content reports the agent has generated. Each report is a markdown file listing articles, videos, and posts found about your subject.',
      tips: ['Click into the Reports view to read or open any of these.'],
    },
    'Recent runs': {
      what: 'Recent agent runs (scans, post generation, calendars). A run is one execution of a Scout command.',
    },
    'Suggestions': {
      what: 'Smart prompts based on the state of your workspace — stale subjects, reports without social posts, missing calendars, etc.',
      tips: ['Each suggestion has a one-click action button.'],
    },
    'Setup wizard': {
      what: 'Configure Content Scout: pick an AI agent to drive it, then set up subjects to track.',
    },
    'Pick an agent': {
      what: 'Content Scout doesn\'t do AI itself — it sends prompts to an AI coding agent (Claude Code, Copilot CLI, Cursor, etc.). Pick which one you have installed.',
      tips: ['You can change this any time. Custom runners use {prompt} as the placeholder.'],
    },
    'Configs': {
      what: 'A config is a markdown file that defines one subject — its name, search terms, sources, topic tags, and your role (developer advocate, marketer, PM, etc.).',
      tips: ['Edit configs to refine what counts as relevant content.'],
    },
    'Custom RSS Feeds': {
      what: 'Add any RSS or Atom feed as an extra source. The agent fetches it and applies the same date + relevancy + scoring filters as built-in sources. Format: one entry per line as "Name | URL".',
      tips: [
        'Most blogs already publish a feed — try /feed, /rss, /feed.xml, or /atom.xml on the site URL. View page source and search for "application/rss+xml" if those don\'t work.',
        'For sites without a feed (X/Twitter, Instagram, search pages), use an RSS bridge: rss.app (paid, point-and-click) or RSSHub (free, self-hostable, https://docs.rsshub.app/).',
        'X/Twitter keyword:  https://rsshub.app/twitter/keyword/<term>',
        'X/Twitter user:     https://rsshub.app/twitter/user/<handle>',
        'Google News:        https://news.google.com/rss/search?q=<query>&hl=en-US',
        'YouTube channel:    https://www.youtube.com/feeds/videos.xml?channel_id=<UC...>',
        'GitHub releases:    https://github.com/<owner>/<repo>/releases.atom',
        'Subreddit:          https://www.reddit.com/r/<sub>/.rss',
        'Verify before adding — paste the URL into a browser. You should see XML. If you get HTML or 404, it\'s not a valid feed.',
        'Full guide: docs/SOURCES.md → Custom RSS Feeds.',
      ],
    },
    'Run a command': {
      what: 'Pick a Scout command, choose subjects, and start the agent. Output streams live below.',
      tips: [
        'Scan: discover new content and write a report.',
        'Generate posts: turn a report item into ready-to-publish social posts.',
        'Calendar: build a weekly posting schedule.',
        'Gaps: find topics with no recent coverage.',
        'Trends: month-over-month comparison.',
      ],
    },
    'Reports': {
      what: 'Every saved scan report. Reports are markdown files; click one to read it rendered.',
    },
    'Social posts': {
      what: 'Drafted social posts (LinkedIn, X, Bluesky, etc.) and posting calendars generated from reports.',
    },
    'API keys (optional)': {
      what: 'Some sources need a key (YouTube, Reddit, Bluesky, X). Add keys here and the agent uses them automatically. Sources without keys are simply skipped — Content Scout always works with no keys at all.',
      tips: [
        'Stack Overflow, Hacker News, Dev.to, Medium, GitHub (read-only), and LinkedIn need NO keys.',
        'Hover the "?" next to each key field for a one-line explanation. Click it to open the full setup walkthrough in docs/API-KEYS.md.',
        'YouTube, Reddit, Bluesky, and a GitHub token are all FREE — only X requires a paid plan for reliable scanning.',
      ],
    },
    'Review & save': {
      what: 'Final check before saving. The wizard writes a config file under .github/prompts/ that the agent reads on every run.',
    },
    'Your role': {
      what: 'Tells the agent what kind of content matters to you. A developer advocate gets technical tutorials and conference talks; a marketer gets case studies and customer stories.',
    },
    'Search identity': {
      what: 'The exact terms the agent searches for. Include the official product name plus common variants and abbreviations.',
    },
    'Networks & output': {
      what: 'Which social networks to draft posts for, and the tone/voice you want.',
    },
    'Advanced settings': {
      what: 'Quality thresholds, date windows, custom topic tags, source preferences. Defaults are fine for most users.',
    },
    'How much do you want to customize?': {
      what: 'Quick = bare-minimum 3 fields. Standard = sensible defaults you can tweak. Full = every setting exposed.',
    },
    'What are you tracking?': {
      what: 'The product, project, or technology this config is about. Used as the slug for filenames and reports.',
    },
  };

  // --- Drawer ----------------------------------------------------------
  function ensureDrawer() {
    if (document.getElementById('help-drawer')) return;

    const drawer = document.createElement('aside');
    drawer.id = 'help-drawer';
    drawer.setAttribute('aria-hidden', 'true');
    drawer.innerHTML = `
      <div class="help-drawer-head">
        <h2>What is Content Scout?</h2>
        <button type="button" id="help-close" aria-label="Close help">×</button>
      </div>
      <div class="help-drawer-body">
        <p class="help-lede">
          Content Scout is an AI-powered content research assistant. It scans places where developers
          talk about your product (blogs, Reddit, Stack Overflow, YouTube, GitHub, etc.), filters for
          quality, and produces reports plus ready-to-post social media drafts.
        </p>

        <h3>The 5-minute mental model</h3>
        <ol class="help-steps">
          <li><strong>Set up a subject</strong> — what you want to track (e.g. "Azure Cosmos DB"). Done in <a href="#" data-goto="setup">Setup</a>.</li>
          <li><strong>Run a scan</strong> — the agent searches every source and writes a markdown report under <code>reports/</code>.</li>
          <li><strong>Generate social posts</strong> — turn an interesting report item into LinkedIn / X / Bluesky drafts.</li>
          <li><strong>Build a calendar</strong> — schedule those posts across the week.</li>
        </ol>

        <h3>Glossary</h3>
        <div id="help-glossary"></div>

        <h3>Where things live on disk</h3>
        <ul class="help-paths">
          <li><code>.github/prompts/scout-config-*.md</code> — your subject configs</li>
          <li><code>reports/</code> — scan output</li>
          <li><code>social-posts/</code> — social drafts and calendars</li>
          <li><code>.env</code> — API keys</li>
        </ul>

        <h3>Need more?</h3>
        <p class="hint">
          The repo's <code>README.md</code> and <code>docs/</code> folder have the deep version of all this.
          Or run <code>/scout-onboard</code> in the Run view for a guided chat walkthrough.
        </p>
      </div>
    `;
    document.body.appendChild(drawer);

    // Glossary list
    const glossary = drawer.querySelector('#help-glossary');
    const items = Object.entries(TOPICS)
      .filter(([, v]) => v.what)
      .sort(([a], [b]) => a.localeCompare(b));
    glossary.innerHTML = items.map(([k, v]) => `
      <details class="help-term">
        <summary>${escape(k)}</summary>
        <p>${escape(v.what)}</p>
        ${v.tips ? `<ul class="help-tips">${v.tips.map((t) => `<li>${escape(t)}</li>`).join('')}</ul>` : ''}
      </details>
    `).join('');

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.id = 'help-backdrop';
    backdrop.hidden = true;
    document.body.appendChild(backdrop);

    backdrop.addEventListener('click', closeDrawer);
    drawer.querySelector('#help-close').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer();
    });
  }

  function openDrawer(focusKey) {
    ensureDrawer();
    const drawer = document.getElementById('help-drawer');
    const backdrop = document.getElementById('help-backdrop');
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.hidden = false;
    if (focusKey) {
      const target = [...drawer.querySelectorAll('.help-term summary')]
        .find((s) => s.textContent === focusKey);
      if (target) {
        target.parentElement.open = true;
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }
  function closeDrawer() {
    const drawer = document.getElementById('help-drawer');
    const backdrop = document.getElementById('help-backdrop');
    if (!drawer) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    backdrop.hidden = true;
  }

  // --- Nav button ------------------------------------------------------
  function injectNavButton() {
    const nav = document.querySelector('.site-header nav');
    if (!nav || nav.querySelector('.help-nav-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'help-nav-btn';
    btn.textContent = 'Help';
    btn.title = 'What is this app? (Shift+?)';
    btn.addEventListener('click', () => openDrawer());
    nav.appendChild(btn);
  }

  // --- Inline "?" icons ------------------------------------------------
  function injectInlineHelp() {
    document.querySelectorAll('h2, h3').forEach((h) => {
      const text = h.textContent.trim();
      if (!TOPICS[text] || h.dataset.helpInjected) return;
      h.dataset.helpInjected = '1';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'help-icon';
      btn.setAttribute('aria-label', `What is ${text}?`);
      btn.title = TOPICS[text].what;
      btn.textContent = '?';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openDrawer(text);
      });
      h.appendChild(btn);
    });
  }

  // Re-run inline injection when views toggle (new headings become visible).
  function watchForNewHeadings() {
    const mo = new MutationObserver(() => injectInlineHelp());
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // Keyboard shortcut: Shift+?
  document.addEventListener('keydown', (e) => {
    if (e.shiftKey && e.key === '?') {
      const t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      e.preventDefault();
      openDrawer();
    }
  });

  function escape(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  }

  function init() {
    injectNavButton();
    injectInlineHelp();
    watchForNewHeadings();
    // Expose for command-palette integration
    window.scoutHelp = { open: openDrawer, close: closeDrawer };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
