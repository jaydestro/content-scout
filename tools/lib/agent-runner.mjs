// agent-runner.mjs
// Shared helper used by BOTH the web UI (tools/web-ui/server.js) and the
// CLI (tools/scout-cli/index.mjs) so both surfaces drive the agent the
// exact same way. The agent (Claude Code, Copilot CLI, Codex, Cursor,
// Gemini) is the source of truth — these wrappers just spawn it with the
// right prompt.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const SETTINGS_FILE = path.join(REPO_ROOT, 'tools', 'web-ui', '.scout-web-settings.json');

export const AGENT_PRESETS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    runner: 'claude -p "{prompt}"',
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    runner: 'copilot --allow-all-tools --allow-all-paths --allow-all-urls -p "{prompt}"',
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    runner: 'codex exec "{prompt}"',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor Agent CLI',
    runner: 'cursor-agent -p "{prompt}"',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    runner: 'gemini -p "{prompt}"',
  },
};

/**
 * Load the persisted agent settings (shared with the web UI).
 * @returns {Promise<{agent: string|null, runner: string}>}
 */
export async function loadSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      agent: typeof data.agent === 'string' ? data.agent : null,
      runner: typeof data.runner === 'string' ? data.runner : '',
    };
  } catch {
    return { agent: null, runner: '' };
  }
}

export async function saveSettings(settings) {
  await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

/**
 * Resolve the runner template. SCOUT_RUNNER env var wins.
 * @returns {Promise<{runner: string, source: 'env'|'settings'|'none'}>}
 */
export async function getRunner() {
  if (typeof process.env.SCOUT_RUNNER === 'string' && process.env.SCOUT_RUNNER.length > 0) {
    return { runner: process.env.SCOUT_RUNNER, source: 'env' };
  }
  const s = await loadSettings();
  return { runner: s.runner || '', source: s.runner ? 'settings' : 'none' };
}

/**
 * Build the slash-style prompt for an agent invocation.
 * Mirrors tools/web-ui/server.js#buildPrompt.
 */
export function buildPrompt(command, args = {}) {
  const safe = (s) => String(s).replace(/["`$\\]/g, '');
  if (command === 'custom' && typeof args.prompt === 'string') {
    return safe(args.prompt);
  }
  const parts = [`/${command}`];
  if (args.slug) parts.push(safe(args.slug));
  if (args.extra) parts.push(safe(args.extra));
  return parts.join(' ');
}

export const REPO = REPO_ROOT;

/**
 * Spawn the configured agent runner and stream stdio to the parent
 * process. Resolves with the exit code. The prompt is delivered via the
 * runner template's `{prompt}` placeholder; if the resulting command
 * line would exceed the shell's max length, the prompt is piped via
 * stdin instead.
 *
 * @param {string} command  Slash command (e.g. 'scout-scan')
 * @param {object} args     { slug?, extra?, prompt? }
 * @param {object} [opts]   { stdio: 'inherit'|'pipe'|'silent', signal, env }
 * @returns {Promise<{ code: number, prompt: string, commandLine: string }>}
 */
export async function runAgent(command, args = {}, opts = {}) {
  const prompt = buildPrompt(command, args);
  const { runner, source } = await getRunner();
  if (!runner) {
    const err = new Error(
      'No agent configured. Run `node tools/scout-cli/index.mjs config agent <name>` ' +
        'or set SCOUT_RUNNER env var. Available presets: ' +
        Object.keys(AGENT_PRESETS).join(', '),
    );
    err.code = 'NO_AGENT';
    err.prompt = prompt;
    throw err;
  }
  const MAX_INLINE_CMD = 1500;
  const inlineCmd = runner.replace('{prompt}', prompt);
  let commandLine = inlineCmd;
  let usedStdin = false;
  if (inlineCmd.length > MAX_INLINE_CMD && runner.includes('{prompt}')) {
    commandLine = runner
      .replace(/\s*(?:-p|--prompt|exec)\s+["']?\{prompt\}["']?/, '')
      .replace(/\s*["']?\{prompt\}["']?/, '')
      .trim();
    usedStdin = true;
  }
  const stdioMode = opts.stdio || 'inherit';
  const child = spawn(commandLine, {
    shell: true,
    cwd: opts.cwd || REPO_ROOT,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: usedStdin
      ? ['pipe', stdioMode === 'silent' ? 'ignore' : stdioMode, stdioMode === 'silent' ? 'ignore' : stdioMode]
      : [stdioMode === 'inherit' ? 'inherit' : 'ignore', stdioMode === 'silent' ? 'ignore' : stdioMode, stdioMode === 'silent' ? 'ignore' : stdioMode],
    signal: opts.signal,
  });
  if (usedStdin) {
    child.stdin.end(prompt);
  }
  const code = await new Promise((resolve) => {
    child.on('exit', (c) => resolve(c ?? 0));
    child.on('error', () => resolve(1));
  });
  return { code, prompt, commandLine, source };
}
