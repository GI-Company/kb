// chart_utils.js
// Shared loss-chart drawing logic used by both the main-thread chart
// (index.html's drawChart, single-threaded/default training) and
// chart_worker.js (OffscreenCanvas, parallel-worker training) -- factored
// out so the two don't drift out of sync as one gets fixed/tweaked and the
// other doesn't.
//
// Two correctness-relevant details baked in here:
//  - safeMin/safeMax use a plain loop instead of Math.min(...arr)/Math.max(...arr):
//    spreading a large array into a function call blows the JS call stack
//    once lossHistory gets into the tens of thousands of entries (a real
//    training run can get there), throwing a RangeError.
//  - the rendered polyline is downsampled to roughly one point per
//    horizontal pixel, since redrawing every raw point on every redraw is
//    wasted work once there are far more loss values than pixels to show
//    them in. The returned metadata includes enough information (`stride`,
//    `pointCount`, `fullLength`) for a caller doing hover/tooltip hit-testing
//    to map a rendered point back to its original index in the full history.

export function safeMin(arr) {
  let m = Infinity;
  for (const v of arr) if (v < m) m = v;
  return m;
}

export function safeMax(arr) {
  let m = -Infinity;
  for (const v of arr) if (v > m) m = v;
  return m;
}

/** Downsample to at most maxPoints, keeping roughly-even spacing (including the first and last point). */
export function downsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr;
  const out = new Array(maxPoints);
  const stride = (arr.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) out[i] = arr[Math.round(i * stride)];
  return out;
}

/**
 * Draws the loss curve into `ctx` (already sized/transformed by the caller)
 * over a `w`×`h` CSS-pixel area. `theme` needs `{grid, baseline, series, muted}`
 * hex colors. Returns hit-testing metadata (or null if there's nothing to
 * draw yet), including enough to map a rendered point back to the original
 * `lossHistoryFull` index even when downsampling is active.
 */
export function drawLossChart(ctx, w, h, lossHistoryFull, theme) {
  ctx.clearRect(0, 0, w, h);

  const padL = 34, padB = 18, padT = 8, padR = 8;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  if (lossHistoryFull.length < 2) {
    ctx.fillStyle = theme.muted;
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText("loss will plot here once training starts", padL, h / 2);
    return null;
  }

  const maxPoints = Math.max(2, Math.floor(plotW));
  const lossHistory = downsample(lossHistoryFull, maxPoints);
  const stride = lossHistory.length < lossHistoryFull.length ? (lossHistoryFull.length - 1) / (lossHistory.length - 1) : 1;

  const maxLoss = safeMax(lossHistory);
  const minLoss = safeMin(lossHistory);
  const range = Math.max(1e-6, maxLoss - minLoss);

  ctx.strokeStyle = theme.grid;
  ctx.fillStyle = theme.muted;
  ctx.font = "10px system-ui, sans-serif";
  ctx.lineWidth = 1;
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = minLoss + (range * i) / yTicks;
    const y = padT + plotH - (plotH * i) / yTicks;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillText(v.toFixed(2), 2, y + 3);
  }

  ctx.strokeStyle = theme.baseline;
  ctx.beginPath(); ctx.moveTo(padL, padT + plotH); ctx.lineTo(w - padR, padT + plotH); ctx.stroke();

  ctx.strokeStyle = theme.series;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  lossHistory.forEach((v, i) => {
    const x = padL + (plotW * i) / (lossHistory.length - 1);
    const y = padT + plotH - (plotH * (v - minLoss)) / range;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  return { padL, padT, plotW, plotH, minLoss, range, pointCount: lossHistory.length, fullLength: lossHistoryFull.length, stride };
}
