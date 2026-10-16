// main.ts - the Electron main process: the only part of Secret Santa that can
// touch the computer.
//
// The window (src/renderer) is treated as untrusted. It can only ask for the
// things listed in shared/types.d.ts (SantaApi), every request is checked here
// before anything happens, and it never sees a file path.
//
// Sections, in the order things happen:
//   0. Before Electron is ready - test hooks, data folder, graphics mode,
//      Chromium switches, single-instance lock.
//   1. Startup - lock down the session, walk the requirements manifest,
//      deal with damaged files, open the window.
//   2. The window - security handlers, failure handlers, paint check.
//   3. Graphics recovery - what to do when the window doesn't draw.
//   4. Requests from the window (IPC).
//   5. Shutdown - flush, release the lock, exit.
//   6. Dialogs Windows draws, and the test hooks behind them.

import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, protocol, screen, session, shell } from 'electron';
import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
  MessageBoxOptions,
  OpenDialogOptions,
  OpenDialogReturnValue,
  Rectangle,
  SaveDialogOptions,
  SaveDialogReturnValue,
  Session,
  WebContents,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as policy from './policy.ts';
import * as santa from './santa.ts';
import * as storage from './storage.ts';
import type { ActionResult, Exchange, Outcome, StartupInfo } from '../shared/types.js';

// ===========================================================================
// 0. Before Electron is ready
// ===========================================================================

/** dist/main - where this file and the preload script live once built. */
const mainDir = path.dirname(fileURLToPath(import.meta.url));
/** The project folder in development; resources\app.asar once installed. */
const appDir = app.getAppPath();
const rendererDir = path.join(appDir, 'src', 'renderer');

/**
 * Test hooks. They exist only in an unpackaged development build started with
 * SECRET_SANTA_TEST=1; an installed copy of the app ignores all of them.
 */
const testing = !app.isPackaged && process.env.SECRET_SANTA_TEST === '1';
const testEnv = (name: string): string | undefined => (testing ? process.env[name] : undefined);

const testDataDir = testEnv('SECRET_SANTA_DATA_DIR');
if (testDataDir) app.setPath('userData', path.resolve(testDataDir));

/** %APPDATA%\Secret Santa - the only place the app writes. */
const dataDir = app.getPath('userData');
// Chromium's own caches and browser storage go in a subfolder, so the data
// folder itself holds only the person's files. The app never uses any of it.
app.setPath('sessionData', path.join(dataDir, 'chromium'));
const log = new storage.Log(path.join(dataDir, 'logs'), !app.isPackaged);
const bases: Record<storage.Base, string> = { userData: dataDir, app: appDir };

// An installed copy refuses to run with remote-debugging switches, which would
// let another program drive the window. (The packaged build's fuses already
// block Node's --inspect.)
if (app.isPackaged && ['remote-debugging-port', 'remote-debugging-pipe'].some((name) => app.commandLine.hasSwitch(name))) {
  log.warn('Refused to start with a remote-debugging switch.');
  process.exit(1);
}

/** The value of a "--name=value" argument this app passes to itself when it restarts. */
function ownArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}
/** Set when this run is a restart the app did itself after a drawing failure. */
const relaunchedBecause = ownArg('ss-relaunched');

// The requirements manifest is read now (it's just a file) so the settings
// path comes from it; any problem is reported once a dialog can be shown.
let manifest: storage.Manifest | null = null;
let manifestError: unknown = null;
try {
  manifest = storage.loadManifest(testEnv('SECRET_SANTA_TEST_MANIFEST') ?? path.join(appDir, 'requirements.json'));
} catch (error) {
  manifestError = error;
}

/** Where a manifest entry lives on disk (falls back to `fallback` if the manifest is unusable). */
function fileOf(id: string, fallback: string): string {
  const entry = manifest?.requirements.find((item) => item.id === id);
  return entry ? storage.resolveEntry(entry, bases) : path.join(dataDir, fallback);
}
const exchangeFile = fileOf('exchange', 'exchange.json');
const settingsFile = fileOf('settings', 'settings.json');

// Settings are read early - before the formal startup check - because the
// graphics mode has to be chosen before Electron starts drawing anything.
let settings: storage.Settings = (() => {
  const read = storage.readJson(settingsFile);
  return (read.state === 'ok' && storage.checkSettings(read.value)) || storage.defaultSettings();
})();

const graphics = policy.chooseGraphics({
  relaunchArg: ownArg('ss-graphics'),
  envSetting: process.env.SECRET_SANTA_GRAPHICS,
  sessionName: process.env.SESSIONNAME,
  saved: settings.graphics,
});
if (graphics.mode === 'angle-gl') app.commandLine.appendSwitch('use-angle', 'gl');
if (graphics.mode === 'software') app.disableHardwareAcceleration();

// Switch off Chromium's own background networking at the source.
for (const [name, value] of policy.CHROMIUM_SWITCHES) {
  if (value === undefined) app.commandLine.appendSwitch(name);
  else app.commandLine.appendSwitch(name, value);
}

// The window is served from app://secret-santa rather than file://, so its
// Content Security Policy has a real origin to mean by 'self'.
protocol.registerSchemesAsPrivileged([{ scheme: policy.APP_SCHEME, privileges: { standard: true, secure: true } }]);

// --- Everything the rest of the file shares ---------------------------------

let win: BrowserWindow | null = null;
let exchange: Exchange = santa.emptyExchange();
let exchangeLoaded = false;
let settingsLoaded = false;
let startupNotices: string[] = [];
let quitting = false;
let shutdownDone = false;
let closeAllowed = false;
let rendererReady = false;
let paintChecked = false;
let graphicsFailureHandled = false;
const recentWindowCrashes: number[] = [];
const timers = new Set<NodeJS.Timeout>();

/** setTimeout that is cancelled automatically at shutdown, so nothing lingers. */
function later(action: () => void, ms: number): void {
  const timer = setTimeout(() => {
    timers.delete(timer);
    action();
  }, ms);
  timers.add(timer);
}
const pause = (ms: number): Promise<void> => new Promise((resolve) => later(resolve, ms));

/** The checkers the manifest refers to by name in its "shape" field. */
const shapes: Record<string, storage.Shape> = {
  exchange: { check: (value) => santa.checkExchange(value) !== null, create: () => santa.emptyExchange() },
  settings: { check: (value) => storage.checkSettings(value) !== null, create: () => storage.defaultSettings() },
};

// --- Single instance ---------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  // Another copy is already running; Electron has already told it to come to
  // the front (see 'second-instance' below). This copy just leaves.
  app.quit();
} else {
  app.on('second-instance', () => {
    log.info('Secret Santa was opened again; brought the existing window forward instead.');
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on('web-contents-created', (_event, contents) => hardenContents(contents));
  app.on('session-created', (created) => secureSession(created));
  app.on('child-process-gone', (_event, details) => {
    if (details.type !== 'GPU' || quitting || details.reason === 'clean-exit') return;
    log.error(`The graphics process ended unexpectedly: ${details.reason} (exit code ${details.exitCode}).`);
    void recoverGraphics('gpu-crash');
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => runShutdown());
  app.whenReady().then(startup).catch(async (error: unknown) => {
    log.error('Startup failed', error);
    await tell('error', "Secret Santa couldn't start.", 'Details were written to the log file in the data folder. Running setup.ps1 again may fix it.', ['Close']);
    quitNow();
  });
}

// ===========================================================================
// 1. Startup
// ===========================================================================

async function startup(): Promise<void> {
  // No menu bar: Electron's default menu includes a View menu that opens the
  // developer tools, and this app has no menu commands of its own.
  Menu.setApplicationMenu(null);
  secureSession(session.defaultSession);
  serveWindowFiles();
  registerRequests();
  log.info(
    `Starting Secret Santa ${app.getVersion()} (Electron ${process.versions.electron}). ` +
      `Graphics: ${graphics.mode} (${graphics.reason}).`,
  );

  if (!manifest) {
    log.error('Requirements list unusable', manifestError);
    await tell('error', "Secret Santa can't open because part of the program (its list of requirements) is missing or damaged.", 'Run setup.ps1 again to reinstall it.', ['Close']);
    quitNow();
    return;
  }

  // Walk the manifest: check, create or verify everything the app needs.
  const walk = storage.walkRequirements(manifest, { bases, shapes });
  if (walk.stop) {
    log.warn(`Stopped at startup: ${walk.stop}`);
    await tell('error', walk.stop, '', ['Close']);
    quitNow();
    return;
  }
  startupNotices = [...walk.notices];
  for (const notice of walk.notices) log.info(`Startup notice: ${notice}`);

  // A damaged file holding the person's work has been left untouched; ask.
  for (const refusal of walk.refusals) {
    const notice = await askAboutDamagedFile(refusal);
    if (notice === null) {
      quitNow();
      return;
    }
    startupNotices.push(notice);
  }

  exchange = readVerified(exchangeFile, santa.checkExchange);
  exchangeLoaded = true;
  settings = readVerified(settingsFile, storage.checkSettings);
  settingsLoaded = true;
  createWindow();
}

/** Read a file the manifest walk has just verified. */
function readVerified<T>(file: string, check: (value: unknown) => T | null): T {
  const read = storage.readJson(file);
  const value = read.state === 'ok' ? check(read.value) : null;
  if (value === null) throw new Error(`${path.basename(file)} failed its check straight after being verified.`);
  return value;
}

/**
 * A damaged file that holds the person's work. Nothing has been done to it.
 * Offer: restore the copy from the last session (if there is a good one), set
 * the damaged file aside (renamed, never deleted) and start fresh, open the
 * data folder to look, or quit. Returns the sentence to show in the window,
 * or null if the person chose to quit.
 */
async function askAboutDamagedFile(refusal: storage.Refusal): Promise<string | null> {
  const restore = 'Restore the last good copy';
  const fresh = 'Set it aside and start fresh';
  const look = 'Open the data folder';
  const quit = 'Quit';
  const buttons = [...(refusal.canRestore ? [restore] : []), fresh, look, quit];
  const detail = refusal.canRestore
    ? 'You can restore the copy Secret Santa saved when you last opened it, or set the damaged file aside and start with an empty exchange. Setting it aside renames it; nothing is deleted.'
    : 'You can set the damaged file aside and start with an empty exchange, or quit and look at it first. Setting it aside renames it; nothing is deleted.';
  log.warn(`Damaged file left untouched: ${path.basename(refusal.file)}`);
  for (;;) {
    const choice = buttons[
      await tell('warning', refusal.entry.says.damaged ?? `${refusal.entry.what} is damaged.`, detail, buttons, buttons.length - 1)
    ];
    if (choice === look) {
      await shell.openPath(dataDir);
      continue;
    }
    if (choice === restore) {
      const aside = storage.restoreFromBackup(refusal, bases);
      log.info(`Restored ${path.basename(refusal.file)} from its backup; damaged copy kept as ${path.basename(aside)}.`);
      return `The damaged file was renamed to ${path.basename(aside)}, and your work was restored from the copy saved when you last opened Secret Santa.`;
    }
    if (choice === fresh) {
      const shape = refusal.entry.shape ? shapes[refusal.entry.shape] : undefined;
      if (!shape) return null;
      const aside = storage.startFresh(refusal, shape);
      log.info(`Started fresh; damaged copy kept as ${path.basename(aside)}.`);
      return `The damaged file was renamed to ${path.basename(aside)} in the data folder, and Secret Santa started fresh.`;
    }
    return null;
  }
}

/** Serve the window's three files from app://secret-santa, with the CSP header on every response. */
function serveWindowFiles(): void {
  protocol.handle(policy.APP_SCHEME, async (request) => {
    const target = policy.rendererFileFor(request.url, rendererDir);
    if (!target) return new Response('Not found', { status: 404 });
    try {
      const body = await fs.promises.readFile(target.file);
      return new Response(body, {
        headers: {
          'Content-Type': target.type,
          'Content-Security-Policy': policy.CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    } catch (error) {
      log.error(`Couldn't read ${path.basename(target.file)} for the window`, error);
      return new Response('Not found', { status: 404 });
    }
  });
}

/** Only the scheme and host of an address - enough for the log, without any data in it. */
function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
  } catch {
    return '(unreadable address)';
  }
}

/**
 * Lock down a browser session: every request that isn't the app's own page
 * or on the network allowlist is cancelled, and every permission (camera,
 * location, notifications...) is refused. Applied to every session that
 * exists, including any a dependency might create.
 */
function secureSession(target: Session): void {
  target.webRequest.onBeforeRequest((details, callback) => {
    const allowed = policy.isAllowedRequest(details.url, app.isPackaged);
    if (!allowed) log.warn(`Blocked a request to ${describeUrl(details.url)}.`);
    callback({ cancel: !allowed });
  });
  target.setPermissionRequestHandler((_contents, permission, callback) => {
    log.warn(`Refused a permission request: ${permission}.`);
    callback(false);
  });
  target.setPermissionCheckHandler(() => false);
  target.setDevicePermissionHandler(() => false);
  target.setSpellCheckerEnabled(false);
}

/** Refuse navigation, pop-ups and embedded web views for every piece of web content. */
function hardenContents(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    event.preventDefault();
    log.warn(`Blocked the window from going to ${describeUrl(url)}.`);
  });
  contents.on('will-redirect', (event, url) => {
    event.preventDefault();
    log.warn(`Blocked a redirect to ${describeUrl(url)}.`);
  });
  contents.setWindowOpenHandler(({ url }) => {
    log.warn(`Blocked a pop-up to ${describeUrl(url)}.`);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

// ===========================================================================
// 2. The window
// ===========================================================================

/** Where to put the window: where it was last time if that's still on a screen, otherwise centred. */
function windowPlace(): Rectangle {
  const saved = settings.window;
  if (saved) {
    const visible = screen.getAllDisplays().some(({ workArea: area }) => {
      const overlapX = Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x);
      const overlapY = Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y);
      return overlapX >= 200 && overlapY >= 120;
    });
    if (visible) return { x: saved.x, y: saved.y, width: Math.max(saved.width, 760), height: Math.max(saved.height, 560) };
  }
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1180, area.width);
  const height = Math.min(880, area.height);
  return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height };
}

function createWindow(): void {
  const icon = path.join(appDir, 'assets', 'icon.png');
  win = new BrowserWindow({
    ...windowPlace(),
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'Secret Santa',
    backgroundColor: '#f7f2e7',
    ...(fs.existsSync(icon) ? { icon } : {}),
    webPreferences: {
      preload: path.join(mainDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      safeDialogs: true,
      devTools: !app.isPackaged,
    },
  });
  if (settings.window?.maximized) win.maximize();
  const contents = win.webContents;

  win.once('ready-to-show', () => win?.show());
  win.on('close', (event) => {
    if (closeAllowed) {
      rememberPlace();
      return;
    }
    // Give the window a moment to save anything still being typed, then close.
    event.preventDefault();
    void askWindowToSave().finally(() => {
      closeAllowed = true;
      if (win && !win.isDestroyed()) win.close();
    });
  });
  win.on('closed', () => {
    win = null;
  });
  // Windows is signing out or shutting down.
  win.on('query-session-end', () => void askWindowToSave(1500));
  win.on('session-end', () => endOfSession());
  win.on('unresponsive', async () => {
    const choice = await tell('warning', "Secret Santa's window isn't responding.", 'You can wait a little longer, or close Secret Santa. Everything you had saved is safe.', ['Wait', 'Close Secret Santa'], 0);
    if (choice === 1) closeEverything();
  });

  contents.on('render-process-gone', (_event, details) => void windowProcessGone(details.reason, details.exitCode));
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = load replaced by another; not a failure
    log.error(`The window failed to load: ${code} ${description}.`);
    void windowFailedToLoad();
  });

  contents.loadURL(policy.PAGE_URL).catch(() => undefined); // failures arrive via did-fail-load

  // Safety nets: show the window even if Chromium never says it's ready to
  // show, and speak up if the page never reports that it has drawn itself.
  later(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      log.warn('The window never reported ready-to-show; showing it anyway.');
      win.show();
    }
  }, 5000);
  later(() => void windowNeverReady(), 20000);
}

/** Note the window's size and position so the next launch opens in the same place. */
function rememberPlace(): void {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getNormalBounds();
  settings = { ...settings, window: { ...bounds, maximized: win.isMaximized() } };
}

/**
 * Ask the window to save any typing it hasn't sent yet, and wait for it to
 * say it's done (or give up after `timeoutMs`). Used before closing.
 */
let flushWaiters: Array<() => void> = [];
function askWindowToSave(timeoutMs = 2000): Promise<void> {
  if (!win || win.isDestroyed() || !rendererReady || win.webContents.isCrashed()) return Promise.resolve();
  const contents = win.webContents;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      flushWaiters = flushWaiters.filter((waiter) => waiter !== finish);
      log.warn('The window took too long to save while closing.');
      resolve();
    }, timeoutMs);
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    flushWaiters.push(finish);
    contents.send('ss:flush');
  });
}

/** Close the window (letting it save first) and so end the app. */
function closeEverything(): void {
  if (win && !win.isDestroyed()) win.close();
  else app.quit();
}

/** The window's own process crashed or was killed. */
async function windowProcessGone(reason: string, exitCode: number): Promise<void> {
  if (quitting) return;
  rendererReady = false;
  log.error(`The window's process ended: ${reason} (exit code ${exitCode}).`);
  const now = Date.now();
  recentWindowCrashes.push(now);
  while ((recentWindowCrashes[0] ?? now) < now - 60_000) recentWindowCrashes.shift();
  const repeated = recentWindowCrashes.length >= 3;
  const choice = await tell(
    'error',
    'The Secret Santa window stopped working unexpectedly. Everything you had saved is safe.',
    repeated
      ? 'It has stopped several times in a row. Closing Secret Santa and opening it again is the best next step.'
      : 'Reopening the window usually fixes this.',
    repeated ? ['Close Secret Santa'] : ['Reopen the window', 'Close Secret Santa'],
  );
  if (!repeated && choice === 0 && win && !win.isDestroyed()) win.webContents.reload();
  else closeEverything();
}

/** The page itself couldn't be loaded. */
async function windowFailedToLoad(): Promise<void> {
  if (quitting) return;
  const choice = await tell('error', "The Secret Santa window couldn't be loaded.", 'Part of the program may be missing. Running setup.ps1 again usually fixes this.', ['Try again', 'Close Secret Santa']);
  if (choice === 0 && win && !win.isDestroyed()) void win.webContents.loadURL(policy.PAGE_URL).catch(() => undefined);
  else closeEverything();
}

/** The page never told us it had drawn itself. */
async function windowNeverReady(): Promise<void> {
  if (rendererReady || quitting) return;
  log.warn('The window did not report that it had drawn itself within 20 seconds.');
  const next = policy.nextGraphicsMode(graphics.mode);
  const buttons = next ? ['Restart with simpler graphics', 'Keep waiting', 'Close Secret Santa'] : ['Keep waiting', 'Close Secret Santa'];
  const choice = buttons[
    await tell('warning', "The Secret Santa window didn't finish opening.", next ? 'This is usually a graphics problem. Secret Santa can restart using a simpler way of drawing the window. Nothing you have saved will be lost.' : 'Nothing you have saved has been lost.', buttons, buttons.length - 1)
  ];
  if (rendererReady) return;
  if (choice === 'Restart with simpler graphics' && next) await relaunchWith(next, 'not-ready');
  else if (choice === 'Keep waiting') later(() => void windowNeverReady(), 20000);
  else closeEverything();
}

/**
 * Runs once, shortly after the window first says it has drawn itself:
 * check it really painted something, then (if this run is a graphics restart)
 * say what happened.
 */
async function afterFirstPaint(): Promise<void> {
  if (!paintChecked) {
    paintChecked = true;
    if (await windowLooksBlank()) {
      await recoverGraphics('blank-window');
      return;
    }
    if (relaunchedBecause !== undefined) {
      // This mode has now been seen to work, so remember it for next time.
      settings = { ...settings, graphics: graphics.mode };
      await tell(
        'info',
        `Secret Santa restarted ${graphics.mode === 'software' ? 'with graphics acceleration turned off' : 'using a more compatible graphics mode'} because the window wasn't being drawn properly. Nothing was lost.`,
        'It will keep using this mode on this computer.',
      );
    }
  }
  if (testing) await runTestProbe();
  const exitAfterReady =
    testEnv('SECRET_SANTA_TEST_EXIT_AFTER_READY') === '1' ||
    (testEnv('SECRET_SANTA_TEST_EXIT_AFTER_RELAUNCH') === '1' && relaunchedBecause !== undefined);
  if (exitAfterReady) closeEverything();
}

/**
 * Take a picture of the window and see whether it is a single flat colour -
 * the blank, black or white window a graphics-driver problem produces.
 */
async function windowLooksBlank(): Promise<boolean> {
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return false;
  if (testEnv('SECRET_SANTA_TEST_BLANK_PAINT') === '1') {
    // Test hook: really hide the page so the capture really is blank.
    await win.webContents.insertCSS('html { visibility: hidden !important; overflow: hidden !important; }');
    await pause(300);
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!win || win.isDestroyed()) return false;
    const image = await win.webContents.capturePage();
    if (!image.isEmpty()) {
      const { width, height } = image.getSize();
      const blank = policy.looksBlank(image.toBitmap(), width, height);
      log.info(`Paint check: ${blank ? 'the window is blank' : 'the window has been drawn'} (${width}x${height}).`);
      return blank;
    }
    await pause(1500);
  }
  log.warn('Paint check: capturing the window came back empty twice.');
  return true;
}

// ===========================================================================
// 3. Graphics recovery
// ===========================================================================

/**
 * The window isn't drawing (the graphics process crashed, or the window is
 * blank). Respond by cost:
 *  - In the normal mode, restart automatically using OpenGL (--use-angle=gl).
 *    That still uses the graphics card, so it costs almost nothing.
 *  - If that also fails, offer to restart with acceleration turned off.
 *  - If even that fails, say so plainly; the person can keep the window.
 * A dialog Windows draws always explains what happened, because the page
 * itself is what's broken.
 */
async function recoverGraphics(reason: 'gpu-crash' | 'blank-window'): Promise<void> {
  if (graphicsFailureHandled || quitting) return;
  graphicsFailureHandled = true;
  const next = policy.nextGraphicsMode(graphics.mode);
  log.warn(`Graphics problem (${reason}) in mode ${graphics.mode}; next mode: ${next ?? 'none'}.`);
  if (next === 'angle-gl') {
    await relaunchWith(next, reason);
    return;
  }
  if (next === 'software') {
    const choice = await tell(
      'warning',
      "Secret Santa's window still isn't being drawn properly.",
      'It can restart with graphics acceleration turned off. That is a little slower, but works on every computer. Nothing you have saved will be lost.',
      ['Restart without graphics acceleration', 'Keep this window', 'Close Secret Santa'],
      1,
    );
    if (choice === 0) await relaunchWith('software', reason);
    else if (choice === 2) closeEverything();
    return;
  }
  const choice = await tell(
    'error',
    "Secret Santa's window can't be drawn properly on this computer right now. Everything you have saved is safe.",
    'Restarting Windows often clears this up. If it keeps happening, updating the graphics driver may help.',
    ['Keep this window', 'Close Secret Santa'],
    0,
  );
  if (choice === 1) closeEverything();
}

/** Restart the app in a different graphics mode. */
async function relaunchWith(mode: storage.GraphicsMode, reason: string): Promise<void> {
  await askWindowToSave();
  const args = process.argv.slice(1).filter((arg) => !arg.startsWith('--ss-graphics=') && !arg.startsWith('--ss-relaunched='));
  app.relaunch({ args: [...args, `--ss-graphics=${mode}`, `--ss-relaunched=${reason}`] });
  log.info(`Restarting in graphics mode ${mode} (${reason}).`);
  quitNow();
}

// ===========================================================================
// 4. Requests from the window
// ===========================================================================

/** True only for messages from the Secret Santa window showing the app's own page. */
function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents && policy.isAppUrl(event.senderFrame?.url));
}

const failed = (message: string): { status: 'failed'; message: string } => ({ status: 'failed', message });

/**
 * Register a request the window may make. The sender is checked first; any
 * unexpected error is logged and turned into one plain sentence, so nothing
 * technical (and no Electron error prefix) ever reaches the screen.
 */
function handle(channel: string, action: (...args: unknown[]) => Promise<ActionResult | Outcome | StartupInfo> | ActionResult | Outcome | StartupInfo): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!trusted(event)) {
      log.warn(`Refused ${channel} from something other than the Secret Santa window.`);
      return failed('That request was refused.');
    }
    try {
      return await action(...args);
    } catch (error) {
      log.error(`${channel} failed`, error);
      return failed('Something went wrong doing that. Your saved work is safe; please try again.');
    }
  });
}

/** Save a new version of the exchange to disk first, then (only if that worked) use it. */
function commit(next: Exchange, message?: string): ActionResult {
  const stamped: Exchange = { ...next, savedAt: new Date().toISOString() };
  try {
    storage.writeJsonAtomic(exchangeFile, stamped);
  } catch (error) {
    log.error('Saving the exchange failed', error);
    return failed("Your change couldn't be saved to disk. Check there is free space on the drive, then try again.");
  }
  exchange = stamped;
  const view = santa.viewOf(exchange);
  return message === undefined ? { status: 'done', view } : { status: 'done', view, message };
}

/** Today's date as YYYY-MM-DD in local time, for suggested file names. */
function today(): string {
  const stamp = storage.fileStamp();
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
}

/**
 * Read a text file the person picked. Handles the encodings Windows
 * programs produce: UTF-8 (with or without a byte-order mark), UTF-16 from
 * Notepad's "Unicode" option, and older "ANSI" files. Returns null if the
 * file is too big or unreadable.
 */
function readTextFile(file: string, maxBytes: number): string | null {
  try {
    if (fs.statSync(file).size > maxBytes) return null;
    const bytes = fs.readFileSync(file);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  } catch (error) {
    log.warn(`Couldn't read a chosen file: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`);
    return null;
  }
}

/** The exchange's name for use in a suggested file name. */
function exchangeTitle(): string {
  return exchange.details.eventName.trim() || 'Secret Santa';
}

/** Windows' own "open file" dialog. The person picks the file; the window never supplies a path. */
function chooseFileToOpen(options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  return win && !win.isDestroyed() ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
}

/** Windows' own "save as" dialog. */
function chooseWhereToSave(options: SaveDialogOptions): Promise<SaveDialogReturnValue> {
  return win && !win.isDestroyed() ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options);
}

function registerRequests(): void {
  handle('ss:load', () => {
    const notices = startupNotices;
    startupNotices = []; // shown once
    return { view: santa.viewOf(exchange), notices };
  });

  handle('ss:update', (patch) => {
    const checked = santa.checkPatch(patch);
    if (!checked) {
      log.warn('Refused a change that was not in the expected form.');
      return failed("That change couldn't be saved because it wasn't in the expected form.");
    }
    return commit(santa.applyPatch(exchange, checked));
  });

  handle('ss:draw', () => {
    const result = santa.runDraw(exchange);
    return result.ok ? commit(result.exchange, result.message) : failed(result.message);
  });

  handle('ss:clear-names', () => commit(santa.clearNames(exchange), 'The names, keep-apart rules and draw were cleared.'));

  handle('ss:save-year', () => {
    const result = santa.saveYear(exchange);
    return result.ok ? commit(result.exchange, result.message) : failed(result.message);
  });

  handle('ss:remove-year', (id) => {
    if (typeof id !== 'string' || id.length > 64) return failed("That year couldn't be found.");
    return commit(santa.removeYear(exchange, id), 'That year was removed.');
  });

  handle('ss:clear-history', () => commit(santa.clearHistory(exchange), 'Previous years were cleared.'));

  handle('ss:import-names', async () => {
    const pick = await chooseFileToOpen({
      title: 'Import names',
      properties: ['openFile'],
      filters: [{ name: 'Text files', extensions: ['txt', 'csv'] }],
    });
    const file = pick.filePaths[0];
    if (pick.canceled || !file) return { status: 'canceled' };
    const contents = readTextFile(file, 1_000_000);
    if (contents === null) return failed("That file couldn't be read. Choose a plain text file with one name on each line.");
    const namesText = santa.namesFromTextFile(contents);
    const count = santa.parseNames(namesText).length;
    if (count === 0) return failed('No names were found in that file. Put one name on each line and try again.');
    return commit({ ...exchange, namesText }, `Imported ${count} name${count === 1 ? '' : 's'}.`);
  });

  handle('ss:import-backup', async () => {
    const pick = await chooseFileToOpen({
      title: 'Import a backup',
      properties: ['openFile'],
      filters: [{ name: 'Secret Santa backup', extensions: ['json'] }],
    });
    const file = pick.filePaths[0];
    if (pick.canceled || !file) return { status: 'canceled' };
    const notABackup = failed("That file isn't a Secret Santa backup this app can read.");
    const contents = readTextFile(file, 10_000_000);
    if (contents === null) return notABackup;
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      return notABackup;
    }
    const imported = santa.fromBackup(parsed);
    if (!imported) return notABackup;
    // Keep a copy of the exchange as it is now, in case the import wasn't wanted.
    const copy = path.join(dataDir, `exchange.before-import-${storage.fileStamp()}.json`);
    try {
      storage.writeJsonAtomic(copy, exchange);
    } catch (error) {
      log.error('Making the safety copy before an import failed', error);
      return failed("The backup wasn't imported because a safety copy of your current exchange couldn't be made first.");
    }
    return commit(
      santa.mergeImport(exchange, imported),
      `Imported the backup. Your exchange from before the import was kept as ${path.basename(copy)} in the data folder.`,
    );
  });

  handle('ss:export-backup', async () => {
    const suggested = storage.safeFileName(`${exchangeTitle()} backup ${today()}`, 'Secret Santa backup', '.json');
    const pick = await chooseWhereToSave({
      title: 'Export a backup',
      defaultPath: path.join(app.getPath('documents'), suggested),
      filters: [{ name: 'Secret Santa backup', extensions: ['json'] }],
    });
    if (pick.canceled || !pick.filePath) return { status: 'canceled' };
    try {
      storage.writeJsonAtomic(pick.filePath, santa.toBackup(exchange));
    } catch (error) {
      log.error('Writing a backup failed', error);
      return failed("The backup couldn't be saved there. Try a different folder, such as Documents.");
    }
    return { status: 'done', message: `Backup saved as ${path.basename(pick.filePath)}.` };
  });

  handle('ss:print-slips', () => {
    if (!exchange.draw) return failed('Make a draw before printing slips.');
    const contents = win?.webContents;
    if (!contents) return failed("The slips couldn't be printed.");
    return new Promise<Outcome>((resolve) => {
      contents.print({ printBackground: true }, (success, reason) => {
        if (success) resolve({ status: 'done', message: 'The slips were sent to the printer.' });
        else if (/cancel/i.test(reason)) resolve({ status: 'canceled' });
        else {
          log.warn(`Printing failed: ${reason}`);
          resolve(failed("The slips couldn't be printed. Check that a printer is set up, or use Save slips as PDF instead."));
        }
      });
    });
  });

  handle('ss:save-slips-pdf', async () => {
    if (!exchange.draw) return failed('Make a draw before saving slips.');
    const contents = win?.webContents;
    if (!contents) return failed("The slips couldn't be saved.");
    const suggested = storage.safeFileName(`${exchangeTitle()} slips`, 'Secret Santa slips', '.pdf');
    const pick = await chooseWhereToSave({
      title: 'Save slips as PDF',
      defaultPath: path.join(app.getPath('documents'), suggested),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (pick.canceled || !pick.filePath) return { status: 'canceled' };
    try {
      const pdf = await contents.printToPDF({ printBackground: true, pageSize: 'Letter' });
      fs.writeFileSync(pick.filePath, pdf);
    } catch (error) {
      log.error('Saving slips as PDF failed', error);
      return failed("The slips couldn't be saved there. Try a different folder, such as Documents.");
    }
    return { status: 'done', message: `Slips saved as ${path.basename(pick.filePath)}.` };
  });

  handle('ss:copy-text', (text) => {
    if (typeof text !== 'string' || text.length > santa.LIMITS.copyText) return failed("That couldn't be copied.");
    clipboard.writeText(text);
    return { status: 'done', message: 'Copied.' };
  });

  handle('ss:open-data-folder', async () => {
    const problem = await shell.openPath(dataDir);
    return problem ? failed("The data folder couldn't be opened.") : { status: 'done' };
  });

  ipcMain.on('ss:ready', (event) => {
    if (!trusted(event)) return;
    rendererReady = true;
    later(() => void afterFirstPaint(), 1200);
  });

  ipcMain.on('ss:report-error', (event, summary: unknown) => {
    if (!trusted(event)) return;
    log.error(`Error in the window: ${typeof summary === 'string' ? summary.slice(0, 2000) : 'no details'}`);
  });

  ipcMain.on('ss:flushed', (event) => {
    if (!trusted(event)) return;
    const waiters = flushWaiters;
    flushWaiters = [];
    for (const finish of waiters) finish();
  });
}

// ===========================================================================
// 5. Shutdown
// ===========================================================================

/**
 * Save what needs saving and let go of everything. Walks the requirements
 * manifest and flushes each entry marked flushOnExit - each on its own, so
 * one failing never stops the others - then cancels timers and releases the
 * single-instance lock. Runs once, however the app is ending.
 */
function runShutdown(): void {
  if (shutdownDone) return;
  shutdownDone = true;
  quitting = true;
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  if (manifest) {
    const flushers = new Map<string, () => void>();
    // Only write files that were actually loaded - never overwrite one that
    // was refused as damaged with an empty stand-in.
    if (exchangeLoaded) flushers.set('exchange', () => storage.writeJsonAtomic(exchangeFile, exchange));
    if (settingsLoaded) flushers.set('settings', () => storage.writeJsonAtomic(settingsFile, settings));
    for (const failure of storage.flushRequirements(manifest, flushers)) {
      log.error(`Couldn't save ${failure.id} while closing`, failure.error);
    }
  }
  try {
    app.releaseSingleInstanceLock();
  } catch (error) {
    log.error('Releasing the single-instance lock failed', error);
  }
  log.info('Closed.');
}

/** End the app straight away (after the shutdown walk). */
function quitNow(): void {
  closeAllowed = true;
  runShutdown();
  app.exit(0);
}

/**
 * Windows is signing out or shutting down. There's no time to wait for the
 * window, and every change is already on disk the moment it's made, so:
 * remember the window's place, run the shutdown walk, and exit.
 */
function endOfSession(): void {
  log.info('Windows is signing out or shutting down; saving and closing.');
  rememberPlace();
  quitNow();
}

// ===========================================================================
// 6. Dialogs Windows draws, and the test hooks behind them
// ===========================================================================

/**
 * Show a message box drawn by Windows (not by the page, which may be the
 * thing that's broken). Returns the index of the button chosen.
 */
async function tell(
  tone: 'info' | 'warning' | 'error',
  message: string,
  detail = '',
  buttons: string[] = ['OK'],
  cancelId = buttons.length - 1,
): Promise<number> {
  log.info(`Dialog: ${message}`);
  if (testing) return testAnswer(message, detail, buttons, cancelId);
  const options: MessageBoxOptions = { type: tone, title: 'Secret Santa', message, detail, buttons, cancelId, defaultId: 0, noLink: true };
  const parent = win && !win.isDestroyed() && win.isVisible() ? win : null;
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response;
}

/** Test hook: answer a dialog from SECRET_SANTA_TEST_DIALOG_ANSWERS ("Button|Button"), and record it. */
const testAnswers = (testEnv('SECRET_SANTA_TEST_DIALOG_ANSWERS') ?? '').split('|').filter((answer) => answer !== '');
function testAnswer(message: string, detail: string, buttons: string[], cancelId: number): number {
  const wanted = testAnswers.shift();
  const found = wanted === undefined ? -1 : buttons.findIndex((button) => button.startsWith(wanted));
  const response = found >= 0 ? found : cancelId;
  testRecord('dialog', { message, detail, buttons, answered: buttons[response] ?? null });
  return response;
}

/** Test hook: append an event to test-events.jsonl in the data folder. */
function testRecord(kind: string, data: Record<string, unknown>): void {
  try {
    fs.appendFileSync(path.join(dataDir, 'test-events.jsonl'), `${JSON.stringify({ kind, pid: process.pid, ...data })}\n`);
  } catch {
    // Recording is best-effort.
  }
}

/**
 * Test hook: try to load SECRET_SANTA_TEST_PROBE_URL in a hidden window and
 * record what happened. Normally the session filter must cancel it. With
 * SECRET_SANTA_TEST_PROBE_UNFILTERED=1 the probe uses a separate session with
 * the filter deliberately removed - used only to prove the network check in
 * the tests can see a real connection when one happens.
 */
async function runTestProbe(): Promise<void> {
  const url = testEnv('SECRET_SANTA_TEST_PROBE_URL');
  if (!url) return;
  const unfiltered = testEnv('SECRET_SANTA_TEST_PROBE_UNFILTERED') === '1';
  const probeSession = unfiltered ? session.fromPartition('ss-test-unfiltered') : session.defaultSession;
  if (unfiltered) probeSession.webRequest.onBeforeRequest(null);
  const probe = new BrowserWindow({ show: false, webPreferences: { session: probeSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  let outcome = 'loaded';
  try {
    await probe.webContents.loadURL(url);
  } catch (error) {
    outcome = `failed: ${(error as { code?: string }).code ?? String(error)}`;
  }
  probe.destroy();
  testRecord('probe', { url, unfiltered, outcome });
}
