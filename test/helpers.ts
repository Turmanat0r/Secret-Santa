// Shared helpers for the tests that run the real app: launching it, reading
// what it recorded, finding its processes, and checking Chromium's network log.
// (Not a test file itself - only files ending .test.ts are run.)

import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright-core';
import type { ElectronApplication, Page } from 'playwright-core';
import type { SantaApi } from '../src/shared/types.js';

// Code the tests run inside the window can use window.santa, as the app does.
declare global {
  interface Window {
    santa: SantaApi;
  }
}

export const projectDir = path.resolve(import.meta.dirname, '..');
export const electronPath = createRequire(import.meta.url)('electron') as string;

/** A new, empty data folder for one run of the app. */
export function freshDataDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-${label}-`));
}

/**
 * The environment to start the app with. Anything inherited that would change
 * how Electron starts is removed - in particular ELECTRON_RUN_AS_NODE, which
 * editors such as VS Code set for the programs they launch and which would
 * make Electron run as plain Node with no window.
 */
export function appEnv(dataDir: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('SECRET_SANTA_')) continue;
    env[key] = value;
  }
  return { ...env, SECRET_SANTA_TEST: '1', SECRET_SANTA_DATA_DIR: dataDir, ...extra };
}

/** A unique marker added to the command line so a run's processes can be found later. */
export function runTag(): string {
  return `--ss-test-run=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
  tag: string;
  stderr: () => string;
}

/** Start the app under Playwright's control and wait for its window to be ready. */
export async function launch(dataDir: string, extraEnv: Record<string, string> = {}, extraArgs: string[] = []): Promise<Launched> {
  const tag = runTag();
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [projectDir, tag, ...extraArgs],
    env: appEnv(dataDir, extraEnv),
    timeout: 60_000,
  });
  let stderr = '';
  app.process().stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.querySelector('#count')?.textContent?.includes('participant'));
  await waitFor(() => readLog(dataDir).includes('Paint check:'), 'the paint check', 20_000);
  return { app, page, dataDir, tag, stderr: () => stderr };
}

/** Start the app directly (not under Playwright) and wait for it to exit by itself. */
export function runToExit(
  dataDir: string,
  extraEnv: Record<string, string>,
  extraArgs: string[] = [],
  timeoutMs = 60_000,
): Promise<{ code: number | null; stderr: string; tag: string }> {
  const tag = runTag();
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [projectDir, tag, ...extraArgs], { env: appEnv(dataDir, extraEnv), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`The app did not exit within ${timeoutMs} ms. stderr:\n${stderr}`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, tag });
    });
  });
}

/** Wait until `check` is true, or fail with a readable message. */
export async function waitFor(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export function readLog(dataDir: string): string {
  try {
    return fs.readFileSync(path.join(dataDir, 'logs', 'main.log'), 'utf8');
  } catch {
    return '';
  }
}

export interface TestEvent {
  kind: string;
  pid: number;
  message?: string;
  answered?: string | null;
  buttons?: string[];
  outcome?: string;
  [key: string]: unknown;
}

/** What the app recorded through its test hooks (dialogs shown, probes made). */
export function readEvents(dataDir: string): TestEvent[] {
  try {
    return fs
      .readFileSync(path.join(dataDir, 'test-events.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as TestEvent);
  } catch {
    return [];
  }
}

export function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

interface ProcessInfo {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  CommandLine: string | null;
}

/** Every running process, from Windows' own process list. */
export function allProcesses(): ProcessInfo[] {
  const json = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(json) as ProcessInfo | ProcessInfo[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Processes still alive that belong to one run: the main process (found by its
 * command-line marker or pid) and anything it started (GPU, window, utility).
 */
export function survivingProcesses(tag: string, mainPid?: number): ProcessInfo[] {
  const all = allProcesses().filter((p) => p.Name.toLowerCase() === 'electron.exe');
  // Main processes: anything carrying this run's marker, plus the pid we were given.
  const mains = new Set(all.filter((p) => p.CommandLine?.includes(tag)).map((p) => p.ProcessId));
  if (mainPid !== undefined) mains.add(mainPid);
  // Children keep their parent's pid even after the parent has gone, so an
  // orphan left behind by a main process is still found.
  return all.filter((p) => mains.has(p.ProcessId) || mains.has(p.ParentProcessId));
}

// ---------------------------------------------------------------------------
// Chromium's network log
// ---------------------------------------------------------------------------

/** Event types in a NetLog that mean the program reached for the network. */
const CONNECTION_EVENTS = [
  'TCP_CONNECT',
  'TCP_CONNECT_ATTEMPT',
  'UDP_CONNECT',
  'SSL_CONNECT',
  'QUIC_SESSION',
  'HOST_RESOLVER_MANAGER_REQUEST',
  'HOST_RESOLVER_IMPL_REQUEST',
  'DNS_TRANSACTION',
  'SOCKET_POOL_CONNECT_JOB',
  'TRANSPORT_CONNECT_JOB_CONNECT',
  'HTTP_STREAM_JOB',
  'WEBSOCKET_STREAM_REQUEST',
];

export interface NetFinding {
  event: string;
  detail: string;
}

/**
 * Read a Chromium NetLog (written with --log-net-log) and list every attempt
 * to reach the network: socket connections, name lookups, and any request
 * for an address that isn't on `allowedOrigins` or the app's own app:// page.
 * The allowlist for this app is empty, so any connection at all is a finding.
 */
export function networkAttempts(netLogFile: string, allowedOrigins: readonly string[] = []): NetFinding[] {
  let text = fs.readFileSync(netLogFile, 'utf8').trim();
  // A log cut off by an abrupt exit lacks its closing brackets; add them.
  if (!text.endsWith('}')) text = `${text.replace(/,\s*$/, '')}]}`;
  const log = JSON.parse(text) as {
    constants: { logEventTypes: Record<string, number> };
    events: Array<{ type: number; params?: Record<string, unknown> }>;
  };
  const nameOf = new Map(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]));
  const findings: NetFinding[] = [];
  for (const event of log.events) {
    const name = nameOf.get(event.type) ?? `type ${event.type}`;
    const params = event.params ?? {};
    if (CONNECTION_EVENTS.includes(name)) {
      findings.push({ event: name, detail: JSON.stringify(params).slice(0, 300) });
      continue;
    }
    const url = typeof params.url === 'string' ? params.url : null;
    if (url && /^(https?|wss?|ftp):/i.test(url)) {
      const origin = new URL(url).origin;
      if (!allowedOrigins.includes(origin)) findings.push({ event: name, detail: url });
    }
  }
  return findings;
}
