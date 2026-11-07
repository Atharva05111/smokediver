// Shared signal state. Both the live SmartSpectra source and the keyboard
// simulator write into this shape, so the game never knows which one it has.

import { BreathPhaseTracker } from './breathPhase.js';

export function emptyState(source) {
  return {
    source,                       // 'live' | 'sim'
    status: 'idle',               // idle | starting | running | stopping | error
    validation: { code: null, name: '', hint: '', ok: false, okSince: null, badSince: null },
    breathingRate: null,          // { value, confidence, stable, at }
    stableRate: null,             // last breathing rate with stable = true
    amplitude: null,              // { value, at }
    ieRatio: null,                // { value, at }  inhale/exhale duration ratio
    pulse: null,                  // { value, confidence, stable, at }
    stablePulse: null,
    hrv: null,                    // { rmssd, sdnn, at }
    talking: { detected: false, at: 0 },
    phase: null,                  // 'inhale' | 'exhale'
    phaseAt: 0,
    trace: [],                    // [{ t (s, local clock), v }] last ~20 s
    lastMetricsAt: 0,
    metricsCount: 0,
    error: null,
  };
}

export class SignalHub {
  constructor(source) {
    this.state = emptyState(source);
    this.listeners = new Map();
    this.phaseTracker = new BreathPhaseTracker({
      onPhase: (phase) => {
        this.state.phase = phase;
        this.state.phaseAt = performance.now();
        this.emit('phase', phase);
      },
    });
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(cb);
    return () => this.listeners.get(event).delete(cb);
  }

  emit(event, ...args) {
    const set = this.listeners.get(event);
    if (set) for (const cb of set) { try { cb(...args); } catch (e) { console.error(e); } }
  }

  pushTrace(tSec, v) {
    const tr = this.state.trace;
    tr.push({ t: tSec, v });
    while (tr.length && tSec - tr[0].t > 20) tr.shift();
    this.phaseTracker.push(tSec, v);
  }

  setFlip(flip) { this.phaseTracker.setFlip(flip); }

  // Best available inhale:exhale ratio.
  ieRatio() {
    if (this.state.ieRatio && performance.now() - this.state.ieRatio.at < 15000) return this.state.ieRatio.value;
    return this.phaseTracker.recentIeRatio();
  }

  // Whether the camera signal is currently trustworthy enough to play.
  signalOk() {
    if (this.state.source === 'sim') return true;
    const v = this.state.validation;
    if (v.ok) return true;
    // Camera tuning briefly reports not-OK at start; give a short grace period.
    return v.badSince != null && performance.now() - v.badSince < 2500;
  }
}
