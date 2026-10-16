// Graphics failures: the window going blank or the graphics process dying must
// be detected and handled - never left as a blank window with nowhere to type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { freshDataDir, launch, readEvents, readJsonFile, readLog, runToExit, survivingProcesses, waitFor } from './helpers.ts';

test('the graphics process crashing: restarts once using OpenGL, says so, and remembers it', async () => {
  const dataDir = freshDataDir('gpu-crash');
  // The restarted copy closes itself once it has drawn, so the test can finish.
  const { app, tag } = await launch(dataDir, { SECRET_SANTA_TEST_EXIT_AFTER_RELAUNCH: '1' });
  const firstPid = app.process().pid;
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  // Really kill the GPU process, as a driver crash would.
  await app.evaluate(({ app: electronApp }) => {
    const gpu = electronApp.getAppMetrics().find((m) => m.type === 'GPU');
    if (!gpu) throw new Error('no GPU process');
    process.kill(gpu.pid);
  });
  await exited;
  await waitFor(() => readEvents(dataDir).some((e) => e.kind === 'dialog' && e.pid !== firstPid), 'the restarted copy to explain', 45_000);
  const dialog = readEvents(dataDir).find((e) => e.kind === 'dialog');
  assert.equal(dialog?.message, "Secret Santa restarted using a more compatible graphics mode because the window wasn't being drawn properly. Nothing was lost.");
  const log = readLog(dataDir);
  assert.match(log, /The graphics process ended unexpectedly/);
  assert.match(log, /Restarting in graphics mode angle-gl \(gpu-crash\)/);
  assert.match(log, /Graphics: angle-gl \(restarted after a drawing failure\)/);
  await waitFor(() => survivingProcesses(tag).length === 0, 'the restarted copy to close', 30_000);
  const settings = readJsonFile(path.join(dataDir, 'settings.json')) as { graphics: string };
  assert.equal(settings.graphics, 'angle-gl', 'the mode that worked is remembered');
  // Next launch starts straight in the mode that worked, with no dialog.
  const next = await runToExit(dataDir, { SECRET_SANTA_TEST_EXIT_AFTER_READY: '1' });
  assert.equal(next.code, 0);
  assert.match(readLog(dataDir), /Graphics: angle-gl \(saved from an earlier drawing failure\)/);
});

test('a blank window: restarts with OpenGL, and if still blank offers to turn acceleration off', async () => {
  const dataDir = freshDataDir('blank');
  // The test hook genuinely hides the page, so the capture really is one flat colour.
  const first = await runToExit(dataDir, { SECRET_SANTA_TEST_BLANK_PAINT: '1', SECRET_SANTA_TEST_DIALOG_ANSWERS: 'Close', SECRET_SANTA_TEST_EXIT_AFTER_READY: '1' });
  assert.equal(first.code, 0);
  await waitFor(() => readEvents(dataDir).some((e) => e.kind === 'dialog'), 'the second dialog', 45_000);
  await waitFor(() => survivingProcesses(first.tag).length === 0, 'the restarted copy to close', 30_000);
  const log = readLog(dataDir);
  assert.match(log, /Paint check: the window is blank/);
  assert.match(log, /Restarting in graphics mode angle-gl \(blank-window\)/);
  const dialog = readEvents(dataDir).find((e) => e.kind === 'dialog');
  assert.equal(dialog?.message, "Secret Santa's window still isn't being drawn properly.");
  assert.deepEqual(dialog?.buttons, ['Restart without graphics acceleration', 'Keep this window', 'Close Secret Santa']);
  const settings = readJsonFile(path.join(dataDir, 'settings.json')) as { graphics: string };
  assert.equal(settings.graphics, 'default', 'a mode is only remembered once it has been seen to work');
});

test('a Remote Desktop session starts with software drawing, because it has no graphics card', async () => {
  const { app, dataDir } = await launch(freshDataDir('rdp'), { SESSIONNAME: 'RDP-Tcp#0' });
  try {
    const status = await app.evaluate(({ app: electronApp }) => electronApp.getGPUFeatureStatus());
    assert.match(String(status.gpu_compositing), /disabled|software/);
    assert.match(readLog(dataDir), /Graphics: software \(Remote Desktop session\)/);
  } finally {
    const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await exited;
  }
});

test('a normal start uses the graphics card', async () => {
  const { app, dataDir } = await launch(freshDataDir('gpu-normal'));
  try {
    const status = await app.evaluate(({ app: electronApp }) => electronApp.getGPUFeatureStatus());
    assert.match(String(status.gpu_compositing), /enabled/);
    assert.match(readLog(dataDir), /Graphics: default \(normal start\)/);
  } finally {
    const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await exited;
  }
});
