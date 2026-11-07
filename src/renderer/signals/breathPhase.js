// Breath phase tracking from the SmartSpectra chest breathing trace.
//
// The trace is a unitless waveform. We find its turning points (with
// hysteresis so noise doesn't fire false breaths), and decide which direction
// is "inhale" from timing: in normal breathing the inhale is the shorter half
// of the cycle, so whichever direction is consistently shorter is the inhale.
// The player can also flip it manually in settings if their camera angle
// confuses the heuristic.

export class BreathPhaseTracker {
  constructor({ onPhase } = {}) {
    this.onPhase = onPhase || (() => {});
    this.reset();
  }

  reset() {
    this.smoothed = null;
    this.dir = 0;            // +1 rising, -1 falling
    this.peak = null;        // running extreme in the current direction
    this.peakT = 0;
    this.lastTurnT = null;
    this.window = [];        // recent smoothed values for scale estimate
    this.segments = [];      // {rising: bool, dur: seconds, depth}
    this.polarity = 1;       // +1 means rising trace = inhale
    this.flip = false;
    this.phase = null;
    this.breaths = [];       // completed breaths {t, inhale, exhale, depth}
    this.pendingInhale = null;
  }

  setFlip(flip) { this.flip = !!flip; }

  get effectivePolarity() { return this.flip ? -this.polarity : this.polarity; }

  push(t, v) {
    if (!Number.isFinite(v) || !Number.isFinite(t)) return;
    this.smoothed = this.smoothed == null ? v : this.smoothed * 0.6 + v * 0.4;
    const s = this.smoothed;

    this.window.push({ t, s });
    while (this.window.length && t - this.window[0].t > 12) this.window.shift();
    let lo = Infinity, hi = -Infinity;
    for (const p of this.window) { if (p.s < lo) lo = p.s; if (p.s > hi) hi = p.s; }
    const range = hi - lo;
    if (!(range > 0)) return;
    const thr = range * 0.18;

    if (this.dir === 0) {
      this.dir = 1; this.peak = s; this.peakT = t; this.lastTurnT = t;
      return;
    }

    if (this.dir > 0) {
      if (s > this.peak) { this.peak = s; this.peakT = t; }
      else if (this.peak - s > thr) this._turn(-1, s, t, range);
    } else {
      if (s < this.peak) { this.peak = s; this.peakT = t; }
      else if (s - this.peak > thr) this._turn(1, s, t, range);
    }
  }

  _turn(newDir, s, t, range) {
    const segDur = this.peakT - this.lastTurnT;
    const rising = this.dir > 0;
    if (segDur > 0.4 && segDur < 15) {
      this.segments.push({ rising, dur: segDur, depth: range });
      if (this.segments.length > 24) this.segments.shift();
      this._updatePolarity();
      this._recordBreath(rising, segDur, range, this.peakT);
    }
    this.lastTurnT = this.peakT;
    this.dir = newDir;
    this.peak = s;
    this.peakT = t;

    const inhale = (newDir > 0) === (this.effectivePolarity > 0);
    const phase = inhale ? 'inhale' : 'exhale';
    if (phase !== this.phase) {
      this.phase = phase;
      this.onPhase(phase, t);
    }
  }

  _recordBreath(rising, dur, depth, endT) {
    const isInhale = rising === (this.effectivePolarity > 0);
    if (isInhale) {
      this.pendingInhale = { dur, depth };
    } else if (this.pendingInhale) {
      this.breaths.push({ t: endT, inhale: this.pendingInhale.dur, exhale: dur, depth: this.pendingInhale.depth });
      if (this.breaths.length > 30) this.breaths.shift();
      this.pendingInhale = null;
    }
  }

  _updatePolarity() {
    const r = this.segments.filter((x) => x.rising).map((x) => x.dur);
    const f = this.segments.filter((x) => !x.rising).map((x) => x.dur);
    if (r.length < 3 || f.length < 3) return;
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const mr = mean(r), mf = mean(f);
    if (mr < mf * 0.92) this.polarity = 1;
    else if (mf < mr * 0.92) this.polarity = -1;
  }

  // Inhale:exhale ratio from our own phase timing (fallback when the SDK's
  // INHALE_EXHALE_RATIO is not available yet).
  recentIeRatio(n = 6) {
    const b = this.breaths.slice(-n);
    if (b.length < 2) return null;
    const i = b.reduce((x, y) => x + y.inhale, 0);
    const e = b.reduce((x, y) => x + y.exhale, 0);
    return e > 0 ? i / e : null;
  }
}
