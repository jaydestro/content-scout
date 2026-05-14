#!/usr/bin/env node
// scout-cli — headless CLI for Content Scout that drives the SAME agent
// commands as the web UI. This is the parity surface: every /scout-*
// command exposed in the web UI's Run view also runs here.
//
// Usage:
//   scout <command> [args] [options]
//
// Agent-driven commands (all 9 prompts):
//   scout scan      [slug]        Run /scout-scan
//   scout post      [url-or-item] Run /scout-post (image alt-text sub-flow lives here)
//   scout calendar  [slug]        Run /scout-calendar
//   scout gaps      [slug]        Run /scout-gaps
//   scout trends    [slug]        Run /scout-trends
//   scout creators  [slug]        Run /scout-creators
//   scout doctor    [slug]        Run /scout-doctor (keys + vision sub-flows live here)
//   scout replay    [slug]        Run /scout-replay
//   scout seo       [url]         Run /scout-seo
//   scout onboard                 Run /scout-onboard wizard
//
// Direct utilities (no agent — same code as web UI internals):
//   scout search    <query>       Full-text search reports + social posts
//   scout config    [...]         View/set agent runner (claude|copilot|codex|cursor|gemini|<custom>)
//   scout browser   [...]         Wraps tools/browser-scan/index.mjs (Layer 0)
//   scout sources                 Wraps tools/probe-sources.mjs (source health)
//   scout convo     [...]         Wraps tools/conversations-cli.mjs (close/reopen mentions)
//   scout list                    List available commands
//
// Global options:
//   -h, --help                    Show this help (or per-command help)
//   --extra "<text>"              Extra text appended to the prompt (free-form args for the agent)
//   --runner "<template>"         Override SCOUT_RUNNER for this invocation
//   --print-prompt                Print the prompt that would be sent and exit (no agent run)
//
// Configuration:
//   The agent runner is read from (in order): --runner flag, SCOUT_RUNNER env
//   var, then the shared settings file at tools/web-ui/.scout-web-settings.json.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import {
  AGENT_PRESETS,
  loadSettings,
  saveSettings,
  getRunner,
  buildPrompt,
  runAgent,
  REPO,
} from '../lib/agent-runner.mjs';
import { searchCorpus } from '../lib/corpus-search.mjs';

const __filename = fileURLToPath(import.meta.url);

const AGENT_COMMANDS = new Set([
  'scan',
  'post',
  'calendar',
  'gaps',
  'trends',
  'creators',
  'doctor',
  'replay',
  'seo',
  'onboard',
]);

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        out.flags[key] = true;
      } else {
        out.flags[key] = next;
        i++;
      }
    } else if (a.startsWith('-') && a.length > 1) {
      out.flags[a.slice(1)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function cmdAgent(name, args) {
  if (args.flags.h || args.flags.help) {
    console.log(`Usage: scout ${name} [slug] [--extra "<more>"] [--print-prompt]`);
    console.log(`Runs the /scout-${name} agent prompt.`);
    return 0;
  }
  if (args.flags.runner) process.env.SCOUT_RUNNER = String(args.flags.runner);
  const slug = args._[0];
  const extra = args.flags.extra ? String(args.flags.extra) : undefined;
  const slashCmd = `scout-${name}`;
  if (args.flags['print-prompt']) {
    console.log(buildPrompt(slashCmd, { slug, extra }));
    return 0;
  }
  try {
    const { code, prompt, commandLine, source } = await runAgent(slashCmd, { slug, extra });
    if (process.env.SCOUT_DEBUG) {
      console.error(`[scout] runner source=${source}`);
      console.error(`[scout] command: ${commandLine}`);
      console.error(`[scout] prompt:  ${prompt}`);
    }
    return code;
  } catch (err) {
    if (err.code === 'NO_AGENT') {
      console.error(err.message);
      console.error('\nPrompt that would have been sent:');
      console.error(`  ${err.prompt}`);
      console.error('\nFix: scout config agent <claude|copilot|codex|cursor|gemini>');
      return 2;
    }
    console.error(`[scout] failed: ${err.message}`);
    return 1;
  }
}

async function cmdSearch(args) {
  if (args.flags.h || args.flags.help || args._.length === 0) {
    console.log('Usage: scout search <query> [--regex] [--kind reports|social-posts] [--json]');
    return args._.length === 0 ? 1 : 0;
  }
  // Delegate to the existing search.mjs to avoid duplicating output formatting.
  const searchScript = path.join(REPO, 'tools', 'search.mjs');
  const passThrough = process.argv.slice(3); // drop node + scout-cli + 'search'
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [searchScript, ...passThrough], {
      stdio: 'inherit',
      cwd: REPO,
    });
    child.on('exit', (c) => resolve(c ?? 0));
  });
  return code;
}

async function cmdConfig(args) {
  const sub = args._[0];
  if (!sub || sub === 'show') {
    const { runner, source } = await getRunner();
    const settings = await loadSettings();
    console.log('Agent settings:');
    console.log(`  agent:  ${settings.agent || '(none)'}`);
    console.log(`  runner: ${runner || '(none)'}`);
    console.log(`  source: ${source}`);
    console.log('');
    console.log('Presets:');
    for (const [id, p] of Object.entries(AGENT_PRESETS)) {
      console.log(`  ${id.padEnd(8)} ${p.runner}`);
    }
    return 0;
  }
  if (sub === 'agent') {
    const id = args._[1];
    if (!id) {
      console.error('Usage: scout config agent <claude|copilot|codex|cursor|gemini>');
      return 1;
    }
    const preset = AGENT_PRESETS[id];
    if (!preset) {
      console.error(`Unknown preset: ${id}. Available: ${Object.keys(AGENT_PRESETS).join(', ')}`);
      return 1;
    }
    await saveSettings({ agent: id, runner: preset.runner });
    console.log(`Saved agent=${id}, runner=${preset.runner}`);
    return 0;
  }
  if (sub === 'runner') {
    const tmpl = args._.slice(1).join(' ');
    if (!tmpl) {
      console.error('Usage: scout config runner "<template with {prompt}>"');
      return 1;
    }
    const cur = await loadSettings();
    await saveSettings({ agent: cur.agent || 'custom', runner: tmpl });
    console.log(`Saved runner template.`);
    return 0;
  }
  console.error(`Unknown config subcommand: ${sub}. Try: show | agent | runner`);
  return 1;
}

async function delegate(scriptRelPath, argv) {
  const script = path.join(REPO, scriptRelPath);
  try {
    await fs.access(script);
  } catch {
    console.error(`[scout] missing tool: ${scriptRelPath}`);
    return 1;
  }
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...argv], {
      stdio: 'inherit',
      cwd: REPO,
    });
    child.on('exit', (c) => resolve(c ?? 0));
  });
  return code;
}

function printHelp() {
  console.log(`scout — headless CLI for Content Scout (parity with the web UI)

Agent-driven commands (drive the same /scout-* prompts as the chat agent
and the web UI's Run view):
  scout scan      [slug]
  scout post      [url-or-item]
  scout calendar  [slug]
  scout gaps      [slug]
  scout trends    [slug]
  scout creators  [slug]
  scout doctor    [slug]            (keys + vision live here as sub-flows)
  scout replay    [slug]
  scout seo       [url]
  scout onboard

Direct utilities:
  scout search    <query>           Full-text grep across reports + social posts
  scout config    [show|agent|runner ...]
                                    View / set the agent runner
  scout browser   [scan|launch|...] Layer 0 browser-scan (X / LinkedIn / Reddit)
  scout sources                     Source health probe
  scout convo     [...]             Conversations close/reopen
  scout thumbs    [...]             Render LinkedIn / X thumbnails
  scout list                        List installed scout-* prompts

Global flags (apply to agent commands):
  --extra "<text>"      Free-form text appended to the prompt
  --runner "<tmpl>"     Override SCOUT_RUNNER for this invocation
  --print-prompt        Show the prompt that would be sent and exit
  -h, --help            Show this help (or per-command help)

Examples:
  scout scan azure-cosmos-db
  scout post https://example.com/blog --extra "linkedin only, professional tone"
  scout config agent claude
  scout search "vector search" --kind reports
  SCOUT_RUNNER='claude -p "{prompt}"' scout doctor
`);
}

async function cmdList() {
  const dir = path.join(REPO, '.github', 'prompts');
  const files = (await fs.readdir(dir)).filter((f) => f.startsWith('scout-') && f.endsWith('.prompt.md'));
  console.log('Installed scout prompts:');
  for (const f of files.sort()) {
    const name = f.replace(/^scout-/, '').replace(/\.prompt\.md$/, '');
    console.log(`  scout-${name.padEnd(18)} (${f})`);
  }
  return 0;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    printHelp();
    return 0;
  }
  const parsed = parseArgs(rest);
  if (AGENT_COMMANDS.has(cmd)) return cmdAgent(cmd, parsed);
  switch (cmd) {
    case 'search':
      return cmdSearch(parsed);
    case 'config':
      return cmdConfig(parsed);
    case 'browser':
      return delegate('tools/browser-scan/index.mjs', rest);
    case 'sources':
      return delegate('tools/probe-sources.mjs', rest);
    case 'convo':
    case 'conversations':
      return delegate('tools/conversations-cli.mjs', rest);
    case 'thumbs':
    case 'thumbnails':
      return delegate('tools/render-thumbnails/index.js', rest);
    case 'list':
      return cmdList();
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error('Run `scout --help` for the list of commands.');
      return 1;
  }
}

main().then(
  (code) => process.exit(code || 0),
  (err) => {
    console.error('[scout] crashed:', err.stack || err.message || err);
    process.exit(1);
  },
);
