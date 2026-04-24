import express from 'express';
import { marked } from 'marked';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo root = tools/web-ui/../..
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROMPTS_DIR = path.join(REPO_ROOT, '.github', 'prompts');
const REPORTS_DIR = path.join(REPO_ROOT, 'reports');
const SOCIAL_DIR = path.join(REPO_ROOT, 'social-posts');
const ENV_FILE = path.join(REPO_ROOT, '.env');
const ENV_EXAMPLE = path.join(REPO_ROOT, '.env.example');
const SETTINGS_FILE = path.join(__dirname, '.scout-web-settings.json');

const PORT = Number(process.env.PORT || 4477);

// Built-in agent presets. `{prompt}` is replaced with the slash-style command.
const AGENT_PRESETS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    runner: 'claude -p "{prompt}"',
    install: 'https://docs.anthropic.com/en/docs/claude-code/overview',
    note: 'Runs /scout-* commands non-interactively via the Claude Code CLI.',
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    runner: 'copilot -p "{prompt}"',
    install: 'https://docs.github.com/en/copilot/github-copilot-in-the-cli',
    note: 'Requires the newer `copilot` CLI (not `gh copilot`). Agent mode + prompt files supported.',
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    runner: 'codex exec "{prompt}"',
    install: 'https://github.com/openai/codex',
    note: 'Non-interactive exec mode. Reads repo context automatically.',
  },
  none: {
    id: 'none',
    label: 'None — copy prompts manually',
    runner: '',
    note: 'No automated execution. The Run view will show a prompt you can paste into any chat panel.',
  },
};

// --- Settings persistence -----------------------------------------
async function loadSettings() {
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

async function saveSettings(settings) {
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

// Effective runner: env var wins, then saved settings.
async function getRunner() {
  if (typeof process.env.SCOUT_RUNNER === 'string' && process.env.SCOUT_RUNNER.length > 0) {
    return { runner: process.env.SCOUT_RUNNER, source: 'env' };
  }
  const s = await loadSettings();
  return { runner: s.runner || '', source: s.runner ? 'settings' : 'none' };
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- in-memory run log ---------------------------------------------
const runs = new Map();

function pushRunOutput(run, chunk) {
  run.output += chunk;
  for (const listener of run.listeners) {
    try {
      listener.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    } catch {}
  }
}

function closeRun(run, status) {
  run.status = status;
  run.finishedAt = new Date().toISOString();
  for (const listener of run.listeners) {
    try {
      listener.write(`event: done\ndata: ${JSON.stringify({ status })}\n\n`);
      listener.end();
    } catch {}
  }
  run.listeners.clear();
}

// --- helpers -------------------------------------------------------
async function listConfigs() {
  try {
    const files = await fs.readdir(PROMPTS_DIR);
    return files
      .filter((f) => f.startsWith('scout-config-') && f.endsWith('.prompt.md') && f !== 'scout-config-example.prompt.md')
      .map((f) => ({ slug: f.replace(/^scout-config-/, '').replace(/\.prompt\.md$/, ''), file: f }));
  } catch {
    return [];
  }
}

async function readConfig(slug) {
  const file = path.join(PROMPTS_DIR, `scout-config-${slug}.prompt.md`);
  const raw = await fs.readFile(file, 'utf8');
  return { slug, file: `scout-config-${slug}.prompt.md`, raw };
}

async function writeConfig(slug, raw) {
  const file = path.join(PROMPTS_DIR, `scout-config-${slug}.prompt.md`);
  await fs.writeFile(file, raw, 'utf8');
}

async function listMarkdownFiles(dir) {
  try {
    const files = await fs.readdir(dir);
    const result = [];
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const stat = await fs.stat(path.join(dir, f));
      result.push({ name: f, mtime: stat.mtime.toISOString(), size: stat.size });
    }
    return result.sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {
    return [];
  }
}

async function readMarkdown(dir, name) {
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error('invalid filename');
  }
  const file = path.join(dir, name);
  const raw = await fs.readFile(file, 'utf8');
  return { name, raw, html: marked.parse(raw) };
}

async function readEnv() {
  let raw = '';
  try {
    raw = await fs.readFile(ENV_FILE, 'utf8');
  } catch {
    try {
      raw = await fs.readFile(ENV_EXAMPLE, 'utf8');
    } catch {
      raw = '';
    }
  }
  const entries = raw
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const idx = l.indexOf('=');
      return { key: l.slice(0, idx), hasValue: l.slice(idx + 1).trim().length > 0 };
    });
  return { exists: raw.length > 0, keys: entries };
}

// --- API -----------------------------------------------------------
app.get('/api/status', async (_req, res) => {
  const [env, configs, settings, runnerInfo] = await Promise.all([
    readEnv(),
    listConfigs(),
    loadSettings(),
    getRunner(),
  ]);
  res.json({
    repoRoot: REPO_ROOT,
    runner: runnerInfo.runner || null,
    runnerSource: runnerInfo.source,
    runnerConfigured: !!runnerInfo.runner,
    runnerLocked: runnerInfo.source === 'env',
    agent: settings.agent,
    hasConfigs: configs.length > 0,
    configCount: configs.length,
    env,
  });
});

app.get('/api/agents', (_req, res) => {
  res.json({
    agents: Object.values(AGENT_PRESETS).map(({ id, label, runner, install, note }) => ({
      id, label, runner, install, note,
    })),
  });
});

app.get('/api/settings', async (_req, res) => {
  res.json(await loadSettings());
});

app.post('/api/settings', async (req, res) => {
  const { agent, runner } = req.body || {};
  if (typeof agent !== 'string') {
    return res.status(400).json({ error: 'agent required' });
  }
  let effectiveRunner = '';
  if (agent === 'custom') {
    if (typeof runner !== 'string') {
      return res.status(400).json({ error: 'runner required for custom agent' });
    }
    effectiveRunner = runner.trim();
  } else if (AGENT_PRESETS[agent]) {
    effectiveRunner = AGENT_PRESETS[agent].runner;
  } else {
    return res.status(400).json({ error: `unknown agent: ${agent}` });
  }
  try {
    await saveSettings({ agent, runner: effectiveRunner });
    res.json({ ok: true, agent, runner: effectiveRunner });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/configs', async (_req, res) => {
  res.json({ configs: await listConfigs() });
});

app.get('/api/configs/:slug', async (req, res) => {
  try {
    res.json(await readConfig(req.params.slug));
  } catch (err) {
    res.status(404).json({ error: String(err.message || err) });
  }
});

app.put('/api/configs/:slug', async (req, res) => {
  try {
    if (typeof req.body?.raw !== 'string') {
      return res.status(400).json({ error: 'raw must be a string' });
    }
    await writeConfig(req.params.slug, req.body.raw);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/reports', async (_req, res) => {
  res.json({
    reports: await listMarkdownFiles(REPORTS_DIR),
    social: await listMarkdownFiles(SOCIAL_DIR),
  });
});

app.get('/api/reports/:name', async (req, res) => {
  try {
    res.json(await readMarkdown(REPORTS_DIR, req.params.name));
  } catch (err) {
    res.status(404).json({ error: String(err.message || err) });
  }
});

app.get('/api/social/:name', async (req, res) => {
  try {
    res.json(await readMarkdown(SOCIAL_DIR, req.params.name));
  } catch (err) {
    res.status(404).json({ error: String(err.message || err) });
  }
});

app.get('/api/runs', (_req, res) => {
  const list = [...runs.values()]
    .map((r) => ({
      id: r.id,
      status: r.status,
      command: r.command,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  res.json({ runs: list });
});

app.get('/api/runs/:id', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json({
    id: run.id,
    status: run.status,
    command: run.command,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    output: run.output,
  });
});

function buildPrompt(command, args = {}) {
  const safe = (s) => String(s).replace(/["`$\\]/g, '');
  if (command === 'custom' && typeof args.prompt === 'string') {
    return safe(args.prompt);
  }
  const parts = [`/${command}`];
  if (args.slug) parts.push(safe(args.slug));
  if (args.extra) parts.push(safe(args.extra));
  return parts.join(' ');
}

app.post('/api/runs', async (req, res) => {
  const { command, args } = req.body || {};
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'command required' });
  }
  const prompt = buildPrompt(command, args || {});
  const { runner } = await getRunner();

  if (!runner) {
    return res.status(400).json({
      error: 'No agent configured. Pick one on the Setup view, or set SCOUT_RUNNER env var. You can also copy the prompt and run it manually.',
      prompt,
    });
  }

  const id = randomUUID();
  const commandLine = runner.replace('{prompt}', prompt);
  const run = {
    id,
    status: 'running',
    command: commandLine,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    output: '',
    listeners: new Set(),
  };
  runs.set(id, run);

  const child = spawn(commandLine, {
    shell: true,
    cwd: REPO_ROOT,
    env: process.env,
  });
  child.stdout.on('data', (d) => pushRunOutput(run, d.toString()));
  child.stderr.on('data', (d) => pushRunOutput(run, d.toString()));
  child.on('close', (code) => closeRun(run, code === 0 ? 'success' : `exited ${code}`));
  child.on('error', (err) => {
    pushRunOutput(run, `\n[runner error] ${err.message}\n`);
    closeRun(run, 'error');
  });

  res.json({ id, command: commandLine, prompt });
});

app.get('/api/runs/:id/stream', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).end();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  if (run.output) {
    res.write(`data: ${JSON.stringify({ chunk: run.output })}\n\n`);
  }
  if (run.status !== 'running') {
    res.write(`event: done\ndata: ${JSON.stringify({ status: run.status })}\n\n`);
    return res.end();
  }
  run.listeners.add(res);
  req.on('close', () => run.listeners.delete(res));
});

app.listen(PORT, async () => {
  const { runner, source } = await getRunner();
  console.log(`Content Scout web UI running at http://localhost:${PORT}`);
  console.log(`Repo root: ${REPO_ROOT}`);
  console.log(`Runner: ${runner || '(none — pick an agent on the Setup view)'}${source !== 'none' ? ` [${source}]` : ''}`);
});
