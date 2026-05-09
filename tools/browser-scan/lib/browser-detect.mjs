// Detect the OS default browser and resolve a Chromium-family executable
// to launch with --remote-debugging-port. Returns one of:
//   { kind: 'chromium', name, path }   - launchable for CDP attach
//   { kind: 'unsupported', name, reason } - default is non-Chromium (Firefox/Safari)
//   { kind: 'none', reason }           - nothing usable found
//
// "Chromium-family" means anything that supports --remote-debugging-port
// and Playwright's chromium.connectOverCDP. That covers Edge, Chrome,
// Brave, Opera, Vivaldi, Arc. Firefox uses a different remote-debugging
// protocol that connectOverCDP does NOT support, so we have to fall back
// to a Chromium-family browser if the user's default is Firefox.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// Friendly name + the executable path(s) we know about, per OS.
// Order within each platform = preferred fallback when default isn't found.
const KNOWN_BROWSERS = {
  win32: [
    { name: 'Microsoft Edge', kind: 'chromium', protocolHandlers: ['MSEdgeHTM', 'MSEdgeMHT'], paths: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      `${process.env.LOCALAPPDATA || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ]},
    { name: 'Google Chrome', kind: 'chromium', protocolHandlers: ['ChromeHTML'], paths: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    ]},
    { name: 'Brave', kind: 'chromium', protocolHandlers: ['BraveHTML', 'BraveFile'], paths: [
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      `${process.env.LOCALAPPDATA || ''}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    ]},
    { name: 'Vivaldi', kind: 'chromium', protocolHandlers: ['VivaldiHTM'], paths: [
      `${process.env.LOCALAPPDATA || ''}\\Vivaldi\\Application\\vivaldi.exe`,
      'C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe',
    ]},
    { name: 'Opera', kind: 'chromium', protocolHandlers: ['OperaStable'], paths: [
      `${process.env.LOCALAPPDATA || ''}\\Programs\\Opera\\opera.exe`,
    ]},
    { name: 'Mozilla Firefox', kind: 'firefox', protocolHandlers: ['FirefoxURL', 'FirefoxHTML'], paths: [
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
    ]},
  ],
  darwin: [
    { name: 'Microsoft Edge', kind: 'chromium', bundleId: 'com.microsoft.edgemac', paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] },
    { name: 'Google Chrome', kind: 'chromium', bundleId: 'com.google.chrome', paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] },
    { name: 'Brave', kind: 'chromium', bundleId: 'com.brave.browser', paths: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'] },
    { name: 'Arc', kind: 'chromium', bundleId: 'company.thebrowser.browser', paths: ['/Applications/Arc.app/Contents/MacOS/Arc'] },
    { name: 'Vivaldi', kind: 'chromium', bundleId: 'com.vivaldi.vivaldi', paths: ['/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'] },
    { name: 'Opera', kind: 'chromium', bundleId: 'com.operasoftware.opera', paths: ['/Applications/Opera.app/Contents/MacOS/Opera'] },
    { name: 'Mozilla Firefox', kind: 'firefox', bundleId: 'org.mozilla.firefox', paths: ['/Applications/Firefox.app/Contents/MacOS/firefox'] },
    { name: 'Safari', kind: 'unsupported', bundleId: 'com.apple.safari', paths: ['/Applications/Safari.app/Contents/MacOS/Safari'] },
  ],
  linux: [
    { name: 'Google Chrome', kind: 'chromium', desktopFile: 'google-chrome', paths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/google-chrome'] },
    { name: 'Microsoft Edge', kind: 'chromium', desktopFile: 'microsoft-edge', paths: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/snap/bin/microsoft-edge'] },
    { name: 'Brave', kind: 'chromium', desktopFile: 'brave-browser', paths: ['/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave'] },
    { name: 'Chromium', kind: 'chromium', desktopFile: 'chromium', paths: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'] },
    { name: 'Vivaldi', kind: 'chromium', desktopFile: 'vivaldi', paths: ['/usr/bin/vivaldi'] },
    { name: 'Opera', kind: 'chromium', desktopFile: 'opera', paths: ['/usr/bin/opera'] },
    { name: 'Mozilla Firefox', kind: 'firefox', desktopFile: 'firefox', paths: ['/usr/bin/firefox', '/snap/bin/firefox'] },
  ],
};

function platformList() {
  return KNOWN_BROWSERS[process.platform] || [];
}

function firstExisting(paths) {
  for (const p of paths || []) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// Look up the OS default browser. Returns the matching KNOWN_BROWSERS
// entry (with `path` populated) or null on failure / unknown.
function detectDefaultBrowser() {
  try {
    if (process.platform === 'win32') return detectWin32();
    if (process.platform === 'darwin') return detectDarwin();
    if (process.platform === 'linux') return detectLinux();
  } catch {
    return null;
  }
  return null;
}

function detectWin32() {
  // Read the user's default ProgId for https://. PowerShell is the most
  // reliable cross-version way to read this without external deps.
  const cmd = 'powershell.exe -NoProfile -Command "(Get-ItemProperty -Path HKCU:\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice -ErrorAction SilentlyContinue).ProgId"';
  let progId;
  try {
    progId = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
  if (!progId) return null;
  for (const browser of platformList()) {
    if (browser.protocolHandlers?.some((h) => progId.toLowerCase().startsWith(h.toLowerCase()))) {
      const p = firstExisting(browser.paths);
      return { ...browser, path: p, defaultRegistration: progId };
    }
  }
  return { name: progId, kind: 'unknown', path: null, defaultRegistration: progId };
}

function detectDarwin() {
  // macOS: query LaunchServices via `defaults read` for LSHandlers.
  // The reliable command is `defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers` then look for LSHandlerURLScheme = https.
  let raw;
  try {
    raw = execSync('defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers', { encoding: 'utf8', timeout: 5000 });
  } catch {
    return null;
  }
  // Find the block whose LSHandlerURLScheme = "https"; pull LSHandlerRoleAll bundle id.
  const blockMatch = raw.split(/\}\s*,?\s*\{/).find((b) => /LSHandlerURLScheme\s*=\s*https;/.test(b));
  if (!blockMatch) return null;
  const idMatch = blockMatch.match(/LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?\s*;/);
  if (!idMatch) return null;
  const bundleId = idMatch[1].toLowerCase();
  for (const browser of platformList()) {
    if (browser.bundleId && browser.bundleId.toLowerCase() === bundleId) {
      const p = firstExisting(browser.paths);
      return { ...browser, path: p, defaultRegistration: bundleId };
    }
  }
  return { name: bundleId, kind: 'unknown', path: null, defaultRegistration: bundleId };
}

function detectLinux() {
  // Try xdg-mime first, fall back to BROWSER env var.
  let desktop;
  try {
    desktop = execSync('xdg-mime query default x-scheme-handler/https', { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    desktop = process.env.BROWSER || '';
  }
  if (!desktop) return null;
  // desktop is something like "google-chrome.desktop"
  const stem = desktop.replace(/\.desktop$/, '').toLowerCase();
  for (const browser of platformList()) {
    if (browser.desktopFile && stem.includes(browser.desktopFile)) {
      const p = firstExisting(browser.paths);
      return { ...browser, path: p, defaultRegistration: desktop };
    }
  }
  return { name: stem, kind: 'unknown', path: null, defaultRegistration: desktop };
}

// Public entry: pick the best browser for CDP attach.
//
// Strategy:
//   1. Try the OS default browser. If it's chromium-family AND installed,
//      use it.
//   2. Otherwise, walk the per-platform fallback list and pick the first
//      installed Chromium-family browser.
//   3. Return a `notice` string when we deviate from the user's default
//      so the caller can print a friendly message.
export function pickBrowser({ preferred = null } = {}) {
  const list = platformList();
  if (!list.length) {
    return { ok: false, error: `Unsupported OS: ${process.platform}. browser-scan only runs on win32, darwin, or linux.` };
  }

  // Honor explicit override (used by --browser flag).
  if (preferred) {
    const wanted = list.find((b) => b.name.toLowerCase() === preferred.toLowerCase());
    if (!wanted) {
      return { ok: false, error: `Unknown browser "${preferred}". Try one of: ${list.map((b) => b.name).join(', ')}.` };
    }
    if (wanted.kind !== 'chromium') {
      return { ok: false, error: `${wanted.name} is not a Chromium-family browser and cannot be controlled over CDP. Use Edge, Chrome, Brave, Vivaldi, Arc, or Opera.` };
    }
    const p = firstExisting(wanted.paths);
    if (!p) {
      return { ok: false, error: `${wanted.name} is configured as preferred but isn't installed at any of the known paths.` };
    }
    return { ok: true, browser: { ...wanted, path: p }, notice: null, source: 'override' };
  }

  // 1. Try OS default.
  const defaultBrowser = detectDefaultBrowser();
  if (defaultBrowser?.kind === 'chromium' && defaultBrowser.path) {
    return { ok: true, browser: defaultBrowser, notice: null, source: 'default' };
  }

  // 2. Walk fallbacks. If the default was non-chromium, surface a notice.
  for (const candidate of list) {
    if (candidate.kind !== 'chromium') continue;
    const p = firstExisting(candidate.paths);
    if (!p) continue;
    let notice = null;
    if (defaultBrowser && defaultBrowser.kind && defaultBrowser.kind !== 'chromium') {
      notice =
        `Your default browser (${defaultBrowser.name}) doesn't support the Chrome DevTools Protocol that browser-scan needs. ` +
        `Falling back to ${candidate.name} for the browser-scan window. Your default browser stays untouched.`;
    } else if (defaultBrowser && defaultBrowser.kind === 'unknown') {
      notice =
        `Couldn't identify your default browser. Falling back to ${candidate.name} for browser-scan. ` +
        `Pass --browser <name> to override.`;
    }
    return { ok: true, browser: { ...candidate, path: p }, notice, source: 'fallback' };
  }

  // 3. Nothing installed.
  return {
    ok: false,
    error:
      'No Chromium-family browser found (Edge, Chrome, Brave, Vivaldi, Arc, Opera). ' +
      'Install one to use browser-scan, e.g. https://www.microsoft.com/edge.',
  };
}

// Convenience: list known browser names so the UI can build a dropdown.
export function listKnownBrowsers() {
  return platformList().map((b) => ({
    name: b.name,
    kind: b.kind,
    installed: !!firstExisting(b.paths),
  }));
}
