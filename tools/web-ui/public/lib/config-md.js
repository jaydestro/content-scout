// Pure markdown helpers for reading and round-tripping the scout-config
// markdown documents (the Configs form's form↔raw sync).
//
// Extracted verbatim from app.js. Every function here is pure (string in,
// string/array out) with no DOM access and no shared state, so moving them
// out of the monolith is behavior-preserving. app.js imports the whole set.

// Extract a `## Section` body (everything until the next `## ` heading or EOF).
export function getMdSection(raw, heading) {
  const re = new RegExp(`(^|\\n)##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|\\n*$)`, 'i');
  const m = raw.match(re);
  return m ? m[2] : '';
}

// Same but for a `### Subheading` under the doc.
export function getMdSubsection(raw, heading) {
  const re = new RegExp(`(^|\\n)###\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|\\n###\\s|\\n*$)`, 'i');
  const m = raw.match(re);
  return m ? m[2] : '';
}

// Parse a bullet list out of a markdown body. Returns array of trimmed values
// (without the leading "- " or "* " marker).
export function parseBulletList(body) {
  if (!body) return [];
  return body
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter((l) => l && !l.startsWith('<!--') && !l.startsWith('_'));
}

export function bulletListBlock(items, emptyComment) {
  const cleaned = (items || []).map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return emptyComment ? `\n${emptyComment}\n\n` : '\n- none\n\n';
  }
  return '\n' + cleaned.map((s) => `- ${s}`).join('\n') + '\n\n';
}

// Strip HTML comment blocks (`<!-- ... -->`, possibly multi-line) from a body.
export function stripHtmlComments(s) {
  return (s || '').replace(/<!--[\s\S]*?-->/g, '');
}

// Extract the leading `<!-- ... -->` comment block from a section body, if any.
export function leadingComment(body) {
  const m = (body || '').match(/^\s*(<!--[\s\S]*?-->)/);
  return m ? m[1] : '';
}

// Build a list-section body that preserves an optional leading comment.
export function listSectionBody(comment, items) {
  const cleaned = (items || []).map((s) => s.trim()).filter(Boolean);
  let out = '\n';
  if (comment) out += comment + '\n\n';
  if (cleaned.length) out += cleaned.map((s) => `- ${s}`).join('\n') + '\n\n';
  return out;
}

// Read a `- **Key:** value` field value from anywhere in the raw markdown.
export function getKvField(raw, key) {
  const m = raw.match(new RegExp(`^\\s*-\\s*\\*\\*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}:\\*\\*\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : '';
}

// Replace a `- **Key:** value` field value in place. No-op if the field is absent.
export function replaceKvField(raw, key, val) {
  const re = new RegExp(`(^\\s*-\\s*\\*\\*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}:\\*\\*\\s*).*$`, 'm');
  return re.test(raw) ? raw.replace(re, `$1${val}`) : raw;
}

// Parse a `## Section` body into ordered key/value entries. Lines that are not
// `- **Key:** value` (comments, blanks) are preserved verbatim for round-tripping.
export function parseKvSection(body) {
  return (body || '').replace(/\r/g, '').split('\n').map((line) => {
    const m = line.match(/^\s*-\s+\*\*(.+?):\*\*\s*(.*)$/);
    return m ? { line, key: m[1].trim(), value: m[2].trim() } : { line };
  });
}

// Replace a `### Subheading` body in raw with new content.
export function replaceMdSubsection(raw, heading, newBodyBlock) {
  const re = new RegExp(`(^|\\n)(###\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^\\n]*\\n)([\\s\\S]*?)(?=\\n##\\s|\\n###\\s|$)`, 'i');
  if (re.test(raw)) {
    return raw.replace(re, (_m, lead, head) => `${lead}${head}${newBodyBlock.replace(/^\n/, '')}`);
  }
  return raw; // subsection not present — skip silently to avoid corrupting unfamiliar configs
}

// Replace a `## Section` body in raw with new content; if missing, append at end.
export function replaceMdSection(raw, heading, newBodyBlock) {
  const re = new RegExp(`(^|\\n)(##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^\\n]*\\n)([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
  if (re.test(raw)) {
    return raw.replace(re, (_m, lead, head) => `${lead}${head}${newBodyBlock.replace(/^\n/, '')}`);
  }
  // Append new section at end of file.
  const sep = raw.endsWith('\n') ? '' : '\n';
  return `${raw}${sep}\n## ${heading}\n${newBodyBlock}`;
}
