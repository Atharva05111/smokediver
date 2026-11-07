// Post-mission debrief: what happened to your air, and why.

import { Chart } from 'chart.js/auto';
import { CYLINDER } from './game/air.js';

const $ = (id) => document.getElementById(id);
const fmt = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
let chart = null;

const TITLES = {
  rescued: 'Casualty rescued',
  withdrew: 'Withdrew without the casualty',
  outOfAir: 'Your cylinder ran out',
};

const REPORT_NAMES = {
  entry: 'Starting pressure',
  aisle: 'Central aisle check',
  casualty: 'Casualty found',
  whistle: 'Whistle, withdrawing',
};

export function renderDebrief(r, previous) {
  $('d-title').textContent = TITLES[r.outcome] || r.outcome;
  const mode = r.source === 'sim' ? 'Simulator run' : 'Live run with SmartSpectra';
  $('d-sub').textContent = r.outcome === 'outOfAir'
    ? `${mode}. In a real building, this is when a rescue team comes in for you.`
    : `${mode}. You found the casualty in ${r.casualtyFound ? r.casualtyRoom : 'none of the rooms you searched'}.`;
  $('d-score').textContent = r.score;
  $('d-rank').textContent = r.rank;

  const okReports = r.reports.filter((x) => x.ok).length;
  const stats = [
    ['Time inside', fmt(r.durationS)],
    ['Exit pressure', r.outcome === 'outOfAir' ? 'Empty' : `${r.endBar} bar`],
    ['Average air use', `${r.avgUsageLpm} L/min`],
    ['Breath control', `${r.avgControl} / 100`],
    ['Peak breathing', r.peakRate ? `${Math.round(r.peakRate)} /min` : '—'],
    ['Whistle', r.whistleAtS != null ? `at ${fmt(r.whistleAtS)}` : 'Never sounded'],
    ['Radio reports', `${okReports} of ${r.reports.length}`],
  ];
  $('d-stats').innerHTML = stats.map(([k, v]) => `<div class="stat"><span class="stat-v">${v}</span><span class="stat-k">${k}</span></div>`).join('');

  $('d-reports').innerHTML = r.reports.length
    ? r.reports.map((x) => `<li class="${x.ok ? 'ok' : 'miss'}"><span class="t">${fmt(x.t)}</span>${REPORT_NAMES[x.id] || x.id}: ${x.ok ? `received at ${x.bar} bar` : 'missed'}</li>`).join('')
    : '<li>No radio calls.</li>';
  $('d-events').innerHTML = r.events.map((e) => `<li><span class="t">${fmt(e.t)}</span>${e.label}</li>`).join('');
  $('d-coach').innerHTML = coaching(r, previous).map((c) => `<li>${c}</li>`).join('');

  drawChart(r);
}

function coaching(r, previous) {
  const tips = [];
  const samples = r.samples.filter((s) => s.rate);
  if (samples.length) {
    const peak = samples.reduce((a, b) => (b.rate > a.rate ? b : a));
    const near = r.events.filter((e) => Math.abs(e.t - peak.t) <= 8).map((e) => e.label.toLowerCase());
    if (peak.rate > (r.baseline?.rate || 14) + 4) {
      tips.push(`Your breathing peaked at ${Math.round(peak.rate)} a minute around ${fmt(peak.t)}${near.length ? `, just as: ${near[0]}` : ''}. That's when your cylinder drained fastest.`);
    }
  }
  if (r.avgControl < 60) tips.push('Try a slow count while you move: in for three, out for five. A longer exhale is the quickest way to stretch your air.');
  else tips.push('Good breath control. Steady, unhurried breathing kept your air use down.');
  if (r.reports.some((x) => !x.ok)) tips.push('Answer radio calls straight away. Entry control uses your pressure reports to know when to send help.');
  if (r.whistleAtS != null && r.outcome !== 'outOfAir') tips.push(`Your whistle went at ${fmt(r.whistleAtS)}. Turning back earlier, around half a cylinder, leaves a margin for the slower trip out.`);
  if (r.outcome === 'outOfAir') tips.push('Plan your turn-around: when you\'ve used half your usable air, head back, even if you haven\'t found the casualty.');

  const prev = previous.filter((p) => p.source === r.source && p.outcome !== 'outOfAir');
  if (prev.length && r.outcome !== 'outOfAir') {
    const best = Math.max(...prev.map((p) => p.endBar));
    const diff = r.endBar - best;
    tips.push(diff > 0
      ? `You came out with ${diff} bar more than your previous best.`
      : `Your previous best exit pressure was ${best} bar.`);
  }
  return tips;
}

function drawChart(r) {
  if (chart) { chart.destroy(); chart = null; }
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--ink').trim() || '#222';
  const red = css.getPropertyValue('--red').trim() || '#c8102e';
  const blue = css.getPropertyValue('--blue').trim() || '#1f5f9e';
  const grid = 'rgba(30,40,50,0.12)';

  const eventsPlugin = {
    id: 'events',
    afterDatasetsDraw(c) {
      const { ctx, chartArea: a, scales: { x } } = c;
      ctx.save();
      ctx.font = '12px Bahnschrift, sans-serif';
      ctx.fillStyle = ink;
      r.events.forEach((e, i) => {
        if (e.t <= 0) return;
        const px = x.getPixelForValue(e.t);
        ctx.strokeStyle = 'rgba(30,40,50,0.35)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
        ctx.setLineDash([]);
        const tw = ctx.measureText(e.label).width;
        const right = px + 4 + tw > a.right;
        ctx.textAlign = right ? 'right' : 'left';
        ctx.fillText(e.label, right ? px - 4 : px + 4, a.top + 12 + (i % 3) * 14);
      });
      const wy = c.scales.bar.getPixelForValue(CYLINDER.whistle);
      ctx.strokeStyle = red; ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.moveTo(a.left, wy); ctx.lineTo(a.right, wy); ctx.stroke();
      ctx.restore();
    },
  };

  chart = new Chart($('d-chart'), {
    type: 'line',
    data: {
      datasets: [
        { label: 'Cylinder pressure (bar)', data: r.samples.map((s) => ({ x: s.t, y: s.bar })), borderColor: red, backgroundColor: red, yAxisID: 'bar', borderWidth: 2.5, pointRadius: 0 },
        { label: 'Breathing rate (/min)', data: r.samples.filter((s) => s.rate).map((s) => ({ x: s.t, y: s.rate })), borderColor: blue, backgroundColor: blue, yAxisID: 'rate', borderWidth: 2, pointRadius: 0, tension: 0.3 },
      ],
    },
    options: {
      animation: false,
      parsing: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: { legend: { labels: { color: ink, font: { family: 'Bahnschrift, sans-serif', size: 13 } } } },
      scales: {
        x: { type: 'linear', min: 0, title: { display: true, text: 'Seconds inside', color: ink }, ticks: { color: ink }, grid: { color: grid } },
        bar: { position: 'left', min: 0, max: 300, title: { display: true, text: 'bar', color: ink }, ticks: { color: ink }, grid: { color: grid } },
        rate: { position: 'right', min: 0, suggestedMax: 30, title: { display: true, text: 'breaths/min', color: ink }, ticks: { color: ink }, grid: { drawOnChartArea: false } },
      },
    },
    plugins: [eventsPlugin],
  });
}
