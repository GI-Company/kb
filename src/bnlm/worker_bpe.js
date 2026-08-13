// worker_bpe.js
// Runs BPETrainer inside a dedicated Web Worker so training a BPE tokenizer
// on a large corpus doesn't block the main thread. Uses the same
// postMessage-based protocol as worker_train.js.
//
// Message protocol:
//   Incoming: { type: "train", text: string, numMerges: number }
//   Outgoing: { type: "progress", mergesCompleted: number, total: number }
//              { type: "done", vocab: string[], mergeTable: [string,string][] }
//              { type: "error", message: string }

import { BPETrainer } from "./bpe_tokenizer.js";

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "train") {
    try {
      const { vocab, mergeTable } = BPETrainer.train(
        msg.text,
        msg.numMerges,
        (done, total) => {
          // Post progress every 64 merges to avoid flooding the main thread
          // with messages on large merge counts.
          if (done % 64 === 0 || done === total) {
            self.postMessage({ type: "progress", mergesCompleted: done, total });
          }
        }
      );
      self.postMessage({ type: "done", vocab, mergeTable });
    } catch (err) {
      self.postMessage({ type: "error", message: err.message });
    }
    return;
  }
  self.postMessage({ type: "error", message: `Unknown message type: ${msg.type}` });
};
