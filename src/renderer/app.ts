// app.ts - everything the Secret Santa window does.
//
// This runs inside the window, which is sandboxed: it can't touch files, the
// network or anything else on the computer. It can only ask the main process
// for things through `window.santa` (listed in shared/types.d.ts). All saving
// happens over there; this file draws the screen and passes on what the
// person does.
//
// Sections:
//   1. Finding things on the page, and small helpers
//   2. Saving what the person types
//   3. Drawing the screen from the saved exchange
//   4. Buttons
//   5. Scratch cards, the wheel and challenges (just for fun - nothing saved)
//   6. Start-up and unexpected errors

import type { ActionResult, AppView, ExchangeDetails, ExchangePatch, KeepApartRule, Outcome, SantaApi } from '../shared/types.js';

declare global {
  interface Window {
    santa: SantaApi;
  }
}

// ===========================================================================
// 1. Finding things on the page, and small helpers
// ===========================================================================

const api = window.santa;

/** Find an element by id and check it's the kind expected. */
function el<T extends HTMLElement>(id: string, kind: { new (): T; prototype: T }): T {
  const found = document.getElementById(id);
  if (!(found instanceof kind)) throw new Error(`The page is missing #${id}.`);
  return found;
}

const ui = {
  saveState: el('saveState', HTMLElement),
  banner: el('appNotice', HTMLElement),
  names: el('names', HTMLTextAreaElement),
  count: el('count', HTMLElement),
  importNames: el('importNames', HTMLButtonElement),
  clearNames: el('clearNames', HTMLButtonElement),
  eventName: el('eventName', HTMLInputElement),
  budget: el('budget', HTMLInputElement),
  eventDate: el('eventDate', HTMLInputElement),
  giftNote: el('giftNote', HTMLInputElement),
  noTwoWay: el('noTwoWay', HTMLInputElement),
  avoidPrevious: el('avoidPrevious', HTMLInputElement),
  rules: el('rules', HTMLElement),
  addRule: el('addRule', HTMLButtonElement),
  draw: el('draw', HTMLButtonElement),
  setupMessage: el('setupMessage', HTMLElement),
  resultCount: el('resultCount', HTMLElement),
  resultIntro: el('resultIntro', HTMLElement),
  staleNotice: el('staleNotice', HTMLElement),
  results: el('results', HTMLElement),
  resultActions: el('resultActions', HTMLElement),
  privateReveal: el('privateReveal', HTMLButtonElement),
  printSlips: el('printSlips', HTMLButtonElement),
  saveSlipsPdf: el('saveSlipsPdf', HTMLButtonElement),
  hideAll: el('hideAll', HTMLButtonElement),
  resultMessage: el('resultMessage', HTMLElement),
  scratchCards: el('scratchCards', HTMLElement),
  resetScratch: el('resetScratch', HTMLButtonElement),
  wheel: el('wheel', HTMLCanvasElement),
  spin: el('spin', HTMLButtonElement),
  resetWheel: el('resetWheel', HTMLButtonElement),
  wheelResult: el('wheelResult', HTMLElement),
  wishLists: el('wishLists', HTMLElement),
  challengeText: el('challengeText', HTMLElement),
  newChallenge: el('newChallenge', HTMLButtonElement),
  copyChallenge: el('copyChallenge', HTMLButtonElement),
  challengeMessage: el('challengeMessage', HTMLElement),
  saveYear: el('saveYear', HTMLButtonElement),
  clearHistory: el('clearHistory', HTMLButtonElement),
  historyList: el('historyList', HTMLElement),
  historyMessage: el('historyMessage', HTMLElement),
  exportBackup: el('exportBackup', HTMLButtonElement),
  importBackup: el('importBackup', HTMLButtonElement),
  openDataFolder: el('openDataFolder', HTMLButtonElement),
  dataMessage: el('dataMessage', HTMLElement),
  slips: el('slips', HTMLElement),
  pickDialog: el('pickDialog', HTMLDialogElement),
  pickName: el('pickName', HTMLSelectElement),
  pickShow: el('pickShow', HTMLButtonElement),
  pickCancel: el('pickCancel', HTMLButtonElement),
  revealDialog: el('revealDialog', HTMLDialogElement),
  revealTitle: el('revealTitle', HTMLElement),
  revealName: el('revealName', HTMLElement),
  revealDetails: el('revealDetails', HTMLElement),
  revealWishes: el('revealWishes', HTMLElement),
  revealWishText: el('revealWishText', HTMLElement),
  closeReveal: el('closeReveal', HTMLButtonElement),
  confirmDialog: el('confirmDialog', HTMLDialogElement),
  confirmText: el('confirmText', HTMLElement),
  confirmYes: el('confirmYes', HTMLButtonElement),
  confirmNo: el('confirmNo', HTMLButtonElement),
};

/** Read one entry of a name -> text record without picking up built-ins like "toString". */
function own(record: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Make an element with a class and text. Text is always set as text, never as HTML. */
function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

/** Show a one-sentence message in one of the notice boxes. */
function say(box: HTMLElement, text: string, kind: 'ok' | 'error' = 'ok'): void {
  box.textContent = text;
  box.className = kind === 'error' ? 'notice error' : 'notice';
}

/** Add a sentence to the banner across the top of the window. */
function showBanner(text: string, kind: 'info' | 'error'): void {
  if (Array.from(ui.banner.children).some((line) => line.textContent === text)) return;
  ui.banner.append(make('p', '', text));
  ui.banner.className = kind === 'error' ? 'banner error' : 'banner';
  ui.banner.hidden = false;
}

/** "2026-12-20" -> "Dec 20, 2026" in the person's own date style. */
function formatDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString(undefined, { timeZone: 'UTC', dateStyle: 'medium' });
}

/** Budget, date and note as one line, e.g. "Budget: $25 · Exchange: Dec 20, 2026 · Keep it fun!" */
function detailsLine(details: ExchangeDetails): string {
  return [
    details.budget.trim() ? `Budget: ${details.budget.trim()}` : '',
    details.eventDate ? `Exchange: ${formatDate(details.eventDate)}` : '',
    details.giftNote.trim(),
  ]
    .filter((part) => part !== '')
    .join(' · ');
}

/** A dashed "nothing here yet" box. */
function emptyBox(text: string): HTMLElement {
  return make('div', 'empty', text);
}

/** Ask a yes/no question in the page's own dialog. Resolves true for yes. */
function confirmAction(question: string, yesLabel: string): Promise<boolean> {
  ui.confirmText.textContent = question;
  ui.confirmYes.textContent = yesLabel;
  return new Promise((resolve) => {
    const finish = (answer: boolean): void => {
      ui.confirmYes.removeEventListener('click', onYes);
      ui.confirmNo.removeEventListener('click', onNo);
      ui.confirmDialog.removeEventListener('cancel', onEscape);
      if (ui.confirmDialog.open) ui.confirmDialog.close();
      resolve(answer);
    };
    const onYes = (): void => finish(true);
    const onNo = (): void => finish(false);
    const onEscape = (event: Event): void => {
      event.preventDefault();
      finish(false);
    };
    ui.confirmYes.addEventListener('click', onYes);
    ui.confirmNo.addEventListener('click', onNo);
    ui.confirmDialog.addEventListener('cancel', onEscape);
    ui.confirmDialog.showModal();
    ui.confirmNo.focus();
  });
}

/**
 * Run a button's action, catching anything unexpected so a mistake becomes a
 * sentence in the banner rather than a broken window.
 */
function onClick(button: HTMLElement, action: () => Promise<void> | void): void {
  button.addEventListener('click', () => {
    void Promise.resolve()
      .then(action)
      .catch((error: unknown) => reportProblem(error));
  });
}

// ===========================================================================
// 2. Saving what the person types
// ===========================================================================
// Typing is sent to the main process a moment after the person pauses
// (or straight away when a field loses focus, or the app is closing). The
// main process writes it to disk before replying. Saves go one at a time,
// in order.

/** The exchange as last saved, plus facts worked out from it. Set at start-up. */
let view: AppView;
/** The keep-apart rules being edited. */
let rules: KeepApartRule[] = [];
let pending: ExchangePatch = {};
let pendingTimer: number | undefined;
let saveChain: Promise<void> = Promise.resolve();

function setSaveState(state: 'saved' | 'saving' | 'problem'): void {
  ui.saveState.textContent =
    state === 'saved' ? 'All changes saved' : state === 'saving' ? 'Saving…' : 'Not saved - see the message above';
  ui.saveState.classList.toggle('problem', state === 'problem');
}

/** Queue a change to be saved after `delay` milliseconds of quiet. */
function queueSave(patch: ExchangePatch, delay = 400): void {
  pending = { ...pending, ...patch };
  setSaveState('saving');
  window.clearTimeout(pendingTimer);
  pendingTimer = window.setTimeout(() => void saveNow(), delay);
}

/** Send any queued change now. Resolves once everything sent so far is saved. */
function saveNow(): Promise<void> {
  window.clearTimeout(pendingTimer);
  pendingTimer = undefined;
  if (Object.keys(pending).length === 0) return saveChain;
  const patch = pending;
  pending = {};
  saveChain = saveChain.then(async () => {
    const result = await api.update(patch);
    if (result.status === 'done') {
      view = result.view;
      render();
      if (Object.keys(pending).length === 0) setSaveState('saved');
    } else if (result.status === 'failed') {
      setSaveState('problem');
      showBanner(result.message, 'error');
    }
  });
  return saveChain;
}

function readDetails(): ExchangeDetails {
  return { eventName: ui.eventName.value, budget: ui.budget.value, eventDate: ui.eventDate.value, giftNote: ui.giftNote.value };
}

/** Every wish list: the ones on screen, plus any kept for people no longer listed. */
function readWishes(): Record<string, string> {
  const wishes: Array<[string, string]> = Object.entries(view.exchange.wishes);
  for (const box of Array.from(ui.wishLists.querySelectorAll('textarea'))) {
    const person = box.dataset.person;
    if (person !== undefined) wishes.push([person, box.value]);
  }
  return Object.fromEntries(wishes);
}

/** Take the result of an action that changed the exchange, redraw, and show its message. */
function applyResult(result: ActionResult, box: HTMLElement, refillForm = false): boolean {
  if (result.status === 'canceled') return false;
  if (result.status === 'failed') {
    say(box, result.message, 'error');
    return false;
  }
  view = result.view;
  if (refillForm) fillForm();
  render();
  setSaveState('saved');
  say(box, result.message ?? '');
  return true;
}

/** Show the result of an action that didn't change the exchange. */
function showOutcome(outcome: Outcome, box: HTMLElement): void {
  if (outcome.status === 'failed') say(box, outcome.message, 'error');
  else if (outcome.status === 'done') say(box, outcome.message ?? '');
}

// ===========================================================================
// 3. Drawing the screen from the saved exchange
// ===========================================================================

let renderedNamesKey: string | null = null;
let renderedDrawKey: string | null = null;

/** Put the saved values into the form fields. Only at start-up and after imports/clears. */
function fillForm(): void {
  const { exchange } = view;
  ui.names.value = exchange.namesText;
  ui.eventName.value = exchange.details.eventName;
  ui.budget.value = exchange.details.budget;
  ui.eventDate.value = exchange.details.eventDate;
  ui.giftNote.value = exchange.details.giftNote;
  ui.noTwoWay.checked = exchange.options.noTwoWay;
  ui.avoidPrevious.checked = exchange.options.avoidPrevious;
  rules = exchange.keepApart.map(([a, b]) => [a, b]);
  renderedNamesKey = null;
  renderedDrawKey = null;
}

/**
 * Redraw everything that depends on the saved exchange. Parts that hold
 * something in progress (scratch cards half scratched, a wish list being
 * typed) are only rebuilt when what they show has actually changed.
 */
function render(): void {
  const { names, exchange } = view;
  ui.count.textContent = `${names.length} participant${names.length === 1 ? '' : 's'}`;

  const namesKey = names.join('\n');
  if (namesKey !== renderedNamesKey) {
    renderedNamesKey = namesKey;
    renderRules();
    renderWishes();
    if (!exchange.draw) resetWheel();
  }

  const drawKey = exchange.draw ? `${exchange.draw.drawnAt}|${JSON.stringify(exchange.draw.assignments)}` : '';
  if (drawKey !== renderedDrawKey) {
    renderedDrawKey = drawKey;
    renderResults();
    renderScratch();
    resetWheel();
  }

  ui.staleNotice.hidden = !view.drawIsStale;
  ui.resultIntro.textContent = exchange.draw
    ? `${exchange.details.eventName.trim() || 'Secret Santa'}${detailsLine({ ...exchange.details, giftNote: '' }) ? ` · ${detailsLine({ ...exchange.details, giftNote: '' })}` : ''}. Click a row to reveal or hide its match.`
    : 'Generate a draw to get started. Click a row to reveal a match.';
  renderHistory();
}

function renderRules(): void {
  ui.rules.replaceChildren(...rules.map((rule, index) => ruleRow(rule, index)));
}

/** One keep-apart rule: two drop-downs and a remove button. */
function ruleRow(rule: KeepApartRule, index: number): HTMLElement {
  const row = make('div', 'rule-row');
  const pickers = ([0, 1] as const).map((side) => {
    const select = make('select');
    select.setAttribute('aria-label', side === 0 ? 'First person in this keep-apart rule' : 'Second person in this keep-apart rule');
    select.add(new Option('Choose a person', ''));
    for (const name of view.names) select.add(new Option(name, name));
    const current = rule[side];
    if (current !== '' && !view.names.includes(current)) select.add(new Option(`${current} (not in the list)`, current));
    select.value = current;
    select.addEventListener('change', () => {
      const existing = rules[index];
      if (!existing) return;
      rules[index] = side === 0 ? [select.value, existing[1]] : [existing[0], select.value];
      queueSave({ keepApart: rules.map(([a, b]) => [a, b]) }, 0);
    });
    return select;
  });
  const remove = make('button', 'remove', '×');
  remove.type = 'button';
  remove.title = 'Remove this rule';
  remove.setAttribute('aria-label', 'Remove this rule');
  remove.addEventListener('click', () => {
    rules.splice(index, 1);
    renderRules();
    queueSave({ keepApart: rules.map(([a, b]) => [a, b]) }, 0);
  });
  row.append(pickers[0] ?? '', make('span', '', '↔'), pickers[1] ?? '', remove);
  return row;
}

function renderWishes(): void {
  if (view.names.length === 0) {
    ui.wishLists.replaceChildren(emptyBox('Add participants first.'));
    return;
  }
  ui.wishLists.replaceChildren(
    ...view.names.map((name) => {
      const card = make('div', 'wish-card');
      const box = make('textarea');
      box.placeholder = 'Likes, hobbies, sizes, no-thanks…';
      box.maxLength = 4000;
      box.value = own(view.exchange.wishes, name) ?? '';
      box.dataset.person = name;
      box.setAttribute('aria-label', `Gift clues for ${name}`);
      box.addEventListener('input', () => queueSave({ wishes: readWishes() }));
      box.addEventListener('blur', () => void saveNow());
      card.append(make('h4', '', `🎁 ${name}`), box);
      return card;
    }),
  );
}

/** The pairs of the current draw, in the order the names were listed. */
function drawPairs(): Array<[string, string]> {
  const draw = view.exchange.draw;
  if (!draw) return [];
  return draw.participants.flatMap((giver): Array<[string, string]> => {
    const recipient = own(draw.assignments, giver);
    return recipient === undefined ? [] : [[giver, recipient]];
  });
}

function renderResults(): void {
  const pairs = drawPairs();
  ui.resultActions.hidden = pairs.length === 0;
  ui.resultCount.textContent = pairs.length ? `${pairs.length} assignments` : 'Not drawn yet';
  if (pairs.length === 0) {
    ui.results.replaceChildren(emptyBox('Your holiday magic will appear here.'));
    return;
  }
  ui.results.replaceChildren(
    ...pairs.map(([giver, recipient]) => {
      const row = make('div', 'result');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-pressed', 'false');
      row.setAttribute('aria-label', `Reveal or hide ${giver}'s match`);
      row.append(make('span', 'person', giver), make('span', 'arrow', '→'), make('span', 'person recipient', recipient));
      const toggle = (): void => {
        const shown = row.classList.toggle('revealed');
        row.setAttribute('aria-pressed', String(shown));
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle();
        }
      });
      return row;
    }),
  );
}

function renderHistory(): void {
  const years = view.exchange.history;
  if (years.length === 0) {
    ui.historyList.replaceChildren(emptyBox('No previous exchanges saved yet.'));
    return;
  }
  ui.historyList.replaceChildren(
    ...years
      .slice()
      .reverse()
      .map((year) => {
        const row = make('div', 'history-item');
        const info = make('div');
        const count = Object.keys(year.assignments).length;
        info.append(make('b', '', year.name), make('div', 'muted', `${formatDate(year.date) || 'No date'} · ${count} assignment${count === 1 ? '' : 's'}`));
        const remove = make('button', 'btn subtle', 'Remove');
        remove.type = 'button';
        onClick(remove, async () => {
          if (!(await confirmAction(`Remove "${year.name}" from previous years?`, 'Remove'))) return;
          applyResult(await api.removeYear(year.id), ui.historyMessage);
        });
        row.append(info, remove);
        return row;
      }),
  );
}

// ===========================================================================
// 4. Buttons
// ===========================================================================

function wireUp(): void {
  // Typing in the form is saved a moment after the person pauses.
  ui.names.addEventListener('input', () => queueSave({ namesText: ui.names.value }));
  ui.names.addEventListener('blur', () => void saveNow());
  for (const field of [ui.eventName, ui.budget, ui.giftNote, ui.eventDate]) {
    field.addEventListener('input', () => queueSave({ details: readDetails() }));
    field.addEventListener('blur', () => void saveNow());
  }
  for (const box of [ui.noTwoWay, ui.avoidPrevious]) {
    box.addEventListener('change', () =>
      queueSave({ options: { noTwoWay: ui.noTwoWay.checked, avoidPrevious: ui.avoidPrevious.checked } }, 0),
    );
  }

  onClick(ui.importNames, async () => {
    await saveNow();
    applyResult(await api.importNames(), ui.setupMessage, true);
  });

  onClick(ui.clearNames, async () => {
    if (!(await confirmAction('Clear all the names, keep-apart rules and the current draw?', 'Clear'))) return;
    await saveNow();
    applyResult(await api.clearNames(), ui.setupMessage, true);
  });

  onClick(ui.addRule, async () => {
    await saveNow(); // so names typed a moment ago count
    if (view.names.length < 2) {
      say(ui.setupMessage, 'Add at least two names first.', 'error');
      return;
    }
    rules.push(['', '']);
    renderRules();
    queueSave({ keepApart: rules.map(([a, b]) => [a, b]) }, 0);
  });

  onClick(ui.draw, async () => {
    ui.draw.disabled = true;
    try {
      await saveNow();
      applyResult(await api.draw(), ui.setupMessage);
    } finally {
      ui.draw.disabled = false;
    }
  });

  onClick(ui.hideAll, () => {
    for (const row of Array.from(ui.results.querySelectorAll('.result'))) {
      row.classList.remove('revealed');
      row.setAttribute('aria-pressed', 'false');
    }
  });

  onClick(ui.privateReveal, () => {
    const pairs = drawPairs();
    if (pairs.length === 0) return;
    ui.pickName.replaceChildren(new Option('Choose your name', ''), ...pairs.map(([giver]) => new Option(giver, giver)));
    ui.pickDialog.showModal();
    ui.pickName.focus();
  });
  onClick(ui.pickCancel, () => ui.pickDialog.close());
  onClick(ui.pickShow, () => {
    const giver = ui.pickName.value;
    const draw = view.exchange.draw;
    const recipient = draw ? own(draw.assignments, giver) : undefined;
    if (!giver || recipient === undefined) return;
    ui.pickDialog.close();
    ui.revealTitle.textContent = `Hi, ${giver}!`;
    ui.revealName.textContent = recipient;
    ui.revealDetails.textContent = detailsLine(view.exchange.details);
    const clues = own(view.exchange.wishes, recipient)?.trim() ?? '';
    ui.revealWishText.textContent = clues;
    ui.revealWishes.hidden = clues === '';
    ui.revealDialog.showModal();
  });
  onClick(ui.closeReveal, () => ui.revealDialog.close());
  // Whatever closes the reveal, clear it so the name isn't left in the page.
  ui.revealDialog.addEventListener('close', () => {
    ui.revealName.textContent = '';
    ui.revealWishText.textContent = '';
  });

  onClick(ui.printSlips, async () => {
    await saveNow();
    buildSlips();
    try {
      showOutcome(await api.printSlips(), ui.resultMessage);
    } finally {
      ui.slips.replaceChildren();
    }
  });

  onClick(ui.saveSlipsPdf, async () => {
    await saveNow();
    buildSlips();
    try {
      showOutcome(await api.saveSlipsPdf(), ui.resultMessage);
    } finally {
      ui.slips.replaceChildren();
    }
  });

  onClick(ui.saveYear, async () => {
    await saveNow();
    applyResult(await api.saveYear(), ui.historyMessage);
  });

  onClick(ui.clearHistory, async () => {
    if (view.exchange.history.length === 0) return;
    if (!(await confirmAction('Delete all saved previous years?', 'Delete'))) return;
    applyResult(await api.clearHistory(), ui.historyMessage);
  });

  onClick(ui.exportBackup, async () => {
    await saveNow();
    showOutcome(await api.exportBackup(), ui.dataMessage);
  });

  onClick(ui.importBackup, async () => {
    const go = await confirmAction(
      "Importing a backup replaces the names, details, rules, draw and wish lists here with the backup's. Previous years are combined, and a copy of your current exchange is kept in the data folder. Continue?",
      'Choose a backup',
    );
    if (!go) return;
    await saveNow();
    applyResult(await api.importBackup(), ui.dataMessage, true);
  });

  onClick(ui.openDataFolder, async () => showOutcome(await api.openDataFolder(), ui.dataMessage));

  // Tabs in Santa's workshop.
  for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tab]'))) {
    tab.addEventListener('click', () => {
      for (const other of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tab]'))) {
        const active = other === tab;
        other.classList.toggle('active', active);
        other.setAttribute('aria-selected', String(active));
      }
      for (const panel of Array.from(document.querySelectorAll('.subpanel'))) {
        panel.classList.toggle('active', panel.id === `tab-${tab.dataset.tab ?? ''}`);
      }
    });
  }

  onClick(ui.resetScratch, () => renderScratch());
  onClick(ui.spin, () => spinWheel());
  onClick(ui.resetWheel, () => {
    resetWheel();
    say(ui.wheelResult, 'Wheel reset. Everyone is back in the running.');
  });
  onClick(ui.newChallenge, () => {
    ui.challengeText.textContent = CHALLENGES[Math.floor(Math.random() * CHALLENGES.length)] ?? '';
    say(ui.challengeMessage, '');
  });
  onClick(ui.copyChallenge, async () => {
    const text = ui.challengeText.textContent ?? '';
    if (!CHALLENGES.includes(text)) {
      say(ui.challengeMessage, 'Deal a challenge first.', 'error');
      return;
    }
    showOutcome(await api.copyText(text), ui.challengeMessage);
  });
}

/** Lay out one printable slip per person (hidden on screen; shown only when printing). */
function buildSlips(): void {
  const { details } = view.exchange;
  ui.slips.replaceChildren(
    ...drawPairs().map(([giver, recipient]) => {
      const slip = make('div', 'slip');
      slip.append(
        make('div', 'eyebrow dark', details.eventName.trim() || 'Secret Santa'),
        make('h2', '', `For ${giver}`),
        make('p', '', 'Your secret assignment is…'),
        make('div', 'big', recipient),
        make('small', '', detailsLine(details)),
      );
      return slip;
    }),
  );
}

// ===========================================================================
// 5. Scratch cards, the wheel and challenges
// ===========================================================================
// These are party games. Nothing here is saved.

const CHALLENGES: readonly string[] = [
  'Make it homemade (or at least look homemade).',
  'Find something cozy for under the budget.',
  'Wrap the gift in newspaper or a reusable cloth.',
  "Give something that starts with the recipient's first initial.",
  'Choose a gift that makes an excellent inside joke.',
  'Include a handwritten note with three genuine compliments.',
  'The gift must fit inside a mug.',
  'Pick something useful that the recipient probably would not buy themselves.',
  'Give the gift a ridiculous, over-the-top name.',
  "Choose something inspired by the recipient's favorite snack.",
  'Find the best silly gift you can without going over budget.',
  'Include one tiny surprise inside the wrapping.',
  'The gift must be a single color.',
  'Choose something that encourages a new hobby.',
  'Make the wrapping part of the gift.',
  'Find something secondhand that deserves a second life.',
  'Gift something that makes a satisfying sound.',
  'Add a clue to the gift before the recipient opens it.',
];

/** One gold scratch-off card per assignment. */
function renderScratch(): void {
  const pairs = drawPairs();
  if (pairs.length === 0) {
    ui.scratchCards.replaceChildren(emptyBox('Generate assignments first.'));
    return;
  }
  ui.scratchCards.replaceChildren(
    ...pairs.map(([giver, recipient]) => {
      const card = make('div', 'scratch-card');
      card.append(make('div', 'under', recipient), make('div', 'caption', `🎁 ${giver}, scratch to reveal`));
      const canvas = make('canvas');
      canvas.width = 500;
      canvas.height = 300;
      canvas.setAttribute('aria-label', `Scratch to reveal ${giver}'s match`);
      card.append(canvas);
      const pen = canvas.getContext('2d');
      if (!pen) return card;
      pen.fillStyle = '#c4a45d';
      pen.fillRect(0, 0, canvas.width, canvas.height);
      pen.fillStyle = '#fff0bf';
      pen.textAlign = 'center';
      pen.font = 'bold 34px "Segoe UI", sans-serif';
      pen.fillText('SCRATCH HERE', 250, 135);
      pen.font = '50px "Segoe UI Emoji", sans-serif';
      pen.fillText('✦  🎁  ✦', 250, 205);
      let scratching = false;
      const scratch = (event: PointerEvent): void => {
        const box = canvas.getBoundingClientRect();
        const x = ((event.clientX - box.left) * canvas.width) / box.width;
        const y = ((event.clientY - box.top) * canvas.height) / box.height;
        pen.globalCompositeOperation = 'destination-out';
        pen.beginPath();
        pen.arc(x, y, 28, 0, Math.PI * 2);
        pen.fill();
      };
      canvas.addEventListener('pointerdown', (event) => {
        scratching = true;
        canvas.setPointerCapture(event.pointerId);
        scratch(event);
      });
      canvas.addEventListener('pointermove', (event) => {
        if (scratching) scratch(event);
      });
      canvas.addEventListener('pointerup', () => (scratching = false));
      canvas.addEventListener('pointercancel', () => (scratching = false));
      canvas.addEventListener('dblclick', () => pen.clearRect(0, 0, canvas.width, canvas.height));
      return card;
    }),
  );
}

let wheelPicked: string[] = [];
let wheelAngle = 0;
let spinning = false;

/** Who's on the wheel: the people in the draw, or the names list if there's no draw yet. */
function wheelPeople(): string[] {
  return view.exchange.draw ? view.exchange.draw.participants : view.names;
}

function resetWheel(): void {
  wheelPicked = [];
  drawWheel();
}

function drawWheel(): void {
  const pen = ui.wheel.getContext('2d');
  if (!pen) return;
  const everyone = wheelPeople();
  const remaining = everyone.filter((name) => !wheelPicked.includes(name));
  const labels = remaining.length ? remaining : everyone.length ? everyone : ['Add names'];
  const colours = ['#1e5b4b', '#d9b66f', '#b94c45', '#e8ddc3', '#286c5a', '#d8c49a'];
  const radius = 225;
  pen.clearRect(0, 0, 500, 500);
  pen.save();
  pen.translate(250, 250);
  pen.rotate(wheelAngle);
  labels.forEach((name, i) => {
    const start = (i * 2 * Math.PI) / labels.length - Math.PI / 2;
    const end = ((i + 1) * 2 * Math.PI) / labels.length - Math.PI / 2;
    pen.beginPath();
    pen.moveTo(0, 0);
    pen.arc(0, 0, radius, start, end);
    pen.closePath();
    pen.fillStyle = colours[i % colours.length] ?? '#1e5b4b';
    pen.fill();
    pen.strokeStyle = '#fff8e8';
    pen.lineWidth = 3;
    pen.stroke();
    pen.save();
    pen.rotate((start + end) / 2);
    pen.textAlign = 'right';
    pen.fillStyle = i % 2 === 1 ? '#17352f' : '#fffdf7';
    pen.font = `bold ${labels.length > 9 ? 13 : 17}px "Segoe UI", sans-serif`;
    pen.fillText(name.length > 17 ? `${name.slice(0, 15)}…` : name, radius - 18, 5);
    pen.restore();
  });
  pen.beginPath();
  pen.arc(0, 0, 42, 0, Math.PI * 2);
  pen.fillStyle = '#fffdf7';
  pen.fill();
  pen.strokeStyle = '#d9b66f';
  pen.lineWidth = 6;
  pen.stroke();
  pen.fillStyle = '#123c32';
  pen.textAlign = 'center';
  pen.font = 'bold 18px "Segoe UI", sans-serif';
  pen.fillText('SANTA', 0, 6);
  pen.restore();
}

/** Spin to a random person who hasn't been picked yet, easing to a stop. */
function spinWheel(): void {
  if (spinning) return;
  const everyone = wheelPeople();
  if (everyone.length === 0) {
    say(ui.wheelResult, 'Add participants first.', 'error');
    return;
  }
  const remaining = everyone.filter((name) => !wheelPicked.includes(name));
  if (remaining.length === 0) {
    say(ui.wheelResult, 'Everyone has had a turn! Reset the wheel to start again.');
    return;
  }
  spinning = true;
  const index = Math.floor(Math.random() * remaining.length);
  const winner = remaining[index] ?? '';
  const segment = (2 * Math.PI) / remaining.length;
  // Land the middle of the winner's slice under the pointer at the top, after eight full turns.
  const target = -(index + 0.5) * segment + 2 * Math.PI * 8;
  const start = wheelAngle;
  const began = performance.now();
  const frame = (now: number): void => {
    const t = Math.min(1, (now - began) / 3300);
    wheelAngle = start + (target - start) * (1 - Math.pow(1 - t, 4));
    drawWheel();
    if (t < 1) {
      requestAnimationFrame(frame);
      return;
    }
    spinning = false;
    wheelAngle %= Math.PI * 2;
    wheelPicked.push(winner);
    say(ui.wheelResult, `🎉 ${winner} is up next!`);
    drawWheel();
  };
  requestAnimationFrame(frame);
}

// ===========================================================================
// 6. Start-up and unexpected errors
// ===========================================================================

/**
 * Something unexpected went wrong in the window. Send the details to the log
 * (with Electron's "Error invoking remote method..." prefix removed) and show
 * one plain sentence instead of a broken or blank window.
 */
function reportProblem(problem: unknown): void {
  const summary = problem instanceof Error ? `${problem.name}: ${problem.message}\n${problem.stack ?? ''}` : String(problem);
  try {
    api.reportError(summary.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''));
  } catch {
    // If even reporting fails, the sentence below is still shown.
  }
  showBanner('Something went wrong in this window. Your saved work is safe - if anything looks wrong, close Secret Santa and open it again.', 'error');
}

window.addEventListener('error', (event) => reportProblem(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => reportProblem(event.reason));

async function start(): Promise<void> {
  try {
    wireUp();
    const startup = await api.load();
    if ('status' in startup) {
      showBanner(startup.message, 'error');
      return;
    }
    view = startup.view;
    fillForm();
    render();
    for (const notice of startup.notices) showBanner(notice, 'info');
    api.onFlushRequest(() => saveNow());
  } finally {
    // Tell the main process the window has drawn itself (after the next two
    // frames, so it really has been painted).
    requestAnimationFrame(() => requestAnimationFrame(() => api.ready()));
  }
}

void start().catch((error: unknown) => reportProblem(error));
