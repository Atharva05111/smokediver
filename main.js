// main.js — Electron main process for SmokeDiver.
//
// Responsibilities:
//   1. Load the Presage API key from .env (never bundled into the renderer source).
//   2. Bind the SmartSpectra IPC bridge so the renderer-side SDK can run.
//   3. Grant camera-only permission to our own bundled page.
//   4. Store run summaries (numbers only, never video) in the user's app-data folder.

'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, session, ipcMain, shell } = require('electron');

// Packaged builds ship the native runtime as an extra resource (see Presage's
// electron-quickstart). Must be set before the SDK binding is required.
if (app.isPackaged && !process.env.SMARTSPECTRA_CAPI_PATH) {
  const LIB = {
    darwin: 'libsmartspectra_capi.dylib',
    win32: 'smartspectra_capi.dll',
    linux: 'libsmartspectra_capi.so',
  }[process.platform];
  if (LIB) process.env.SMARTSPECTRA_CAPI_PATH = path.join(process.resourcesPath, 'smartspectra', LIB);
}

const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');

const SIM_FLAG = process.argv.includes('--sim') || process.env.SMOKEDIVER_SIM === '1';
const DIAGNOSTICS = process.env.SMARTSPECTRA_DIAGNOSTICS === '1';

// --- .env loading (tiny parser, no dependency) -------------------------------
function loadEnvFile() {
  const candidates = [
    path.join(app.getAppPath(), '.env'),
    path.join(process.cwd(), '.env'),
    path.join(path.dirname(app.getPath('exe')), '.env'),
  ];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!m || line.trim().startsWith('#')) continue;
        const value = m[2].replace(/^["']|["']$/g, '');
        if (!(m[1] in process.env)) process.env[m[1]] = value;
      }
      return file;
    } catch { /* try next */ }
  }
  return null;
}
loadEnvFile();

// --- Run history: summaries only, stored locally ----------------------------
const runsFile = () => path.join(app.getPath('userData'), 'runs.json');

function readRuns() {
  try { return JSON.parse(fs.readFileSync(runsFile(), 'utf8')); } catch { return []; }
}

function writeRuns(runs) {
  fs.mkdirSync(path.dirname(runsFile()), { recursive: true });
  fs.writeFileSync(runsFile(), JSON.stringify(runs.slice(-50), null, 2));
}

let mainWindow = null;

function fromOurWindow(event) {
  return mainWindow && event.sender === mainWindow.webContents;
}

ipcMain.handle('smokediver:config', (event) => {
  if (!fromOurWindow(event)) return null;
  const apiKey = (process.env.SMARTSPECTRA_API_KEY || '').trim();
  return {
    apiKey,
    hasKey: apiKey.length > 0 && apiKey !== 'paste-your-key-here',
    simFlag: SIM_FLAG,
    diagnostics: DIAGNOSTICS,
    platform: process.platform,
    version: app.getVersion(),
  };
});

ipcMain.handle('smokediver:loadRuns', (event) => (fromOurWindow(event) ? readRuns() : []));

ipcMain.handle('smokediver:saveRun', (event, run) => {
  if (!fromOurWindow(event) || typeof run !== 'object' || run === null) return false;
  const runs = readRuns();
  runs.push(run);
  writeRuns(runs);
  return true;
});

ipcMain.handle('smokediver:clearRuns', (event) => {
  if (!fromOurWindow(event)) return false;
  try { fs.unlinkSync(runsFile()); } catch { /* nothing stored */ }
  return true;
});

ipcMain.handle('smokediver:openExternal', (event, url) => {
  if (!fromOurWindow(event)) return false;
  const allowed = ['https://physiology.presagetech.com', 'https://smartspectra.presagetech.com', 'https://github.com'];
  if (typeof url === 'string' && allowed.some((a) => url.startsWith(a))) shell.openExternal(url);
  return true;
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#20262e',
    title: 'SmokeDiver',
    autoHideMenuBar: true,
    webPreferences: {
      // Our preload bundles Presage's preload bridge plus a small SmokeDiver API.
      preload: path.join(__dirname, 'dist', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  bindSmartSpectraIpc(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  if (DIAGNOSTICS) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  // Camera only, and only for our own bundled page. Microphone is never granted:
  // talking is detected visually by SmartSpectra, so no audio is captured.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    const mediaTypes = (details && details.mediaTypes) || [];
    const cameraOnly = mediaTypes.length === 1 && mediaTypes[0] === 'video';
    callback(permission === 'media' && cameraOnly && url.startsWith('file://'));
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
