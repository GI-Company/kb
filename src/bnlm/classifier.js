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
   * distribution and the raw logits, not just the argmax — a caller routing
   * on this needs the confidence to decide whether to act or defer to a
   * bigger model, and the logits to see how close the runner-up was.
   *
   * Deliberately cheap: one forward pass. Attribution costs one pass per
   * token, so it lives in attributeByOcclusion() rather than being charged
   * to every routing decision.
   *
   * @param {Int32Array|number[]} ids
   * @returns {Promise<{label:number, confidence:number, probs:number[], logits:number[], pooledNorm:number}>}
   */
  async predict(ids) {
    const truncated = ids.length > this.contextLen ? ids.slice(-this.contextLen) : ids;
    const T = Math.max(truncated.length, 1);
    const idsFlat = new Int32Array(T);
    idsFlat.set(truncated.length ? truncated : [0]);

    // encode() rather than forwardLogits() so the pooled vector is available
    // for the norm below without a second pass.
    const hidden = await this.trunk.encode(idsFlat, 1, T);
    const pooled = embeddingLookup(hidden, new Int32Array([T - 1]));
    const logitsTensor = addBias(await matmul(pooled, this.Wcls, false, true), this.bcls);

    const logits = Array.from(logitsTensor.data.subarray(0, this.numClasses));
    const max = Math.max(...logits);
    const exps = logits.map(v => Math.exp(v - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map(e => e / sum);

    let label = 0;
    for (let c = 1; c < probs.length; c++) if (probs[c] > probs[label]) label = c;

    let pooledNorm = 0;
    for (let d = 0; d < this.dModel; d++) pooledNorm += pooled.data[d] * pooled.data[d];
    pooledNorm = Math.sqrt(pooledNorm);

    return { label, confidence: probs[label], probs, logits, pooledNorm };
  }

  /**
   * The pooled representation alone — no classification head. Same forward
   * pass and same last-token pooling predict() uses, stopped one step
   * earlier, so a caller doing retrieval isn't also paying for (or
   * confusingly receiving) a label this text was never meant to be judged
   * against.
   *
   * @param {Int32Array|number[]} ids
   * @returns {Promise<Float32Array>} length dModel
   */
  async embed(ids) {
    const truncated = ids.length > this.contextLen ? ids.slice(-this.contextLen) : ids;
    const T = Math.max(truncated.length, 1);
    const idsFlat = new Int32Array(T);
    idsFlat.set(truncated.length ? truncated : [0]);

    const hidden = await this.trunk.encode(idsFlat, 1, T);
    const pooled = embeddingLookup(hidden, new Int32Array([T - 1]));
    return pooled.data.slice(0, this.dModel);
  }

  /**
   * Causal attribution by occlusion: drop each token in turn, re-run, and
   * measure how far the target class's probability falls. A positive score
   * means that token was holding the prediction up; a negative score means
   * it was arguing against it.
   *
   * Why occlusion and not a similarity score against the pooled vector: the
   * pooled vector IS the last token's hidden state under last-token pooling,
   * so comparing positions to it would score the final token 1.0 by
   * construction and tell you nothing about what actually drove the
   * decision. Occlusion measures a real counterfactual — remove this
   * evidence, does the answer change? — which is what "why" means here.
   *
   * Cost is one forward pass per token. That is only affordable because
   * these models are tiny (single-digit thousands of parameters); it would
   * be untenable at any serious scale, which is part of the argument for
   * keeping the specialists small.
   *
   * @param {Int32Array|number[]} ids
   * @param {number} [targetClass] defaults to the model's own prediction
   * @returns {Promise<{targetClass:number, baseline:number, contributions:{index:number, score:number}[]}>}
   */
  async attributeByOcclusion(ids, targetClass) {
    const truncated = ids.length > this.contextLen ? Array.from(ids).slice(-this.contextLen) : Array.from(ids);
    const base = await this.predict(truncated);
    const target = targetClass ?? base.label;
    const baseline = base.probs[target];

    // A single token can't be occluded — there'd be nothing left to classify.
    if (truncated.length < 2) {
      return { targetClass: target, baseline, contributions: [] };
    }

    const contributions = [];
    for (let i = 0; i < truncated.length; i++) {
      const without = truncated.slice(0, i).concat(truncated.slice(i + 1));
      const { probs } = await this.predict(without);
      contributions.push({ index: i, score: baseline - probs[target] });
    }
    return { targetClass: target, baseline, contributions };
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
