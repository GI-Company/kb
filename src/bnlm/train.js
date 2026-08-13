// train.js
// Batch sampling + a single train step (forward -> loss -> backward -> Adam
// step). Kept tiny and framework-free on purpose -- this is the whole
// "training loop" a browser tab needs to run.

import { crossEntropyLoss } from "./tensor.js";
import { sampleDocBatch } from "./dataset.js";
import { clipGradNorm } from "./optim.js";

/**
 * Sample B random contiguous windows of length T from a single flat
 * tokenized corpus (Int32Array). Fine for one continuous text (a novel
 * excerpt, an essay); for a corpus made of many short independent examples
 * (TinyStories-style), use trainStep below with an array of per-document
 * token arrays instead -- see dataset.js for why that distinction matters.
 */
export function sampleBatch(data, B, T, rng = Math.random) {
  if (data.length < T + 1) throw new Error("corpus too short for the requested context length");
  const input = new Int32Array(B * T);
  const target = new Int32Array(B * T);
  for (let b = 0; b < B; b++) {
    const start = Math.floor(rng() * (data.length - T)); // inclusive range [0, data.length-T-1]
    for (let t = 0; t < T; t++) {
      input[b * T + t] = data[start + t];
      target[b * T + t] = data[start + t + 1];
    }
  }
  return { input, target };
}

/**
 * A single train step. `data` may be either a flat Int32Array (one
 * contiguous corpus -- windows are sampled anywhere in it) or an array of
 * per-document Int32Arrays (windows are sampled within a single document,
 * never crossing a document boundary -- see dataset.sampleDocBatch).
 *
 * `clipNorm` is optional and off by default (0/undefined): when set, global
 * gradient-norm clipping (see optim.js) is applied between backward() and
 * the optimizer step, as a safety net against exploding gradients at higher
 * learning rates. Leaving it off by default keeps this function's behavior
 * (and every existing test's recorded loss trajectory) exactly as it was
 * before clipping existed.
 */
export async function trainStep(model, optimizer, data, B, T, rng = Math.random, clipNorm = 0) {
  const { input, target } = Array.isArray(data) ? sampleDocBatch(data, B, T, rng) : sampleBatch(data, B, T, rng);
  model.zeroGrad();
  const logits = await model.forward(input, B, T);
  const { loss, value } = crossEntropyLoss(logits, target);
  await loss.backward();
  if (clipNorm > 0) clipGradNorm(model.parameters(), clipNorm);
  optimizer.step();
  return value;
}

export class ReplayBuffer {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.buffer = [];
    this.pointer = 0;
  }
  
  add(window) {
    if (this.buffer.length < this.maxSize) {
      this.buffer.push(window);
    } else {
      this.buffer[this.pointer] = window;
    }
    this.pointer = (this.pointer + 1) % this.maxSize;
  }

  sample(rng) {
    if (this.buffer.length === 0) return null;
    const idx = Math.floor(rng() * this.buffer.length);
    return this.buffer[idx];
  }

  serialize() {
    return {
      maxSize: this.maxSize,
      pointer: this.pointer,
      buffer: this.buffer.map(arr => Array.from(arr))
    };
  }

  deserialize(data) {
    if (data.maxSize) this.maxSize = data.maxSize;
    if (data.pointer !== undefined) this.pointer = data.pointer;
    if (data.buffer) {
      this.buffer = data.buffer.map(arr => new Int32Array(arr));
    }
  }
}

export async function onlineStep(model, optimizer, newTokens, replayBuffer, B, T, rng = Math.random, clipNorm = 0) {
  if (newTokens.length < T + 1) throw new Error("newTokens too short for context length");
  
  const input = new Int32Array(B * T);
  const target = new Int32Array(B * T);
  
  for (let b = 0; b < B; b++) {
    let sourceWindow;
    if (b === 0 || replayBuffer.buffer.length === 0 || rng() > 0.5) {
       const start = Math.floor(rng() * (newTokens.length - T));
       sourceWindow = newTokens.slice(start, start + T + 1);
    } else {
       sourceWindow = replayBuffer.sample(rng);
    }
    
    for (let t = 0; t < T; t++) {
      input[b * T + t] = sourceWindow[t];
      target[b * T + t] = sourceWindow[t + 1];
    }
  }

  model.zeroGrad();
  const logits = await model.forward(input, B, T);
  const { loss, value } = crossEntropyLoss(logits, target);
  await loss.backward();
  if (clipNorm > 0) clipGradNorm(model.parameters(), clipNorm);
  optimizer.step();
  return value;
}
