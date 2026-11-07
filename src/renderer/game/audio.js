// All sounds are synthesised with WebAudio — no recorded assets.
//   demand-valve hiss on every inhale, exhale valve flutter,
//   heartbeat at the player's live pulse, low-pressure whistle, radio chirps.

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.hiss = null;
    this.whistleNodes = null;
    this.heartTimer = null;
    this.bpm = 0;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(this.ctx.destination);
    // 2 s of white noise, reused for hiss / flutter / squelch.
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  resume() { this.init(); if (this.ctx.state === 'suspended') this.ctx.resume(); }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  _noiseSource() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    return s;
  }

  // Inhale: the demand valve opens and air rushes in.
  inhale(depth = 1) {
    if (!this.ctx) return;
    this.exhaleEnd();
    const t = this.ctx.currentTime;
    const src = this._noiseSource();
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 0.9;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 900;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.10 + 0.08 * Math.min(depth, 2), t + 0.12);
    g.gain.setTargetAtTime(0.05, t + 0.5, 0.6);
    src.connect(bp).connect(hp).connect(g).connect(this.master);
    src.start(t, Math.random());
    this.hiss = { src, g };
    // Safety stop if no exhale arrives.
    this.hissTimeout = setTimeout(() => this.exhaleEnd(), 4000);
  }

  // Exhale: hiss stops, exhale valve flutters briefly.
  exhale() {
    if (!this.ctx) return;
    this.exhaleEnd();
    const t = this.ctx.currentTime;
    const src = this._noiseSource();
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 700;
    const g = this.ctx.createGain();
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    lfo.frequency.value = 28; lfoGain.gain.value = 0.03;
    lfo.connect(lfoGain).connect(g.gain);
    g.gain.setValueAtTime(0.05, t);
    g.gain.setTargetAtTime(0, t + 0.4, 0.25);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random()); lfo.start(t);
    src.stop(t + 1.6); lfo.stop(t + 1.6);
  }

  exhaleEnd() {
    clearTimeout(this.hissTimeout);
    if (!this.hiss) return;
    const { src, g } = this.hiss;
    const t = this.ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setTargetAtTime(0, t, 0.05);
    src.stop(t + 0.3);
    this.hiss = null;
  }

  // Heartbeat follows the live pulse reading.
  setHeartRate(bpm) {
    this.bpm = bpm || 0;
    if (!this.heartTimer && this.bpm > 0) this._beat();
  }

  _beat() {
    if (!this.ctx || !this.bpm) { this.heartTimer = null; return; }
    const t = this.ctx.currentTime;
    const thump = (at, f, v) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.frequency.setValueAtTime(f, at);
      o.frequency.exponentialRampToValueAtTime(f * 0.6, at + 0.12);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(v, at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      o.connect(g).connect(this.master);
      o.start(at); o.stop(at + 0.2);
    };
    thump(t, 62, 0.22);
    thump(t + 0.16, 52, 0.14);
    this.heartTimer = setTimeout(() => this._beat(), 60000 / Math.max(40, Math.min(160, this.bpm)));
  }

  stopHeart() { this.bpm = 0; clearTimeout(this.heartTimer); this.heartTimer = null; }

  // Low-pressure warning whistle: keeps sounding once triggered.
  whistleOn() {
    if (!this.ctx || this.whistleNodes) return;
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.value = 0.0;
    g.gain.linearRampToValueAtTime(0.06, t + 0.3);
    const o1 = this.ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = 2950;
    const o2 = this.ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 3020;
    const trem = this.ctx.createOscillator(); trem.frequency.value = 6;
    const tremG = this.ctx.createGain(); tremG.gain.value = 0.025;
    trem.connect(tremG).connect(g.gain);
    o1.connect(g); o2.connect(g); g.connect(this.master);
    o1.start(); o2.start(); trem.start();
    this.whistleNodes = [o1, o2, trem, g];
  }

  whistleOff() {
    if (!this.whistleNodes) return;
    const [o1, o2, trem, g] = this.whistleNodes;
    const t = this.ctx.currentTime;
    g.gain.setTargetAtTime(0, t, 0.05);
    for (const o of [o1, o2, trem]) o.stop(t + 0.3);
    this.whistleNodes = null;
  }

  radio(kind = 'open') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(kind === 'ok' ? 1320 : kind === 'fail' ? 300 : 980, t);
    if (kind === 'ok') o.frequency.setValueAtTime(1760, t + 0.09);
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.25);
    const src = this._noiseSource();
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.04, t + 0.22);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    src.connect(bp).connect(ng).connect(this.master);
    src.start(t + 0.2); src.stop(t + 0.5);
  }

  stopAll() {
    this.exhaleEnd();
    this.whistleOff();
    this.stopHeart();
  }
}
