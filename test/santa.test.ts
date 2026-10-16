// Tests for santa.ts - the exchange rules, the draw, checking untrusted data, and backups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as santa from '../src/main/santa.ts';
import type { Exchange } from '../src/shared/types.js';

/** An exchange with these names typed in, and optional changes on top. */
function exchangeWith(names: string[], changes: Partial<Exchange> = {}): Exchange {
  return { ...santa.emptyExchange(new Date('2026-01-01T00:00:00Z')), namesText: names.join('\n'), ...changes };
}

/** A repeatable "random" picker so failures can be reproduced. */
function seededPicker(seed: number): santa.Picker {
  let state = seed >>> 0 || 1;
  return (n) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % n;
  };
}

/** Check a draw obeys every rule; returns the first broken rule, or null. */
function brokenRule(exchange: Exchange, assignments: Record<string, string>): string | null {
  const names = santa.parseNames(exchange.namesText);
  const givers = Object.keys(assignments);
  const recipients = Object.values(assignments);
  if (givers.length !== names.length) return 'not everyone gives';
  if (new Set(recipients).size !== names.length) return 'someone receives twice';
  for (const [giver, recipient] of Object.entries(assignments)) {
    if (!names.includes(giver) || !names.includes(recipient)) return 'unknown person';
    if (giver === recipient) return `${giver} drew themselves`;
    if (exchange.options.noTwoWay && assignments[recipient] === giver) return `${giver} and ${recipient} drew each other`;
    for (const [a, b] of exchange.keepApart) {
      if ((giver === a && recipient === b) || (giver === b && recipient === a)) return `keep-apart ${a}/${b} broken`;
    }
    if (exchange.options.avoidPrevious) {
      for (const year of exchange.history) {
        if (year.assignments[giver] === recipient) return `repeated ${giver}->${recipient} from ${year.name}`;
      }
    }
  }
  return null;
}

test('names: trimmed, blank lines dropped, repeats ignoring capitals dropped', () => {
  assert.deepEqual(santa.parseNames('  Alex \n\nalex\nJordan\r\n  sam  \nSam\n'), ['Alex', 'Jordan', 'sam']);
  assert.deepEqual(santa.parseNames(''), []);
  assert.equal(santa.parseNames('x'.repeat(500))[0]?.length, santa.LIMITS.nameLength);
});

test('names file: commas, semicolons and tabs also separate names', () => {
  assert.equal(santa.namesFromTextFile('Alex, Jordan;Sam\tTaylor\r\n\r\nMorgan'), 'Alex\nJordan\nSam\nTaylor\nMorgan');
});

test('draw: hundreds of random draws all obey every rule', () => {
  const names = ['Alex', 'Jordan', 'Sam', 'Taylor', 'Morgan', 'Casey', 'Riley'];
  const exchange = exchangeWith(names, {
    keepApart: [['Alex', 'Jordan'], ['Sam', 'Taylor']],
    history: [{ id: 'y1', name: '2025', date: '2025-12-20', assignments: { Alex: 'Sam', Casey: 'Riley' } }],
  });
  for (let seed = 1; seed <= 400; seed++) {
    const result = santa.runDraw(exchange, new Date(), seededPicker(seed));
    assert.ok(result.ok, `seed ${seed} found no draw`);
    if (result.ok && result.exchange.draw) {
      assert.equal(brokenRule(exchange, result.exchange.draw.assignments), null, `seed ${seed}`);
    }
  }
});

test('draw: real randomness gives different draws, not one fixed answer', () => {
  const exchange = exchangeWith(['A', 'B', 'C', 'D', 'E', 'F']);
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const result = santa.runDraw(exchange);
    if (result.ok) seen.add(JSON.stringify(result.exchange.draw?.assignments));
  }
  assert.ok(seen.size > 5, `only ${seen.size} different draws in 60 tries`);
});

test('draw: three people with no two-way rule can still draw (one big circle)', () => {
  const result = santa.runDraw(exchangeWith(['A', 'B', 'C']));
  assert.ok(result.ok);
});

test('draw: needs at least three different names', () => {
  const result = santa.runDraw(exchangeWith(['A', 'a', 'B']));
  assert.deepEqual(result, { ok: false, message: 'Please enter at least 3 different names.' });
});

test('draw: a keep-apart rule naming one person twice is refused', () => {
  const result = santa.runDraw(exchangeWith(['A', 'B', 'C'], { keepApart: [['A', 'a']] }));
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.message, /same person twice/);
});

test('draw: an impossible set of rules says so instead of hanging', () => {
  // C may not draw A or B, and can't draw themselves: nobody is left for C.
  const exchange = exchangeWith(['A', 'B', 'C'], { keepApart: [['C', 'A'], ['C', 'B']] });
  const started = Date.now();
  const result = santa.runDraw(exchange);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.message, /No draw is possible/);
  assert.ok(Date.now() - started < 1000);
});

test('draw: impossible only because of the two-way rule is still found to be impossible', () => {
  // With 3 people, if A and B are kept apart, A must draw C and B must draw C - impossible anyway.
  // A subtler case: 4 people where only pairs remain possible.
  const exchange = exchangeWith(['A', 'B', 'C', 'D'], {
    keepApart: [['A', 'C'], ['A', 'D'], ['B', 'C'], ['B', 'D']],
  });
  // A and B can only draw each other, which the two-way rule forbids.
  const result = santa.runDraw(exchange);
  assert.equal(result.ok, false);
  const allowed = santa.runDraw({ ...exchange, options: { noTwoWay: false, avoidPrevious: true } });
  assert.ok(allowed.ok, 'without the two-way rule a draw exists');
});

test('draw: a huge, hopeless search gives up within its budget rather than freezing', () => {
  const names = Array.from({ length: 40 }, (_, i) => `P${i}`);
  // Everyone except P0 is blocked from drawing P0... but P0 must be drawn by someone: impossible,
  // and the matching check spots it instantly.
  const blocked = new Map(names.map((n) => [n, new Set(n === 'P0' ? [] : ['P0'])]));
  const started = Date.now();
  assert.equal(santa.findDraw(names, blocked, true).kind, 'impossible');
  // A tiny work budget forces the "gave up" path.
  assert.equal(santa.findDraw(names, new Map(), true, undefined, 10).kind, 'gave-up');
  assert.ok(Date.now() - started < 2000);
});

test('draw: rules and previous years match names ignoring capitals', () => {
  const exchange = exchangeWith(['alex', 'jordan', 'sam'], {
    keepApart: [['Alex', 'JORDAN']],
  });
  const result = santa.runDraw(exchange);
  // alex/jordan kept apart with 3 people: alex->sam, jordan->sam - impossible.
  assert.equal(result.ok, false);
});

test('checkPatch: accepts the five editable fields and nothing else', () => {
  assert.deepEqual(santa.checkPatch({ namesText: 'A\nB' }), { namesText: 'A\nB' });
  assert.equal(santa.checkPatch({}), null);
  assert.equal(santa.checkPatch({ draw: null }), null, 'the draw can only change through the draw button');
  assert.equal(santa.checkPatch({ namesText: 5 }), null);
  assert.equal(santa.checkPatch({ namesText: 'x'.repeat(santa.LIMITS.namesText + 1) }), null);
  assert.equal(santa.checkPatch({ details: { eventName: 'x', budget: '', eventDate: '2026-02-30', giftNote: '' } }), null, 'not a real date');
  assert.equal(santa.checkPatch({ details: { eventName: 'x', budget: '', eventDate: '', giftNote: '', extra: 1 } }), null);
  assert.equal(santa.checkPatch({ keepApart: [['A']] }), null);
  assert.equal(santa.checkPatch({ options: { noTwoWay: 'yes', avoidPrevious: true } }), null);
  assert.equal(santa.checkPatch(null), null);
  assert.equal(santa.checkPatch([]), null);
  assert.equal(santa.checkPatch('namesText'), null);
});

test('checkPatch: a person called __proto__ or toString is stored as an ordinary name', () => {
  const patch = santa.checkPatch(JSON.parse('{"wishes":{"__proto__":"socks","toString":"books"}}'));
  assert.ok(patch?.wishes);
  assert.equal(santa.own(patch.wishes, '__proto__'), 'socks');
  assert.equal(santa.own(patch.wishes, 'toString'), 'books');
  assert.equal(Object.getPrototypeOf(patch.wishes), Object.prototype, 'prototype not replaced');
  assert.equal(santa.own({}, 'toString'), undefined, 'built-ins are not wish lists');
});

test('checkExchange: accepts what the app saves and rejects damage', () => {
  const good = santa.runDraw(exchangeWith(['A', 'B', 'C']));
  assert.ok(good.ok);
  const saved = JSON.parse(JSON.stringify(good.exchange)) as unknown;
  assert.deepEqual(santa.checkExchange(saved), good.exchange);
  assert.equal(santa.checkExchange({ ...good.exchange, version: 2 }), null);
  assert.equal(santa.checkExchange({ ...good.exchange, history: 'nope' }), null);
  assert.equal(santa.checkExchange({ ...good.exchange, extra: true }), null);
  assert.equal(santa.checkExchange('{}'), null);
});

test('save year, remove year, clear history', () => {
  const drawn = santa.runDraw(exchangeWith(['A', 'B', 'C'], { details: { eventName: 'Office', budget: '', eventDate: '2026-12-18', giftNote: '' } }));
  assert.ok(drawn.ok);
  assert.equal(santa.saveYear(exchangeWith(['A'])).ok, false, 'no draw yet');
  const saved = santa.saveYear(drawn.exchange, new Date(), () => 'year-1');
  assert.ok(saved.ok);
  assert.equal(saved.exchange.history[0]?.name, 'Office');
  assert.equal(saved.exchange.history[0]?.date, '2026-12-18');
  assert.equal(santa.removeYear(saved.exchange, 'year-1').history.length, 0);
  assert.equal(santa.clearHistory(saved.exchange).history.length, 0);
});

test('clear names removes names, rules and the draw but keeps history and wish lists', () => {
  const start = exchangeWith(['A', 'B', 'C'], {
    keepApart: [['A', 'B']],
    wishes: { A: 'socks' },
    history: [{ id: 'y', name: 'old', date: '2025', assignments: {} }],
  });
  const cleared = santa.clearNames(start);
  assert.equal(cleared.namesText, '');
  assert.deepEqual(cleared.keepApart, []);
  assert.equal(cleared.draw, null);
  assert.equal(cleared.history.length, 1);
  assert.deepEqual(cleared.wishes, { A: 'socks' });
});

test('the view reports a stale draw when the names change', () => {
  const drawn = santa.runDraw(exchangeWith(['A', 'B', 'C']));
  assert.ok(drawn.ok);
  assert.equal(santa.viewOf(drawn.exchange).drawIsStale, false);
  assert.equal(santa.viewOf({ ...drawn.exchange, namesText: 'a\nb\nc' }).drawIsStale, false, 'capitals alone do not count');
  assert.equal(santa.viewOf({ ...drawn.exchange, namesText: 'A\nB\nC\nD' }).drawIsStale, true);
});

test('backups: a backup round-trips through export and import', () => {
  const drawn = santa.runDraw(
    exchangeWith(['A', 'B', 'C', 'D'], {
      details: { eventName: 'Family', budget: '$25', eventDate: '2026-12-20', giftNote: 'Fun' },
      keepApart: [['A', 'B']],
      wishes: { C: 'tea' },
      history: [{ id: 'y', name: 'Family', date: '2025-12-20', assignments: { A: 'C', B: 'A', C: 'B' } }],
    }),
  );
  assert.ok(drawn.ok);
  const backup = JSON.parse(JSON.stringify(santa.toBackup(drawn.exchange))) as unknown;
  const imported = santa.fromBackup(backup, () => 'new-id');
  assert.ok(imported);
  assert.equal(imported.namesText, 'A\nB\nC\nD');
  assert.deepEqual(imported.details, drawn.exchange.details);
  assert.deepEqual(imported.draw?.assignments, drawn.exchange.draw?.assignments);
  assert.deepEqual(imported.wishes, { C: 'tea' });
  assert.equal(imported.history.length, 1);
});

test('backups: a backup from the original browser version imports', () => {
  // The exact layout secret-santa-offline-plus.html wrote.
  const browserBackup = {
    app: 'Secret Santa Generator',
    version: 2,
    exportedAt: '2025-12-01T10:00:00.000Z',
    names: 'Alex\nJordan\nSam',
    eventName: 'Family Secret Santa',
    budget: '$25',
    eventDate: '2025-12-20',
    giftNote: 'Keep it fun!',
    noTwoWay: true,
    avoidPrevious: true,
    exclusions: [['Alex', 'Jordan']],
    participants: ['Alex', 'Jordan', 'Sam'],
    assignments: { Alex: 'Sam', Jordan: 'Alex', Sam: 'Jordan' },
    history: [{ name: 'Family Secret Santa', date: '2024-12-20', assignments: { Alex: 'Jordan', Jordan: 'Sam', Sam: 'Alex' } }],
    wishes: { Sam: 'Coffee' },
  };
  const imported = santa.fromBackup(browserBackup);
  assert.ok(imported);
  assert.equal(imported.details.eventName, 'Family Secret Santa');
  assert.deepEqual(imported.keepApart, [['Alex', 'Jordan']]);
  assert.equal(imported.history[0]?.date, '2024-12-20');
  // The result must be a valid exchange once given a save time.
  assert.ok(santa.checkExchange({ ...imported, savedAt: 'now' }));
});

test('backups: anything else is refused', () => {
  assert.equal(santa.fromBackup({ app: 'Something else' }), null);
  assert.equal(santa.fromBackup({ app: 'Secret Santa Generator', names: 42 }), null);
  assert.equal(santa.fromBackup({ app: 'Secret Santa Generator', history: [{ assignments: 'x' }] }), null);
  assert.equal(santa.fromBackup([]), null);
});

test('importing combines previous years without duplicating any', () => {
  const year = { id: 'a', name: 'Fam', date: '2024', assignments: { A: 'B', B: 'A' } };
  const current = exchangeWith(['X'], { history: [year] });
  const imported = santa.fromBackup({
    app: 'Secret Santa Generator',
    names: 'A\nB\nC',
    history: [
      { name: 'Fam', date: '2024', assignments: { B: 'A', A: 'B' } }, // same year, keys in another order
      { name: 'Fam', date: '2025', assignments: { A: 'C' } },
    ],
  });
  assert.ok(imported);
  const merged = santa.mergeImport(current, imported);
  assert.equal(merged.namesText, 'A\nB\nC');
  assert.deepEqual(merged.history.map((y) => y.date), ['2024', '2025']);
});
