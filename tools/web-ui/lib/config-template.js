// Config template rendering — extracted from server.js to keep that file
// focused on HTTP concerns. Pure: no I/O, no globals. Safe to unit-test.

// Built-in role presets. Each sets smart defaults matching the /scout-onboard role table.
// Keys are short ids; `label` is the human name written into the config.
export const ROLE_PRESETS = {
  'program-manager': {
    label: 'Program Manager',
    focus: 'Adoption metrics, SDK usage, feature coverage, feature request flagging, community feedback',
    ordering: 'adoption first',
    flags: { socialPosts: false, postingCalendar: false, competitorTracking: false, conferenceCfp: false, launchCoverage: false, risingContributors: false, communityHealth: false, docGapFocus: false, sdkAdoption: true, featureRequests: true, unansweredQuestions: true },
  },
  'product-manager': {
    label: 'Product Manager',
    focus: 'Market signals, competitor mentions, customer requests, sentiment analysis',
    ordering: 'market signals first',
    flags: { socialPosts: false, postingCalendar: false, competitorTracking: true, conferenceCfp: false, launchCoverage: false, risingContributors: false, communityHealth: false, docGapFocus: false, sdkAdoption: true, featureRequests: true, unansweredQuestions: true },
  },
  'social-media-manager': {
    label: 'Social Media Manager',
    focus: 'Post-ready content, engagement opportunities, trending topics, conversation sentiment',
    ordering: 'trending first',
    flags: { socialPosts: true, postingCalendar: true, competitorTracking: false, conferenceCfp: false, launchCoverage: false, risingContributors: false, communityHealth: false, docGapFocus: false, sdkAdoption: false, featureRequests: false, unansweredQuestions: false },
  },
  'product-marketer': {
    label: 'Product Marketer',
    focus: 'Launch coverage, success stories, analyst mentions, campaign amplification',
    ordering: 'launches first',
    flags: { socialPosts: true, postingCalendar: true, competitorTracking: true, conferenceCfp: true, launchCoverage: true, risingContributors: false, communityHealth: false, docGapFocus: false, sdkAdoption: false, featureRequests: true, unansweredQuestions: false },
  },
  'developer-advocate': {
    label: 'Developer Advocate',
    focus: 'Community projects, tutorials, rising contributors, conference talks',
    ordering: 'community first',
    flags: { socialPosts: true, postingCalendar: true, competitorTracking: false, conferenceCfp: true, launchCoverage: false, risingContributors: true, communityHealth: true, docGapFocus: false, sdkAdoption: false, featureRequests: false, unansweredQuestions: true },
  },
  'community-manager': {
    label: 'Community Manager',
    focus: 'Contributor tracking, sentiment trends, engagement health, unanswered questions',
    ordering: 'community first',
    flags: { socialPosts: false, postingCalendar: false, competitorTracking: false, conferenceCfp: false, launchCoverage: false, risingContributors: true, communityHealth: true, docGapFocus: false, sdkAdoption: false, featureRequests: false, unansweredQuestions: true },
  },
  'technical-writer': {
    label: 'Technical Writer',
    focus: 'Doc gap analysis, tutorial patterns, FAQ signals, community tutorials vs. official docs',
    ordering: 'doc gaps first',
    flags: { socialPosts: false, postingCalendar: false, competitorTracking: false, conferenceCfp: false, launchCoverage: false, risingContributors: false, communityHealth: false, docGapFocus: true, sdkAdoption: false, featureRequests: false, unansweredQuestions: true },
  },
};

// Render a scout-config markdown file from a structured options object.
// Output starts with `# scout-config: ${name}` (after YAML frontmatter) so
// the config-validator's required-header check matches.
export function renderConfigTemplate(opts) {
  const {
    name, slug, type,
    roleIds = [], customRoleLabel = '',
    flags = {},
    focusOverride = '', orderingOverride = '',
    searchTerms = [], hashtags = [], topicTags = [],
    exclusions = {}, // { blog, youtube, handles: [], repos: [], domains: [] }
    watchlist = [],  // [{ name, affiliation, handle }]
    influencers = [], // [{ name, platform, handle }]
    teamMembers = [], // [{ name, context }]
    brand = {},      // { logoDir, thumbnailStyle, theme, productName, logoRules, colors:{bg,accent,highlight,text}, font, composition, guardrails }
    socialAccounts = {}, // { linkedin, x, bluesky, youtube }
    socialStandards = {}, // { audience, tone, shortName, neverWrite, avoidWords, emoji, hashtag, thingsAvoid, additional }
    postingPrefs = {}, // { frequency, avoid, approval, tagTeam }
    language = {},   // { langs, regions }
    competitors = [], // ["MongoDB", "DynamoDB"]
    conferences = [], // ["KubeCon", "re:Invent"]
    customSources = [], // [{ name, type, url }]
    standardSources = null, // optional array to override the default standard-source list
  } = opts;
  const terms = searchTerms.length ? searchTerms.map((t) => `"${t}"`).join(', ') : `"${name}"`;
  const tags = hashtags.length ? hashtags.map((h) => `#${h}`).join(', ') : 'none';
  const topicList = topicTags.length ? topicTags.join(', ') : 'architecture, integration, sdk, performance, release, tutorial';

  // Resolve role label(s) and default flags by merging selected presets (any-true wins).
  const selected = roleIds.map((id) => ROLE_PRESETS[id]).filter(Boolean);
  const roleLabel = selected.length
    ? selected.map((p) => p.label).join(', ')
    : (customRoleLabel || 'Custom');
  const mergedFlags = selected.reduce((acc, p) => {
    for (const [k, v] of Object.entries(p.flags)) acc[k] = acc[k] || v;
    return acc;
  }, {});
  // Explicit form overrides win over preset defaults.
  const f = { ...mergedFlags, ...flags };
  const focus = focusOverride || selected[0]?.focus || 'Tutorials, SDK releases, integration content, performance deep-dives';
  const ordering = orderingOverride || selected[0]?.ordering || 'SDK first';
  const on = (v) => (v ? 'on' : 'off');

  const joinList = (v, fallback) => {
    if (Array.isArray(v)) {
      const items = v.map((s) => String(s).trim()).filter(Boolean);
      return items.length ? items.join(', ') : fallback;
    }
    if (typeof v === 'string' && v.trim()) return v.trim();
    return fallback;
  };
  const officialBlog = joinList(exclusions.blog, '(add during refinement)');
  const officialYouTube = joinList(exclusions.youtube, '(add during refinement)');
  const officialHandles = joinList(exclusions.handles, '(add during refinement)');

  const watchRows = Array.isArray(watchlist) && watchlist.length
    ? watchlist.map((w) => `| ${w.name || ''} | ${w.affiliation || ''} | ${w.handle || ''} |`)
    : ['|      |             |        |'];

  const influencerLines = Array.isArray(influencers) && influencers.length
    ? influencers.map((i) => `- ${i.name || ''} — ${i.platform || ''} — ${i.handle || ''}`).join('\n')
    : '_None tracked. Add to enable high-signal account monitoring._';

  const teamLines = Array.isArray(teamMembers) && teamMembers.length
    ? teamMembers.map((t) => `- ${t.name || ''} — ${t.context || ''}`).join('\n')
    : '_None listed. Add to flag team-authored content as Team Member Mentions instead of external coverage._';

  const repoLines = Array.isArray(exclusions.repos) && exclusions.repos.length
    ? exclusions.repos.map((r) => `- ${r}`).join('\n')
    : '- none';
  const domainLines = Array.isArray(exclusions.domains) && exclusions.domains.length
    ? exclusions.domains.map((d) => `- ${d}`).join('\n')
    : '- none';

  const brandLogoDir = brand.logoDir?.trim() || 'none';
  const brandThumbStyle = brand.thumbnailStyle?.trim() || 'text-only';
  const brandTheme = brand.theme?.trim() || 'dark';

  const competitorList = Array.isArray(competitors) && competitors.length
    ? competitors.map((c) => `- ${c}`).join('\n')
    : '_None tracked. Add to enable competitor mention tracking._';

  const conferenceList = Array.isArray(conferences) && conferences.length
    ? conferences.map((c) => `- ${c}`).join('\n')
    : '_None tracked. Add to enable CFP and talk tracking._';

  const defaultStandardSources = [
    '1. **GitHub** — community repos, SDK releases, samples',
    '2. **Community blogs** — Dev.to, Medium, Hashnode, Blogspot, WordPress, DZone, C# Corner, InfoQ',
    '3. **Conversation tracking (not numbered):** Stack Overflow, Reddit, Hacker News, Bluesky, X/Twitter, LinkedIn',
  ];
  const standardSourceList = Array.isArray(standardSources) && standardSources.length
    ? standardSources
    : defaultStandardSources;

  const customSourceRows = Array.isArray(customSources) && customSources.length
    ? customSources.map((s) => `| ${s.name || ''} | ${s.type || ''} | ${s.url || ''} |`)
    : [];

  return [
    '---',
    `description: Content Scout configuration for ${name}`,
    'mode: content-scout',
    '---',
    '',
    `# scout-config: ${name}`,
    '',
    `Apply this configuration to the Content Scout agent.`,
    '',
    '## Role',
    '',
    `- **Role:** ${roleLabel}`,
    `- **Social posts:** ${on(f.socialPosts)}`,
    `- **Posting calendar:** ${on(f.postingCalendar)}`,
    `- **Report focus:** ${focus}`,
    `- **Report section ordering:** ${ordering}`,
    `- **Engagement scoring:** on`,
    `- **Conversation sentiment:** on`,
    `- **Feature request flagging:** ${on(f.featureRequests)}`,
    `- **Unanswered question tracking:** ${on(f.unansweredQuestions)}`,
    `- **Rising contributors:** ${on(f.risingContributors)}`,
    `- **SDK/feature adoption tracking:** ${on(f.sdkAdoption)}`,
    `- **Competitor tracking:** ${on(f.competitorTracking)}`,
    `- **Conference CFP tracking:** ${on(f.conferenceCfp)}`,
    `- **Launch coverage tracking:** ${on(f.launchCoverage)}`,
    `- **Community health signals:** ${on(f.communityHealth)}`,
    `- **Doc gap focus:** ${on(f.docGapFocus)}`,
    '',
    '## Topic Identity',
    '',
    `- **Name:** ${name}`,
    `- **Slug:** ${slug}`,
    `- **Type:** ${type}`,
    `- **Search terms (text):** ${terms}`,
    `- **Search hashtags:** ${tags}`,
    '',
    '## Official Channels (used to classify content as Official vs. Community)',
    '',
    `- **Official blog URLs:** ${officialBlog}`,
    `- **Official YouTube channels:** ${officialYouTube}`,
    `- **Official social accounts:** ${officialHandles}`,
    '',
    '### Excluded GitHub Orgs/Repos',
    '',
    repoLines,
    '',
    '### Excluded Domains/Authors',
    '',
    domainLines,
    '',
    '### Product Team Members',
    '<!-- Content by these people appears in "Team Member Mentions" section, not as numbered items. -->',
    '',
    teamLines,
    '',
    '## Known Author Watchlist',
    '',
    'External community developers whose content always passes quality filter. Fill in as you identify them.',
    '',
    '| Name | Affiliation | Handle |',
    '|------|-------------|--------|',
    ...watchRows,
    '',
    '## Influencers to Monitor',
    '',
    influencerLines,
    '',
    '## Brand Assets',
    '',
    `- **Logo directory:** ${brandLogoDir}`,
    `- **Logos available:** ${brandLogoDir === 'none' ? 'none' : '(auto-discovered from directory)'}`,
    `- **Product name on thumbnails:** ${brand.productName || name}`,
    `- **Logo usage rules:** ${brand.logoRules || 'none'}`,
    '- **Brand colors:**',
    `  - Primary background: ${brand.colors?.bg || 'none'}`,
    `  - Accent: ${brand.colors?.accent || 'none'}`,
    `  - Highlight: ${brand.colors?.highlight || 'none'}`,
    `  - Text: ${brand.colors?.text || 'none'}`,
    `- **Thumbnail style:** ${brandThumbStyle}`,
    `- **Background theme:** ${brandTheme}`,
    `- **Font:** ${brand.font || 'none'}`,
    `- **Thumbnail composition:** ${brand.composition || 'none'}`,
    `- **Brand guardrails (never do):** ${brand.guardrails || 'none'}`,
    '',
    '## Social Post Platforms',
    '',
    '| Platform | Account |',
    '|----------|---------|',
    `| LinkedIn | ${socialAccounts.linkedin || 'none'} |`,
    `| X | ${socialAccounts.x || 'none'} |`,
    `| Bluesky | ${socialAccounts.bluesky || 'none'} |`,
    `| YouTube Community | ${socialAccounts.youtube || 'none'} |`,
    '',
    '## Social Post Standards',
    '',
    `- **Target audience:** ${socialStandards.audience || 'defaults'}`,
    `- **Tone:** ${socialStandards.tone || 'defaults'}`,
    `- **Brand name — canonical form:** ${brand.productName || name}`,
    `- **Brand name — acceptable short form:** ${socialStandards.shortName || 'none — always use full name'}`,
    `- **Brand name — never write:** ${socialStandards.neverWrite || 'none'}`,
    `- **Avoid words/phrases:** ${socialStandards.avoidWords || 'none'}`,
    `- **Emoji policy:** ${socialStandards.emoji || '0-2 max'}`,
    `- **Hashtag policy:** ${socialStandards.hashtag || '1-2 at end'}`,
    `- **Things to avoid:** ${socialStandards.thingsAvoid || 'none'}`,
    `- **Additional rules:** ${socialStandards.additional || 'none'}`,
    '',
    '## Posting Preferences',
    '',
    `- **Target posting frequency:** ${postingPrefs.frequency || 'none specified'}`,
    `- **Days/times to avoid:** ${postingPrefs.avoid || 'none'}`,
    `- **Approval workflow:** ${postingPrefs.approval || 'none'}`,
    `- **Team members to tag:** ${postingPrefs.tagTeam || 'none'}`,
    '',
    '## Language & Region',
    '',
    `- **Languages:** ${language.langs || 'English'}`,
    `- **Region focus:** ${language.regions || 'Global'}`,
    '',
    '## Competitors',
    '',
    competitorList,
    '',
    '## Conferences',
    '',
    conferenceList,
    '',
    '## API Keys',
    '',
    '_Keys are stored in `.env` — see `.env.example` for setup._',
    '',
    '## Content Sources (scan order)',
    '',
    '### Standard Sources',
    ...standardSourceList,
    '',
    '_To enable YouTube scanning, add it here along with your official channel ID to exclude (e.g., `YouTube (excluding UCxxxx) — community tutorials via Data API v3`)._',
    '',
    '### Custom Sources',
    '',
    customSourceRows.length ? '| Name | Type | URL |' : '_None configured. Add rows to the table below to track specific blogs, newsletters, podcasts, or other sources._',
    ...(customSourceRows.length ? ['|------|------|-----|', ...customSourceRows] : ['', '| Name | Type | URL |', '|------|------|-----|']),
    '',
    '## Content Quality Filter',
    '',
    '**INCLUDE:** tutorials, architecture deep-dives, problem-solving stories, demos, SDK releases, conference talks, performance deep-dives, integration content, success stories, educational content with depth',
    '',
    '**EXCLUDE:** "What is" intros, shallow listicles, name-drop posts, AI content farms, job postings, certification guides, YouTube videos with no description',
    '',
    '**Scoring:** Product depth (1-3) + practical value (1-3) + originality (1-3) >= 5/9 to include',
    '',
    '## Topic Tags',
    '',
    topicList,
    '',
    '## Output Files',
    '',
    `- Reports: \`reports/{YYYY-MM-DD-HHmm}-${slug}-content.md\``,
    '- Dedup tracker: `reports/.seen-links.json`',
    `- Social posts: \`social-posts/{YYYY-MM-DD-HHmm}-${slug}-social-posts.md\``,
    `- Thumbnails: \`social-posts/images/{YYYY-MM-DD-HHmm}/{N}-{platform}-${slug}.png\``,
    `- Posting calendar: \`social-posts/{YYYY-MM-DD-HHmm}-${slug}-posting-calendar.md\``,
    '',
  ].join('\n');
}
