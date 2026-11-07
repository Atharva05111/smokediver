// Automated walkthrough in simulator mode: drives every screen and saves
// screenshots. Run with:  npx electron test/shoot.js  (xvfb-run on Linux CI)

'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

process.env.SMOKEDIVER_SIM = '0';
require('../main.js');

const OUT = process.env.SHOT_DIR || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  await app.whenReady();
  await wait(1500);
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1366, 860);
  const wc = win.webContents;
  wc.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('[renderer]', msg); });
  const js = (code) => wc.executeJavaScript(code);
  const shot = async (name) => {
    await wait(250);
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    console.log('shot', name);
  };
  const click = (id) => js(`document.getElementById('${id}').click()`);
  const key = (code, type = 'keydown') => js(`window.dispatchEvent(new KeyboardEvent('${type}', { code: '${code}' }))`);

  await shot('01-title');
  await click('btn-privacy'); await shot('02-privacy');
  await js(`document.querySelector('#s-privacy [data-go]').click()`);
  await click('btn-live');
  await shot('03-consent');
  await js(`document.querySelector('#s-consent [data-go]').click()`);

  await click('btn-sim');
  await wait(14000);
  await shot('04-check');
  await click('btn-check-next');
  await wait(6000);
  await shot('05-calib');
  await wait(8000);
  await click('btn-calib-next');
  await shot('06-brief');

  await click('btn-go');
  await js(`window.__smokediver.app.source.setAuto(true, 13)`);
  await wait(2500);
  await shot('07-mission-radio');
  await js(`window.__smokediver.app.source.setTalking(true)`);
  await wait(1800);
  await js(`window.__smokediver.app.source.setTalking(false)`);
  // Walk right along the bottom aisle for a few seconds.
  await key('KeyD'); await wait(3500); await key('KeyD', 'keyup');
  await key('KeyW'); await wait(1200); await key('KeyW', 'keyup');
  await shot('08-mission-moving');

  // Teleport to the casualty, pick up, report.
  await js(`(() => { const m = window.__smokediver.app.mission; const c = m.map.casualty; m.player.x = c.x + 0.6; m.player.y = c.y + 0.4; })()`);
  await wait(400);
  await key('KeyE'); await key('KeyE', 'keyup');
  await wait(600);
  await shot('09-casualty');
  await js(`window.__smokediver.app.source.setTalking(true)`);
  await wait(1800);
  await js(`window.__smokediver.app.source.setTalking(false)`);
  // Burn air to show the whistle.
  await js(`window.__smokediver.app.mission.air.pressure = 58`);
  await wait(2500);
  await shot('10-whistle');
  await js(`(() => { const m = window.__smokediver.app.mission; const e = m.map.entry; m.player.x = e.x + 0.5; m.player.y = e.y - 0.3; })()`);
  await wait(300);
  await key('KeyE'); await key('KeyE', 'keyup');
  await wait(1500);
  await shot('11-debrief');
  await click('btn-history') .catch(() => {});
  await js(`window.__smokediver.show('s-history')`);
  await shot('12-history');
  await js(`window.__smokediver.show('s-title')`);
  await shot('13-title-after');
  app.quit();
}

run().catch((e) => { console.error(e); app.exit(1); });
