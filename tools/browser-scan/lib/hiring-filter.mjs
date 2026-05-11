// hiring-filter.mjs
// Code-level enforcement of the agent doc's "No Hiring Content" hard ban.
// We strip recruiting / job-posting items at sidecar-generation time so the
// agent can't accidentally include them in reports even when its prompt
// filtering misses one.
//
// Source of truth for the ban list: `.github/agents/content-scout.agent.md`
// section "No Hiring Content -- Hard Ban (Applies To EVERY Section)".
// Keep this list in sync if that section changes.

// Phrases / tokens that, when found anywhere in the title or body, mark the
// item as a hiring / recruiting / job-search post.
//
// Notes on choices:
//   * "hiring" alone is broad enough to catch ~95% of recruiter posts on
//     LinkedIn; the false-positive rate against actual technical content
//     is acceptable because legitimate Cosmos DB content rarely includes
//     the literal word "hiring".
//   * Email contact tokens like `hr@`, `careers@`, `recruiting@`,
//     `talent@` are near-perfect classifiers for job ads.
//   * Indian-market and US-contracting jargon (`c2c`, `c2h`, `w2 only`,
//     `usc only`, `gc only`, `urgent requirement`, `position 1:`,
//     `please share resume`) catches the body of contracting posts that
//     don't say "hiring" up front.
const HIRING_PHRASES = [
  'hiring',
  '[hiring]',
  "we're hiring",
  'we are hiring',
  'now hiring',
  'is hiring',
  'looking to hire',
  'apply now',
  'open position',
  'open role',
  'seeking candidates',
  'interested candidates',
  'please share resume',
  'please share resumes',
  'share your resume',
  'dm your resume',
  'hr@',
  'recruiting@',
  'talent@',
  'careers@',
  'position 1:',
  'urgent requirement',
  'urgent hiring',
  'c2c',
  'c2h',
  'w2 only',
  'usc only',
  'gc only',
];

// Subreddits whose entire purpose is recruiting / job-search.
// r/cscareerquestions has a narrow exception in the agent doc (technical
// retros where Cosmos DB is non-trivially central) — the safer default in
// code is to drop, then let the agent's manual review re-add specific
// items via /scout-reddit-import if needed.
const HIRING_SUBREDDITS = new Set([
  'r/indiajobs',
  'r/forhire',
  'r/hiring',
  'r/jobs',
  'r/jobsearch',
  'r/recruitinghell',
  'r/cscareerquestions',
]);

function normalize(s) {
  if (!s) return '';
  // Lowercase + strip common Unicode "stylized" letters that LinkedIn
  // recruiters use to evade keyword filters (e.g. 𝗛𝗶𝗿𝗶𝗻𝗴 → "hiring").
  // The NFKD normalization step folds the mathematical alphanumeric
  // symbols block to their ASCII equivalents.
  return String(s).normalize('NFKD').toLowerCase();
}

/**
 * Returns true if the item looks like a hiring / recruiting / job-posting
 * piece of content and should be dropped from the report.
 *
 * @param {{title?: string, body?: string, subreddit?: string|null, thread_context?: string|null}} item
 * @returns {boolean}
 */
export function isHiringContent(item) {
  if (!item) return false;
  const sub = normalize(item.subreddit || item.thread_context || '');
  if (sub) {
    // Match exact subreddit token; threads_context can contain extra words.
    for (const s of HIRING_SUBREDDITS) {
      if (sub === s || sub.startsWith(s + ' ') || sub.includes(' ' + s)) {
        return true;
      }
    }
  }

  const haystack = normalize(`${item.title || ''}\n${item.body || ''}`);
  if (!haystack.trim()) return false;
  for (const phrase of HIRING_PHRASES) {
    if (haystack.includes(phrase)) return true;
  }
  return false;
}

/**
 * Filters a list of items, returning { kept, dropped } so callers can
 * log a count without losing visibility into what was removed.
 *
 * @param {Array<object>} items
 * @returns {{ kept: Array<object>, dropped: Array<object> }}
 */
export function filterHiring(items) {
  const kept = [];
  const dropped = [];
  for (const it of items || []) {
    if (isHiringContent(it)) dropped.push(it);
    else kept.push(it);
  }
  return { kept, dropped };
}
