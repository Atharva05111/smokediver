// SmokeDiver renderer: screen flow, mask check, baseline, mission, debrief.

import { LiveSource, VALIDATION_HELP } from './signals/live.js';
import { SimSource } from './signals/sim.js';
import { Mission } from './game/mission.js';
import { Sound } from './game/audio.js';
import { renderDebrief } from './debrief.js';

const $ = (id) => document.getElementById(id);
const bridge = window.smokediver;

const app = {
  config: null,
  source: null,          // LiveSource | SimSource
  mode: null,            // 'live' | 'sim'
  baseline: null,
  mission: null,
  sound: new Sound(),
  flip: false,
  runs: [],
};

// --- screens ----------------------------------------------------------------
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
  document.body.dataset.screen = id;
  if (id === 's-title') renderTally();
  if (id === 's-history') renderHistory();
}

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { stopSource(); show(go.dataset.go); }
});

// --- title ------------------------------------------------------------------
const fmtClock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const OUTCOME = { rescued: 'Casualty rescued', withdrew: 'Withdrew', outOfAir: 'Out of air' };

function renderTally() {
  const el = $('tally');
  const recent = app.runs.slice(-3).reverse();
  if (!recent.length) {
    el.innerHTML = '<div class="tally empty">No crews committed yet.<br>Your runs appear here as tally tags.</div>';
    return;
  }
  el.innerHTML = recent.map((r) => `
    <div class="tally ${r.outcome}">
      <div class="tally-name">Team 1 <span class="tally-mode">${r.source === 'sim' ? 'simulator' : 'live'}</span></div>
      <div class="tally-grid">
        <span>Time in</span><b>${fmtClock(r.date)}</b>
        <span>In at</span><b>300 bar</b>
        <span>Out at</span><b>${r.endBar} bar</b>
        <span>Inside</span><b>${fmtDur(r.durationS)}</b>
      </div>
      <div class="tally-out">${OUTCOME[r.outcome] || r.outcome} · ${r.score} pts</div>
    </div>`).join('');
}

// --- history ----------------------------------------------------------------
function renderHistory() {
  const body = $('runs-body');
  if (!app.runs.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty-row">No runs yet. Finish a mission and it shows up here.</td></tr>';
    return;
  }
  body.innerHTML = app.runs.slice().reverse().map((r) => `
    <tr>
      <td>${new Date(r.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
      <td>${r.source === 'sim' ? 'Simulator' : 'Live'}</td>
      <td>${OUTCOME[r.outcome] || r.outcome}</td>
      <td>${fmtDur(r.durationS)}</td>
      <td>${r.endBar} bar</td>
      <td>${r.avgUsageLpm} L/min</td>
      <td>${r.avgControl}</td>
      <td><b>${r.score}</b></td>
    </tr>`).join('');
}

$('btn-clear').addEventListener('click', async () => {
  if (!confirm('Delete all stored run summaries from this computer? This cannot be undone.')) return;
  await bridge.clearRuns();
  app.runs = [];
  renderHistory();
});

// --- start ------------------------------------------------------------------
$('btn-live').addEventListener('click', () => { app.sound.resume(); app.mode = 'live'; show('s-consent'); });
$('btn-sim').addEventListener('click', () => { app.sound.resume(); app.mode = 'sim'; startSource(); });
$('btn-history').addEventListener('click', () => show('s-history'));
$('btn-privacy').addEventListener('click', () => show('s-privacy'));
$('agree').addEventListener('change', (e) => { $('btn-consent').disabled = !e.target.checked; });
$('btn-consent').addEventListener('click', () => startSource());

async function startSource({ skipCalib = false } = {}) {
  await stopSource();
  const live = app.mode === 'live';
  app.source = live
    ? new LiveSource(app.config.apiKey, { breathOnly: $('opt-breath-only').checked })
    : new SimSource();
  app.source.setFlip(app.flip);
  app.skipCalib = skipCalib && !!app.baseline;
  show('s-check');
  startCheck();
  try {
    await app.source.start();
    if (!live) app.source.setAuto(true, 11);
  } catch {
    // error event already shown
  }
}

async function stopSource() {
  if (app.mission) { app.mission.destroy(); app.mission = null; }
  clearInterval(app.checkTimer);
  clearInterval(app.calibTimer);
  if (app.source) {
    const s = app.source;
    app.source = null;
    await s.stop();
  }
  for (const v of [$('preview'), $('hud-video')]) v.srcObject = null;
}

// --- mask check -------------------------------------------------------------
function startCheck() {
  const src = app.source;
  const sim = src.state.source === 'sim';
  $('preview-sim').hidden = !sim;
  $('check-error').hidden = true;
  $('check-hint').textContent = sim ? 'Simulator running. Signals come from your keyboard.' : 'Starting the camera…';
  $('btn-check-next').disabled = true;

  src.on('stream', (stream) => {
    $('preview').srcObject = stream;
    $('preview').play().catch(() => {});
    $('hud-video').srcObject = stream;
    $('hud-video').play().catch(() => {});
  });
  src.on('error', (err) => {
    const box = $('check-error');
    box.hidden = false;
    box.textContent = `${err.help}${err.code != null ? ` (code ${err.code})` : ''}`;
    $('btn-check-retry').hidden = false;
    $('check-hint').textContent = 'Camera stopped.';
  });
  // A session in the error state can't measure; release the camera right away.
  src.on('status', (status) => {
    if (status === 'error' && app.source === src) stopSource();
  });
  $('btn-check-retry').hidden = true;

  const tick = () => {
    const st = src.state;
    const v = st.validation;
    if (!sim && v.name) $('check-hint').textContent = VALIDATION_HELP[v.name] || v.hint || v.name;
    const faceOk = sim || (v.ok && v.okSince && performance.now() - v.okSince > 1500);
    const breathOk = !!st.breathingRate;
    const pulseOk = !!st.pulse || (!sim && src.breathOnly);
    mark('ck-face', faceOk);
    mark('ck-breath', breathOk, st.breathingRate ? `${st.breathingRate.value.toFixed(0)}/min` : 'waiting');
    mark('ck-pulse', pulseOk, src.breathOnly ? 'off (breathing-only mode)' : st.pulse ? `${Math.round(st.pulse.value)} bpm` : 'waiting');
    const ready = faceOk && breathOk;
    $('btn-check-next').disabled = !ready;
    if (ready && app.skipCalib) { clearInterval(app.checkTimer); show('s-brief'); renderBaseline(); }
  };
  clearInterval(app.checkTimer);
  app.checkTimer = setInterval(tick, 250);
}

function mark(id, ok, detail) {
  const li = $(id);
  li.classList.toggle('ok', !!ok);
  let d = li.querySelector('.detail');
  if (!d) { d = document.createElement('span'); d.className = 'detail'; li.appendChild(d); }
  d.textContent = detail ? ` ${detail}` : '';
}

$('btn-check-next').addEventListener('click', () => { clearInterval(app.checkTimer); startCalib(); });
$('btn-check-back').addEventListener('click', async () => { await stopSource(); show('s-title'); });
$('btn-check-retry').addEventListener('click', () => startSource({ skipCalib: !!app.baseline }));

// --- baseline ---------------------------------------------------------------
function startCalib() {
  show('s-calib');
  const src = app.source;
  const sim = src.state.source === 'sim';
  const target = sim ? 12 : 30;
  let elapsed = 0;
  const rates = [], amps = [], pulses = [];
  const ring = $('calib-ring');
  const C = 2 * Math.PI * 52;
  ring.style.strokeDasharray = `${C}`;
  $('btn-calib-next').disabled = true;
  $('btn-calib-next').textContent = 'Continue to briefing';

  const waveCv = $('calib-wave');
  const draw = () => drawWave(waveCv, src);

  clearInterval(app.calibTimer);
  app.calibTimer = setInterval(() => {
    draw();
    const st = src.state;
    if (!src.signalOk()) {
      $('calib-count').textContent = '…';
      return;
    }
    elapsed += 0.1;
    if (st.stableRate && performance.now() - st.stableRate.at < 1500) rates.push(st.stableRate.value);
    if (st.amplitude) amps.push(st.amplitude.value);
    if (st.stablePulse) pulses.push(st.stablePulse.value);
    $('calib-rate').textContent = st.breathingRate ? st.breathingRate.value.toFixed(0) : '—';
    $('calib-pulse').textContent = st.pulse ? Math.round(st.pulse.value) : src.breathOnly ? 'off' : '—';

    const left = Math.max(0, target - elapsed);
    $('calib-count').textContent = Math.ceil(left);
    ring.style.strokeDashoffset = `${C * (left / target)}`;

    const enough = rates.length > 0 || elapsed > target * 2;
    if (left <= 0 && enough) {
      clearInterval(app.calibTimer);
      app.baseline = {
        rate: median(rates) || st.breathingRate?.value || 14,
        amplitude: median(amps),
        pulse: median(pulses),
        stable: rates.length > 0,
      };
      $('calib-count').textContent = '✓';
      $('btn-calib-next').disabled = false;
    } else if (left <= 0) {
      $('calib-count').textContent = '…';
      $('btn-calib-next').textContent = 'Waiting for a steady breathing reading';
    }
  }, 100);
}

$('btn-flip').addEventListener('click', () => {
  app.flip = !app.flip;
  if (app.source) app.source.setFlip(app.flip);
});
$('btn-calib-next').addEventListener('click', () => { show('s-brief'); renderBaseline(); });
$('btn-recalib').addEventListener('click', () => startCalib());

function renderBaseline() {
  const b = app.baseline;
  if (!b) { $('baseline-line').textContent = ''; return; }
  const parts = [`Your baseline: ${b.rate.toFixed(0)} breaths/min`];
  if (b.pulse) parts.push(`pulse ${Math.round(b.pulse)} bpm`);
  $('baseline-line').textContent = parts.join(', ') + '. The cylinder drains faster as you breathe faster or deeper than this.';
}

// --- mission ----------------------------------------------------------------
$('btn-go').addEventListener('click', () => {
  if (!app.source) return startSource({ skipCalib: true });
  show('s-mission');
  app.sound.resume();
  const sim = app.source.state.source === 'sim';
  if (sim) app.source.setAuto(false);
  $('hud-source').textContent = sim
    ? 'Simulator: hold Space to breathe in, V to talk, B for auto-breathing'
    : 'Live from your camera · Presage SmartSpectra';
  document.body.classList.toggle('sim', sim);
  app.mission = new Mission({
    canvas: $('world'),
    signals: app.source,
    sound: app.sound,
    baseline: app.baseline,
    hud: {
      gauge: $('h-gauge'), whistleIn: $('h-whistle-in'), whistleRow: $('h-whistle-row'), whistleLabel: $('h-whistle-label'),
      usage: $('h-usage'), rate: $('h-rate'), controlBar: $('h-control-bar'), controlValue: $('h-control-value'),
      wave: $('h-wave'), pulse: $('h-pulse'), talkLamp: $('h-talk'), clock: $('h-clock'), objective: $('h-objective'),
      radio: $('h-radio'), radioPrompt: $('h-radio-prompt'), radioLine: $('h-radio-line'), radioMeter: $('h-radio-meter'),
      radioTimer: $('h-radio-timer'), pause: $('h-pause'), pauseHint: $('h-pause-hint'), muteLabel: $('h-mute'),
    },
    onEnd: (result) => endMission(result),
  });
  app.mission.start();
});

async function endMission(result) {
  app.mission = null;
  const previous = app.runs.slice();
  // Stop measuring as soon as the mission ends.
  await stopSource();
  try { await bridge.saveRun(result); } catch (e) { console.error(e); }
  app.runs.push(result);
  show('s-debrief');
  renderDebrief(result, previous);
}

$('btn-again').addEventListener('click', () => startSource({ skipCalib: true }));

// --- helpers ----------------------------------------------------------------
function median(arr) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

function drawWave(cv, src) {
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const tr = src.state.trace;
  if (tr.length < 2) return;
  const tEnd = tr[tr.length - 1].t, span = 15;
  let lo = Infinity, hi = -Infinity;
  for (const q of tr) if (q.t > tEnd - span) { lo = Math.min(lo, q.v); hi = Math.max(hi, q.v); }
  if (!(hi > lo)) return;
  const pol = src.phaseTracker.effectivePolarity;
  ctx.lineWidth = 3;
  ctx.strokeStyle = src.state.phase === 'inhale' ? '#7fd3ff' : '#e9edf0';
  ctx.beginPath();
  let first = true;
  for (const q of tr) {
    if (q.t < tEnd - span) continue;
    const x = ((q.t - (tEnd - span)) / span) * w;
    let n = (q.v - lo) / (hi - lo);
    if (pol < 0) n = 1 - n;
    const y = h - 6 - n * (h - 12);
    if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// Exposed for automated screenshot tests only.
window.__smokediver = { app, show, startSource };

// --- boot -------------------------------------------------------------------
(async function boot() {
  app.config = (await bridge.getConfig()) || {};
  app.runs = (await bridge.loadRuns()) || [];
  if (!app.config.hasKey) {
    $('btn-live').disabled = true;
    $('key-note').hidden = false;
  }
  show('s-title');
  if (app.config.simFlag) {
    app.mode = 'sim';
    startSource();
  }
})();

window.addEventListener('beforeunload', () => { stopSource(); });
