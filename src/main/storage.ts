// storage.ts - everything that reads or writes files, and nothing that needs Electron.
//
// What lives here:
//   1. Saving JSON safely (write a temporary file, then swap it in), so a
//      crash or power cut mid-save can never leave a half-written file.
//   2. Setting a damaged file aside by renaming it - never deleting it.
//   3. Making a Windows-safe file name from something a person typed.
//   4. The requirements manifest: reading requirements.json and walking it at
//      startup (check / create / verify each entry) and at shutdown (flush).
//   5. The settings file (window position and the graphics mode that works).
//   6. The log file.

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 1. Safe saving
// ---------------------------------------------------------------------------

/** Pause the current thread briefly. Used only between retries of a file rename. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename a file, replacing the target. On Windows an antivirus scan or the
 * search indexer can hold a file open for a moment, which makes a rename fail
 * with EPERM/EBUSY/EACCES; that clears up on its own, so try a few times.
 */
export function renameWithRetry(from: string, to: string): void {
  const transient = new Set(['EPERM', 'EBUSY', 'EACCES']);
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 6 || !transient.has(code)) throw error;
      pause(40 * attempt);
    }
  }
}

/**
 * Write `value` as JSON to `file` so that the file is always either the old
 * version or the new one, never a mixture: write a temporary file, force it to
 * disk, then rename it over the real one.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.tmp`;
  const handle = fs.openSync(temporary, 'w');
  try {
    fs.writeSync(handle, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  renameWithRetry(temporary, file);
}

/** How reading a JSON file went. */
export type JsonRead = { state: 'missing' } | { state: 'unreadable' } | { state: 'ok'; value: unknown };

/** Read and parse a JSON file without throwing. A byte-order mark is tolerated. */
export function readJson(file: string): JsonRead {
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' };
  }
  try {
    return { state: 'ok', value: JSON.parse(contents.replace(/^﻿/, '')) as unknown };
  } catch {
    return { state: 'unreadable' };
  }
}

// ---------------------------------------------------------------------------
// 2. Setting damaged files aside
// ---------------------------------------------------------------------------

/** A timestamp that is safe in a file name, e.g. 20261216-093012. */
export function fileStamp(now: Date = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

/**
 * Move a file out of the way by renaming it to "<name>.<label>-<time><ext>"
 * next to the original. It is never deleted. Returns the new path.
 */
export function setAside(file: string, label: string, now: Date = new Date()): string {
  const { dir, name, ext } = path.parse(file);
  let target = path.join(dir, `${name}.${label}-${fileStamp(now)}${ext}`);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${name}.${label}-${fileStamp(now)}-${n}${ext}`);
  renameWithRetry(file, target);
  return target;
}

// ---------------------------------------------------------------------------
// 3. Windows-safe file names
// ---------------------------------------------------------------------------

/** Names Windows reserves for devices; they can't be file names even with an extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * Turn typed text into a file name Windows will accept and keep as written:
 * no  < > : " / \ | ? *  or control characters, no trailing dots or spaces
 * (Windows silently strips them), not a reserved device name such as CON or
 * LPT1, and not absurdly long. Falls back to `fallback` if nothing is left.
 * `extension` is added at the end, e.g. ".json".
 */
export function safeFileName(typed: string, fallback: string, extension: string): string {
  let name = typed
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .replace(/[. ]+$/, '');
  if (name === '') name = fallback;
  const base = name.split('.')[0] ?? '';
  if (RESERVED.test(base.trim())) name = `_${name}`;
  return `${name}${extension}`;
}

// ---------------------------------------------------------------------------
// 4. The requirements manifest
// ---------------------------------------------------------------------------

/** Where an entry's path is measured from. */
export type Base = 'userData' | 'app';

/** One thing the app needs, as written in requirements.json. */
export interface Requirement {
  id: string;
  /** Plain words: what this is. */
  what: string;
  kind: 'folder' | 'app-file' | 'json-file';
  base: Base;
  path: string;
  /** 'create' = make a fresh one; 'stop' = say what's missing and don't open. */
  ifMissing: 'create' | 'stop';
  /** 'reset' = set it aside and start fresh; 'refuse' = leave it alone and ask; 'stop' = don't open. */
  ifDamaged: 'reset' | 'refuse' | 'stop';
  /** Does it hold something the person made? (Decides how carefully damage is handled.) */
  holdsMyWork: boolean;
  /** For json-file: the name of the shape checker to verify it with. */
  shape?: string;
  /** For json-file: a copy kept from the start of the last session, used to recover. */
  backup?: string;
  /** Save this entry again when the app closes. */
  flushOnExit?: boolean;
  /** The plain sentences shown to the person for each outcome. */
  says: { created?: string; restored?: string; reset?: string; damaged?: string; missing?: string };
}

export interface Manifest {
  requirements: Requirement[];
}

/** Read requirements.json. Throws a plain-English error if the list itself is unusable. */
export function loadManifest(file: string): Manifest {
  const read = readJson(file);
  const broken = new Error("The app's list of requirements (requirements.json) is missing or damaged.");
  if (read.state !== 'ok') throw broken;
  const list = (read.value as { requirements?: unknown }).requirements;
  if (!Array.isArray(list)) throw broken;
  const kinds = ['folder', 'app-file', 'json-file'];
  for (const entry of list as Requirement[]) {
    const ok =
      typeof entry === 'object' && entry !== null &&
      typeof entry.id === 'string' && typeof entry.what === 'string' && kinds.includes(entry.kind) &&
      (entry.base === 'userData' || entry.base === 'app') && typeof entry.path === 'string' &&
      (entry.ifMissing === 'create' || entry.ifMissing === 'stop') &&
      (entry.ifDamaged === 'reset' || entry.ifDamaged === 'refuse' || entry.ifDamaged === 'stop') &&
      typeof entry.holdsMyWork === 'boolean' && typeof entry.says === 'object' && entry.says !== null &&
      (entry.kind !== 'json-file' || typeof entry.shape === 'string');
    if (!ok) throw broken;
  }
  return { requirements: list as Requirement[] };
}

/** How to check, and how to create, a JSON file of a given shape. */
export interface Shape {
  check(value: unknown): boolean;
  create(): unknown;
}

/** Everything the walker needs from the outside world. */
export interface WalkContext {
  bases: Record<Base, string>;
  shapes: Record<string, Shape>;
  now?: Date;
}

/** A work-holding file that is damaged and was left untouched for the person to decide about. */
export interface Refusal {
  entry: Requirement;
  file: string;
  /** True when a valid copy from the last session exists to restore from. */
  canRestore: boolean;
}

export interface WalkResult {
  /** Plain sentences to show in the window about anything that was reset or restored. */
  notices: string[];
  /** Set when something required is missing or broken: show this sentence and stop. */
  stop: string | null;
  /** Damaged files holding the person's work; nothing has been done to them. */
  refusals: Refusal[];
  /** True when none of the app's own data files existed yet - a first launch. */
  firstRun: boolean;
}

/** The absolute path of an entry. */
export function resolveEntry(entry: Requirement, bases: Record<Base, string>, file = entry.path): string {
  return path.resolve(bases[entry.base], file);
}

/** True if `file` holds valid JSON of the given shape. */
function isValid(file: string, shape: Shape | undefined): boolean {
  const read = readJson(file);
  return read.state === 'ok' && shape !== undefined && shape.check(read.value);
}

/**
 * Walk the manifest at startup. For each entry, in order:
 *  - folder:    create it if missing.
 *  - app-file:  one of the app's own files; if missing, stop.
 *  - json-file: if missing, restore it from its backup copy when there is a
 *               valid one, otherwise create a fresh one. If damaged, either
 *               set it aside and start fresh ('reset'), leave it completely
 *               alone and report it ('refuse'), or stop.
 *               If it's fine and has a backup, refresh the backup copy.
 *
 * On a first launch (none of the data files exist yet) creating files is
 * normal, so no notices are produced for it.
 */
export function walkRequirements(manifest: Manifest, context: WalkContext): WalkResult {
  const now = context.now ?? new Date();
  const result: WalkResult = { notices: [], stop: null, refusals: [], firstRun: false };
  const dataFiles = manifest.requirements.filter((entry) => entry.kind === 'json-file' && entry.base === 'userData');
  result.firstRun = dataFiles.every((entry) => {
    const backup = entry.backup ? resolveEntry(entry, context.bases, entry.backup) : null;
    return !fs.existsSync(resolveEntry(entry, context.bases)) && (backup === null || !fs.existsSync(backup));
  });
  const tell = (sentence: string | undefined): void => {
    if (sentence && !result.firstRun) result.notices.push(sentence);
  };
  const stopWith = (entry: Requirement, sentence: string | undefined): void => {
    result.stop ??= sentence ?? `Something the app needs is missing or damaged: ${entry.what}`;
  };

  for (const entry of manifest.requirements) {
    if (result.stop) break;
    const file = resolveEntry(entry, context.bases);

    if (entry.kind === 'folder') {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (stat?.isDirectory()) continue;
      if (stat) {
        stopWith(entry, entry.says.damaged);
      } else if (entry.ifMissing === 'create') {
        fs.mkdirSync(file, { recursive: true });
        tell(entry.says.created);
      } else {
        stopWith(entry, entry.says.missing);
      }
      continue;
    }

    if (entry.kind === 'app-file') {
      if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) stopWith(entry, entry.says.missing);
      continue;
    }

    // json-file
    const shape = entry.shape ? context.shapes[entry.shape] : undefined;
    if (!shape) {
      stopWith(entry, `The app doesn't know how to check ${entry.what}`);
      continue;
    }
    const backup = entry.backup ? resolveEntry(entry, context.bases, entry.backup) : null;
    const backupIsValid = backup !== null && isValid(backup, shape);
    const read = readJson(file);

    if (read.state === 'missing') {
      if (entry.ifMissing === 'stop') {
        stopWith(entry, entry.says.missing);
      } else if (backupIsValid && backup) {
        fs.copyFileSync(backup, file);
        tell(entry.says.restored);
      } else {
        writeJsonAtomic(file, shape.create());
        tell(entry.says.created);
      }
      continue;
    }

    if (read.state === 'ok' && shape.check(read.value)) {
      if (backup) fs.copyFileSync(file, backup); // remember this good copy for next time
      continue;
    }

    // The file exists but is unreadable or the wrong shape: it's damaged.
    if (entry.ifDamaged === 'reset' && !entry.holdsMyWork) {
      setAside(file, 'damaged', now);
      writeJsonAtomic(file, shape.create());
      result.notices.push(entry.says.reset ?? `${entry.what} was damaged, so it was reset.`);
    } else if (entry.ifDamaged === 'stop') {
      stopWith(entry, entry.says.damaged);
    } else {
      // 'refuse' - and 'reset' on something holding work is treated the same,
      // because work is never thrown away automatically.
      result.refusals.push({ entry, file, canRestore: backupIsValid });
    }
  }
  return result;
}

/** The person chose "restore": set the damaged file aside, then copy the backup into place. */
export function restoreFromBackup(refusal: Refusal, bases: Record<Base, string>, now: Date = new Date()): string {
  if (!refusal.entry.backup) throw new Error('This entry has no backup copy.');
  const aside = setAside(refusal.file, 'damaged', now);
  fs.copyFileSync(resolveEntry(refusal.entry, bases, refusal.entry.backup), refusal.file);
  return aside;
}

/** The person chose "start fresh": set the damaged file aside, then create a new empty one. */
export function startFresh(refusal: Refusal, shape: Shape, now: Date = new Date()): string {
  const aside = setAside(refusal.file, 'damaged', now);
  writeJsonAtomic(refusal.file, shape.create());
  return aside;
}

/**
 * Walk the manifest at shutdown: call the flush function registered for every
 * entry marked flushOnExit. Each one is tried on its own, so one failing to
 * save never stops the others. Returns the ids that failed, with the errors.
 */
export function flushRequirements(
  manifest: Manifest,
  flushers: ReadonlyMap<string, () => void>,
): Array<{ id: string; error: unknown }> {
  const failures: Array<{ id: string; error: unknown }> = [];
  for (const entry of manifest.requirements) {
    if (!entry.flushOnExit) continue;
    const flush = flushers.get(entry.id);
    if (!flush) continue;
    try {
      flush();
    } catch (error) {
      failures.push({ id: entry.id, error });
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// 5. Settings
// ---------------------------------------------------------------------------

/** How the window is drawn. See policy.ts for when each is used. */
export type GraphicsMode = 'default' | 'angle-gl' | 'software';

export interface WindowPlace {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

/** The contents of settings.json. Nothing in here is the person's work. */
export interface Settings {
  version: 1;
  window: WindowPlace | null;
  graphics: GraphicsMode;
}

export function defaultSettings(): Settings {
  return { version: 1, window: null, graphics: 'default' };
}

export function isGraphicsMode(value: unknown): value is GraphicsMode {
  return value === 'default' || value === 'angle-gl' || value === 'software';
}

/** Check settings.json's contents; returns the settings or null if damaged. */
export function checkSettings(value: unknown): Settings | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !isGraphicsMode(v.graphics)) return null;
  let place: WindowPlace | null = null;
  if (v.window !== null) {
    const w = v.window as Record<string, unknown> | undefined;
    if (typeof w !== 'object' || w === null) return null;
    const numbers = [w.x, w.y, w.width, w.height];
    if (!numbers.every((n) => typeof n === 'number' && Number.isInteger(n) && Math.abs(n) < 100_000)) return null;
    if (typeof w.maximized !== 'boolean') return null;
    place = { x: w.x as number, y: w.y as number, width: w.width as number, height: w.height as number, maximized: w.maximized };
  }
  return { version: 1, window: place, graphics: v.graphics };
}

// ---------------------------------------------------------------------------
// 6. The log file
// ---------------------------------------------------------------------------

/**
 * A plain-text log under the data folder: logs/main.log, rolled over to
 * main.old.log at 1 MB. Technical detail goes here, never onto the screen.
 * Names and draws are never written to the log - only what happened.
 */
export class Log {
  private readonly file: string;
  private readonly echo: boolean;

  constructor(folder: string, echo = false) {
    this.file = path.join(folder, 'main.log');
    this.echo = echo;
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? ` | ${error.stack ?? error.message}` : error === undefined ? '' : ` | ${String(error)}`;
    this.write('error', `${message}${detail}`);
  }

  private write(level: string, message: string): void {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message.replace(/\r?\n/g, '\n    ')}\n`;
    if (this.echo) process.stderr.write(line);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const size = fs.statSync(this.file, { throwIfNoEntry: false })?.size ?? 0;
      if (size > 1_000_000) renameWithRetry(this.file, path.join(path.dirname(this.file), 'main.old.log'));
      fs.appendFileSync(this.file, line);
    } catch {
      // A log that can't be written must never stop the app.
    }
  }
}
