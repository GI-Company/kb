// BNLMSeq2Seq — an encoder-decoder pair, for "transform this into that"
// tasks (summarize, rephrase, translate a style) that the decoder-only
// generative model can't do: it only ever continues a prompt, it can't
// condition its whole output on a separate, fully-read source sequence.
//
// ARCHITECTURE
//
//   source tokens  → [encoder: BNLM trunk, NON-causal] → encoder hidden states
//   target tokens  → [decoder: BNLM trunk, causal self-attn
//                      + cross-attn over encoder hidden states] → logits
//
// The encoder is bidirectional (every position sees the whole source) — see
// model.js's encode(..., { causal: false }), added for exactly this. The
// decoder's self-attention is causal (reuses BNLM's own attention() method
// unmodified, on a second BNLM instance used purely as a decoder trunk);
// its cross-attention (crossAttention() below) is the one genuinely new
// primitive this model needs, since nothing else in this engine has one
// sequence's queries attend over a DIFFERENT sequence's keys/values.
//
// WHY NO BATCHING (B is always 1 here): cross-attention is non-causal, so
// unlike the decoder's own causal self-attention (where padding at the END
// of a sequence never reaches earlier valid positions), a padded ENCODER
// position would leak into every decoder position's attention unless
// explicitly masked. Building and threading that mask correctly is real
// complexity for what buys, at this model's scale, no fully solved
// problem. Training one (source, target) pair at a time sidesteps it
// entirely — no padding anywhere in this file, ever — at the cost of a
// noisier per-step gradient than a true batch would give. Given how small
// the encoder-decoder architecture already is, that's the right trade for
// a first version; batching with proper masking is a real, larger, later
// change, not a small tweak to this one.
//
// WHY A RESERVED BOS ID: CharTokenizer's vocabulary is exactly the
// characters seen in training, with no special tokens at all (see
// tokenizer.js). But a real seq2seq decoder needs SOMETHING to seed
// generation with, since the target text is exactly what's unknown at
// inference time — you can't "start" the decoder with the first character
// of an answer you don't have yet. So the decoder's token embedding table
// gets ONE extra row beyond the tokenizer's real vocabSize (id ===
// vocabSize), used only as that seed token, and never as a valid output —
// generate() explicitly restricts its search to real vocabulary ids.

import { BNLM, buildCausalMaskAdditive } from './model.js';
import {
  Tensor, zeros, randTensor, makeRng, embeddingLookup, addElem, layerNorm,
  linear, matmul, slice2D, scatterInto, scaleConst, softmaxRows, crossEntropyLoss,
} from './tensor.js';

/**
 * Decoder queries (xQuery) attend over encoder keys/values (xKV) — the one
 * primitive nothing else in this engine has, since every other attention
 * variant here has Q/K/V all come from the same sequence. Structurally
 * identical to BNLM.attention() (model.js) otherwise: same per-head
 * slice/matmul/softmax/scatter shape, just with independent sources and
 * row ranges for Q vs K/V, and no mask — a decoder position may attend
 * over the ENTIRE source, not just what came "before" it (source order
 * has no causal meaning from the decoder's point of view).
 */
/**
 * `attentionCapture`, if given, is pushed one `{ head, Tq, Tkv, weights }`
 * entry per head — `weights` is the raw post-softmax Float32Array (length
 * Tq*Tkv, row-major), read directly off the `probs` Tensor already computed
 * here for the real forward pass. Purely additive: `undefined` (the
 * default) skips the push entirely, so training pays nothing for it.
 */
async function crossAttention(xQuery, xKV, w, numHeads, headDim, B, Tq, Tkv, attentionCapture) {
  const Q = await linear(xQuery, w.Wq, w.bq);
  const K = await linear(xKV, w.Wk, w.bk);
  const V = await linear(xKV, w.Wv, w.bv);

  const pieces = [];
  for (let b = 0; b < B; b++) {
    const rq0 = b * Tq, rq1 = rq0 + Tq;
    const rk0 = b * Tkv, rk1 = rk0 + Tkv;
    for (let h = 0; h < numHeads; h++) {
      const c0 = h * headDim, c1 = c0 + headDim;
      const Qh = slice2D(Q, rq0, rq1, c0, c1);
      const Kh = slice2D(K, rk0, rk1, c0, c1);
      const Vh = slice2D(V, rk0, rk1, c0, c1);
      let scores = await matmul(Qh, Kh, false, true); // (Tq, Tkv)
      scores = scaleConst(scores, 1 / Math.sqrt(headDim));
      const probs = softmaxRows(scores);
      if (attentionCapture) attentionCapture.push({ head: h, Tq, Tkv, weights: probs.data });
      const headOut = await matmul(probs, Vh); // (Tq, headDim)
      pieces.push({ tensor: headOut, r0: rq0, c0 });
    }
  }
  const concat = scatterInto(B * Tq, numHeads * headDim, pieces);
  return linear(concat, w.Wo, w.bo);
}

export class BNLMSeq2Seq {
  /**
   * @param {number} vocabSize real character vocabulary size (shared by encoder and decoder input)
   * @param {{dModel:number, numLayers:number, numHeads:number, contextLen:number, mlpRatio?:number, seed?:number}} config
   */
  constructor(vocabSize, config) {
    const { dModel, numLayers, numHeads, seed = 1234 } = config;
    if (dModel % numHeads !== 0) throw new Error("dModel must be divisible by numHeads");
    this.vocabSize = vocabSize;
    this.bosId = vocabSize; // reserved decoder-seed id, one past the real vocabulary
    this.dModel = dModel;
    this.numHeads = numHeads;
    this.headDim = dModel / numHeads;

    this.encoder = new BNLM(vocabSize, { ...config, mixerType: 'attention' });
    // +1 for the reserved BOS row in the decoder's own token embedding.
    this.decoder = new BNLM(vocabSize + 1, { ...config, mixerType: 'attention', seed: seed + 1 });

    const rng = makeRng(seed + 99991);
    const std = 0.02;
    this.crossLayers = [];
    for (let l = 0; l < numLayers; l++) {
      this.crossLayers.push({
        lncg: new Tensor(new Float32Array(dModel).fill(1), [dModel], true),
        lncb: zeros([dModel], true),
        Wq: randTensor([dModel, dModel], std, true, rng), bq: zeros([dModel], true),
        Wk: randTensor([dModel, dModel], std, true, rng), bk: zeros([dModel], true),
        Wv: randTensor([dModel, dModel], std, true, rng), bv: zeros([dModel], true),
        Wo: randTensor([dModel, dModel], std, true, rng), bo: zeros([dModel], true),
      });
    }
  }

  parameters() {
    const cross = this.crossLayers.flatMap(l => [l.lncg, l.lncb, l.Wq, l.bq, l.Wk, l.bk, l.Wv, l.bv, l.Wo, l.bo]);
    return [...this.encoder.parameters(), ...this.decoder.parameters(), ...cross];
  }

  zeroGrad() {
    for (const p of this.parameters()) p.grad.fill(0);
  }

  paramCount() {
    return this.parameters().reduce((sum, p) => sum + p.data.length, 0);
  }

  /** @returns {Promise<Tensor>} (Tsrc, dModel) — bidirectional, every position sees the whole source. */
  async encodeSource(srcIdsFlat, Tsrc) {
    if (Tsrc > this.encoder.contextLen) {
      throw new Error(`source length ${Tsrc} exceeds contextLen ${this.encoder.contextLen}`);
    }
    return this.encoder.encode(srcIdsFlat, 1, Tsrc, { causal: false });
  }

  /**
   * One decoder forward pass: causal self-attention, then cross-attention
   * over the (already-computed) encoder hidden states, then MLP, per
   * layer — the standard Transformer decoder block, built by hand here
   * since BNLM.encode()'s own loop has no cross-attention step to
   * interleave. B is always 1 (see file header for why).
   *
   * `attentionCapture`, if given, receives the LAST layer's per-head
   * cross-attention weights (each a flat Float32Array of length Ttgt*Tsrc)
   * — purely additive, `undefined` by default so loss()'s training path
   * (which never passes it) pays nothing extra. Only the last layer:
   * that's the one whose attention pattern is most directly tied to what
   * actually gets weight-tied into the output logits two steps later, and
   * capturing every layer would multiply the bookkeeping for a glass-box
   * feature that only needs one honest answer, not four.
   * @returns {Promise<Tensor>} (Ttgt, vocabSize+1) logits, weight-tied against the decoder's own token embedding.
   */
  async decoderLogits(tgtIdsFlat, encoderHidden, Ttgt, Tsrc, attentionCapture) {
    const dec = this.decoder;
    if (Ttgt > dec.contextLen) throw new Error(`target length ${Ttgt} exceeds contextLen ${dec.contextLen}`);

    const tok = embeddingLookup(dec.tokEmb, tgtIdsFlat);
    const posIndices = new Int32Array(Ttgt);
    for (let t = 0; t < Ttgt; t++) posIndices[t] = t;
    const pos = embeddingLookup(dec.posEmb, posIndices);
    let x = addElem(tok, pos);

    const causalMaskAdd = buildCausalMaskAdditive(Ttgt);
    for (let i = 0; i < dec.layers.length; i++) {
      const layer = dec.layers[i];
      const cross = this.crossLayers[i];
      const isLastLayer = i === dec.layers.length - 1;

      const normed1 = layerNorm(x, layer.ln1g, layer.ln1b);
      const selfOut = await dec.attention(normed1, layer, 1, Ttgt, causalMaskAdd);
      x = addElem(x, selfOut);

      const normedCross = layerNorm(x, cross.lncg, cross.lncb);
      const crossOut = await crossAttention(
        normedCross, encoderHidden, cross, this.numHeads, this.headDim, 1, Ttgt, Tsrc,
        isLastLayer ? attentionCapture : undefined
      );
      x = addElem(x, crossOut);

      const normed2 = layerNorm(x, layer.ln2g, layer.ln2b);
      const mlpOut = await dec.mlp(normed2, layer);
      x = addElem(x, mlpOut);
    }

    const finalNormed = layerNorm(x, dec.lnfg, dec.lnfb);
    return matmul(finalNormed, dec.tokEmb, false, true); // weight-tied, same convention as BNLM.forward()
  }

  /**
   * Teacher-forced loss for one (source, target) pair. Decoder input is
   * [BOS, target[0..n-2]]; decoder target is [target[0..n-1]] — the
   * standard "shift right, seed with BOS" pattern.
   * @param {Int32Array|number[]} srcIds
   * @param {Int32Array|number[]} tgtIds must have at least 1 element
   * @returns {Promise<{loss: Tensor, value: number}>}
   */
  async loss(srcIds, tgtIds) {
    if (tgtIds.length === 0) throw new Error('target sequence must have at least 1 character');
    const Tsrc = srcIds.length;
    const Ttgt = tgtIds.length;

    const encoderHidden = await this.encodeSource(Int32Array.from(srcIds), Tsrc);

    const decInput = new Int32Array(Ttgt);
    decInput[0] = this.bosId;
    for (let i = 1; i < Ttgt; i++) decInput[i] = tgtIds[i - 1];

    const logits = await this.decoderLogits(decInput, encoderHidden, Ttgt, Tsrc);
    return crossEntropyLoss(logits, Int32Array.from(tgtIds));
  }

  /**
   * Autoregressive greedy generation: encode the source once, then decode
   * one character at a time, re-running the full (uncached) decoder each
   * step — O(steps^2) rather than the generative model's KV-cached O(steps),
   * an acceptable trade at this model's scale for not building a second
   * caching path for cross-attention. Stops early if the growing decoder
   * input would exceed its contextLen.
   * @param {Int32Array|number[]} srcIds
   * @param {number} maxNewTokens
   * @returns {Promise<number[]>} generated token ids, real vocabulary only (never bosId)
   */
  async generate(srcIds, maxNewTokens) {
    const Tsrc = srcIds.length;
    const encoderHidden = await this.encodeSource(Int32Array.from(srcIds), Tsrc);

    const decInput = [this.bosId];
    const generated = [];
    for (let step = 0; step < maxNewTokens; step++) {
      const Ttgt = decInput.length;
      if (Ttgt > this.decoder.contextLen) break;

      const logits = await this.decoderLogits(Int32Array.from(decInput), encoderHidden, Ttgt, Tsrc);
      const V = this.vocabSize + 1;
      const rowStart = (Ttgt - 1) * V;
      let best = 0;
      let bestVal = logits.data[rowStart];
      // Restricted to [0, vocabSize) -- bosId is a seed token, never a
      // valid generated character.
      for (let v = 1; v < this.vocabSize; v++) {
        const val = logits.data[rowStart + v];
        if (val > bestVal) { bestVal = val; best = v; }
      }
      generated.push(best);
      decInput.push(best);
    }
    return generated;
  }

  /**
   * Same generation loop as generate(), but also returns, for each
   * generated character, the last decoder layer's cross-attention weights
   * over the source — averaged across heads, since a glass box wants one
   * honest per-step answer, not `numHeads` competing ones. This is the
   * genuinely free half of interpretability here: the attention weights
   * are already computed as part of the real forward pass (see
   * crossAttention's attentionCapture), unlike the classifier/embedder's
   * occlusion, which needs extra forward passes it doesn't get for free.
   * @param {Int32Array|number[]} srcIds
   * @param {number} maxNewTokens
   * @returns {Promise<{generated: number[], attentionPerStep: Float32Array[]}>} attentionPerStep[i] has length Tsrc and sums to ~1
   */
  async generateWithAttention(srcIds, maxNewTokens) {
    const Tsrc = srcIds.length;
    const encoderHidden = await this.encodeSource(Int32Array.from(srcIds), Tsrc);

    const decInput = [this.bosId];
    const generated = [];
    const attentionPerStep = [];

    for (let step = 0; step < maxNewTokens; step++) {
      const Ttgt = decInput.length;
      if (Ttgt > this.decoder.contextLen) break;

      const attentionCapture = [];
      const logits = await this.decoderLogits(Int32Array.from(decInput), encoderHidden, Ttgt, Tsrc, attentionCapture);
      const V = this.vocabSize + 1;
      const rowStart = (Ttgt - 1) * V;
      let best = 0;
      let bestVal = logits.data[rowStart];
      for (let v = 1; v < this.vocabSize; v++) {
        const val = logits.data[rowStart + v];
        if (val > bestVal) { bestVal = val; best = v; }
      }
      generated.push(best);
      decInput.push(best);

      // The character just generated came from query row Ttgt-1 (the last
      // position before this step's append) — average that row across
      // every captured head.
      const avg = new Float32Array(Tsrc);
      for (const { Tkv, weights } of attentionCapture) {
        const rowOffset = (Ttgt - 1) * Tkv;
        for (let s = 0; s < Tsrc; s++) avg[s] += weights[rowOffset + s];
      }
      for (let s = 0; s < Tsrc; s++) avg[s] /= attentionCapture.length;
      attentionPerStep.push(avg);
    }
    return { generated, attentionPerStep };
  }
}
