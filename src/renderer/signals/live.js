// Live signals from the Presage SmartSpectra SDK (renderer side).
//
// Requested metrics:
//   breathing bundle  → rate, amplitude, inhale:exhale ratio, chest trace
//   cardio bundle     → pulse rate (+ the arterial trace it is derived from), HRV
//   TALKING           → radio reports are confirmed by visual talking detection;
//                       no microphone is ever opened.

import {
  SmartSpectraSDK,
  ProcessingStatus,
  ValidationCode,
  MetricType,
  breathingMetrics,
  cardioMetrics,
} from '@smartspectra/node-sdk/renderer';
import { decodeMetrics } from '@smartspectra/node-sdk/messages';
import { SignalHub } from './hub.js';

export function requestedMetrics({ breathOnly = false } = {}) {
  return breathOnly
    ? [...breathingMetrics, MetricType.TALKING]
    : [...breathingMetrics, ...cardioMetrics, MetricType.TALKING];
}

const STATUS = Object.fromEntries(Object.entries(ProcessingStatus).map(([k, v]) => [v, k.replace(/^k/, '').toLowerCase()]));
const VALIDATION = Object.fromEntries(Object.entries(ValidationCode).map(([k, v]) => [v, k.replace(/^k/, '')]));

// Plain-language guidance for each readiness code.
export const VALIDATION_HELP = {
  Ok: 'Locked on. Keep still and breathe normally.',
  NoFaceFound: 'No face found. Sit in front of the camera.',
  MultipleFacesFound: 'More than one face in view. Only the player should be on camera.',
  FaceNotCentered: 'Move to the centre of the frame.',
  FaceSizeOutOfRange: 'Adjust your distance from the camera.',
  FaceTooClose: 'Lean back a little.',
  FaceTooFar: 'Move a little closer.',
  FaceTooHigh: 'Lower the camera or sit up less.',
  FaceTooLow: 'Raise the camera or sit up straighter.',
  FaceNotForward: 'Face the camera directly.',
  TooDark: 'Too dark. Turn on a light in front of you.',
  TooBright: 'Too bright. Avoid a window or lamp behind or beside the camera.',
  ChestNotVisible: 'Your shoulders and upper chest need to be in view.',
  CameraTuning: 'Camera is adjusting. Hold still for a moment.',
  FrameRateTooLow: 'Camera frame rate is too low. Close other camera apps.',
  ExcessiveMotion: 'Too much movement. Rest your arms and keep your body still.',
};

const ERROR_HELP = {
  2: 'Your Presage API key was rejected. Check SMARTSPECTRA_API_KEY in your .env file.',
  4: 'Your Presage free-trial credit is used up. Ask on the Presage Discord, or use the simulator.',
  5: 'Could not reach Presage to verify your key. Check your internet connection.',
  7: 'The camera is unavailable. Close other apps using it and try again.',
};

const tsNum = (ts) => (ts == null ? 0 : typeof ts === 'number' ? ts : typeof ts.toNumber === 'function' ? ts.toNumber() : Number(ts));
const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);

export class LiveSource extends SignalHub {
  constructor(apiKey, { breathOnly = false } = {}) {
    super('live');
    this.apiKey = apiKey;
    this.breathOnly = breathOnly;
    this.sdk = null;
    this.stream = null;
    this.traceOriginUs = null;
    this.traceOffsetSec = 0;
  }

  async start() {
    if (this.sdk) return;
    const st = this.state;
    st.status = 'starting';
    st.error = null;
    this.sdk = new SmartSpectraSDK({
      apiKey: this.apiKey,
      requestedMetrics: requestedMetrics({ breathOnly: this.breathOnly }),
      enableAccumulatedOutput: false,
      // Aggregate SDK telemetry is on by default; SmokeDiver opts out.
      enableTelemetry: false,
    });

    this.sdk.on('processingStatus', (status) => {
      st.status = STATUS[status] || String(status);
      this.emit('status', st.status);
    });

    this.sdk.on('validationStatus', (code, _ts, hint) => {
      const name = VALIDATION[code] || `Code ${code}`;
      const ok = code === ValidationCode.kOk;
      const v = st.validation;
      if (ok && !v.ok) v.okSince = performance.now();
      if (!ok && (v.ok || v.badSince == null)) v.badSince = performance.now();
      if (ok) v.badSince = null;
      Object.assign(v, { code, name, hint: hint || '', ok });
      this.emit('validation', v);
    });

    this.sdk.on('metrics', (buf) => {
      try { this._handle(decodeMetrics(buf)); } catch (e) { console.error('[smokediver] decode failed', e); }
    });

    this.sdk.on('error', (code, message, retryable) => {
      st.error = { code, message, retryable, help: ERROR_HELP[code] || message };
      this.emit('error', st.error);
    });

    this.sdk.on('streamAvailable', (stream) => {
      this.stream = stream;
      this.emit('stream', stream);
    });

    try {
      await this.sdk.start();
    } catch (err) {
      st.error = { code: err.code ?? 'JS', message: err.message, retryable: false, help: ERROR_HELP[err.code] || err.message };
      this.emit('error', st.error);
      throw err;
    }
  }

  _handle(m) {
    const st = this.state;
    const now = performance.now();
    st.lastMetricsAt = now;
    st.metricsCount++;

    const b = m.breathing;
    if (b) {
      const r = last(b.rate);
      if (r && r.value > 0) {
        st.breathingRate = { value: r.value, confidence: r.confidence, stable: !!r.stable, at: now };
        if (r.stable) st.stableRate = { value: r.value, at: now };
      }
      const a = last(b.amplitude);
      if (a && Number.isFinite(a.value) && a.value > 0) st.amplitude = { value: a.value, at: now };
      const ie = last(b.inhaleExhaleRatio);
      if (ie && Number.isFinite(ie.value) && ie.value > 0) st.ieRatio = { value: ie.value, at: now };

      if (b.upperTrace && b.upperTrace.length) {
        for (const p of b.upperTrace) {
          const us = tsNum(p.timestamp);
          if (this.traceOriginUs == null) {
            this.traceOriginUs = us;
            this.traceOffsetSec = now / 1000;
          }
          this.pushTrace(this.traceOffsetSec + (us - this.traceOriginUs) / 1e6, p.value);
        }
      }
    }

    const c = m.cardio;
    if (c) {
      const p = last(c.pulseRate);
      if (p && p.value > 0) {
        st.pulse = { value: p.value, confidence: p.confidence, stable: !!p.stable, at: now };
        if (p.stable) st.stablePulse = { value: p.value, at: now };
      }
      const h = c.hrv && (Array.isArray(c.hrv) ? last(c.hrv) : c.hrv);
      if (h && h.rmssd) st.hrv = { rmssd: h.rmssd, sdnn: h.sdnn, at: now };
    }

    const f = m.face;
    if (f) {
      const t = last(f.talking);
      if (t) st.talking = { detected: !!t.detected, at: now };
    }

    this.emit('metrics', st);
  }

  async stop() {
    if (!this.sdk) return;
    const sdk = this.sdk;
    this.sdk = null;
    // From the error state the SDK only accepts reset/destroy, not stop.
    if (this.state.status !== 'error') {
      try { await sdk.stop(); } catch (e) { console.warn('[smokediver] stop failed', e); }
    }
    try { sdk.destroy(); } catch { /* already destroyed */ }
    this.stream = null;
    this.state.status = 'idle';
    this.emit('status', 'idle');
  }
}
