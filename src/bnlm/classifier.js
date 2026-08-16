// BNLMClassifier — a second head on the same transformer trunk, trained on
// labeled examples instead of next-token prediction.
//
// WHY THIS EXISTS, and why it isn't just "the LM with a prompt":
//
// A decoder-only LM answers "what character comes next?" To use one as a
// tool you have to coax the answer out of free-form generation and then
// parse it, which is exactly where a model this size falls apart — a
// ~150k-parameter char-level model has no capacity to spare on producing
// well-formed output *and* being right. Empirically it produces noise on
// structured-completion tasks at this scale.
//
// Classification removes that whole failure mode. The output isn't text
// that might be malformed; it's a probability distribution over a fixed,
// known set of labels. The model never has to spell anything. All of its
// capacity goes into the only thing being asked of it: telling the classes
// apart. That is a task tiny models are genuinely good at, and it's what
// makes a local model usable as a *router* — the piece that decides which
// tool or handler should run, with no cloud call.
//
// ARCHITECTURE
//
//   tokens → [shared BNLM trunk] → hidden states (B*T, dModel)
//          → pool the last real token per sequence → (B, dModel)
//          → linear head → (B, numClasses) → softmax
//
// Last-token pooling (rather than mean pooling) is the right choice here
// because every mixer in this engine is causal: attention is causally
// masked, and linear/RWKV are recurrent. So position `len-1` is the only
// one that has seen the entire sequence. Mean pooling would average in
// early positions that saw almost nothing.
//
// Sequences in a batch are padded to a common length, and each example is
// pooled at its own true final index — so padding never contributes to the
// representation being classified.
//
// ON FREEZING THE TRUNK: don't. BNLM.freeze() exists for fine-tuning a
// *pretrained* language model, where the frozen layers hold representations
// worth preserving. This trunk is randomly initialized and trained from
// scratch alongside the head, so freezing it would leave the head as a
// linear probe over random projections. Measured on the 3-way intent router
// (167 held-out examples, identical config and step count):
//
//   trunk frozen, head only   51.5%
//   everything trained        95.2%
//
// The trunk learning the features is where nearly all the accuracy comes
// from. parameters() therefore returns trunk + head deliberately.

import { BNLM } from './model.js';
import {
  zeros, randTensor, makeRng, embeddingLookup, crossEntropyLoss, matmul, addBias,
} from './tensor.js';

export class BNLMClassifier {
  /**
   * @param {number} vocabSize
   * @param {number} numClasses
   * @param {{dModel:number, numLayers:number, numHeads:number, contextLen:number, mixerType?:string, seed?:number}} config
   */
  constructor(vocabSize, numClasses, config) {
    if (!Number.isInteger(numClasses) || numClasses < 2) {
      throw new Error(`numClasses must be an integer >= 2, got ${numClasses}`);
    }
    this.trunk = new BNLM(vocabSize, config);
    this.vocabSize = vocabSize;
    this.numClasses = numClasses;
    this.contextLen = config.contextLen;
    this.dModel = config.dModel;

    // Offset the seed so the head doesn't mirror the trunk's first matrix.
    const rng = makeRng((config.seed ?? 1234) + 7919);
    this.Wcls = randTensor([numClasses, config.dModel], 0.02, true, rng);
    this.bcls = zeros([numClasses], true);
  }

  parameters() {
    return [...this.trunk.parameters(), this.Wcls, this.bcls];
  }

  zeroGrad() {
    for (const p of this.parameters()) p.grad.fill(0);
  }

  paramCount() {
    return this.parameters().reduce((sum, p) => sum + p.data.length, 0);
  }

  /**
   * @param {Int32Array} idsFlat padded (B, T) token ids, row-major
   * @param {number} B batch size
   * @param {number} T padded sequence length
   * @param {Int32Array|number[]} lengths true length of each sequence, 1..T
   * @returns {Promise<Tensor>} class logits, shape (B, numClasses)
   */
  async forwardLogits(idsFlat, B, T, lengths) {
    const hidden = await this.trunk.encode(idsFlat, B, T);

    // Gather each sequence's last real position. embeddingLookup is a
    // differentiable row-gather, so gradients flow back to exactly the
    // positions that were pooled and nowhere else.
    const poolIndices = new Int32Array(B);
    for (let b = 0; b < B; b++) {
      const len = Math.min(Math.max(lengths[b], 1), T);
      poolIndices[b] = b * T + (len - 1);
    }
    const pooled = embeddingLookup(hidden, poolIndices);

    const logits = await matmul(pooled, this.Wcls, false, true);
    return addBias(logits, this.bcls);
  }

  /**
   * Cross-entropy against integer class labels.
   * @returns {Promise<{loss: Tensor, value: number}>}
   */
  async loss(idsFlat, B, T, lengths, labels) {
    const logits = await this.forwardLogits(idsFlat, B, T, lengths);
    return crossEntropyLoss(logits, labels);
  }

  /**
   * Inference for a single sequence. Returns the full probability
   * distribution, not just the argmax — a caller routing on this needs the
   * confidence to decide whether to act or fall back to a bigger model.
   * @param {Int32Array|number[]} ids
   * @returns {Promise<{label:number, confidence:number, probs:number[]}>}
   */
  async predict(ids) {
    const truncated = ids.length > this.contextLen ? ids.slice(-this.contextLen) : ids;
    const T = Math.max(truncated.length, 1);
    const idsFlat = new Int32Array(T);
    idsFlat.set(truncated.length ? truncated : [0]);

    const logits = await this.forwardLogits(idsFlat, 1, T, [T]);

    const row = Array.from(logits.data.subarray(0, this.numClasses));
    const max = Math.max(...row);
    const exps = row.map(v => Math.exp(v - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map(e => e / sum);

    let label = 0;
    for (let c = 1; c < probs.length; c++) if (probs[c] > probs[label]) label = c;
    return { label, confidence: probs[label], probs };
  }
}

/**
 * Pads a batch of variable-length id arrays into a flat (B, T) buffer,
 * returning the true lengths so pooling can skip the padding.
 *
 * Sequences longer than contextLen keep their TAIL rather than their head:
 * with last-token pooling the final positions are what actually get
 * classified, so dropping the front preserves the part that matters.
 */
export function padBatch(sequences, contextLen) {
  const clipped = sequences.map(s => (s.length > contextLen ? s.slice(-contextLen) : s));
  const T = Math.max(1, ...clipped.map(s => s.length));
  const B = clipped.length;
  const idsFlat = new Int32Array(B * T);
  const lengths = new Int32Array(B);
  for (let b = 0; b < B; b++) {
    const seq = clipped[b];
    lengths[b] = Math.max(seq.length, 1);
    for (let t = 0; t < seq.length; t++) idsFlat[b * T + t] = seq[t];
  }
  return { idsFlat, B, T, lengths };
}
