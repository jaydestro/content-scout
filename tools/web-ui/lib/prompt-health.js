// Prompt health checks — pure helpers for spotting drift between the UI's
// known command list and the .github/prompts/ directory on disk.
//
// Both helpers are pure (string in, string[] out). I/O lives in server.js.

// Files that match these patterns are considered "configs" or examples and
// should not be flagged as orphan command prompts.
const IGNORED_PATTERNS = [
  /^scout-config-/, // dynamic per-product configs
];

function isCommandPromptFile(name) {
  if (!name.endsWith('.prompt.md')) return false;
  return !IGNORED_PATTERNS.some((re) => re.test(name));
}

// Given the list of expected command-prompt filenames the UI references and
// the actual filenames found on disk in .github/prompts/, return the expected
// names that are missing from disk.
export function findMissingPrompts(expected, diskFiles) {
  const onDisk = new Set(diskFiles);
  return expected.filter((name) => !onDisk.has(name));
}

// Given the list of expected command-prompt filenames and the actual disk
// listing, return command-prompt files on disk that the UI doesn't reference.
// Excludes scout-config-*.prompt.md (those are user-generated configs, not
// orphan commands).
export function findUnreferencedPrompts(expected, diskFiles) {
  const expectedSet = new Set(expected);
  return diskFiles
    .filter(isCommandPromptFile)
    .filter((name) => !expectedSet.has(name))
    .sort();
}
