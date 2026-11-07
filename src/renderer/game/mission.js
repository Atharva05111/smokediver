// The mission: search a smoke-filled warehouse, find the casualty, report
// to entry control by radio, and get out before your air does.

import { buildMap, TILE } from './map.js';
import { AirModel, CYLINDER, breathControl } from './air.js';
import { Gauge } from './gauge.js';
import { VALIDATION_HELP } from '../signals/live.js';

const SPEED = 1.9;            // tiles/s
const CARRY_SPEED = 1.05;
const RADIUS = 0.3;           // player radius in tiles
const SIGHT = 4.4;            // torch reach in tiles
const REPORT_WINDOW = 22;     // seconds to answer a radio call
const REPORT_TALK = 1.3;      // seconds of detected talking to count as a report

const fmt = (s) => {
  if (s == null || !Number.isFinite(s)) return '—';
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export class Mission {
  constructor({ canvas, hud, signals, sound, baseline, onEnd, rng = Math.random }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hud = hud;
    this.sig = signals;
    this.sound = sound;
    this.onEnd = onEnd;
    this.map = buildMap(rng);
    this.air = new AirModel(baseline);
    this.gauge = new Gauge(hud.gauge);

    const e = this.map.entry;
    this.player = { x: e.x + 0.6, y: e.y - 0.6, dir: -Math.PI / 4, carrying: false };
    this.seen = new Float32Array(this.map.w * this.map.h);
    this.trail = [{ x: e.x, y: e.y }];
    this.keys = new Set();
    this.t = 0;
    this.running = false;
    this.paused = false;
    this.pauseReason = '';
    this.casualtyFound = false;
    this.reports = [];
    this.activeReport = null;
    this.reportQueue = [];
    this.checkpointsDone = new Set();
    this.events = [];
    this.samples = [];
    this.sampleClock = 0;
    this.controlSum = 0;
    this.controlN = 0;
    this.peakRate = 0;
    this.minBar = CYLINDER.full;
    this.whistleAt = null;
    this.confirmWithdraw = false;
    this.mist = 0;               // mask condensation 0..1
    this.mistTarget = 0;
    this.pulseFlash = 0;
    this.smoke = this._makeSmoke();
    this.staticLayer = this._renderStatic();
    this.fog = document.createElement('canvas');

    this._onKey = this._onKey.bind(this);
    this._frame = this._frame.bind(this);
    this.unsub = [
      this.sig.on('phase', (phase) => {
        if (!this.running || this.paused) return;
        if (phase === 'inhale') {
          const amp = this.sig.state.amplitude?.value;
          const base = this.air.baseline.amplitude;
          this.sound.inhale(amp && base ? amp / base : 1);
          this.mistTarget = 0;
        } else {
          this.sound.exhale();
          this.mistTarget = 1;
        }
      }),
    ];
  }

  start() {
    this.running = true;
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKey);
    this._log('Entered the building');
    this._radioCall('entry', 'Entry control: "Team 1, confirm your starting pressure."',
      () => `Say: "Team 1, ${Math.round(this.air.pressure)} bar, going in."`);
    this.last = performance.now();
    requestAnimationFrame(this._frame);
  }

  destroy() {
    this.running = false;
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKey);
    for (const u of this.unsub) u();
    this.sound.stopAll();
  }

  // --- input ---------------------------------------------------------------
  _onKey(e) {
    const down = e.type === 'keydown';
    const k = e.code;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(k)) {
      e.preventDefault();
      if (down) this.keys.add(k); else this.keys.delete(k);
    }
    if (!down || e.repeat) return;
    if (k === 'KeyE') this._interact();
    if (k === 'KeyM') this.hud.muteLabel.textContent = this.sound.toggleMute() ? 'Sound off' : 'Sound on';
    if (k === 'Escape' && this.confirmWithdraw) this.confirmWithdraw = false;
  }

  _interact() {
    const p = this.player;
    const c = this.map.casualty;
    if (!p.carrying && Math.hypot(p.x - c.x, p.y - c.y) < 1.3) {
      p.carrying = true;
      this.casualtyFound = true;
      this._log('Casualty found');
      this._radioCall('casualty', 'Casualty found. Tell entry control.',
        () => `Say: "Team 1, casualty found in ${c.roomName}, ${Math.round(this.air.pressure)} bar, coming out."`);
      return;
    }
    if (this._atExit()) {
      if (p.carrying) this._finish('rescued');
      else if (this.confirmWithdraw) this._finish('withdrew');
      else this.confirmWithdraw = true;
    }
  }

  _atExit() {
    const e = this.map.entry;
    return Math.hypot(this.player.x - e.x, this.player.y - e.y) < 1.4;
  }

  // --- radio ---------------------------------------------------------------
  _radioCall(id, prompt, line) {
    const r = { id, prompt, line, talked: 0, elapsed: 0 };
    if (this.activeReport) this.reportQueue.push(r);
    else { this.activeReport = r; this.sound.radio('open'); }
  }

  _updateRadio(dt) {
    const r = this.activeReport;
    if (!r) return;
    r.elapsed += dt;
    if (this.sig.state.talking?.detected) r.talked += dt;
    if (r.talked >= REPORT_TALK || r.elapsed >= REPORT_WINDOW) {
      const ok = r.talked >= REPORT_TALK;
      this.reports.push({ id: r.id, ok, bar: Math.round(this.air.pressure), t: Math.round(this.t) });
      this._log(ok ? `Radio report received (${Math.round(this.air.pressure)} bar)` : 'Radio report missed');
      this.sound.radio(ok ? 'ok' : 'fail');
      this.lastRadioResult = { ok, at: this.t };
      this.activeReport = this.reportQueue.shift() || null;
      if (this.activeReport) this.sound.radio('open');
    }
  }

  // --- loop ----------------------------------------------------------------
  _frame(now) {
    if (!this.running) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;

    const ok = this.sig.signalOk();
    this.paused = !ok;
    if (!ok) {
      const v = this.sig.state.validation;
      this.pauseReason = VALIDATION_HELP[v.name] || v.hint || '';
      this.sound.exhaleEnd();
    } else {
      this._update(dt);
    }
    this._render(dt);
    this._updateHud(dt);
    if (this.running) requestAnimationFrame(this._frame);
  }

  _update(dt) {
    this.t += dt;
    const st = this.sig.state;

    this.air.update(dt, this.sig);
    this.minBar = Math.min(this.minBar, this.air.pressure);

    if (this.air.whistled && this.whistleAt == null) {
      this.whistleAt = this.t;
      this.sound.whistleOn();
      this._log('Low-pressure whistle');
      this._radioCall('whistle', 'Your whistle is sounding. Tell entry control you are withdrawing.',
        () => 'Say: "Team 1, whistle sounding, withdrawing now."');
    }
    if (this.air.empty) { this._finish('outOfAir'); return; }

    // Movement
    const p = this.player;
    let dx = 0, dy = 0;
    if (this.keys.has('ArrowLeft') || this.keys.has('KeyA')) dx -= 1;
    if (this.keys.has('ArrowRight') || this.keys.has('KeyD')) dx += 1;
    if (this.keys.has('ArrowUp') || this.keys.has('KeyW')) dy -= 1;
    if (this.keys.has('ArrowDown') || this.keys.has('KeyS')) dy += 1;
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      const sp = (p.carrying ? CARRY_SPEED : SPEED) * dt;
      this._move((dx / len) * sp, 0);
      this._move(0, (dy / len) * sp);
      p.dir = Math.atan2(dy, dx);
      const lastT = this.trail[this.trail.length - 1];
      if (Math.hypot(lastT.x - p.x, lastT.y - p.y) > 0.4) this.trail.push({ x: p.x, y: p.y });
      if (this.confirmWithdraw && !this._atExit()) this.confirmWithdraw = false;
    }

    // Reveal what the torch touches.
    const { w, h } = this.map;
    const r = Math.ceil(SIGHT);
    for (let y = Math.max(0, Math.floor(p.y) - r); y <= Math.min(h - 1, Math.floor(p.y) + r); y++) {
      for (let x = Math.max(0, Math.floor(p.x) - r); x <= Math.min(w - 1, Math.floor(p.x) + r); x++) {
        const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y);
        if (d < SIGHT) this.seen[y * w + x] = Math.max(this.seen[y * w + x], 1 - d / SIGHT);
      }
    }

    // Radio checkpoints
    for (const c of this.map.checkpoints) {
      if (!this.checkpointsDone.has(c.id) && Math.hypot(p.x - c.x, p.y - c.y) < 1.8) {
        this.checkpointsDone.add(c.id);
        this._radioCall(c.id, `You've reached ${c.label}. Give entry control a pressure check.`,
          () => `Say: "Team 1, ${Math.round(this.air.pressure)} bar, searching ${c.label}."`);
      }
    }
    this._updateRadio(dt);

    // Breath technique and once-a-second samples for the debrief.
    const rate = st.stableRate?.value ?? st.breathingRate?.value ?? null;
    const control = breathControl(rate, this.sig.ieRatio());
    this.control = control;
    this.controlSum += control * dt;
    this.controlN += dt;
    if (rate) this.peakRate = Math.max(this.peakRate, rate);
    this.sampleClock += dt;
    if (this.sampleClock >= 1) {
      this.sampleClock = 0;
      this.samples.push({
        t: Math.round(this.t),
        bar: Math.round(this.air.pressure),
        rate: rate ? +rate.toFixed(1) : null,
        lpm: Math.round(this.air.usageLpm),
        control,
        pulse: st.stablePulse ? Math.round(st.stablePulse.value) : null,
        talking: !!st.talking?.detected,
      });
    }

    this.mist += (this.mistTarget - this.mist) * Math.min(1, dt * (this.mistTarget > this.mist ? 4 : 1.6));
    if (this.mistTarget > 0 && performance.now() - st.phaseAt > 2200) this.mistTarget = 0;

    const pulse = st.stablePulse?.value || st.pulse?.value;
    if (pulse) this.sound.setHeartRate(pulse);
  }

  _move(dx, dy) {
    const p = this.player;
    const nx = p.x + dx, ny = p.y + dy;
    const m = this.map;
    const minX = Math.floor(nx - RADIUS), maxX = Math.floor(nx + RADIUS);
    const minY = Math.floor(ny - RADIUS), maxY = Math.floor(ny + RADIUS);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (m.isSolid(x, y)) return;
    p.x = nx; p.y = ny;
  }

  _log(label) { this.events.push({ t: Math.round(this.t), label }); }

  _finish(outcome) {
    if (!this.running) return;
    this.running = false;
    this.sound.stopAll();
    this._log(outcome === 'rescued' ? 'Exited with casualty' : outcome === 'withdrew' ? 'Withdrew without casualty' : 'Cylinder empty');
    if (this.activeReport) this.reports.push({ id: this.activeReport.id, ok: false, bar: Math.round(this.air.pressure), t: Math.round(this.t) });
    const result = {
      outcome,
      source: this.sig.state.source,
      date: new Date().toISOString(),
      durationS: Math.round(this.t),
      endBar: Math.round(this.air.pressure),
      minBar: Math.round(this.minBar),
      whistleAtS: this.whistleAt != null ? Math.round(this.whistleAt) : null,
      avgUsageLpm: this.t > 0 ? Math.round((this.air.totalLitres / this.t) * 60) : 0,
      totalLitres: Math.round(this.air.totalLitres),
      avgControl: this.controlN > 0 ? Math.round(this.controlSum / this.controlN) : 0,
      peakRate: this.peakRate ? +this.peakRate.toFixed(1) : null,
      casualtyRoom: this.map.casualty.roomName,
      casualtyFound: this.casualtyFound,
      reports: this.reports,
      events: this.events,
      samples: this.samples,
      baseline: this.air.baseline,
    };
    result.score = scoreRun(result);
    result.rank = rankFor(result.score);
    this.destroy();
    this.onEnd(result);
  }

  // --- rendering -----------------------------------------------------------
  _renderStatic() {
    const { w, h, kind } = this.map;
    const c = document.createElement('canvas');
    c.width = w * TILE; c.height = h * TILE;
    const g = c.getContext('2d');
    // Concrete floor with expansion joints
    g.fillStyle = '#4a4f55'; g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < 1800; i++) {
      g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${Math.random() * 0.05})`;
      g.fillRect(Math.random() * c.width, Math.random() * c.height, 2 + Math.random() * 6, 2 + Math.random() * 6);
    }
    g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 1;
    for (let x = 0; x < w; x += 4) { g.beginPath(); g.moveTo(x * TILE, 0); g.lineTo(x * TILE, c.height); g.stroke(); }
    for (let y = 0; y < h; y += 4) { g.beginPath(); g.moveTo(0, y * TILE); g.lineTo(c.width, y * TILE); g.stroke(); }
    // Painted aisle lines
    g.strokeStyle = 'rgba(232, 210, 29, 0.35)'; g.lineWidth = 3;
    for (const y of [6, 8, 10, 12, 14, 16, 18]) { g.beginPath(); g.moveTo(TILE, y * TILE + TILE / 2); g.lineTo((w - 1) * TILE, y * TILE + TILE / 2); g.stroke(); }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = kind[y * w + x];
        const px = x * TILE, py = y * TILE;
        if (k === 'wall') {
          g.fillStyle = '#2a2d31'; g.fillRect(px, py, TILE, TILE);
          g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(px, py, TILE, 3);
        } else if (k === 'rack') {
          g.fillStyle = '#1f5f9e'; g.fillRect(px + 1, py + 3, TILE - 2, TILE - 6);
          g.fillStyle = '#e07b1a'; g.fillRect(px + 1, py + 3, TILE - 2, 3);
          g.fillStyle = '#8a6a43'; g.fillRect(px + 5, py + 8, TILE - 10, TILE - 14);
          g.strokeStyle = 'rgba(0,0,0,0.35)'; g.strokeRect(px + 5, py + 8, TILE - 10, TILE - 14);
        } else if (k === 'debris') {
          g.fillStyle = '#7d5c38';
          g.save(); g.translate(px + TILE / 2, py + TILE / 2); g.rotate(0.5);
          g.fillRect(-TILE * 0.4, -TILE * 0.3, TILE * 0.8, TILE * 0.6);
          g.strokeStyle = '#3a2a18'; g.strokeRect(-TILE * 0.4, -TILE * 0.3, TILE * 0.8, TILE * 0.6);
          g.restore();
        }
      }
    }
    return c;
  }

  _makeSmoke() {
    const blobs = [];
    for (let i = 0; i < 16; i++) {
      blobs.push({
        x: Math.random() * this.map.w, y: Math.random() * this.map.h,
        r: 3 + Math.random() * 6, vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.12,
        a: 0.06 + Math.random() * 0.08,
      });
    }
    return blobs;
  }

  _render(dt) {
    const { ctx, canvas, map } = this;
    const W = map.w * TILE, H = map.h * TILE;
    if (canvas.width !== W) { canvas.width = W; canvas.height = H; }
    if (this.fog.width !== W) { this.fog.width = W; this.fog.height = H; }
    const p = this.player;
    const px = p.x * TILE, py = p.y * TILE;

    ctx.drawImage(this.staticLayer, 0, 0);

    // Hose line laid from the entry — the player's way back out.
    ctx.strokeStyle = 'rgba(200, 60, 40, 0.9)'; ctx.lineWidth = 3; ctx.lineJoin = 'round';
    ctx.beginPath();
    this.trail.forEach((q, i) => (i ? ctx.lineTo(q.x * TILE, q.y * TILE) : ctx.moveTo(q.x * TILE, q.y * TILE)));
    ctx.lineTo(px, py); ctx.stroke();

    // Casualty
    if (!p.carrying) this._drawCasualty(ctx, map.casualty.x * TILE, map.casualty.y * TILE, 0);

    // Player
    ctx.save(); ctx.translate(px, py); ctx.rotate(p.dir);
    if (p.carrying) this._drawCasualty(ctx, -TILE * 0.55, 0, Math.PI / 2, true);
    ctx.fillStyle = '#1b2633'; ctx.beginPath(); ctx.arc(0, 0, TILE * 0.36, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#e8d21d'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, TILE * 0.36, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#f2f2ee'; ctx.beginPath(); ctx.arc(TILE * 0.08, 0, TILE * 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // Smoke: fog canvas with the torch and remembered areas cut out.
    const f = this.fog.getContext('2d');
    f.globalCompositeOperation = 'source-over';
    f.clearRect(0, 0, W, H);
    f.fillStyle = 'rgba(28, 30, 33, 0.985)';
    f.fillRect(0, 0, W, H);
    f.globalCompositeOperation = 'destination-out';
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const s = this.seen[y * map.w + x];
        if (s > 0) { f.fillStyle = `rgba(0,0,0,${0.3 + s * 0.35})`; f.fillRect(x * TILE, y * TILE, TILE, TILE); }
      }
    }
    const flicker = 1 + Math.sin(performance.now() / 90) * 0.015;
    const torch = f.createRadialGradient(px, py, TILE * 0.4, px, py, SIGHT * TILE * flicker);
    torch.addColorStop(0, 'rgba(0,0,0,1)');
    torch.addColorStop(0.6, 'rgba(0,0,0,0.95)');
    torch.addColorStop(1, 'rgba(0,0,0,0)');
    f.fillStyle = torch;
    f.beginPath(); f.arc(px, py, SIGHT * TILE * flicker, 0, Math.PI * 2); f.fill();
    ctx.drawImage(this.fog, 0, 0);

    // Drifting smoke
    for (const b of this.smoke) {
      if (!this.paused) {
        b.x += b.vx * dt; b.y += b.vy * dt;
        if (b.x < -b.r) b.x = map.w + b.r; if (b.x > map.w + b.r) b.x = -b.r;
        if (b.y < -b.r) b.y = map.h + b.r; if (b.y > map.h + b.r) b.y = -b.r;
      }
      const g = ctx.createRadialGradient(b.x * TILE, b.y * TILE, 0, b.x * TILE, b.y * TILE, b.r * TILE);
      g.addColorStop(0, `rgba(120,122,120,${b.a})`); g.addColorStop(1, 'rgba(120,122,120,0)');
      ctx.fillStyle = g; ctx.fillRect((b.x - b.r) * TILE, (b.y - b.r) * TILE, b.r * 2 * TILE, b.r * 2 * TILE);
    }

    // Hose line and exit sign stay faintly visible through the smoke.
    ctx.strokeStyle = 'rgba(220, 80, 50, 0.35)'; ctx.lineWidth = 2;
    ctx.beginPath();
    this.trail.forEach((q, i) => (i ? ctx.lineTo(q.x * TILE, q.y * TILE) : ctx.moveTo(q.x * TILE, q.y * TILE)));
    ctx.lineTo(px, py); ctx.stroke();
    const e = map.entry;
    ctx.fillStyle = '#1aa34a';
    ctx.shadowColor = '#2bff74'; ctx.shadowBlur = 14;
    ctx.fillRect(e.x * TILE - 13, e.y * TILE - 8, 26, 16);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff'; ctx.font = '600 10px Bahnschrift, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('EXIT', e.x * TILE, e.y * TILE + 1);

    // Mask condensation on exhale + heartbeat vignette.
    if (this.mist > 0.01) {
      const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.65);
      v.addColorStop(0, 'rgba(230,236,240,0)');
      v.addColorStop(1, `rgba(230,236,240,${0.26 * this.mist})`);
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    }
    const bpm = this.sig.state.stablePulse?.value || 0;
    if (bpm) {
      const beat = (performance.now() / 1000) * (bpm / 60);
      const throb = Math.pow(Math.max(0, Math.sin(beat * Math.PI * 2)), 8) * 0.25;
      const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.7);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, `rgba(60,0,0,${0.12 + throb})`);
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    }
  }

  _drawCasualty(ctx, x, y, rot, carried = false) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = carried ? '#c9853c' : '#d9933f';
    ctx.beginPath(); ctx.roundRect(-TILE * 0.18, -TILE * 0.5, TILE * 0.36, TILE * 0.85, 6); ctx.fill();
    ctx.fillStyle = '#e8c4a0';
    ctx.beginPath(); ctx.arc(0, -TILE * 0.62, TILE * 0.15, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  _updateHud(dt) {
    const h = this.hud;
    const st = this.sig.state;
    const air = this.air;
    const whistle = air.pressure <= CYLINDER.whistle;
    this.gauge.draw(air.pressure, { dt, whistle, flash: Math.floor(performance.now() / 300) % 2 === 0 });

    if (whistle) {
      h.whistleIn.textContent = 'Withdraw now';
      h.whistleRow.classList.add('alarm');
      h.whistleLabel.textContent = 'Whistle sounding';
    } else {
      h.whistleIn.textContent = fmt(air.secondsToWhistle());
      h.whistleRow.classList.remove('alarm');
      h.whistleLabel.textContent = 'Whistle in, at this breathing rate';
    }
    h.usage.textContent = air.usageLpm ? Math.round(air.usageLpm) : '—';
    const rate = st.stableRate?.value ?? st.breathingRate?.value;
    h.rate.textContent = rate ? rate.toFixed(0) : '—';
    const c = this.control ?? breathControl(rate, this.sig.ieRatio());
    h.controlBar.style.setProperty('--v', `${c}%`);
    h.controlValue.textContent = c;
    h.controlBar.dataset.level = c >= 75 ? 'good' : c >= 45 ? 'fair' : 'poor';
    const pulse = st.stablePulse?.value ?? st.pulse?.value;
    h.pulse.textContent = pulse ? Math.round(pulse) : '—';
    h.talkLamp.classList.toggle('on', !!st.talking?.detected);
    h.clock.textContent = fmt(this.t);

    // Radio banner
    const r = this.activeReport;
    if (r) {
      h.radio.hidden = false;
      h.radio.classList.remove('done', 'missed');
      h.radioPrompt.textContent = r.prompt;
      h.radioLine.textContent = r.line();
      h.radioMeter.style.setProperty('--v', `${Math.min(100, (r.talked / REPORT_TALK) * 100)}%`);
      h.radioTimer.textContent = `${Math.max(0, Math.ceil(REPORT_WINDOW - r.elapsed))} s`;
    } else if (this.lastRadioResult && this.t - this.lastRadioResult.at < 2.5) {
      h.radio.hidden = false;
      h.radio.classList.toggle('done', this.lastRadioResult.ok);
      h.radio.classList.toggle('missed', !this.lastRadioResult.ok);
      h.radioPrompt.textContent = this.lastRadioResult.ok ? 'Entry control: "Received, Team 1."' : 'Entry control heard nothing. Report missed.';
      h.radioLine.textContent = '';
      h.radioTimer.textContent = '';
    } else {
      h.radio.hidden = true;
    }

    // Objective line
    const p = this.player;
    let obj;
    if (this.confirmWithdraw) obj = 'Press E again to leave without the casualty, or keep searching.';
    else if (p.carrying) obj = 'Follow your hose line back to the exit. Carrying slows you down.';
    else if (Math.hypot(p.x - this.map.casualty.x, p.y - this.map.casualty.y) < 1.3) obj = 'Casualty here. Press E to pick them up.';
    else if (whistle) obj = 'Whistle sounding. Get out, with or without the casualty.';
    else obj = 'Search the rooms along the back wall for the missing worker.';
    h.objective.textContent = obj;

    // Signal-loss overlay
    h.pause.hidden = !this.paused;
    if (this.paused) h.pauseHint.textContent = this.pauseReason || 'Get back in front of the camera.';

    this._drawWave(h.wave);
  }

  _drawWave(cv) {
    const ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, hgt = cv.clientHeight;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = hgt * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const tr = this.sig.state.trace;
    if (tr.length < 2) return;
    const tEnd = tr[tr.length - 1].t, span = 12;
    let lo = Infinity, hi = -Infinity;
    for (const q of tr) if (q.t > tEnd - span) { lo = Math.min(lo, q.v); hi = Math.max(hi, q.v); }
    if (!(hi > lo)) return;
    const pol = this.sig.phaseTracker.effectivePolarity;
    ctx.strokeStyle = this.sig.state.phase === 'inhale' ? '#7fd3ff' : '#e9edf0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (const q of tr) {
      if (q.t < tEnd - span) continue;
      const x = ((q.t - (tEnd - span)) / span) * w;
      let n = (q.v - lo) / (hi - lo);
      if (pol < 0) n = 1 - n;
      const y = hgt - 4 - n * (hgt - 8);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

export function scoreRun(r) {
  let s = 0;
  if (r.outcome === 'rescued') s += 400;
  if (r.outcome === 'rescued' || r.outcome === 'withdrew') {
    s += r.endBar > CYLINDER.whistle ? 150 + Math.min(100, (r.endBar - CYLINDER.whistle) * 0.5) : 60;
  }
  s += r.reports.filter((x) => x.ok).length * 60;
  s += Math.round(r.avgControl * 1.5);
  return Math.round(s);
}

export function rankFor(score) {
  if (score >= 850) return 'Instructor standard';
  if (score >= 650) return 'Team leader';
  if (score >= 450) return 'Firefighter';
  return 'Recruit';
}
