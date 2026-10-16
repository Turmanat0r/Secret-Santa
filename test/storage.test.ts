// Tests for storage.ts - safe saving, damaged files, Windows file names, and the requirements manifest walk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as storage from '../src/main/storage.ts';
import * as santa from '../src/main/santa.ts';

const projectDir = path.resolve(import.meta.dirname, '..');

/** A fresh, empty folder for one test. */
function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ss-storage-'));
}

/** The real manifest and the real shapes, pointed at a temporary data folder. */
function setup(): { manifest: storage.Manifest; context: storage.WalkContext; dataDir: string } {
  const dataDir = tempDir();
  const manifest = storage.loadManifest(path.join(projectDir, 'requirements.json'));
  // App files are checked against a fake app folder that has them all.
  const appDir = tempDir();
  for (const entry of manifest.requirements.filter((e) => e.kind === 'app-file')) {
    fs.mkdirSync(path.dirname(path.join(appDir, entry.path)), { recursive: true });
    fs.writeFileSync(path.join(appDir, entry.path), 'x');
  }
  const context: storage.WalkContext = {
    bases: { userData: dataDir, app: appDir },
    shapes: {
      exchange: { check: (v) => santa.checkExchange(v) !== null, create: () => santa.emptyExchange() },
      settings: { check: (v) => storage.checkSettings(v) !== null, create: () => storage.defaultSettings() },
    },
    now: new Date(2026, 11, 16, 9, 30, 12),
  };
  return { manifest, context, dataDir };
}

const files = (dir: string): string[] => fs.readdirSync(dir).sort();

test('the real requirements.json loads and every entry is complete', () => {
  const manifest = storage.loadManifest(path.join(projectDir, 'requirements.json'));
  assert.ok(manifest.requirements.length >= 6);
  for (const entry of manifest.requirements) {
    assert.ok(entry.what.length > 10, `${entry.id} explains what it is`);
    if (entry.ifMissing === 'stop') assert.ok(entry.says.missing, `${entry.id} says what to do when missing`);
    if (entry.holdsMyWork && entry.kind === 'json-file') assert.equal(entry.ifDamaged, 'refuse', `${entry.id} is never reset automatically`);
  }
});

test('a broken requirements list is reported in plain words', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'requirements.json'), '{ not json');
  assert.throws(() => storage.loadManifest(path.join(dir, 'requirements.json')), /requirements\.json\) is missing or damaged/);
  fs.writeFileSync(path.join(dir, 'requirements.json'), JSON.stringify({ requirements: [{ id: 'x', kind: 'mystery' }] }));
  assert.throws(() => storage.loadManifest(path.join(dir, 'requirements.json')));
});

test('first launch: everything is created and no notices are shown', () => {
  const { manifest, context, dataDir } = setup();
  const walk = storage.walkRequirements(manifest, context);
  assert.equal(walk.stop, null);
  assert.equal(walk.firstRun, true);
  assert.deepEqual(walk.notices, []);
  assert.deepEqual(walk.refusals, []);
  assert.ok(files(dataDir).includes('exchange.json'));
  assert.ok(files(dataDir).includes('settings.json'));
  assert.ok(fs.statSync(path.join(dataDir, 'logs')).isDirectory());
});

test('second launch: the good exchange is copied to exchange.previous.json', () => {
  const { manifest, context, dataDir } = setup();
  storage.walkRequirements(manifest, context);
  const walk = storage.walkRequirements(manifest, context);
  assert.equal(walk.firstRun, false);
  assert.deepEqual(walk.notices, []);
  assert.equal(
    fs.readFileSync(path.join(dataDir, 'exchange.previous.json'), 'utf8'),
    fs.readFileSync(path.join(dataDir, 'exchange.json'), 'utf8'),
  );
});

test('missing exchange with a good previous copy: restored, with one plain sentence', () => {
  const { manifest, context, dataDir } = setup();
  storage.walkRequirements(manifest, context);
  const mine = { ...santa.emptyExchange(), namesText: 'Alex\nJordan' };
  storage.writeJsonAtomic(path.join(dataDir, 'exchange.json'), mine);
  storage.walkRequirements(manifest, context); // copies it to exchange.previous.json
  fs.rmSync(path.join(dataDir, 'exchange.json'));
  const walk = storage.walkRequirements(manifest, context);
  assert.deepEqual(walk.notices, ['Your exchange file was missing, so Secret Santa restored the copy it saved when you last opened it.']);
  assert.equal((storage.readJson(path.join(dataDir, 'exchange.json')) as { value: { namesText: string } }).value.namesText, 'Alex\nJordan');
});

test('missing settings on a later launch: recreated, and the person is told', () => {
  const { manifest, context, dataDir } = setup();
  storage.walkRequirements(manifest, context);
  fs.rmSync(path.join(dataDir, 'settings.json'));
  const walk = storage.walkRequirements(manifest, context);
  assert.equal(walk.stop, null);
  assert.equal(walk.notices.length, 1);
  assert.match(walk.notices[0] ?? '', /window settings were missing/);
});

test('damaged settings: renamed aside (never deleted), reset, and the person is told', () => {
  const { manifest, context, dataDir } = setup();
  storage.walkRequirements(manifest, context);
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{"version": 1, "graphics": "rainbow"');
  const walk = storage.walkRequirements(manifest, context);
  assert.equal(walk.notices.length, 1);
  assert.match(walk.notices[0] ?? '', /damaged/);
  const aside = path.join(dataDir, 'settings.damaged-20261216-093012.json');
  assert.equal(fs.readFileSync(aside, 'utf8'), '{"version": 1, "graphics": "rainbow"', 'damaged file kept byte for byte');
  assert.ok(storage.checkSettings(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))));
});

test('damaged exchange: left exactly as it is and reported, never reset automatically', () => {
  const { manifest, context, dataDir } = setup();
  storage.walkRequirements(manifest, context);
  storage.walkRequirements(manifest, context); // creates a good exchange.previous.json
  const damaged = '{"format":"secret-santa-desktop","version":1,"namesText":"Alex\\nJor';
  fs.writeFileSync(path.join(dataDir, 'exchange.json'), damaged);
  const before = files(dataDir);
  const walk = storage.walkRequirements(manifest, context);
  assert.equal(walk.refusals.length, 1);
  assert.equal(walk.refusals[0]?.entry.id, 'exchange');
  assert.equal(walk.refusals[0]?.canRestore, true);
  assert.equal(fs.readFileSync(path.join(dataDir, 'exchange.json'), 'utf8'), damaged, 'not touched');
  assert.deepEqual(files(dataDir), before, 'nothing created, renamed or deleted');
  assert.equal(
    fs.readFileSync(path.join(dataDir, 'exchange.previous.json'), 'utf8').includes('Jor'),
    false,
    'the good previous copy was not overwritten with the damaged one',
  );
});

test('damaged exchange, person chooses restore: damaged copy renamed, good copy back in place', () => {
  const { manifest, context, dataDir } = setup();
  storage.walkRequirements(manifest, context);
  storage.walkRequirements(manifest, context);
  fs.writeFileSync(path.join(dataDir, 'exchange.json'), 'garbage');
  const refusal = storage.walkRequirements(manifest, context).refusals[0];
  assert.ok(refusal);
  const aside = storage.restoreFromBackup(refusal, context.bases, context.now);
  assert.equal(fs.readFileSync(aside, 'utf8'), 'garbage');
  assert.ok(santa.checkExchange(JSON.parse(fs.readFileSync(path.join(dataDir, 'exchange.json'), 'utf8'))));
});

test('damaged exchange, person chooses start fresh: damaged copy renamed, new empty exchange', () => {
  const { manifest, context, dataDir } = setup();
  storage.walkRequirements(manifest, context);
  fs.writeFileSync(path.join(dataDir, 'exchange.json'), 'garbage');
  fs.rmSync(path.join(dataDir, 'exchange.previous.json'), { force: true });
  const refusal = storage.walkRequirements(manifest, context).refusals[0];
  assert.ok(refusal);
  assert.equal(refusal.canRestore, false);
  const shape = context.shapes.exchange;
  assert.ok(shape);
  const aside = storage.startFresh(refusal, shape, context.now);
  assert.equal(fs.readFileSync(aside, 'utf8'), 'garbage');
  assert.equal(path.basename(aside), 'exchange.damaged-20261216-093012.json');
});

test('setting aside twice in the same second never overwrites the first copy', () => {
  const dir = tempDir();
  const file = path.join(dir, 'a.json');
  const now = new Date(2026, 0, 1, 0, 0, 0);
  fs.writeFileSync(file, 'one');
  const first = storage.setAside(file, 'damaged', now);
  fs.writeFileSync(file, 'two');
  const second = storage.setAside(file, 'damaged', now);
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(first, 'utf8'), 'one');
  assert.equal(fs.readFileSync(second, 'utf8'), 'two');
});

test('a missing program file stops the app with its own sentence', () => {
  const { manifest, context } = setup();
  fs.rmSync(path.join(context.bases.app, 'src', 'renderer', 'index.html'));
  const walk = storage.walkRequirements(manifest, context);
  assert.match(walk.stop ?? '', /index\.html\) is missing/);
});

test('a file where the data folder should be stops the app', () => {
  const { manifest, context } = setup();
  const blocker = path.join(tempDir(), 'blocked');
  fs.writeFileSync(blocker, 'not a folder');
  const walk = storage.walkRequirements(manifest, { ...context, bases: { ...context.bases, userData: blocker } });
  assert.match(walk.stop ?? '', /isn't a folder/);
});

test('shutdown flush: one failing entry never stops the others', () => {
  const { manifest } = setup();
  const done: string[] = [];
  const failures = storage.flushRequirements(
    manifest,
    new Map([
      ['exchange', () => { throw new Error('disk full'); }],
      ['settings', () => { done.push('settings'); }],
    ]),
  );
  assert.deepEqual(done, ['settings']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.id, 'exchange');
});

test('atomic save leaves no temporary file and replaces the old contents', () => {
  const dir = tempDir();
  const file = path.join(dir, 'x.json');
  storage.writeJsonAtomic(file, { a: 1 });
  storage.writeJsonAtomic(file, { a: 2 });
  assert.deepEqual(files(dir), ['x.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 2 });
});

test('readJson tolerates a byte-order mark and reports missing vs unreadable', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'bom.json'), '﻿{"ok":true}');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{');
  assert.deepEqual(storage.readJson(path.join(dir, 'bom.json')), { state: 'ok', value: { ok: true } });
  assert.deepEqual(storage.readJson(path.join(dir, 'bad.json')), { state: 'unreadable' });
  assert.deepEqual(storage.readJson(path.join(dir, 'none.json')), { state: 'missing' });
});

test('file names made from typed text are safe on Windows', () => {
  assert.equal(storage.safeFileName('Family Secret Santa backup', 'x', '.json'), 'Family Secret Santa backup.json');
  assert.equal(storage.safeFileName('CON', 'x', '.json'), '_CON.json');
  assert.equal(storage.safeFileName('con.backup', 'x', '.json'), '_con.backup.json');
  assert.equal(storage.safeFileName('lpt9', 'x', '.pdf'), '_lpt9.pdf');
  assert.equal(storage.safeFileName('COM¹', 'x', '.pdf'), '_COM¹.pdf');
  assert.equal(storage.safeFileName('Console party', 'x', '.json'), 'Console party.json', 'only the exact device names are reserved');
  assert.equal(storage.safeFileName('a<b>c:d"e/f\\g|h?i*j', 'x', '.json'), 'a b c d e f g h i j.json');
  assert.equal(storage.safeFileName('Party...  ', 'x', '.json'), 'Party.json', 'trailing dots and spaces removed');
  assert.equal(storage.safeFileName('...', 'Fallback', '.json'), 'Fallback.json');
  assert.equal(storage.safeFileName('tab\there\u0007', 'x', '.json'), 'tab here.json');
  assert.ok(storage.safeFileName('y'.repeat(500), 'x', '.json').length <= 105);
});

test('settings: good values accepted, anything odd refused', () => {
  assert.ok(storage.checkSettings({ version: 1, window: null, graphics: 'default' }));
  assert.ok(storage.checkSettings({ version: 1, window: { x: -8, y: 0, width: 1200, height: 900, maximized: false }, graphics: 'angle-gl' }));
  assert.equal(storage.checkSettings({ version: 1, window: null, graphics: 'turbo' }), null);
  assert.equal(storage.checkSettings({ version: 1, window: { x: 1.5, y: 0, width: 1, height: 1, maximized: false }, graphics: 'default' }), null);
  assert.equal(storage.checkSettings(null), null);
});

test('the log never throws, rolls over at 1 MB, and keeps one old file', () => {
  const dir = tempDir();
  const log = new storage.Log(dir);
  log.info('hello');
  log.error('broke', new Error('boom'));
  const text = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
  assert.match(text, /info  hello/);
  assert.match(text, /error broke \| Error: boom/);
  fs.writeFileSync(path.join(dir, 'main.log'), 'x'.repeat(1_100_000));
  log.info('after');
  assert.ok(fs.existsSync(path.join(dir, 'main.old.log')));
  assert.ok(fs.statSync(path.join(dir, 'main.log')).size < 1000);
});
