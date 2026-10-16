// Types shared by the main process and the window.
//
// This file holds declarations only - no runtime code - so both TypeScript
// projects can include it without either one owning it, and without the
// window ever being able to import anything that runs in the main process.

/** The free-text details about this year's exchange. */
export interface ExchangeDetails {
  eventName: string;
  budget: string;
  /** "YYYY-MM-DD", or "" when no date has been picked. */
  eventDate: string;
  giftNote: string;
}

/** The two switches that change how the draw is made. */
export interface ExchangeOptions {
  /** Stop two people drawing each other (A gives to B and B gives to A). */
  noTwoWay: boolean;
  /** Avoid repeating a giver -> recipient pair from any saved previous year. */
  avoidPrevious: boolean;
}

/** Two people who must not draw each other, in either direction. "" = not chosen yet. */
export type KeepApartRule = [string, string];

/** The most recent draw: who gives to whom. */
export interface CurrentDraw {
  /** The names, in order, exactly as they were when the draw was made. */
  participants: string[];
  /** giver -> recipient */
  assignments: Record<string, string>;
  /** ISO date-time the draw was made. */
  drawnAt: string;
}

/** A draw saved into "Previous years". */
export interface PastExchange {
  id: string;
  name: string;
  date: string;
  assignments: Record<string, string>;
}

/** Everything the app saves: one Secret Santa exchange plus its history. */
export interface Exchange {
  format: 'secret-santa-desktop';
  version: 1;
  /** ISO date-time of the last save. */
  savedAt: string;
  /** The names box exactly as typed, one name per line. */
  namesText: string;
  details: ExchangeDetails;
  options: ExchangeOptions;
  keepApart: KeepApartRule[];
  draw: CurrentDraw | null;
  history: PastExchange[];
  /** person -> their gift clues */
  wishes: Record<string, string>;
}

/** A change the window asks to make. Any field left out stays as it is. */
export interface ExchangePatch {
  namesText?: string;
  details?: ExchangeDetails;
  options?: ExchangeOptions;
  keepApart?: KeepApartRule[];
  wishes?: Record<string, string>;
}

/** What the window draws from: the saved exchange plus facts worked out from it. */
export interface AppView {
  exchange: Exchange;
  /** The names box turned into a clean list (trimmed, blank lines and repeats removed). */
  names: string[];
  /** True when the names have changed since the current draw was made. */
  drawIsStale: boolean;
}

/** The answer to anything that changes the exchange. */
export type ActionResult =
  | { status: 'done'; view: AppView; message?: string }
  | { status: 'canceled' }
  | { status: 'failed'; message: string };

/** The answer to anything that doesn't change the exchange (printing, copying, exporting). */
export type Outcome =
  | { status: 'done'; message?: string }
  | { status: 'canceled' }
  | { status: 'failed'; message: string };

/** What the window gets when it first opens. */
export interface StartupInfo {
  view: AppView;
  /** Plain sentences about anything that was reset or restored while opening. */
  notices: string[];
}

/**
 * The whole of what the window is allowed to ask the main process to do.
 * Exposed as `window.santa` by the preload script. Nothing else crosses over.
 */
export interface SantaApi {
  load(): Promise<StartupInfo | { status: 'failed'; message: string }>;
  update(patch: ExchangePatch): Promise<ActionResult>;
  draw(): Promise<ActionResult>;
  clearNames(): Promise<ActionResult>;
  saveYear(): Promise<ActionResult>;
  removeYear(id: string): Promise<ActionResult>;
  clearHistory(): Promise<ActionResult>;
  importNames(): Promise<ActionResult>;
  importBackup(): Promise<ActionResult>;
  exportBackup(): Promise<Outcome>;
  printSlips(): Promise<Outcome>;
  saveSlipsPdf(): Promise<Outcome>;
  copyText(text: string): Promise<Outcome>;
  openDataFolder(): Promise<Outcome>;
  /** Tell the main process the window has drawn itself. */
  ready(): void;
  /** Send a short description of an unexpected error to the log file. */
  reportError(summary: string): void;
  /** Register the function that saves any unsaved typing when the app is closing. */
  onFlushRequest(handler: () => Promise<void>): void;
}
