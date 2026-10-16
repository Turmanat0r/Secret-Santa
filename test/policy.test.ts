// Tests for policy.ts - the network allowlist, the Content Security Policy, request and file rules, and graphics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as policy from '../src/main/policy.ts';

const projectDir = path.resolve(import.meta.dirname, '..');
const rendererDir = path.join(projectDir, 'src', 'renderer');

test("the page's <meta> CSP is identical to the header the main process sends", () => {
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(match, 'index.html has a CSP meta tag');
  assert.equal(match[1], policy.CSP);
});

test('the CSP never lets code, styles, fonts or images come from anywhere but the app', () => {
  const directives = new Map(policy.CSP.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));
  for (const name of ['default-src', 'script-src', 'style-src', 'img-src', 'font-src']) {
    assert.deepEqual(directives.get(name), ["'self'"], name);
  }
  assert.deepEqual(directives.get('object-src'), ["'none'"]);
  assert.ok(!policy.CSP.includes('unsafe-inline') && !policy.CSP.includes('unsafe-eval'));
  assert.ok(!policy.CSP.includes('*'), 'no wildcards anywhere');
});

test('connect-src is exactly the network allowlist (empty: this app never uses the network)', () => {
  const connect = policy.CSP.split('; ').find((d) => d.startsWith('connect-src '));
  assert.deepEqual(policy.NETWORK_ALLOWLIST, []);
  assert.equal(connect, "connect-src 'none'");
});

test('only the app itself may be requested; everything else is cancelled', () => {
  assert.equal(policy.isAllowedRequest('app://secret-santa/index.html', true), true);
  assert.equal(policy.isAllowedRequest('app://secret-santa/app.js', true), true);
  assert.equal(policy.isAllowedRequest('app://evil/index.html', true), false);
  assert.equal(policy.isAllowedRequest('https://example.com/', true), false);
  assert.equal(policy.isAllowedRequest('http://127.0.0.1:8080/', true), false);
  assert.equal(policy.isAllowedRequest('file:///C:/Windows/win.ini', true), false);
  assert.equal(policy.isAllowedRequest('data:text/html,hi', true), false);
  assert.equal(policy.isAllowedRequest('wss://example.com/', true), false);
  assert.equal(policy.isAllowedRequest('devtools://devtools/bundled/x', true), false, 'no developer tools once installed');
  assert.equal(policy.isAllowedRequest('devtools://devtools/bundled/x', false), true);
  assert.equal(policy.isAllowedRequest('not a url', false), false);
});

test('the window can only ever be served its three files', () => {
  const page = policy.rendererFileFor('app://secret-santa/index.html', rendererDir);
  assert.equal(page?.file, path.join(rendererDir, 'index.html'));
  assert.equal(policy.rendererFileFor('app://secret-santa/', rendererDir)?.file, path.join(rendererDir, 'index.html'));
  assert.equal(policy.rendererFileFor('app://secret-santa/app.js', rendererDir)?.type, 'text/javascript; charset=utf-8');
  for (const sneaky of [
    'app://secret-santa/../main/main.js',
    'app://secret-santa/%2e%2e/%2e%2e/package.json',
    'app://secret-santa/app.ts',
    'app://secret-santa/tsconfig.json',
    'app://secret-santa/..%5c..%5crequirements.json',
    'app://secret-santa/constructor',
    'app://other/index.html',
    'file:///C:/dev/secret-santa/src/renderer/index.html',
  ]) {
    assert.equal(policy.rendererFileFor(sneaky, rendererDir), null, sneaky);
  }
});

test('isAppUrl recognises only the app page', () => {
  assert.equal(policy.isAppUrl(policy.PAGE_URL), true);
  assert.equal(policy.isAppUrl('https://secret-santa/'), false);
  assert.equal(policy.isAppUrl(undefined), false);
});

test("Chromium's own networking switches are all present", () => {
  const names = policy.CHROMIUM_SWITCHES.map(([name]) => name);
  for (const needed of ['disable-background-networking', 'disable-component-update', 'disable-domain-reliability', 'no-pings', 'no-proxy-server']) {
    assert.ok(names.includes(needed), needed);
  }
  const features = policy.CHROMIUM_SWITCHES.find(([name]) => name === 'disable-features')?.[1] ?? '';
  assert.ok(features.split(',').includes('DnsOverHttps'));
});

test('graphics: the most specific instruction wins', () => {
  const base = { relaunchArg: undefined, envSetting: undefined, sessionName: 'Console', saved: 'default' as const };
  assert.equal(policy.chooseGraphics(base).mode, 'default');
  assert.equal(policy.chooseGraphics({ ...base, saved: 'angle-gl' }).mode, 'angle-gl');
  assert.equal(policy.chooseGraphics({ ...base, sessionName: 'RDP-Tcp#3' }).mode, 'software', 'Remote Desktop has no GPU');
  assert.equal(policy.chooseGraphics({ ...base, sessionName: 'RDP-Tcp#3', envSetting: 'default' }).mode, 'default');
  assert.equal(policy.chooseGraphics({ ...base, envSetting: 'software', relaunchArg: 'angle-gl' }).mode, 'angle-gl');
  assert.equal(policy.chooseGraphics({ ...base, envSetting: 'nonsense' }).mode, 'default', 'invalid values are ignored');
});

test('graphics: fallbacks go from cheapest to most compatible, then stop', () => {
  assert.equal(policy.nextGraphicsMode('default'), 'angle-gl');
  assert.equal(policy.nextGraphicsMode('angle-gl'), 'software');
  assert.equal(policy.nextGraphicsMode('software'), null);
});

test('blank-window detection: flat colour is blank, anything drawn is not', () => {
  const flat = new Uint8Array(4 * 10 * 10).fill(0);
  assert.equal(policy.looksBlank(flat, 10, 10), true);
  const drawn = flat.slice();
  drawn[4 * 57 + 1] = 200;
  assert.equal(policy.looksBlank(drawn, 10, 10), false);
  assert.equal(policy.looksBlank(new Uint8Array(0), 0, 0), true, 'an empty capture counts as blank');
});
