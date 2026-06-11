import { $ } from '../lib/core.js';

let reportsPayload = null;

export function setReportsPayload(payload) {
  reportsPayload = payload;
}

export function getReportsPayload() {
  return reportsPayload;
}

export function activeRoleSlug() {
  const picked = (($('run-slug') && $('run-slug').value) || '').trim();
  if (picked) return picked;
  const reports = (reportsPayload && reportsPayload.reports) || [];
  const counts = new Map();
  for (const report of reports) {
    const slug = (report.meta && report.meta.subject) || '';
    if (slug) counts.set(slug, (counts.get(slug) || 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [slug, count] of counts) {
    if (count > bestCount) {
      best = slug;
      bestCount = count;
    }
  }
  return best;
}
