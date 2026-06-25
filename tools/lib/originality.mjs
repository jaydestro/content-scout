// originality.mjs — deterministic "originality vs. AI-generated" scorer.
//
// Content Scout uses this to annotate each piece of content found in a scan
// with an originality score: how human-written / original the text reads versus
// how much it shows the tell-tale signs of LLM-generated prose. It is NOT a
// plagiarism checker and NOT a definitive AI detector — those don't reliably
// exist. It's a transparent, explainable heuristic over the documented "signs
// of AI writing" (see .claude/skills/humanizer/SKILL.md), so a reviewer can see
// WHY a piece looks AI-assisted and decide for themselves.
//
// Pure Node, no deps. Exports:
//   - scoreOriginality(text, opts) -> { score, score100, rating, ratingLabel,
//                                       wordCount, signals }
//       score      : 0–10 (higher = more original / human-written)
//       score100   : 0–100 internal scale
//       rating     : 'likely-original' | 'mixed' | 'likely-ai' | 'insufficient-text'
//       signals    : [{ label, count, penalty }] strongest tells first
//   - formatOriginality(result) -> short label e.g. "7/10 · Mixed signals"

// High-frequency post-2023 "AI vocabulary" — penalised by density, not raw count.
const AI_VOCAB = [
  'delve', 'tapestry', 'testament', 'underscore', 'underscores', 'underscoring',
  'pivotal', 'intricate', 'intricacies', 'interplay', 'showcase', 'showcases',
  'showcasing', 'foster', 'fostering', 'garner', 'garnered', 'vibrant',
  'enduring', 'crucial', 'realm', 'nuanced', 'multifaceted', 'seamless',
  'seamlessly', 'robust', 'leverage', 'leveraging', 'utilize', 'utilizing',
  'holistic', 'myriad', 'plethora', 'paradigm', 'synergy', 'elevate',
  'empower', 'empowering', 'endeavor', 'bolster', 'unveil', 'unveiled',
  'harness', 'harnessing', 'cutting-edge', 'game-changer', 'game-changing',
  'transformative', 'unparalleled', 'unlock', 'unlocking', 'dive into',
];

// Phrase-level tells (counted, not density). Each entry: [regex, label].
const PHRASE_SIGNALS = [
  [/\bnot only\b[^.?!]*\bbut\b/gi, 'negative-parallelism'],
  [/\bit'?s not (just|merely|only|about)\b/gi, 'negative-parallelism'],
  [/\b(highlighting|underscoring|emphasizing|reflecting|symbolizing|showcasing|fostering|ensuring|cultivating|encompassing|paving the way|contributing to)\b/gi, 'superficial-ing-analysis'],
  [/\b(stands?|serves?) as a\b/gi, 'copula-avoidance'],
  [/\b(represents|marks|embodies) a\b/gi, 'copula-avoidance'],
  [/\bboasts?\b/gi, 'copula-avoidance'],
  [/\b(testament to|pivotal moment|evolving landscape|setting the stage|rich tapestry|in the heart of|nestled in|rich cultural heritage|natural beauty|marking a (?:pivotal|key|significant) )/gi, 'significance-puffery'],
  [/\b(breathtaking|stunning|must-visit|renowned|groundbreaking|world-class|state-of-the-art)\b/gi, 'promotional-language'],
  [/\b(experts?|observers?|critics?|analysts?|researchers?)\s+(say|argue|believe|note|suggest|cite|claim|contend)/gi, 'vague-attribution'],
  [/\b(industry reports?|studies (show|suggest)|some (say|argue|believe)|it is (widely )?(believed|considered))\b/gi, 'vague-attribution'],
  [/\b(i hope this helps|certainly!|of course!|you'?re absolutely right|let me know if|here'?s a|feel free to|in conclusion,|in summary,|overall,)\b/gi, 'chatbot-artifact'],
  [/\bin today'?s (digital |modern |fast-paced )?(world|landscape|era)\b/gi, 'ai-cliche'],
  [/\bwhen it comes to\b/gi, 'ai-cliche'],
];

const SIGNAL_LABELS = {
  'ai-vocabulary': 'AI vocabulary density',
  'em-dash-overuse': 'Em-dash overuse',
  'rule-of-three': 'Rule-of-three lists',
  'negative-parallelism': 'Negative parallelisms',
  'superficial-ing-analysis': 'Superficial "-ing" analysis',
  'copula-avoidance': 'Copula avoidance (serves/stands as)',
  'significance-puffery': 'Significance puffery',
  'promotional-language': 'Promotional language',
  'vague-attribution': 'Vague attributions',
  'chatbot-artifact': 'Chatbot correspondence artifacts',
  'ai-cliche': 'AI clichés',
  'curly-quotes': 'Curly quotation marks',
  'emoji-decoration': 'Decorative emoji',
  'boldface-overuse': 'Boldface overuse',
};

function countMatches(re, text) {
  const m = text.match(re);
  return m ? m.length : 0;
}

// Strip the heaviest markdown so word-based detectors see prose, while keeping
// a copy of the original for marker-based detectors (bold, emoji, quotes).
function toProse(raw) {
  return String(raw || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2700}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;

export function scoreOriginality(text, { minWords = 40 } = {}) {
  const raw = String(text || '');
  const prose = toProse(raw);
  const words = prose ? prose.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;

  if (wordCount < minWords) {
    return {
      score: null,
      score100: null,
      rating: 'insufficient-text',
      ratingLabel: 'Not enough text to score',
      wordCount,
      signals: [],
    };
  }

  const per1k = (n) => (n / wordCount) * 1000;
  const tally = {}; // label -> count
  const bump = (label, count) => {
    if (count > 0) tally[label] = (tally[label] || 0) + count;
  };

  // 1) AI vocabulary density.
  let vocabHits = 0;
  for (const w of AI_VOCAB) {
    vocabHits += countMatches(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\b`, 'gi'), prose);
  }
  bump('ai-vocabulary', vocabHits);

  // 2) Phrase-level tells.
  for (const [re, label] of PHRASE_SIGNALS) {
    bump(label, countMatches(re, prose));
  }

  // 3) Em-dash overuse (humans use some; overuse is a tell).
  bump('em-dash-overuse', countMatches(/—|--/g, raw));

  // 4) Rule-of-three "A, B, and C" lists (allow a couple before penalising).
  bump('rule-of-three', countMatches(/\b[\w'-]+,\s+[\w'-]+,\s+and\s+[\w'-]+/gi, prose));

  // 5) Style markers from the original (markdown-aware).
  bump('curly-quotes', countMatches(/[\u201C\u201D\u2018\u2019]/g, raw));
  bump('emoji-decoration', countMatches(EMOJI_RE, raw));
  bump('boldface-overuse', countMatches(/\*\*[^*\n]+\*\*/g, raw));

  // Weighted penalties → originality = 100 - sum(penalties).
  const penaltyFor = (label, count) => {
    switch (label) {
      case 'ai-vocabulary': return Math.min(per1k(count) * 0.7, 26);
      case 'em-dash-overuse': return Math.min(Math.max(per1k(count) - 4, 0) * 1.4, 14);
      case 'rule-of-three': return Math.min(Math.max(count - 1, 0) * 3, 12);
      case 'negative-parallelism': return Math.min(count * 5, 16);
      case 'superficial-ing-analysis': return Math.min(count * 3.5, 16);
      case 'copula-avoidance': return Math.min(count * 2.5, 12);
      case 'significance-puffery': return Math.min(count * 4, 16);
      case 'promotional-language': return Math.min(count * 3, 14);
      case 'vague-attribution': return Math.min(count * 4, 12);
      case 'chatbot-artifact': return Math.min(count * 8, 26);
      case 'ai-cliche': return Math.min(count * 4, 12);
      case 'curly-quotes': return Math.min(per1k(count) * 0.4, 6);
      case 'emoji-decoration': return Math.min(count * 2, 10);
      case 'boldface-overuse': return Math.min(Math.max(per1k(count) - 6, 0) * 1.2, 8);
      default: return 0;
    }
  };

  const signals = Object.entries(tally)
    .map(([label, count]) => ({
      label: SIGNAL_LABELS[label] || label,
      key: label,
      count,
      penalty: Math.round(penaltyFor(label, count) * 10) / 10,
    }))
    .filter((s) => s.penalty > 0)
    .sort((a, b) => b.penalty - a.penalty);

  const totalPenalty = signals.reduce((sum, s) => sum + s.penalty, 0);
  const score100 = Math.max(0, Math.min(100, Math.round(100 - totalPenalty)));
  const score = Math.round(score100 / 10);

  let rating = 'likely-original';
  let ratingLabel = 'Likely original';
  if (score100 < 45) {
    rating = 'likely-ai';
    ratingLabel = 'Likely AI-generated';
  } else if (score100 < 75) {
    rating = 'mixed';
    ratingLabel = 'Mixed signals';
  }

  return { score, score100, rating, ratingLabel, wordCount, signals };
}

export function formatOriginality(result) {
  if (!result || result.rating === 'insufficient-text') return 'n/a (too short)';
  return `${result.score}/10 · ${result.ratingLabel}`;
}
