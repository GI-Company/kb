// worker_train.js
// Runs inside a dedicated Web Worker (loaded as an ES module). Holds one
// BNLM replica whose weights are overwritten from the main thread before
// every step, computes forward + backward on whatever batch it's handed,
// and posts the resulting gradients back. It never runs an optimizer step
// itself -- averaging gradients across workers and applying the update is
// the coordinator's job (see worker_pool.js), so every replica is guaranteed
// to start each step from the exact same weights instead of slowly drifting
// out of sync the way independently-stepping replicas could.
//
// See BLUEPRINT.md's "Worker/MessagePort data parallelism" section for why.

import { BNLM } from "./model.js";
import { crossEntropyLoss } from "./tensor.js";

let model = null;

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === "init") {
    // The seed here doesn't matter -- weights are overwritten from the
    // coordinator before the first step. What matters is that vocabSize/
    // config exactly match the main thread's model, so parameters() lines
    // up shape-for-shape and index-for-index between the two.
    model = new BNLM(msg.vocabSize, msg.config);
    self.postMessage({ type: "ready" });
    return;
  }

  if (msg.type === "step") {
    const params = model.parameters();
    if (params.length !== msg.weights.length) {
      self.postMessage({ type: "error", message: `param count mismatch: worker has ${params.length}, received ${msg.weights.length}` });
      return;
    }
    for (let i = 0; i < params.length; i++) params[i].data.set(msg.weights[i]);

    model.zeroGrad();
    const logits = await model.forward(msg.input, msg.B, msg.T);
    const { loss, value } = crossEntropyLoss(logits, msg.target);
    await loss.backward();

    const grads = params.map((p) => p.grad.slice()); // copy out -- structured clone will copy again on postMessage, but this keeps the worker's own live grad buffer untouched by that clone
    self.postMessage({ type: "gradResult", grads, lossValue: value, reqId: msg.reqId });
    return;
  }

  self.postMessage({ type: "error", message: `unknown message type: ${msg.type}` });
};
