// Simulated breathing-apparatus cylinder.
//
// This is a game model, not a measurement of real air use. It turns the
// player's live breathing (rate × relative depth) into a ventilation figure,
// then drains a "training cylinder" scaled so a mission lasts a few minutes:
//   calm   ~10 breaths/min → about 3.5–4 min to the whistle
//   normal ~14 breaths/min → about 2.5–3 min
//   rushed ~20+ breaths/min, deep → under 2 min
// Talking costs extra air, as it does in a real mask.

export const CYLINDER = {
  full: 300,        // bar
  whistle: 55,      // low-pressure warning whistle, bar
};

const TIDAL_LITRES = 0.55;     // nominal resting breath at the player's baseline depth
const BAR_PER_LPM_SEC = 0.19;  // training-cylinder scaling (bar per second per L/min)
const DISPLAY_FACTOR = 6.5;    // desk ventilation → working-firefighter L/min shown on HUD
const TALK_FACTOR = 1.25;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export class AirModel {
  constructor(baseline = {}) {
    this.baseline = { rate: baseline.rate || 14, amplitude: baseline.amplitude || null };
    this.pressure = CYLINDER.full;
    this.drainRate = 0;          // bar/s, smoothed
    this.usageLpm = 0;           // displayed L/min, smoothed
    this.whistled = false;
    this.empty = false;
    this.totalLitres = 0;        // displayed-scale litres consumed
  }

  // Current ventilation in "desk litres per minute".
  ventilation(sig) {
    const st = sig.state;
    const rate = clamp(st.stableRate?.value ?? st.breathingRate?.value ?? this.baseline.rate, 3, 45);
    let depth = 1;
    if (st.amplitude && this.baseline.amplitude) depth = clamp(st.amplitude.value / this.baseline.amplitude, 0.5, 2.2);
    let v = rate * TIDAL_LITRES * depth;
    if (st.talking?.detected) v *= TALK_FACTOR;
    return v;
  }

  update(dt, sig) {
    if (this.empty) return;
    const v = this.ventilation(sig);
    const drain = BAR_PER_LPM_SEC * v;
    this.pressure = Math.max(0, this.pressure - drain * dt);
    const k = Math.min(1, dt * 0.8);
    this.drainRate += (drain - this.drainRate) * k;
    this.usageLpm += (v * DISPLAY_FACTOR - this.usageLpm) * k;
    this.totalLitres += (v * DISPLAY_FACTOR / 60) * dt;
    if (!this.whistled && this.pressure <= CYLINDER.whistle) this.whistled = true;
    if (this.pressure <= 0) this.empty = true;
  }

  // Seconds until the whistle at the current rate (null once past it).
  secondsToWhistle() {
    if (this.pressure <= CYLINDER.whistle || this.drainRate <= 0) return null;
    return (this.pressure - CYLINDER.whistle) / this.drainRate;
  }

  secondsToEmpty() {
    if (this.drainRate <= 0) return null;
    return this.pressure / this.drainRate;
  }
}

// Breath-control score 0–100: slow, steady breathing with an exhale at least
// as long as the inhale scores highest. This scores a technique, not health.
export function breathControl(rate, ie) {
  const rateScore = rate == null ? 70 : rate <= 12 ? 100 : Math.max(0, 100 - (rate - 12) * 7);
  const ieScore = ie == null ? 70 : ie <= 0.8 ? 100 : Math.max(0, 100 - (ie - 0.8) * 120);
  return Math.round(rateScore * 0.65 + ieScore * 0.35);
}
