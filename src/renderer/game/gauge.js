// Analog BA pressure gauge with a luminous face — the hero instrument.

import { CYLINDER } from './air.js';

const START = Math.PI * 0.75;      // 0 bar at bottom-left
const SWEEP = Math.PI * 1.5;       // 270° to 300 bar at bottom-right

export class Gauge {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.shown = CYLINDER.full;
    this.size = 0;
  }

  _fit() {
    const dpr = window.devicePixelRatio || 1;
    const css = this.canvas.clientWidth || 240;
    if (css === this.size && this.dpr === dpr) return;
    this.size = css; this.dpr = dpr;
    this.canvas.width = css * dpr;
    this.canvas.height = css * dpr;
  }

  draw(pressure, { dt = 0.016, whistle = false, flash = false } = {}) {
    this._fit();
    const { ctx } = this;
    const s = this.size;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, s, s);
    // Needle has a little mechanical lag.
    this.shown += (pressure - this.shown) * Math.min(1, dt * 6);

    const cx = s / 2, cy = s / 2, R = s * 0.47;

    // Bezel
    const bez = ctx.createLinearGradient(0, 0, s, s);
    bez.addColorStop(0, '#5d646c'); bez.addColorStop(0.5, '#262b31'); bez.addColorStop(1, '#4a5158');
    ctx.fillStyle = bez;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    // Luminous face
    const face = ctx.createRadialGradient(cx, cy - R * 0.2, R * 0.1, cx, cy, R * 0.88);
    face.addColorStop(0, '#e9f6dc'); face.addColorStop(1, '#bcd3ad');
    ctx.fillStyle = face;
    ctx.shadowColor = 'rgba(190, 240, 170, 0.55)'; ctx.shadowBlur = s * 0.08;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.86, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    const ang = (bar) => START + (bar / CYLINDER.full) * SWEEP;

    // Red reserve band
    ctx.strokeStyle = '#c8102e';
    ctx.lineWidth = R * 0.12;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.72, ang(0), ang(CYLINDER.whistle)); ctx.stroke();

    // Ticks and numerals
    ctx.strokeStyle = '#1d2329'; ctx.fillStyle = '#1d2329';
    for (let bar = 0; bar <= CYLINDER.full; bar += 10) {
      const a = ang(bar);
      const major = bar % 50 === 0;
      const r1 = R * 0.80, r2 = major ? R * 0.64 : R * 0.72;
      ctx.lineWidth = major ? 2.4 : 1.1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.stroke();
      if (major) {
        ctx.font = `600 ${Math.round(s * 0.072)}px Bahnschrift, 'DIN Alternate', 'Arial Narrow', sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(bar), cx + Math.cos(a) * R * 0.51, cy + Math.sin(a) * R * 0.51);
      }
    }

    ctx.font = `500 ${Math.round(s * 0.06)}px Bahnschrift, 'DIN Alternate', sans-serif`;
    ctx.fillText('bar', cx, cy + R * 0.3);

    // Readout window
    ctx.fillStyle = '#1d2329';
    ctx.font = `700 ${Math.round(s * 0.11)}px Bahnschrift, 'DIN Alternate', sans-serif`;
    ctx.fillText(String(Math.round(this.shown)), cx, cy + R * 0.52);

    // Needle
    const a = ang(Math.max(0, Math.min(CYLINDER.full, this.shown)));
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(a);
    ctx.fillStyle = whistle && flash ? '#ff2a3d' : '#d4231f';
    ctx.beginPath();
    ctx.moveTo(-R * 0.14, -R * 0.025);
    ctx.lineTo(R * 0.78, 0);
    ctx.lineTo(-R * 0.14, R * 0.025);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#2b3036';
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.07, 0, Math.PI * 2); ctx.fill();

    // Glass glint
    const glint = ctx.createLinearGradient(cx - R, cy - R, cx, cy);
    glint.addColorStop(0, 'rgba(255,255,255,0.22)'); glint.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glint;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.86, Math.PI, Math.PI * 1.5); ctx.lineTo(cx, cy); ctx.fill();
  }
}
