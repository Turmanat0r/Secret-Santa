// policy.ts - the rules about what the app may do, kept apart from the code
// that enforces them so they can be read in one place and tested without
// starting Electron.
//
// What lives here:
//   1. The network allowlist and the Content Security Policy built from it.
//   2. Which requests the window may make, and which files it may load.
//   3. The Chromium switches that turn off the browser engine's own networking.
//   4. Graphics: which drawing mode to start in, what to fall back to, and
//      how to tell whether a window actually painted anything.

import path from 'node:path';
import type { GraphicsMode } from './storage.ts';

// ---------------------------------------------------------------------------
// 1. Network allowlist and Content Security Policy
// ---------------------------------------------------------------------------

/**
 * Exact origins (scheme + host) the app may contact. Secret Santa never uses
 * the network, so this is empty - and it is the same list used for the
 * window's `connect-src`. Adding an origin here is the only way to allow one.
 */
export const NETWORK_ALLOWLIST: readonly string[] = [];

/** The address the window is served from (a private scheme, never file:// or http://). */
export const APP_SCHEME = 'app';
export const APP_HOST = 'secret-santa';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const PAGE_URL = `${APP_ORIGIN}/index.html`;

/**
 * The window's Content Security Policy. Sent as a response header by the
 * main process AND repeated in index.html's <meta> tag; a test checks the two
 * are identical. Scripts, styles, fonts and images come only from the app
 * itself, forever. Only `connect-src` may ever name a remote origin.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  `connect-src ${NETWORK_ALLOWLIST.length > 0 ? NETWORK_ALLOWLIST.join(' ') : "'none'"}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// ---------------------------------------------------------------------------
// 2. Requests and files
// ---------------------------------------------------------------------------

/**
 * May a request to `url` go ahead? Allowed: the app's own pages (app://secret-santa)
 * and anything on the network allowlist. In development only, the developer
 * tools' own pages. Everything else - including file://, http(s):// and
 * anything a dependency or Chromium tries on its own - is cancelled.
 */
export function isAllowedRequest(url: string, isPackaged: boolean): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === `${APP_SCHEME}:`) return parsed.host === APP_HOST;
  if (parsed.protocol === 'devtools:') return !isPackaged;
  return NETWORK_ALLOWLIST.includes(parsed.origin);
}

/** True when a page address belongs to the app's own window. */
export function isAppUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}

/** The only files the window is ever served, and their content types. */
const PAGE_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};

/**
 * Map an app:// address to a file on disk. Only the three files above can
 * ever be served; any other path - including attempts like /../main.js -
 * returns null. Nothing typed in the window can reach any other file.
 */
export function rendererFileFor(url: string, rendererDir: string): { file: string; type: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null;
  const entry = Object.hasOwn(PAGE_FILES, parsed.pathname) ? PAGE_FILES[parsed.pathname] : undefined;
  return entry ? { file: path.join(rendererDir, entry.file), type: entry.type } : null;
}

// ---------------------------------------------------------------------------
// 3. Chromium's own networking
// ---------------------------------------------------------------------------

/**
 * Switches that stop the browser engine contacting anything by itself:
 * background fetches, component updates, reliability reports, hyperlink
 * auditing pings, proxy auto-discovery (WPAD), secure-DNS probes and
 * media-device discovery on the network.
 * None of that is ever "the app's network use", so it is switched off at the
 * source rather than merely filtered.
 */
export const CHROMIUM_SWITCHES: ReadonlyArray<readonly [string, string?]> = [
  ['disable-background-networking'],
  ['disable-component-update'],
  ['disable-domain-reliability'],
  ['no-pings'],
  // Never look for a proxy. Windows' "automatically detect settings" otherwise makes
  // Chromium look up a WPAD server on the local network at start-up.
  ['no-proxy-server'],
  ['disable-features', 'DnsOverHttps,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication'],
];

// ---------------------------------------------------------------------------
// 4. Graphics
// ---------------------------------------------------------------------------

/** The graphics mode to start in, and why - the reason goes in the log. */
export interface GraphicsChoice {
  mode: GraphicsMode;
  reason: string;
}

/**
 * Decide how to draw the window, most specific instruction first:
 *  1. a restart the app did itself after a drawing failure (--ss-graphics=...)
 *  2. the SECRET_SANTA_GRAPHICS environment variable (default | angle-gl | software)
 *  3. a Remote Desktop session, which has no graphics card -> software
 *  4. what worked last time on this computer (settings.json)
 *  5. otherwise the normal hardware-accelerated mode
 */
export function chooseGraphics(input: {
  relaunchArg: string | undefined;
  envSetting: string | undefined;
  sessionName: string | undefined;
  saved: GraphicsMode;
}): GraphicsChoice {
  const valid = (v: string | undefined): v is GraphicsMode => v === 'default' || v === 'angle-gl' || v === 'software';
  if (valid(input.relaunchArg)) return { mode: input.relaunchArg, reason: 'restarted after a drawing failure' };
  if (valid(input.envSetting)) return { mode: input.envSetting, reason: 'SECRET_SANTA_GRAPHICS environment variable' };
  if (isRemoteSession(input.sessionName)) return { mode: 'software', reason: 'Remote Desktop session' };
  return { mode: input.saved, reason: input.saved === 'default' ? 'normal start' : 'saved from an earlier drawing failure' };
}

/**
 * Remote Desktop sessions are named "RDP-Tcp#N" in the SESSIONNAME variable
 * Windows sets for every session (a local sign-in is "Console"). This is the
 * same fact GetSystemMetrics(SM_REMOTESESSION) reports, read without native code.
 */
export function isRemoteSession(sessionName: string | undefined): boolean {
  return /^rdp-/i.test(sessionName ?? '');
}

/**
 * The next, more compatible mode after a drawing failure:
 * default (Direct3D 11) -> angle-gl (OpenGL; still uses the graphics card) -> software.
 * Returns null when there is nothing left to fall back to.
 */
export function nextGraphicsMode(mode: GraphicsMode): GraphicsMode | null {
  if (mode === 'default') return 'angle-gl';
  if (mode === 'angle-gl') return 'software';
  return null;
}

/**
 * Does a screenshot of the window show nothing at all? Takes the raw BGRA
 * pixels of a capture and reports true when every pixel is the same colour -
 * a window that opened blank, black or white. A real Secret Santa window
 * always has its coloured header, so it never looks uniform.
 */
export function looksBlank(pixels: Uint8Array, width: number, height: number): boolean {
  const count = width * height;
  if (count === 0 || pixels.length < count * 4) return true;
  const [b, g, r] = [pixels[0], pixels[1], pixels[2]];
  for (let i = 4; i < count * 4; i += 4) {
    if (pixels[i] !== b || pixels[i + 1] !== g || pixels[i + 2] !== r) return false;
  }
  return true;
}
