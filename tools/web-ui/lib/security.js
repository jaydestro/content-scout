// Pure helper functions extracted from server.js so they can be unit-tested
// without booting the HTTP server. server.js re-exports the same logic.
import path from 'node:path';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function isValidSlug(s) {
  return typeof s === 'string' && SLUG_RE.test(s);
}

export const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
export function isValidFilename(s) {
  return typeof s === 'string' && FILENAME_RE.test(s) && !s.includes('..');
}

export function safeJoin(baseDir, name) {
  const resolved = path.resolve(baseDir, name);
  const baseWithSep = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (resolved !== baseDir && !resolved.startsWith(baseWithSep)) {
    throw new Error('path escapes base directory');
  }
  return resolved;
}
