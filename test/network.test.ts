// The network: Secret Santa's allowlist is empty, so no connection of any kind
// may be attempted - not by the app, not by a dependency, not by Chromium on
// its own. Checked with Chromium's own network log (--log-net-log), which
// records every socket, name lookup and request the engine makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { freshDataDir, launch, networkAttempts, readEvents, runToExit } from './helpers.ts';

/** A tiny web server on this computer that counts every request it receives. */
async function countingServer(): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = http.createServer((_request, response) => {
    hits += 1;
    response.end('probe');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/probe`,
    hits: () => hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const netLogArg = (dataDir: string): [string, string] => {
  const file = path.join(dataDir, '..', `${path.basename(dataDir)}-netlog.json`);
  return [file, `--log-net-log=${file}`];
};

test('start-up and an attempt to reach a server: blocked, and no connection is ever made', async () => {
  const server = await countingServer();
  try {
    const dataDir = freshDataDir('net-blocked');
    const [netLog, arg] = netLogArg(dataDir);
    const run = await runToExit(dataDir, { SECRET_SANTA_TEST_EXIT_AFTER_READY: '1', SECRET_SANTA_TEST_PROBE_URL: server.url }, [arg]);
    assert.equal(run.code, 0);
    const probe = readEvents(dataDir).find((e) => e.kind === 'probe');
    assert.match(probe?.outcome ?? '', /ERR_BLOCKED_BY_CLIENT/, 'the session filter cancelled the request');
    assert.equal(server.hits(), 0, 'the server never heard from the app');
    assert.deepEqual(networkAttempts(netLog), [], 'Chromium attempted no connection at all');
    assert.doesNotMatch(run.stderr, /handshake|ssl_client_socket|net_error/i);
  } finally {
    await server.close();
  }
});

test('a whole working session makes no connection at all', async () => {
  const dataDir = freshDataDir('net-session');
  const [netLog, arg] = netLogArg(dataDir);
  const { app, page } = await launch(dataDir, {}, [arg]);
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  try {
    await page.fill('#names', 'Alex\nJordan\nSam\nTaylor');
    await page.click('#draw');
    await page.waitForFunction(() => document.querySelector('#setupMessage')?.textContent?.startsWith('Done!'));
    await page.click('[data-tab="wheel"]');
    await page.click('#spin');
    await page.click('[data-tab="wish"]');
    await page.click('[data-tab="challenge"]');
    await page.click('#newChallenge');
    await page.click('[data-tab="history"]');
    await page.click('#saveYear');
    const pdf = path.join(dataDir, 'slips.pdf');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
    }, pdf);
    await page.click('#saveSlipsPdf');
    await page.waitForFunction(() => document.querySelector('#resultMessage')?.textContent?.startsWith('Slips saved'));
    await page.waitForTimeout(3000); // give any background activity a chance to show itself
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await exited;
  }
  assert.deepEqual(networkAttempts(netLog), []);
});

test('the network check really sees a connection when one happens (so a pass means something)', async () => {
  // Deliberately make one real connection from a separate, unprotected session
  // (a test-only hook) and confirm both the server and the log analysis catch it.
  const server = await countingServer();
  try {
    const dataDir = freshDataDir('net-control');
    const [netLog, arg] = netLogArg(dataDir);
    const run = await runToExit(
      dataDir,
      { SECRET_SANTA_TEST_EXIT_AFTER_READY: '1', SECRET_SANTA_TEST_PROBE_URL: server.url, SECRET_SANTA_TEST_PROBE_UNFILTERED: '1' },
      [arg],
    );
    assert.equal(run.code, 0);
    assert.equal(readEvents(dataDir).find((e) => e.kind === 'probe')?.outcome, 'loaded');
    assert.ok(server.hits() >= 1, 'the server was reached');
    const attempts = networkAttempts(netLog);
    assert.ok(attempts.some((a) => a.event === 'TCP_CONNECT' || a.event === 'TCP_CONNECT_ATTEMPT'), JSON.stringify(attempts.slice(0, 5)));
    assert.ok(attempts.some((a) => a.detail.includes('127.0.0.1')));
  } finally {
    await server.close();
  }
});

test('the network-log reader handles a log cut off by an abrupt exit', () => {
  const dir = freshDataDir('net-truncated');
  const file = path.join(dir, 'cut.json');
  fs.writeFileSync(file, '{"constants":{"logEventTypes":{"TCP_CONNECT":7}},"events":[{"type":7,"params":{"address":"1.2.3.4:443"}},');
  assert.equal(networkAttempts(file).length, 1);
});
