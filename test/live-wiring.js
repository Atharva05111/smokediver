// Checks the live SmartSpectra path end to end with Chromium's fake camera
// and a deliberately invalid key: the SDK should start, receive frames and
// fail at authentication with a clear message on the mask-check screen.
//   SMARTSPECTRA_API_KEY=invalid npx electron --use-fake-device-for-media-stream test/live-wiring.js

'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
require('../main.js');

const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await app.whenReady();
  await wait(1500);
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1366, 860);
  const wc = win.webContents;
  wc.on('console-message', (_e, _level, msg) => console.log('[renderer]', msg.slice(0, 300)));
  const js = (c) => wc.executeJavaScript(c);
  await js(`document.getElementById('btn-live').click()`);
  await wait(300);
  await js(`document.getElementById('agree').click()`);
  await js(`document.getElementById('btn-consent').click()`);
  await wait(15000);
  const state = await js(`JSON.stringify((() => { const s = window.__smokediver.app.source?.state; return s && { status: s.status, validation: s.validation, error: s.error, metrics: s.metricsCount }; })())`);
  console.log('STATE', state);
  const img = await wc.capturePage();
  fs.writeFileSync(path.join(OUT, 'live-wiring.png'), img.toPNG());
  app.quit();
})().catch((e) => { console.error(e); app.exit(1); });
