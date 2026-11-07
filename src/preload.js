// src/preload.js — bundled by esbuild into dist/preload.js so it runs in a
// sandboxed preload (which cannot require node_modules at runtime).

'use strict';

// Presage's bridge: exposes window.__smartspectraBridge for the renderer SDK.
require('@smartspectra/node-sdk/preload');

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smokediver', {
  getConfig: () => ipcRenderer.invoke('smokediver:config'),
  loadRuns: () => ipcRenderer.invoke('smokediver:loadRuns'),
  saveRun: (run) => ipcRenderer.invoke('smokediver:saveRun', run),
  clearRuns: () => ipcRenderer.invoke('smokediver:clearRuns'),
  openExternal: (url) => ipcRenderer.invoke('smokediver:openExternal', url),
});
