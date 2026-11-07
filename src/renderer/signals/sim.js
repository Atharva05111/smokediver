// Keyboard simulator — for development, testing without a camera, and for
// judges who want to try the game before setting up a Presage key.
// It is always labelled as simulated in the UI and never claims to be live.
//
//   Hold Space  → breathe in, release → breathe out
//   Hold V      → talk (radio report)
//   B           → toggle auto-breathing (calm 10 breaths/min)

import { SignalHub } from './hub.js';

export class SimSource extends SignalHub {
  constructor() {
    super('sim');
    this.inhaling = false;
    this.talkHeld = false;
    this.auto = false;
    this.autoRate = 10;
    this.level = 0;            // simulated chest position 0..1
    this.cycles = [];          // {inhale, exhale, depth}
    this.inStart = 0;
    this.exStart = performance.now();
    this.pulse = 72;
    this.timer = null;
    this._onKey = this._onKey.bind(this);
  }

  async start() {
    const st = this.state;
    st.status = 'running';
    st.validation = { code: 0, name: 'Ok', hint: '', ok: true, okSince: performance.now(), badSince: null };
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKey);
    this.timer = setInterval(() => this._tick(), 33);
    this.emit('status', 'running');
    this.emit('validation', st.validation);
  }

  setAuto(on, rate = 10) { this.auto = on; this.autoRate = rate; }

  // Scriptable control for automated tests.
  setInhale(on) { this._breath(on); }
  setTalking(on) { this.talkHeld = on; }

  _onKey(e) {
    if (e.repeat) return;
    const down = e.type === 'keydown';
    if (e.code === 'Space') { e.preventDefault(); this._breath(down); }
    if (e.code === 'KeyV') this.talkHeld = down;
    if (e.code === 'KeyB' && down) this.auto = !this.auto;
  }

  _breath(inhale) {
    const now = performance.now();
    if (inhale && !this.inhaling) {
      this.inhaling = true;
      this.inStart = now;
      this._lastExhale = (now - this.exStart) / 1000;
    } else if (!inhale && this.inhaling) {
      this.inhaling = false;
      this.exStart = now;
      const inhaleDur = (now - this.inStart) / 1000;
      if (this._lastExhale != null && inhaleDur > 0.25) {
        this.cycles.push({ inhale: inhaleDur, exhale: this._lastExhale, depth: Math.min(2.2, 0.4 + inhaleDur * 0.45) });
        if (this.cycles.length > 6) this.cycles.shift();
      }
    }
  }

  _tick() {
    const now = performance.now();
    const st = this.state;

    if (this.auto) {
      const period = 60 / this.autoRate;
      const phase = ((now / 1000) % period) / period;
      this._breath(phase < 0.38);
    }

    // Chest position eases toward full on inhale, empty on exhale.
    this.level += ((this.inhaling ? 1 : 0) - this.level) * (this.inhaling ? 0.07 : 0.05);
    this.pushTrace(now / 1000, this.level + (Math.random() - 0.5) * 0.01);

    if (this.cycles.length >= 2) {
      const c = this.cycles.slice(-4);
      const period = c.reduce((s, x) => s + x.inhale + x.exhale, 0) / c.length;
      const rate = Math.max(3, Math.min(40, 60 / period));
      st.breathingRate = { value: rate, confidence: 80, stable: true, at: now };
      st.stableRate = { value: rate, at: now };
      st.amplitude = { value: c.reduce((s, x) => s + x.depth, 0) / c.length, at: now };
      st.ieRatio = { value: c.reduce((s, x) => s + x.inhale, 0) / c.reduce((s, x) => s + x.exhale, 0), at: now };
      const target = 66 + (rate - 10) * 1.6;
      this.pulse += (target - this.pulse) * 0.01;
    }
    const pulse = this.pulse + Math.sin(now / 3000) * 1.5;
    st.pulse = { value: pulse, confidence: 80, stable: true, at: now };
    st.stablePulse = { value: pulse, at: now };
    st.talking = { detected: this.talkHeld, at: now };
    st.lastMetricsAt = now;
    st.metricsCount++;
    this.emit('metrics', st);
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKey);
    this.state.status = 'idle';
    this.emit('status', 'idle');
  }
}
