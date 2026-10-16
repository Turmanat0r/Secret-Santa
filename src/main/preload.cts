// preload.cts - the one bridge between the window and the main process.
//
// It runs in Electron's sandbox, where the only things it can reach are
// contextBridge and ipcRenderer. It hands the window one small, named API -
// `window.santa` - and nothing else: no ipcRenderer, no require, no process.
// Every value the window sends is checked again in the main process, because
// the window is treated as untrusted.
//
// The file is CommonJS (.cts -> .cjs) because sandboxed preload scripts can't
// be ES modules.

import type { SantaApi } from '../shared/types.js';

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

let flushHandlerRegistered = false;

const api: SantaApi = {
  load: () => ipcRenderer.invoke('ss:load'),
  update: (patch) => ipcRenderer.invoke('ss:update', patch),
  draw: () => ipcRenderer.invoke('ss:draw'),
  clearNames: () => ipcRenderer.invoke('ss:clear-names'),
  saveYear: () => ipcRenderer.invoke('ss:save-year'),
  removeYear: (id) => ipcRenderer.invoke('ss:remove-year', id),
  clearHistory: () => ipcRenderer.invoke('ss:clear-history'),
  importNames: () => ipcRenderer.invoke('ss:import-names'),
  importBackup: () => ipcRenderer.invoke('ss:import-backup'),
  exportBackup: () => ipcRenderer.invoke('ss:export-backup'),
  printSlips: () => ipcRenderer.invoke('ss:print-slips'),
  saveSlipsPdf: () => ipcRenderer.invoke('ss:save-slips-pdf'),
  copyText: (text) => ipcRenderer.invoke('ss:copy-text', text),
  openDataFolder: () => ipcRenderer.invoke('ss:open-data-folder'),
  ready: () => ipcRenderer.send('ss:ready'),
  reportError: (summary) => ipcRenderer.send('ss:report-error', String(summary).slice(0, 2000)),
  onFlushRequest: (handler) => {
    // Only the first registration counts, so nothing loaded later can replace it.
    if (flushHandlerRegistered) return;
    flushHandlerRegistered = true;
    ipcRenderer.on('ss:flush', () => {
      Promise.resolve()
        .then(handler)
        .catch(() => undefined)
        .finally(() => ipcRenderer.send('ss:flushed'));
    });
  },
};

contextBridge.exposeInMainWorld('santa', api);
