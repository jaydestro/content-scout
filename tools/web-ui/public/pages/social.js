import { $, api, escape } from '../lib/core.js';
import { wireListFilter, renderDocListItem, renderDocBody } from '../lib/doc-list.js';

const SOCIAL_REFRESH_MS = 12000;
let socialRefreshTimer = null;
let socialFilterWired = false;
let lastSocialSignature = '';

function isSocialViewActive() {
  const panel = document.getElementById('view-social');
  return !!panel && panel.classList.contains('active') && !document.hidden;
}

function ensureSocialAutoRefresh() {
  if (socialRefreshTimer) return;
  socialRefreshTimer = setInterval(() => {
    if (!isSocialViewActive()) return;
    loadSocial({ silent: true }).catch(() => {});
  }, SOCIAL_REFRESH_MS);
}

export async function loadSocial({ silent = false } = {}) {
  const { social } = await api('/api/reports');
  const signature = (social || []).map((r) => `${r.name}:${r.mtime}`).join('|');
  ensureSocialAutoRefresh();
  if (signature === lastSocialSignature) {
    if (!silent) window.dispatchEvent(new CustomEvent('scout:social-loaded'));
    return;
  }
  lastSocialSignature = signature;

  const prevSelected =
    $('social-list')?.querySelector('li.selected')?.dataset.name ||
    $('social-body')?.dataset.name ||
    '';

  $('social-list').innerHTML = social
    .map((report) => renderDocListItem(report).replace('/view/reports/', '/view/social/'))
    .join('') || '<li class="hint">No social posts yet.</li>';
  $('social-list').querySelectorAll('li[data-name]').forEach((li) => {
    li.addEventListener('click', async (event) => {
      if (event.target.closest('.entry-open')) return;
      document.querySelectorAll('#social-list li').forEach((item) => item.classList.remove('selected'));
      li.classList.add('selected');
      const socialDoc = await api(`/api/social/${encodeURIComponent(li.dataset.name)}`);
      renderDocBody($('social-body'), { name: li.dataset.name, html: socialDoc.html, kind: 'social' });
      $('social-body').dataset.name = li.dataset.name;
      enhanceSocialBody($('social-body'));
    });
  });
  const body = $('social-body');
  const selected = prevSelected
    ? $('social-list').querySelector(`li[data-name="${CSS.escape(prevSelected)}"]`)
    : null;
  const first = $('social-list').querySelector('li[data-name]');
  if (selected) {
    selected.classList.add('selected');
    if (!body || body.dataset.name !== prevSelected) selected.click();
  } else if (first && body && !body.dataset.name) {
    first.click();
  }
  if (!socialFilterWired) {
    wireListFilter({ inputId: 'social-filter', listId: 'social-list', kind: 'social-posts' });
    socialFilterWired = true;
  }
  if (!silent) window.dispatchEvent(new CustomEvent('scout:social-loaded'));
}

function enhanceSocialBody(root) {
  if (!root) return;

  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector(':scope > .copy-btn')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-btn';
    button.textContent = 'Copy';
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      const text = (pre.querySelector('code')?.innerText ?? pre.innerText).trim();
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied ✓';
        button.classList.add('copied');
        window.toast?.success?.({ title: 'Post copied to clipboard', duration: 2500 });
      } catch {
        button.textContent = 'Copy failed';
        window.toast?.error?.({ title: 'Could not copy', description: 'Browser blocked clipboard access.' });
      }
      setTimeout(() => { button.textContent = 'Copy'; button.classList.remove('copied'); }, 2000);
    });
    pre.appendChild(button);
  });

  const links = new Set();
  root.querySelectorAll('a[href^="http"]').forEach((anchor) => links.add(anchor.href));
  const existing = root.querySelector(':scope > .post-url-strip');
  if (existing) existing.remove();
  if (links.size) {
    const strip = document.createElement('div');
    strip.className = 'post-url-strip';
    strip.innerHTML =
      '<span class="post-url-label">URLs:</span>' +
      [...links].map((href) => {
        const safe = href.replace(/"/g, '&quot;');
        const short = href.length > 60 ? href.slice(0, 57) + '…' : href;
        return `<span class="post-url"><a href="${safe}" target="_blank" rel="noopener">${short}</a>` +
          `<button type="button" class="post-url-copy" data-url="${safe}" title="Copy URL">⎘</button></span>`;
      }).join('');
    root.prepend(strip);
    strip.querySelectorAll('.post-url-copy').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        const url = button.dataset.url || '';
        try {
          await navigator.clipboard.writeText(url);
          button.textContent = '✓';
          window.toast?.success?.({ title: 'URL copied', duration: 2000 });
          setTimeout(() => { button.textContent = '⎘'; }, 1500);
        } catch {
          window.toast?.error?.({ title: 'Could not copy URL' });
        }
      });
    });
  }

  const fileName = root.dataset.name;
  if (fileName) decorateInlineSocialImages(root, fileName);
}

function decorateInlineSocialImages(root, fileName) {
  root.querySelectorAll(':scope .inline-thumb-actions').forEach((node) => node.remove());
  const legacyGallery = root.querySelector(':scope > .social-image-gallery');
  if (legacyGallery) legacyGallery.remove();

  const images = [...root.querySelectorAll('.markdown img, .doc-content img')]
    .filter((image) => !image.closest('.gallery-item'));
  if (!images.length) return;

  const safeAttr = (value) => String(value).replace(/"/g, '&quot;');

  images.forEach((image) => {
    const raw = image.getAttribute('src') || '';
    const match = raw.match(/^(?:\.?\/?)?images\/(.+)$/);
    if (match) {
      const newUrl = `/brand-assets/${match[1]}`;
      image.src = newUrl;
      if (!image.parentElement || image.parentElement.tagName !== 'A') {
        const anchor = document.createElement('a');
        anchor.href = newUrl;
        anchor.target = '_blank';
        anchor.rel = 'noopener';
        anchor.title = `Open ${match[1].split('/').pop()}`;
        image.parentNode.insertBefore(anchor, image);
        anchor.appendChild(image);
      }
    }
    image.classList.add('inline-thumb');
    image.loading = 'lazy';

    const finalUrl = image.getAttribute('src');
    const fileBase = decodeURIComponent(finalUrl.split('/').pop());
    const batch = (finalUrl.match(/^\/brand-assets\/(.+)\/[^/]+$/) || [, ''])[1];
    const repoPath = `social-posts/images/${batch ? batch + '/' : ''}${fileBase}`;
    const wrap = image.closest('p, figure, li, div') || image.parentElement;
    const row = document.createElement('div');
    row.className = 'inline-thumb-actions';
    row.innerHTML =
      `<button type="button" class="thumb-btn" data-copy-path="${safeAttr(repoPath)}" title="Copy repo path">Copy path</button>` +
      `<a class="thumb-btn" href="${safeAttr(finalUrl)}" download="${safeAttr(fileBase)}">Download</a>` +
      `<a class="thumb-btn thumb-btn-ghost" href="${safeAttr(finalUrl)}" target="_blank" rel="noopener">Open full size</a>`;
    wrap.after(row);
  });

  root.querySelectorAll('.inline-thumb-actions [data-copy-path]').forEach((button) => {
    button.addEventListener('click', async () => {
      const path = button.dataset.copyPath || '';
      try {
        await navigator.clipboard.writeText(path);
        const label = button.textContent;
        button.textContent = 'Copied ✓';
        button.classList.add('copied');
        window.toast?.success?.({ title: 'Path copied', description: path, duration: 2000 });
        setTimeout(() => { button.textContent = label; button.classList.remove('copied'); }, 1600);
      } catch {
        window.toast?.error?.({ title: 'Could not copy path' });
      }
    });
  });
}

async function renderSocialImageGallery(root, fileName) {
  const prior = root.querySelector(':scope > .social-image-gallery');
  if (prior) prior.remove();
  let images = [];
  try {
    const response = await fetch(`/api/social/${encodeURIComponent(fileName)}/images`);
    if (!response.ok) return;
    const data = await response.json();
    images = Array.isArray(data.images) ? data.images : [];
  } catch { return; }
  if (!images.length) return;

  const fmtBytes = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };
  const safeAttr = (value) => String(value).replace(/"/g, '&quot;');

  const section = document.createElement('section');
  section.className = 'social-image-gallery';
  section.innerHTML =
    `<h4>Generated images <span class="hint" style="text-transform:none;font-weight:400;letter-spacing:0;color:var(--muted-2);margin-left:0.4rem;">(${images.length})</span></h4>` +
    `<div class="gallery-grid">` +
    images.map((image) => {
      const repoPath = `social-posts/images/${image.batch ? image.batch + '/' : ''}${image.name}`;
      return `
        <figure class="gallery-item">
          <a href="${safeAttr(image.url)}" target="_blank" rel="noopener" title="Open ${safeAttr(image.name)}">
            <img src="${safeAttr(image.url)}" alt="${safeAttr(image.name)}" loading="lazy" />
          </a>
          <figcaption class="gallery-name" title="${safeAttr(repoPath)}">${escape(image.name)}</figcaption>
          <div class="gallery-actions">
            <button type="button" class="gallery-btn" data-copy-path="${safeAttr(repoPath)}" title="Copy repo path">Copy path</button>
            <a class="gallery-btn" href="${safeAttr(image.url)}" download="${safeAttr(image.name)}">Download</a>
            <span class="gallery-btn" style="cursor:default;border-style:dashed;">${fmtBytes(image.bytes)}</span>
          </div>
        </figure>`;
    }).join('') +
    `</div>`;

  const urlStrip = root.querySelector(':scope > .post-url-strip');
  if (urlStrip) urlStrip.after(section);
  else root.prepend(section);

  section.querySelectorAll('button[data-copy-path]').forEach((button) => {
    button.addEventListener('click', async () => {
      const path = button.dataset.copyPath || '';
      try {
        await navigator.clipboard.writeText(path);
        button.textContent = 'Copied ✓';
        button.classList.add('copied');
        window.toast?.success?.({ title: 'Path copied', description: path, duration: 2200 });
        setTimeout(() => { button.textContent = 'Copy path'; button.classList.remove('copied'); }, 1800);
      } catch {
        window.toast?.error?.({ title: 'Could not copy path' });
      }
    });
  });
}
