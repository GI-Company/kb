// worker_pool.js
// Main-thread coordinator for data-parallel training (see BLUEPRINT.md). Owns
// N Worker replicas (worker_train.js) and one optional chart-rendering
// Worker (chart_worker.js). This module runs on the main thread -- it's the
// piece that broadcasts weights out, collects gradients back, averages
// them, and hands the averaged gradient to the canonical model so the
// existing Adam optimizer (unchanged, still main-thread) can apply it.
//
// Deliberately NOT wired into the default single-threaded path: the
// existing #chart canvas keeps being drawn from the main thread exactly as
// before (see index.html). transferControlToOffscreen() is one-way and
// permanent for whichever canvas element it's called on, so parallel mode
// uses its own separate #chartParallel canvas rather than ever touching the
// one the simple path owns -- that's what keeps numWorkers=1 behaviorally
// identical to before this feature existed.

export class TrainingWorkerPool {
  constructor(numWorkers) {
    if (numWorkers < 1) throw new Error("numWorkers must be >= 1");
    this.numWorkers = numWorkers;
    this.workers = [];
    for (let i = 0; i < numWorkers; i++) {
      this.workers.push(new Worker(new URL("./worker_train.js", import.meta.url), { type: "module" }));
    }
  }

  async init(vocabSize, config) {
    await Promise.all(
      this.workers.map(
        (w) =>
          new Promise((resolve, reject) => {
            const handler = (e) => {
              if (e.data.type === "ready") {
                w.removeEventListener("message", handler);
                resolve();
              } else if (e.data.type === "error") {
                w.removeEventListener("message", handler);
                reject(new Error(e.data.message));
              } else {
                // Unexpected message type during init -- reject rather than
                // silently ignoring and leaving the Promise pending forever.
                w.removeEventListener("message", handler);
                reject(new Error(`Unexpected worker message type during init: ${JSON.stringify(e.data.type)}`));
              }
            };
            w.addEventListener("message", handler);
            w.postMessage({ type: "init", vocabSize, config });
          })
      )
    );
  }

  /**
   * One synchronous data-parallel step: broadcasts the model's current
   * weights + one batch per worker, averages the returned gradients into
   * the model's own parameter .grad buffers. Caller still calls
   * optimizer.step() afterward -- this function only computes the (averaged)
   * gradient, exactly mirroring what a single-threaded trainStep does
   * internally, just spread across workers.
   */
  async step(model, batches, B, T) {
    if (batches.length !== this.workers.length) {
      throw new Error(`expected ${this.workers.length} batches (one per worker), got ${batches.length}`);
    }
    const weights = model.parameters().map((p) => p.data);

    const results = await Promise.all(
      this.workers.map(
        (w, i) =>
          new Promise((resolve, reject) => {
            const handler = (e) => {
              if (e.data.type === "gradResult") {
                w.removeEventListener("message", handler);
                resolve(e.data);
              } else if (e.data.type === "error") {
                w.removeEventListener("message", handler);
                reject(new Error(e.data.message));
              } else {
                // Unexpected message type during step -- reject rather than
                // silently ignoring and leaving the Promise pending forever.
                w.removeEventListener("message", handler);
                reject(new Error(`Unexpected worker message type during step: ${JSON.stringify(e.data.type)}`));
              }
            };
            w.addEventListener("message", handler);
            w.postMessage({ type: "step", weights, input: batches[i].input, target: batches[i].target, B, T });
          })
      )
    );

    const params = model.parameters();
    for (let p = 0; p < params.length; p++) {
      const acc = params[p].grad;
      acc.fill(0);
      for (const r of results) {
        const g = r.grads[p];
        for (let k = 0; k < acc.length; k++) acc[k] += g[k] / this.workers.length;
      }
    }
    const avgLoss = results.reduce((s, r) => s + r.lossValue, 0) / results.length;
    return avgLoss;
  }

  destroy() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}

export class ChartWorkerHandle {
  constructor(canvasEl, theme) {
    // canvasEl is kept (not just its offscreen transfer) so resize() can
    // keep reading its live CSS size -- transferControlToOffscreen() moves
    // the *rendering context*, not the element's normal DOM layout/CSS sizing.
    this.canvasEl = canvasEl;
    const dpr = window.devicePixelRatio || 1;
    const w = canvasEl.clientWidth || 600, h = canvasEl.clientHeight || 180;
    const offscreen = canvasEl.transferControlToOffscreen(); // one-way -- see file header
    this.worker = new Worker(new URL("./chart_worker.js", import.meta.url), { type: "module" });
    this.worker.postMessage({ type: "init", canvas: offscreen, theme, width: w * dpr, height: h * dpr, dpr }, [offscreen]);
  }
  reset() { this.worker.postMessage({ type: "reset" }); }
  pushLoss(value) { this.worker.postMessage({ type: "loss", value }); }
  /** Re-reads the (still-DOM-controlled) canvas element's current CSS size and forwards it so the worker's drawing-buffer resolution stays correct after a window resize. */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvasEl.clientWidth || 600, h = this.canvasEl.clientHeight || 180;
    this.worker.postMessage({ type: "resize", width: w * dpr, height: h * dpr, dpr });
  }
  destroy() { this.worker.terminate(); }
}
