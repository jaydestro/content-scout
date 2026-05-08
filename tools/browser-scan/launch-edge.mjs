#!/usr/bin/env node
// Launch Microsoft Edge with the Chrome DevTools Protocol enabled, so the
// browser-scan tool can attach over CDP and reuse this real Edge session
// (cookies, passkeys, 2FA, the works).
//
// Usage:
//   node tools/browser-scan/launch-edge.mjs                # default port 9222, dedicated CDP profile
//   node tools/browser-scan/launch-edge.mjs --port 9333
//   node tools/browser-scan/launch-edge.mjs --use-default-profile   # share your real Edge profile (see warning below)
//
// IMPORTANT: by default this launches Edge with a DEDICATED user-data-dir
// at `tools/browser-scan/.cdp-profile/`. That directory is gitignored.
// You log in to X / LinkedIn / Reddit *once* in this Edge window — the
// session sticks to that profile across runs.
//
// Why a dedicated profile by default?
//   - Edge refuses to enable remote debugging on a profile that is already
//     in use by a normal Edge window. Trying to attach to your day-to-day
//     Edge profile while it's running fails with "DevToolsActivePort missing".
//   - Closing your normal Edge to free the profile is annoying.
//   - The dedicated profile also keeps your scraping browsing separate
//     from your personal browsing, which is what you usually want.
//
// If you really want to share your existing day-to-day Edge profile, pass
// --use-default-profile. You must close ALL existing Edge windows first.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const flags = { port: 9222, 'use-default-profile': false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') { flags.port = Number(argv[++i] || 9222); }
  else if (a === '--use-default-profile') { flags['use-default-profile'] = true; }
  else if (a === '--help' || a === '-h') {
    console.log(`Usage: node launch-edge.mjs [--port 9222] [--use-default-profile]`);
    process.exit(0);
  }
}

// Pick an Edge executable. Try common Windows install paths first, then
// fall back to PATH. macOS / Linux paths included for completeness.
const candidates = process.platform === 'win32'
  ? [
      'C\u003a\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C\u003a\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      `${process.env.LOCALAPPDATA || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ]
  : process.platform === 'darwin'
  ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
  : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/snap/bin/microsoft-edge'];

const edgePath = candidates.find((p) => p && fs.existsSync(p));
if (!edgePath) {
  console.error('Could not find Microsoft Edge. Install it from https://www.microsoft.com/edge or pass the path manually.');
  process.exit(1);
}

const args = [`--remote-debugging-port=${flags.port}`];

if (!flags['use-default-profile']) {
  const cdpProfileDir = path.join(__dirname, '.cdp-profile');
  fs.mkdirSync(cdpProfileDir, { recursive: true });
  args.push(`--user-data-dir=${cdpProfileDir}`);
  console.log(`[launch-edge] Using dedicated CDP profile: ${cdpProfileDir}`);
} else {
  console.log('[launch-edge] Using your DEFAULT Edge profile. Close all other Edge windows first or this will fail.');
}

// Open the three login pages so you can sign in once.
args.push(
  'https://x.com/login',
  'https://www.linkedin.com/login',
  'https://www.reddit.com/login/'
);

console.log(`[launch-edge] Launching: ${edgePath}`);
console.log(`[launch-edge] Debug port: ${flags.port}`);
console.log(`[launch-edge] Sign in to X, LinkedIn, and Reddit in the Edge window that just opened.`);
console.log(`[launch-edge] Once signed in, leave Edge running and start a scan in another terminal:`);
console.log(`[launch-edge]   node tools/browser-scan/index.mjs scan --slug <your-slug>`);
console.log(`[launch-edge] (the scanner attaches over CDP and reuses these sessions)`);

const child = spawn(edgePath, args, {
  detached: false,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', (code) => {
  console.log(`[launch-edge] Edge exited with code ${code ?? 0}.`);
  process.exit(code ?? 0);
});

// Pass through Ctrl+C
process.on('SIGINT', () => { try { child.kill('SIGINT'); } catch { /* ignore */ } });
process.on('SIGTERM', () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } });
