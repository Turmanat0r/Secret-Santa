// End-to-end tests: the real app, started the way it really starts, driven
// through its window. Each test gets its own empty data folder.
//
// Native Windows message boxes can't be clicked by a test, so in test mode the
// app answers them from SECRET_SANTA_TEST_DIALOG_ANSWERS and records each one
// in test-events.jsonl. File pickers are replaced inside the main process for
// the length of one test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright-core';
import {
  freshDataDir,
  launch,
  projectDir,
  readEvents,
  readJsonFile,
  readLog,
  runToExit,
  survivingProcesses,
  waitFor,
} from './helpers.ts';

const exchangeOf = (dataDir: string): { namesText: string; draw: { assignments: Record<string, string> } | null; details: { giftNote: string }; history: unknown[]; wishes: Record<string, string> } =>
  readJsonFile(path.join(dataDir, 'exchange.json')) as never;

/** Close the window the way a person does (the X button), and wait for the app to exit. */
async function closeWindow(app: ElectronApplication): Promise<void> {
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await exited;
}

async function waitSaved(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelector('#saveState')?.textContent === 'All changes saved');
}

/** Make the next "open file" / "save file" dialog in the main process pick `file`. */
async function nextFileDialogPicks(app: ElectronApplication, kind: 'open' | 'save', file: string): Promise<void> {
  await app.evaluate(
    ({ dialog }, [which, chosen]) => {
      if (which === 'open') {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as typeof dialog.showOpenDialog;
      } else {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as typeof dialog.showSaveDialog;
      }
    },
    [kind, file] as const,
  );
}

test('the window opens locked down: sandboxed, isolated, no menu, no Node, strict CSP', async () => {
  const { app, page, dataDir } = await launch(freshDataDir('secure'));
  try {
    // Ask Windows, through Electron, how the window's process is actually running.
    const facts = await app.evaluate(({ app: electronApp, BrowserWindow, Menu }) => {
      const windowPid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId();
      const metric = electronApp.getAppMetrics().find((m) => m.pid === windowPid);
      return {
        sandboxed: metric?.sandboxed,
        integrityLevel: metric?.integrityLevel,
        menu: Menu.getApplicationMenu(),
        windows: BrowserWindow.getAllWindows().length,
      };
    });
    assert.deepEqual(facts, { sandboxed: true, integrityLevel: 'untrusted', menu: null, windows: 1 });

    const inPage = await page.evaluate(() => ({
      require: typeof (globalThis as Record<string, unknown>).require,
      process: typeof (globalThis as Record<string, unknown>).process,
      module: typeof (globalThis as Record<string, unknown>).module,
      api: Object.keys(window.santa).sort(),
      url: location.href,
    }));
    assert.equal(inPage.require, 'undefined');
    assert.equal(inPage.process, 'undefined');
    assert.equal(inPage.module, 'undefined');
    assert.equal(inPage.url, 'app://secret-santa/index.html');
    assert.deepEqual(inPage.api, [
      'clearHistory', 'clearNames', 'copyText', 'draw', 'exportBackup', 'importBackup', 'importNames', 'load',
      'onFlushRequest', 'openDataFolder', 'printSlips', 'ready', 'removeYear', 'reportError', 'saveSlipsPdf', 'saveYear', 'update',
    ]);

    // The CSP header sent with the page matches the page's own <meta> tag.
    const header = await app.evaluate(async ({ session }) => {
      const response = await session.defaultSession.fetch('app://secret-santa/index.html');
      return response.headers.get('content-security-policy');
    });
    const meta = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
    assert.ok(header);
    assert.equal(header, meta);

    // Nothing outside the app can be fetched, opened, navigated to or granted.
    const fetched = await page.evaluate(() => fetch('https://example.com/').then(() => 'fetched', () => 'blocked'));
    assert.equal(fetched, 'blocked');
    const popup = await page.evaluate(() => window.open('https://example.com/') === null);
    assert.equal(popup, true);
    const notifications = await page.evaluate(() => Notification.requestPermission());
    assert.equal(notifications, 'denied');
    const geolocation = await page.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state);
    assert.equal(geolocation, 'denied');
    await page.evaluate(() => {
      location.href = 'https://example.com/';
    });
    await page.waitForTimeout(800);
    assert.equal(page.url(), 'app://secret-santa/index.html');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    const log = readLog(dataDir);
    assert.match(log, /Blocked a pop-up to https:\/\/example\.com/);
    assert.match(log, /Blocked the window from going to https:\/\/example\.com/);
    assert.match(log, /Refused a permission request: notifications/);

    // Changes that aren't the right shape are refused by the main process.
    const bad = await page.evaluate(async () => [
      await window.santa.update({ draw: null } as never),
      await window.santa.update({ namesText: 42 } as never),
      await window.santa.removeYear({} as never),
      await window.santa.copyText('x'.repeat(5000)),
    ]);
    for (const answer of bad) assert.equal(answer.status, 'failed');
    assert.match(readLog(dataDir), /Refused a change that was not in the expected form/);
  } finally {
    await closeWindow(app);
  }
});

test('a whole exchange: names, rule, draw, private reveal, wish list, saved year - and it all survives a restart', async () => {
  const dataDir = freshDataDir('exchange');
  let assignments: Record<string, string>;
  {
    const { app, page } = await launch(dataDir);
    try {
      assert.equal(await page.isVisible('#resultActions'), false, 'no result buttons before a draw');
      await page.fill('#names', 'Alex\nJordan\nSam\nTaylor\nMorgan\nCasey');
      await page.fill('#eventName', 'Family Secret Santa');
      await page.fill('#budget', '$25');
      await page.fill('#eventDate', '2026-12-20');
      await page.click('#addRule');
      await page.selectOption('#rules .rule-row select >> nth=0', 'Alex');
      await page.selectOption('#rules .rule-row select >> nth=1', 'Jordan');
      await page.click('#draw');
      await page.waitForFunction(() => document.querySelector('#setupMessage')?.textContent?.startsWith('Done!'));
      assert.equal(await page.locator('.result').count(), 6);
      assert.equal(await page.isVisible('#resultActions'), true);
      assignments = exchangeOf(dataDir).draw?.assignments ?? {};
      assert.notEqual(assignments.Alex, 'Jordan');
      assert.notEqual(assignments.Jordan, 'Alex');

      // Names stay blurred until clicked.
      const blur = await page.locator('.result >> nth=0').locator('.recipient').evaluate((node) => getComputedStyle(node).filter);
      assert.match(blur, /blur/);

      // Private reveal shows the right person, with their wish list.
      const recipient = assignments.Sam ?? '';
      await page.click('[data-tab="wish"]');
      await page.fill(`#wishLists textarea[data-person="${recipient}"]`, 'Loves board games');
      await waitSaved(page);
      await page.click('#privateReveal');
      await page.selectOption('#pickName', 'Sam');
      await page.click('#pickShow');
      assert.equal(await page.textContent('#revealName'), recipient);
      assert.equal(await page.textContent('#revealWishText'), 'Loves board games');
      assert.match((await page.textContent('#revealDetails')) ?? '', /Budget: \$25/);
      await page.click('#closeReveal');
      assert.equal(await page.textContent('#revealName'), '', 'the name is cleared once the reveal closes');

      // Save the year.
      await page.click('[data-tab="history"]');
      await page.click('#saveYear');
      await page.waitForFunction(() => document.querySelectorAll('.history-item').length === 1);

      // Changing the names marks the draw as out of date.
      await page.fill('#names', 'Alex\nJordan\nSam\nTaylor\nMorgan\nCasey\nRiley');
      await waitSaved(page);
      assert.equal(await page.isVisible('#staleNotice'), true);
      await page.screenshot({ path: path.join(dataDir, 'exchange.png'), fullPage: true });
    } finally {
      await closeWindow(app);
    }
  }
  {
    // Reopen: everything is read back from disk.
    const { app, page } = await launch(dataDir);
    try {
      assert.equal(await page.inputValue('#names'), 'Alex\nJordan\nSam\nTaylor\nMorgan\nCasey\nRiley');
      assert.equal(await page.inputValue('#eventName'), 'Family Secret Santa');
      assert.equal(await page.inputValue('#eventDate'), '2026-12-20');
      assert.equal(await page.locator('.result').count(), 6);
      assert.equal(await page.locator('.history-item').count(), 1);
      assert.equal(await page.locator('#rules .rule-row').count(), 1);
      assert.deepEqual(exchangeOf(dataDir).draw?.assignments, assignments);
      assert.equal(await page.isVisible('#appNotice'), false, 'no notices on a normal launch');
    } finally {
      await closeWindow(app);
    }
  }
});

test('files: import names, export and import backups, save slips as PDF - through dialogs the main process opens', async () => {
  const { app, page, dataDir } = await launch(freshDataDir('files'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-files-out-'));
  try {
    // A names file saved by Notepad as "Unicode" (UTF-16 with a byte-order mark), comma separated.
    const namesFile = path.join(outside, 'names.txt');
    fs.writeFileSync(namesFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('José, Zoë\r\nAmélie\r\n', 'utf16le')]));
    await nextFileDialogPicks(app, 'open', namesFile);
    await page.click('#importNames');
    await page.waitForFunction(() => document.querySelector('#setupMessage')?.textContent === 'Imported 3 names.');
    assert.equal(await page.inputValue('#names'), 'José\nZoë\nAmélie');

    await page.click('#draw');
    await page.waitForFunction(() => document.querySelector('#setupMessage')?.textContent?.startsWith('Done!'));

    const backupFile = path.join(outside, 'backup.json');
    await nextFileDialogPicks(app, 'save', backupFile);
    await page.click('#exportBackup');
    await page.waitForFunction(() => document.querySelector('#dataMessage')?.textContent?.startsWith('Backup saved'));
    const backup = readJsonFile(backupFile) as { app: string; version: number; names: string };
    assert.equal(backup.app, 'Secret Santa Generator');
    assert.equal(backup.version, 2);
    assert.equal(backup.names, 'José\nZoë\nAmélie');

    const pdfFile = path.join(outside, 'slips.pdf');
    await nextFileDialogPicks(app, 'save', pdfFile);
    await page.click('#saveSlipsPdf');
    await page.waitForFunction(() => document.querySelector('#resultMessage')?.textContent?.startsWith('Slips saved'));
    assert.equal(fs.readFileSync(pdfFile).subarray(0, 4).toString(), '%PDF');
    assert.equal(await page.locator('#slips .slip').count(), 0, 'slips are cleared from the page after saving');

    // Import a backup made by the original browser version.
    const browserBackup = path.join(outside, 'browser-backup.json');
    fs.writeFileSync(browserBackup, JSON.stringify({
      app: 'Secret Santa Generator', version: 2, names: 'Ann\nBen\nCal', eventName: 'Old browser one',
      history: [{ name: 'Old browser one', date: '2024-12-20', assignments: { Ann: 'Ben', Ben: 'Cal', Cal: 'Ann' } }],
    }));
    await nextFileDialogPicks(app, 'open', browserBackup);
    await page.click('#importBackup');
    await page.click('#confirmYes');
    await page.waitForFunction(() => document.querySelector('#dataMessage')?.textContent?.startsWith('Imported the backup'));
    assert.equal(await page.inputValue('#names'), 'Ann\nBen\nCal');
    assert.equal(await page.inputValue('#eventName'), 'Old browser one');
    const safety = fs.readdirSync(dataDir).filter((name) => name.startsWith('exchange.before-import-'));
    assert.equal(safety.length, 1, 'a safety copy of the previous exchange was kept');
    assert.match(fs.readFileSync(path.join(dataDir, safety[0] ?? ''), 'utf8'), /Amélie/);

    // Something that isn't a backup is refused in one plain sentence.
    const notBackup = path.join(outside, 'random.json');
    fs.writeFileSync(notBackup, '{"hello": "world"}');
    await nextFileDialogPicks(app, 'open', notBackup);
    await page.click('#importBackup');
    await page.click('#confirmYes');
    await page.waitForFunction(() => document.querySelector('#dataMessage')?.textContent === "That file isn't a Secret Santa backup this app can read.");
  } finally {
    await closeWindow(app);
  }
});

test('typing right before closing is still saved', async () => {
  const { app, page, dataDir } = await launch(freshDataDir('flush'));
  await page.fill('#names', 'A\nB\nC');
  await waitSaved(page);
  // Type and close at once - well inside the pause before an automatic save.
  await page.fill('#giftNote', 'Wrap it in newspaper');
  await closeWindow(app);
  assert.equal(exchangeOf(dataDir).details.giftNote, 'Wrap it in newspaper');
  // It was saved because the window answered the "save now" request - not
  // because the main process gave up waiting and the automatic save happened
  // to land in the meantime.
  assert.doesNotMatch(readLog(dataDir), /took too long to save/);
});

test('closing the window ends every process the app started', async () => {
  const { app, tag } = await launch(freshDataDir('close'));
  const pid = app.process().pid;
  assert.ok(pid);
  assert.ok(survivingProcesses(tag, pid).length >= 2, 'main process and its helpers are running');
  await closeWindow(app);
  await waitFor(() => survivingProcesses(tag, pid).length === 0, 'every process to end', 15_000);
});

test('a second launch brings the existing window forward instead of opening another', async () => {
  const { app, dataDir } = await launch(freshDataDir('second'));
  try {
    const started = Date.now();
    const second = await runToExit(dataDir, {}, [], 30_000);
    assert.equal(second.code, 0);
    assert.ok(Date.now() - started < 15_000);
    await waitFor(() => readLog(dataDir).includes('opened again; brought the existing window forward'), 'the first copy to notice');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  } finally {
    await closeWindow(app);
  }
});

test('the window crashing: a plain dialog, then the window reopens with nothing lost', async () => {
  const { app, page, dataDir } = await launch(freshDataDir('crash'), { SECRET_SANTA_TEST_DIALOG_ANSWERS: 'Reopen' });
  try {
    await page.fill('#names', 'A\nB\nC');
    await waitSaved(page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer());
    await waitFor(() => readEvents(dataDir).some((e) => e.kind === 'dialog'), 'the crash dialog');
    const dialog = readEvents(dataDir).find((e) => e.kind === 'dialog');
    assert.equal(dialog?.message, 'The Secret Santa window stopped working unexpectedly. Everything you had saved is safe.');
    assert.equal(dialog?.answered, 'Reopen the window');
    await waitFor(() => (readLog(dataDir).match(/Paint check|window's process ended/g) ?? []).length >= 2, 'the reload');
    const names = await app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents;
      for (let i = 0; i < 50; i++) {
        const value = await contents?.executeJavaScript('document.querySelector("#names")?.value ?? ""');
        if (value) return value as string;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return '';
    });
    assert.equal(names, 'A\nB\nC');
  } finally {
    await closeWindow(app);
  }
});

test('Windows signing out: saves, lets go of the lock and exits', async () => {
  const { app, page, dataDir, tag } = await launch(freshDataDir('signout'));
  const pid = app.process().pid;
  await page.fill('#names', 'Signing\nOut\nNow');
  await waitSaved(page);
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  // Electron raises session-end when Windows sends WM_ENDSESSION; raise it the same way.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.emit('session-end', { reasons: ['logoff'] });
  });
  await exited;
  assert.match(readLog(dataDir), /Windows is signing out or shutting down/);
  const settings = readJsonFile(path.join(dataDir, 'settings.json')) as { window: { width: number } | null };
  assert.ok(settings.window && settings.window.width > 0, 'window position saved');
  assert.equal(exchangeOf(dataDir).namesText, 'Signing\nOut\nNow');
  await waitFor(() => survivingProcesses(tag, pid).length === 0, 'every process to end', 15_000);
  // The lock was released: the next launch opens normally.
  const next = await runToExit(dataDir, { SECRET_SANTA_TEST_EXIT_AFTER_READY: '1' });
  assert.equal(next.code, 0);
  assert.match(readLog(dataDir), /Paint check: the window has been drawn[\s\S]*Paint check: the window has been drawn/);
});

/** A data folder holding a damaged exchange (and, optionally, a good copy from last time). */
function damagedDataDir(label: string, withGoodCopy: boolean): { dataDir: string; damaged: string } {
  const dataDir = freshDataDir(label);
  const damaged = '{"format":"secret-santa-desktop","version":1,"namesText":"Alex\\nJor';
  fs.writeFileSync(path.join(dataDir, 'exchange.json'), damaged);
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, window: null, graphics: 'default' }));
  if (withGoodCopy) {
    fs.writeFileSync(path.join(dataDir, 'exchange.previous.json'), JSON.stringify({
      format: 'secret-santa-desktop', version: 1, savedAt: '2026-10-01T00:00:00.000Z', namesText: 'Good\nCopy\nHere',
      details: { eventName: '', budget: '', eventDate: '', giftNote: '' }, options: { noTwoWay: true, avoidPrevious: true },
      keepApart: [], draw: null, history: [], wishes: {},
    }));
  }
  return { dataDir, damaged };
}

test('damaged exchange, person quits: the file is left exactly as it was and no window opens', async () => {
  const { dataDir, damaged } = damagedDataDir('damaged-quit', true);
  const run = await runToExit(dataDir, { SECRET_SANTA_TEST_DIALOG_ANSWERS: 'Quit' });
  assert.equal(run.code, 0);
  const dialog = readEvents(dataDir).find((e) => e.kind === 'dialog');
  assert.equal(dialog?.message, "Your Secret Santa exchange file is damaged, so the app has left it exactly as it is and hasn't opened it.");
  assert.deepEqual(dialog?.buttons, ['Restore the last good copy', 'Set it aside and start fresh', 'Open the data folder', 'Quit']);
  assert.equal(fs.readFileSync(path.join(dataDir, 'exchange.json'), 'utf8'), damaged);
  assert.ok(!readLog(dataDir).includes('Paint check'), 'no window was opened');
  assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.includes('damaged')), [], 'nothing renamed');
});

test('damaged exchange, person restores: damaged file renamed, last good copy back, and a plain sentence says so', async () => {
  const { dataDir, damaged } = damagedDataDir('damaged-restore', true);
  const { app, page } = await launch(dataDir, { SECRET_SANTA_TEST_DIALOG_ANSWERS: 'Restore' });
  try {
    assert.equal(await page.inputValue('#names'), 'Good\nCopy\nHere');
    const banner = (await page.textContent('#appNotice')) ?? '';
    assert.match(banner, /renamed to exchange\.damaged-\d{8}-\d{6}\.json, and your work was restored/);
    const aside = fs.readdirSync(dataDir).find((f) => f.startsWith('exchange.damaged-'));
    assert.ok(aside);
    assert.equal(fs.readFileSync(path.join(dataDir, aside), 'utf8'), damaged, 'damaged copy kept byte for byte');
  } finally {
    await closeWindow(app);
  }
});

test('damaged exchange, person starts fresh: damaged file renamed, empty exchange, plain sentence', async () => {
  const { dataDir } = damagedDataDir('damaged-fresh', false);
  const { app, page } = await launch(dataDir, { SECRET_SANTA_TEST_DIALOG_ANSWERS: 'Set it aside' });
  try {
    const dialog = readEvents(dataDir).find((e) => e.kind === 'dialog');
    assert.deepEqual(dialog?.buttons, ['Set it aside and start fresh', 'Open the data folder', 'Quit'], 'no restore offered without a good copy');
    assert.equal(await page.inputValue('#names'), '');
    assert.match((await page.textContent('#appNotice')) ?? '', /Secret Santa started fresh/);
  } finally {
    await closeWindow(app);
  }
});

test('damaged settings: reset automatically, old file kept, and one sentence says so', async () => {
  const dataDir = freshDataDir('bad-settings');
  {
    const { app } = await launch(dataDir);
    await closeWindow(app);
  }
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{"version": 1, "graphics": ');
  const { app, page } = await launch(dataDir);
  try {
    assert.match((await page.textContent('#appNotice')) ?? '', /window settings were damaged/);
    assert.ok(fs.readdirSync(dataDir).some((f) => f.startsWith('settings.damaged-')));
  } finally {
    await closeWindow(app);
  }
});

test('a missing part of the program: says what is missing in one sentence and stops', async () => {
  const dataDir = freshDataDir('missing');
  const manifest = readJsonFile(path.join(projectDir, 'requirements.json')) as { requirements: Array<{ id: string; path: string }> };
  const page = manifest.requirements.find((entry) => entry.id === 'window-page');
  assert.ok(page);
  page.path = 'src/renderer/not-there.html';
  const manifestFile = path.join(dataDir, '..', `${path.basename(dataDir)}-requirements.json`);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const run = await runToExit(dataDir, { SECRET_SANTA_TEST_MANIFEST: manifestFile });
  assert.equal(run.code, 0);
  const dialog = readEvents(dataDir).find((e) => e.kind === 'dialog');
  assert.match(dialog?.message ?? '', /index\.html\) is missing\. Run setup\.ps1 again/);
  assert.ok(!readLog(dataDir).includes('Paint check'), 'no window was opened');
});
