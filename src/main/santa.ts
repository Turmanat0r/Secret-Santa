// santa.ts - everything about a Secret Santa exchange that doesn't need Electron.
//
// What lives here:
//   1. The limits and the empty starting exchange.
//   2. Checking data that arrives from outside (the saved file, the window,
//      an imported backup) before anything trusts it.
//   3. Turning the names box into a clean list.
//   4. The draw itself.
//   5. The small changes the buttons make (save a year, clear names...).
//   6. Converting to and from the backup format the original browser
//      version of this app used, so old backups still import.
//
// Nothing in this file touches the disk or the screen. That keeps it easy to
// test, and means the rules of the exchange are all in one place.

import { randomInt, randomUUID } from 'node:crypto';
import type {
  AppView,
  CurrentDraw,
  Exchange,
  ExchangeDetails,
  ExchangeOptions,
  ExchangePatch,
  KeepApartRule,
  PastExchange,
} from '../shared/types.js';

// ---------------------------------------------------------------------------
// 1. Limits and the empty exchange
// ---------------------------------------------------------------------------

/**
 * Upper limits on everything a person can type or import. They are far above
 * any real gift exchange; they exist so a damaged or hostile file can't make
 * the app use unbounded memory or time.
 */
export const LIMITS = {
  people: 300,
  nameLength: 100,
  namesText: 40_000,
  detail: 200,
  wish: 4_000,
  wishEntries: 1_000,
  rules: 500,
  history: 200,
  copyText: 1_000,
} as const;

/** A fresh, empty exchange - what a first launch starts with. */
export function emptyExchange(now: Date = new Date()): Exchange {
  return {
    format: 'secret-santa-desktop',
    version: 1,
    savedAt: now.toISOString(),
    namesText: '',
    details: { eventName: '', budget: '', eventDate: '', giftNote: '' },
    options: { noTwoWay: true, avoidPrevious: true },
    keepApart: [],
    draw: null,
    history: [],
    wishes: {},
  };
}

// ---------------------------------------------------------------------------
// 2. Checking untrusted data
// ---------------------------------------------------------------------------
// Every checker returns the cleaned value, or null if the input is not the
// right shape. They never throw, and they never pass through extra fields.

/** True for a plain `{...}` object (not null, not an array, not a class instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** True when the object has exactly the listed keys - no more, no fewer. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** A string no longer than `max`, or null. */
function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

/**
 * Read one entry from a record of name -> text. Uses an own-property check so
 * a person called "constructor" or "toString" doesn't pick up a built-in.
 */
export function own(record: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A name -> text record with sensible limits, or null. */
function checkStringRecord(value: unknown, maxEntries: number, maxValue: number): Record<string, string> | null {
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > maxEntries) return null;
  const clean: Array<[string, string]> = [];
  for (const [key, item] of entries) {
    const checked = text(item, maxValue);
    if (checked === null || key.length > LIMITS.nameLength) return null;
    clean.push([key, checked]);
  }
  // Object.fromEntries defines own properties, so a key like "__proto__"
  // becomes an ordinary entry rather than changing the object's prototype.
  return Object.fromEntries(clean);
}

export function checkDetails(value: unknown): ExchangeDetails | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ['eventName', 'budget', 'eventDate', 'giftNote'])) return null;
  const eventName = text(value.eventName, LIMITS.detail);
  const budget = text(value.budget, LIMITS.detail);
  const eventDate = text(value.eventDate, 10);
  const giftNote = text(value.giftNote, LIMITS.detail);
  if (eventName === null || budget === null || eventDate === null || giftNote === null) return null;
  if (eventDate !== '' && !isRealDate(eventDate)) return null;
  return { eventName, budget, eventDate, giftNote };
}

/** True for a real calendar date written as YYYY-MM-DD. */
function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function checkOptions(value: unknown): ExchangeOptions | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ['noTwoWay', 'avoidPrevious'])) return null;
  if (typeof value.noTwoWay !== 'boolean' || typeof value.avoidPrevious !== 'boolean') return null;
  return { noTwoWay: value.noTwoWay, avoidPrevious: value.avoidPrevious };
}

export function checkRules(value: unknown): KeepApartRule[] | null {
  if (!Array.isArray(value) || value.length > LIMITS.rules) return null;
  const rules: KeepApartRule[] = [];
  for (const rule of value) {
    if (!Array.isArray(rule) || rule.length !== 2) return null;
    const first = text(rule[0], LIMITS.nameLength);
    const second = text(rule[1], LIMITS.nameLength);
    if (first === null || second === null) return null;
    rules.push([first, second]);
  }
  return rules;
}

function checkAssignments(value: unknown): Record<string, string> | null {
  return checkStringRecord(value, LIMITS.people, LIMITS.nameLength);
}

function checkDraw(value: unknown): CurrentDraw | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ['participants', 'assignments', 'drawnAt'])) return null;
  const { participants, drawnAt } = value;
  if (!Array.isArray(participants) || participants.length > LIMITS.people) return null;
  if (!participants.every((name) => typeof name === 'string' && name.length <= LIMITS.nameLength)) return null;
  const assignments = checkAssignments(value.assignments);
  const when = text(drawnAt, 40);
  if (assignments === null || when === null) return null;
  return { participants: participants as string[], assignments, drawnAt: when };
}

function checkPastExchange(value: unknown): PastExchange | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ['id', 'name', 'date', 'assignments'])) return null;
  const id = text(value.id, 64);
  const name = text(value.name, LIMITS.detail);
  const date = text(value.date, LIMITS.detail);
  const assignments = checkAssignments(value.assignments);
  if (id === null || id === '' || name === null || date === null || assignments === null) return null;
  return { id, name, date, assignments };
}

/**
 * Check a whole saved exchange (the contents of exchange.json).
 * Returns null if anything at all is wrong - the caller treats that as damage.
 */
export function checkExchange(value: unknown): Exchange | null {
  const keys = ['format', 'version', 'savedAt', 'namesText', 'details', 'options', 'keepApart', 'draw', 'history', 'wishes'];
  if (!isPlainObject(value) || !hasExactKeys(value, keys)) return null;
  if (value.format !== 'secret-santa-desktop' || value.version !== 1) return null;
  const savedAt = text(value.savedAt, 40);
  const namesText = text(value.namesText, LIMITS.namesText);
  const details = checkDetails(value.details);
  const options = checkOptions(value.options);
  const keepApart = checkRules(value.keepApart);
  const draw = value.draw === null ? null : checkDraw(value.draw);
  const wishes = checkStringRecord(value.wishes, LIMITS.wishEntries, LIMITS.wish);
  if (savedAt === null || namesText === null || details === null || options === null) return null;
  if (keepApart === null || (value.draw !== null && draw === null) || wishes === null) return null;
  if (!Array.isArray(value.history) || value.history.length > LIMITS.history) return null;
  const history: PastExchange[] = [];
  for (const item of value.history) {
    const past = checkPastExchange(item);
    if (past === null) return null;
    history.push(past);
  }
  return { format: 'secret-santa-desktop', version: 1, savedAt, namesText, details, options, keepApart, draw, history, wishes };
}

/**
 * Check a change sent by the window. Only the five editable fields are
 * accepted, each must be the right shape, and anything else is refused.
 */
export function checkPatch(value: unknown): ExchangePatch | null {
  if (!isPlainObject(value)) return null;
  const allowed = new Set(['namesText', 'details', 'options', 'keepApart', 'wishes']);
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) return null;
  const patch: ExchangePatch = {};
  if (Object.hasOwn(value, 'namesText')) {
    const namesText = text(value.namesText, LIMITS.namesText);
    if (namesText === null) return null;
    patch.namesText = namesText;
  }
  if (Object.hasOwn(value, 'details')) {
    const details = checkDetails(value.details);
    if (details === null) return null;
    patch.details = details;
  }
  if (Object.hasOwn(value, 'options')) {
    const options = checkOptions(value.options);
    if (options === null) return null;
    patch.options = options;
  }
  if (Object.hasOwn(value, 'keepApart')) {
    const keepApart = checkRules(value.keepApart);
    if (keepApart === null) return null;
    patch.keepApart = keepApart;
  }
  if (Object.hasOwn(value, 'wishes')) {
    const wishes = checkStringRecord(value.wishes, LIMITS.wishEntries, LIMITS.wish);
    if (wishes === null) return null;
    patch.wishes = wishes;
  }
  return patch;
}

/** Apply a checked change. Returns a new exchange; the old one is not modified. */
export function applyPatch(exchange: Exchange, patch: ExchangePatch): Exchange {
  return {
    ...exchange,
    namesText: patch.namesText ?? exchange.namesText,
    details: patch.details ?? exchange.details,
    options: patch.options ?? exchange.options,
    keepApart: patch.keepApart ?? exchange.keepApart,
    wishes: patch.wishes ?? exchange.wishes,
  };
}

// ---------------------------------------------------------------------------
// 3. Names
// ---------------------------------------------------------------------------

/** Names are compared ignoring capitals and extra spaces, so "Sam" and "sam " are one person. */
export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/**
 * Turn the names box into a clean list: one name per line, trimmed, blank
 * lines dropped, and repeats (ignoring capitals) dropped - the first spelling
 * wins. Very long lines are cut to the name length limit.
 */
export function parseNames(namesText: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const line of namesText.split(/\r?\n/)) {
    const name = line.trim().replace(/\s+/g, ' ').slice(0, LIMITS.nameLength).trim();
    if (name === '' || seen.has(nameKey(name))) continue;
    seen.add(nameKey(name));
    names.push(name);
  }
  return names;
}

/**
 * Clean the contents of an imported names file: commas, semicolons and tabs
 * also separate names (so a line from a spreadsheet works), and blank lines go.
 */
export function namesFromTextFile(contents: string): string {
  return contents
    .split(/\r?\n|[,;\t]/)
    .map((name) => name.trim())
    .filter((name) => name !== '')
    .join('\n')
    .slice(0, LIMITS.namesText);
}

/** What the window draws from: the exchange plus the facts derived from it. */
export function viewOf(exchange: Exchange): AppView {
  const names = parseNames(exchange.namesText);
  let drawIsStale = false;
  if (exchange.draw) {
    const drawn = new Set(exchange.draw.participants.map(nameKey));
    drawIsStale = drawn.size !== names.length || names.some((name) => !drawn.has(nameKey(name)));
  }
  return { exchange, names, drawIsStale };
}

// ---------------------------------------------------------------------------
// 4. The draw
// ---------------------------------------------------------------------------

/** How a draw attempt ended. */
export type DrawOutcome =
  | { kind: 'found'; assignments: Record<string, string> }
  | { kind: 'impossible' }
  | { kind: 'gave-up' };

/** Picks a whole number from 0 to n-1. Swappable so tests can make draws repeatable. */
export type Picker = (n: number) => number;

const cryptoPicker: Picker = (n) => randomInt(n);

function shuffle<T>(items: readonly T[], pick: Picker): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

/**
 * Can every person be given exactly one recipient at all, ignoring the
 * "no two-way" rule? This is the classic matching problem; if the answer is
 * no, no amount of searching will find a draw, so we can say so at once.
 * `allowed[g]` lists the recipients giver g may have.
 */
function everyoneCanBeMatched(allowed: number[][]): boolean {
  const n = allowed.length;
  const giverOf = new Array<number>(n).fill(-1);
  const tryGiver = (giver: number, visited: boolean[]): boolean => {
    for (const recipient of allowed[giver] ?? []) {
      if (visited[recipient]) continue;
      visited[recipient] = true;
      const current = giverOf[recipient] ?? -1;
      if (current === -1 || tryGiver(current, visited)) {
        giverOf[recipient] = giver;
        return true;
      }
    }
    return false;
  };
  for (let giver = 0; giver < n; giver++) {
    if (!tryGiver(giver, new Array<boolean>(n).fill(false))) return false;
  }
  return true;
}

/**
 * Find a random draw: everyone gives exactly once, everyone receives exactly
 * once, nobody draws themselves, nobody draws someone in `blocked`, and - if
 * `noTwoWay` - nobody draws the person who drew them.
 *
 * How: a randomised search that always fills in the most constrained giver
 * next and backs up when it hits a dead end. It has a work budget so a
 * hopeless set of rules can't freeze the app; if the budget runs out it
 * reports 'gave-up' rather than claiming no draw exists.
 */
export function findDraw(
  names: readonly string[],
  blocked: ReadonlyMap<string, ReadonlySet<string>>,
  noTwoWay: boolean,
  pick: Picker = cryptoPicker,
  workBudget = 30_000_000,
): DrawOutcome {
  const n = names.length;
  // allowed[g] = indexes of the people giver g may draw.
  const allowed: number[][] = names.map((giver, g) =>
    names.flatMap((recipient, r) => (r !== g && !blocked.get(giver)?.has(recipient) ? [r] : [])),
  );
  if (!everyoneCanBeMatched(allowed)) return { kind: 'impossible' };

  const recipientOf = new Array<number>(n).fill(-1);
  const taken = new Array<boolean>(n).fill(false);
  let work = 0;
  let ranOut = false;

  // The recipients giver g could still take right now.
  const choicesFor = (g: number): number[] => {
    const list = allowed[g] ?? [];
    work += list.length;
    return list.filter((r) => !taken[r] && !(noTwoWay && recipientOf[r] === g));
  };

  const search = (assigned: number): boolean => {
    if (assigned === n) return true;
    if (work > workBudget) {
      ranOut = true;
      return false;
    }
    // Pick the unassigned giver with the fewest choices left.
    let giver = -1;
    let choices: number[] = [];
    for (let g = 0; g < n; g++) {
      if (recipientOf[g] !== -1) continue;
      const options = choicesFor(g);
      if (options.length === 0) return false; // dead end - back up
      if (giver === -1 || options.length < choices.length) {
        giver = g;
        choices = options;
      }
    }
    for (const r of shuffle(choices, pick)) {
      recipientOf[giver] = r;
      taken[r] = true;
      if (search(assigned + 1)) return true;
      recipientOf[giver] = -1;
      taken[r] = false;
      if (ranOut) return false;
    }
    return false;
  };

  if (search(0)) {
    const assignments: Record<string, string> = Object.fromEntries(
      names.map((giver, g) => [giver, names[recipientOf[g] ?? -1] ?? '']),
    );
    return { kind: 'found', assignments };
  }
  // A search that finished without running out of budget looked at every
  // possibility, so it has proved there is no draw.
  return ranOut ? { kind: 'gave-up' } : { kind: 'impossible' };
}

/**
 * Work out who may not draw whom: keep-apart rules (both directions) and,
 * if the option is on, every giver -> recipient pair from saved previous years.
 * Names are matched ignoring capitals and spacing.
 */
export function blockedPairs(exchange: Exchange, names: readonly string[]): Map<string, Set<string>> {
  const byKey = new Map(names.map((name) => [nameKey(name), name]));
  const blocked = new Map(names.map((name) => [name, new Set<string>()]));
  const block = (from: string, to: string): void => {
    const giver = byKey.get(nameKey(from));
    const recipient = byKey.get(nameKey(to));
    if (giver !== undefined && recipient !== undefined) blocked.get(giver)?.add(recipient);
  };
  for (const [first, second] of exchange.keepApart) {
    if (first === '' || second === '') continue;
    block(first, second);
    block(second, first);
  }
  if (exchange.options.avoidPrevious) {
    for (const year of exchange.history) {
      for (const [giver, recipient] of Object.entries(year.assignments)) block(giver, recipient);
    }
  }
  return blocked;
}

/** Make a new draw for the exchange, or explain in one sentence why it can't be done. */
export function runDraw(
  exchange: Exchange,
  now: Date = new Date(),
  pick: Picker = cryptoPicker,
): { ok: true; exchange: Exchange; message: string } | { ok: false; message: string } {
  const names = parseNames(exchange.namesText);
  if (names.length < 3) return { ok: false, message: 'Please enter at least 3 different names.' };
  if (names.length > LIMITS.people) {
    return { ok: false, message: `Secret Santa can draw for up to ${LIMITS.people} people at a time.` };
  }
  if (exchange.keepApart.some(([a, b]) => a !== '' && b !== '' && nameKey(a) === nameKey(b))) {
    return { ok: false, message: "A keep-apart rule can't list the same person twice." };
  }
  const outcome = findDraw(names, blockedPairs(exchange, names), exchange.options.noTwoWay, pick);
  if (outcome.kind === 'impossible') {
    return {
      ok: false,
      message:
        'No draw is possible with these keep-apart rules and previous-year exclusions. Remove a rule or turn off one of the exclusion options, then try again.',
    };
  }
  if (outcome.kind === 'gave-up') {
    return {
      ok: false,
      message:
        "Couldn't find a draw that fits all these rules. Remove a rule or turn off one of the exclusion options, then try again.",
    };
  }
  const draw: CurrentDraw = { participants: names, assignments: outcome.assignments, drawnAt: now.toISOString() };
  return {
    ok: true,
    exchange: { ...exchange, draw },
    message: `Done! ${names.length} assignments made. Everyone gives once and receives once.`,
  };
}

// ---------------------------------------------------------------------------
// 5. Button actions
// ---------------------------------------------------------------------------

/** "Clear names": empties the names box and removes the rules and the current draw. */
export function clearNames(exchange: Exchange): Exchange {
  return { ...exchange, namesText: '', keepApart: [], draw: null };
}

/** "Save current draw as a year". */
export function saveYear(
  exchange: Exchange,
  now: Date = new Date(),
  makeId: () => string = randomUUID,
): { ok: true; exchange: Exchange; message: string } | { ok: false; message: string } {
  if (!exchange.draw) return { ok: false, message: 'Make a draw before saving it as a year.' };
  if (exchange.history.length >= LIMITS.history) {
    return { ok: false, message: 'Previous years is full. Remove an old year first.' };
  }
  const name = exchange.details.eventName.trim() || 'Secret Santa';
  const date = exchange.details.eventDate || String(now.getFullYear());
  const year: PastExchange = { id: makeId(), name, date, assignments: { ...exchange.draw.assignments } };
  return { ok: true, exchange: { ...exchange, history: [...exchange.history, year] }, message: `Saved "${name}" to previous years.` };
}

export function removeYear(exchange: Exchange, id: string): Exchange {
  return { ...exchange, history: exchange.history.filter((year) => year.id !== id) };
}

export function clearHistory(exchange: Exchange): Exchange {
  return { ...exchange, history: [] };
}

// ---------------------------------------------------------------------------
// 6. Backups
// ---------------------------------------------------------------------------
// The backup file uses the same layout as the original single-file browser
// version of Secret Santa ("version 2"), so a backup made there imports here
// and a backup made here still opens there.

export interface BackupFile {
  app: 'Secret Santa Generator';
  version: 2;
  exportedAt: string;
  names: string;
  eventName: string;
  budget: string;
  eventDate: string;
  giftNote: string;
  noTwoWay: boolean;
  avoidPrevious: boolean;
  exclusions: KeepApartRule[];
  participants: string[];
  assignments: Record<string, string>;
  history: Array<{ name: string; date: string; assignments: Record<string, string> }>;
  wishes: Record<string, string>;
}

export function toBackup(exchange: Exchange, now: Date = new Date()): BackupFile {
  return {
    app: 'Secret Santa Generator',
    version: 2,
    exportedAt: now.toISOString(),
    names: exchange.namesText,
    ...exchange.details,
    ...exchange.options,
    exclusions: exchange.keepApart,
    participants: exchange.draw?.participants ?? [],
    assignments: exchange.draw?.assignments ?? {},
    history: exchange.history.map(({ name, date, assignments }) => ({ name, date, assignments })),
    wishes: exchange.wishes,
  };
}

/**
 * Read a backup file's parsed JSON. Accepts the version-2 layout from either
 * the browser version or this app. Missing fields fall back to empty; fields
 * of the wrong type make the whole file unreadable (null).
 */
export function fromBackup(
  value: unknown,
  makeId: () => string = randomUUID,
): Omit<Exchange, 'savedAt'> | null {
  if (!isPlainObject(value) || value.app !== 'Secret Santa Generator') return null;
  const pick = <T>(key: string, fallback: T, check: (v: unknown) => T | null): T | null =>
    Object.hasOwn(value, key) && value[key] !== undefined ? check(value[key]) : fallback;
  const str = (max: number) => (v: unknown) => text(v, max);
  const bool = (v: unknown) => (typeof v === 'boolean' ? v : null);

  const namesText = pick('names', '', str(LIMITS.namesText));
  const eventName = pick('eventName', '', str(LIMITS.detail));
  const budget = pick('budget', '', str(LIMITS.detail));
  const eventDate = pick('eventDate', '', (v) => {
    const s = text(v, 10);
    return s === null || (s !== '' && !isRealDate(s)) ? null : s;
  });
  const giftNote = pick('giftNote', '', str(LIMITS.detail));
  const noTwoWay = pick('noTwoWay', true, bool);
  const avoidPrevious = pick('avoidPrevious', true, bool);
  const keepApart = pick('exclusions', [] as KeepApartRule[], checkRules);
  const participants = pick('participants', [] as string[], (v) =>
    Array.isArray(v) && v.length <= LIMITS.people && v.every((n) => typeof n === 'string' && n.length <= LIMITS.nameLength)
      ? (v as string[])
      : null,
  );
  const assignments = pick('assignments', {} as Record<string, string>, checkAssignments);
  const wishes = pick('wishes', {} as Record<string, string>, (v) => checkStringRecord(v, LIMITS.wishEntries, LIMITS.wish));
  const rawHistory = pick('history', [] as unknown[], (v) => (Array.isArray(v) && v.length <= LIMITS.history ? v : null));

  if (
    namesText === null || eventName === null || budget === null || eventDate === null || giftNote === null ||
    noTwoWay === null || avoidPrevious === null || keepApart === null || participants === null ||
    assignments === null || wishes === null || rawHistory === null
  ) {
    return null;
  }

  const history: PastExchange[] = [];
  for (const item of rawHistory) {
    if (!isPlainObject(item)) return null;
    const name = text(item.name ?? 'Secret Santa', LIMITS.detail);
    const date = text(item.date ?? '', LIMITS.detail);
    const yearAssignments = checkAssignments(item.assignments ?? {});
    if (name === null || date === null || yearAssignments === null) return null;
    history.push({ id: makeId(), name, date, assignments: yearAssignments });
  }

  const hasDraw = participants.length > 0 && Object.keys(assignments).length > 0;
  return {
    format: 'secret-santa-desktop',
    version: 1,
    namesText,
    details: { eventName, budget, eventDate, giftNote },
    options: { noTwoWay, avoidPrevious },
    keepApart,
    draw: hasDraw ? { participants, assignments, drawnAt: '' } : null,
    history,
    wishes,
  };
}

/**
 * Bring an imported backup into the app. The backup's names, details, rules,
 * draw and wish lists replace the current ones (the caller keeps a copy of the
 * current file first). Previous years are combined, so importing never loses
 * a year: any year already present is not added twice.
 */
export function mergeImport(current: Exchange, imported: Omit<Exchange, 'savedAt'>): Exchange {
  const fingerprint = (year: PastExchange): string =>
    JSON.stringify([year.name, year.date, Object.entries(year.assignments).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
  const known = new Set(current.history.map(fingerprint));
  const added = imported.history.filter((year) => {
    const key = fingerprint(year);
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  return {
    ...current,
    namesText: imported.namesText,
    details: imported.details,
    options: imported.options,
    keepApart: imported.keepApart,
    draw: imported.draw,
    wishes: imported.wishes,
    history: [...current.history, ...added].slice(-LIMITS.history),
  };
}
