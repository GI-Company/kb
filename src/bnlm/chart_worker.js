// chart_worker.js
// Owns an OffscreenCanvas (transferred once from the main-thread <canvas>
// via canvas.transferControlToOffscreen()) and redraws the loss chart
// itself whenever a new value arrives. The point: while parallel training
// is running, the main thread only ever forwards a number
// (`{type:'loss', value}`) -- it never touches a 2D rendering context, so a
// slow/large chart repaint can never contend with it handling the Stop
// button or relaying worker messages.
//
// A transferred canvas can never be un-transferred, so this worker is only
// ever attached to the dedicated #chartParallel canvas (see index.html) --
// the default single-threaded path keeps drawing on the ordinary #chart
// canvas from the main thread, completely unchanged (see the file header in
// worker_pool.js for why that separation exists).
//
// No hover/tooltip support here (v1 scoping choice, documented in
// BLUEPRINT.md) -- that would need the worker to answer "what's the nearest
// point to this mouse x" over another round of postMessage, which isn't
// worth the complexity for what's already an explicitly-labeled prototype.

import { drawLossChart } from "./chart_utils.js";

let canvas = null;
let ctx = null;
let theme = null;
let dpr = 1;
let lossHistory = [];

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    canvas = msg.canvas;
    theme = msg.theme;
    dpr = msg.dpr || 1;
    canvas.width = msg.width;
    canvas.height = msg.height;
    ctx = canvas.getContext("2d");
    draw();
  } else if (msg.type === "reset") {
    lossHistory = [];
    draw();
  } else if (msg.type === "loss") {
    lossHistory.push(msg.value);
    draw();
  } else if (msg.type === "resize") {
    canvas.width = msg.width;
    canvas.height = msg.height;
    dpr = msg.dpr || dpr;
    draw();
  }
};

function draw() {
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawLossChart(ctx, canvas.width / dpr, canvas.height / dpr, lossHistory, theme);
}
