// model.js
// BNLM: a small decoder-only Transformer, architected to be trained AND
// run entirely client-side (see ../BLUEPRINT.md for the full rationale).
//
// - Character-level or BPE vocabulary (caller supplies vocabSize)
// - Weight-tied output projection
// - Pre-norm blocks: LN -> causal token-mixer -> residual,
//                    LN -> 2-layer GELU MLP -> residual
// - Three selectable mixers (config.mixerType):
//     'attention' (default) - standard causal multi-head softmax attention,
//        with learned absolute positional embeddings and an O(T^2) cost that's
//        negligible at this model's short context lengths. Includes a KV-cache
//        generation path (generateWithCache) that reduces per-token cost to
//        O(T) by reusing K/V projections across generation steps. The cache is
//        hard-capped at contextLen total tokens (prompt + generated) -- no
//        eviction or position remapping. For unbounded generation use 'linear'
//        or 'rwkv'.
//     'linear'    - causal linear attention (Katharopoulos et al., "Transformers
//        are RNNs"): a positive feature map replaces softmax, which makes the
//        causal weighted-average a cumulative sum instead of a full T*T matrix.
//        Trained here in its O(T) *parallel* form, but generates via the
//        exactly-equivalent O(1)-memory *recurrent* form (generateRecurrent).
//     'rwkv'      - RWKV v4 mixer: adds learned time-decay (w) and receptance
//        gate (r) on top of the linear-attention structure. Generates via the
//        recurrent form with log-space stabilization (no overflow at T=128+).
//
// Every op is gradient-checked in test/gradcheck.mjs.

import {
  Tensor, randTensor, zeros, linear, addElem, addConst, scaleConst,
  gelu, layerNorm, softmaxRows, slice2D, scatterInto, matmul,
  embeddingLookup, crossEntropyLoss, makeRng, featureMap, mulConst, rowNormalize,
  sigmoid, expNeg, hadamard,
  GELU_C1, GELU_C2,
} from "./tensor.js";

export class BNLM {
  /**
   * @param {number} vocabSize
   * @param {{dModel:number, numLayers:number, numHeads:number, contextLen:number, mlpRatio?:number, seed?:number, mixerType?:'attention'|'linear'|'rwkv'}} config
   */
  constructor(vocabSize, config) {
    const { dModel, numLayers, numHeads, contextLen, mlpRatio = 4, seed = 1234, mixerType = "attention" } = config;
    if (dModel % numHeads !== 0) throw new Error("dModel must be divisible by numHeads");
    if (!['attention', 'linear', 'rwkv'].includes(mixerType)) throw new Error(`unknown mixerType ${mixerType}`);
    this.vocabSize = vocabSize;
    this.dModel = dModel;
    this.numLayers = numLayers;
    this.numHeads = numHeads;
    this.contextLen = contextLen;
    this.headDim = dModel / numHeads;
    this.mixerType = mixerType;

    const rng = makeRng(seed);
    const std = 0.02;
    const dHidden = dModel * mlpRatio;

    this.tokEmb = randTensor([vocabSize, dModel], std, true, rng);
    // posEmb: only used by attention. Linear and RWKV encode order via recurrence.
    this.posEmb = randTensor([contextLen, dModel], std, mixerType === "attention", rng);

    this.layers = [];
    for (let l = 0; l < numLayers; l++) {
      const layer = {
        ln1g: onesTensor(dModel), ln1b: zeros([dModel], true),
        Wq: randTensor([dModel, dModel], std, true, rng), bq: zeros([dModel], true),
        Wk: randTensor([dModel, dModel], std, true, rng), bk: zeros([dModel], true),
        Wv: randTensor([dModel, dModel], std, true, rng), bv: zeros([dModel], true),
        Wo: randTensor([dModel, dModel], std, true, rng), bo: zeros([dModel], true),
        ln2g: onesTensor(dModel), ln2b: zeros([dModel], true),
        W1: randTensor([dHidden, dModel], std, true, rng), b1: zeros([dHidden], true),
        W2: randTensor([dModel, dHidden], std, true, rng), b2: zeros([dModel], true),
      };
      if (mixerType === "rwkv") {
        // RWKV v4 additional parameters:
        //   mu_k, mu_v, mu_r: time-mix coefficients in [0,1] for keys, values, receptance.
        //     x_mixed = mu * x_t + (1-mu) * x_{t-1}, where x is the input to each projection.
        //   w: log-decay in unconstrained log-log space; actual decay = expNeg(w) in (0,1).
        //   u: time-first bonus; added to the current-token term in the WKV numerator.
        //   Wr, br: receptance gate projection (r = sigmoid(Wr @ x + br)).
        layer.mu_k = randTensor([dModel], std, true, rng);
        layer.mu_v = randTensor([dModel], std, true, rng);
        layer.mu_r = randTensor([dModel], std, true, rng);
        // Initialize w to small positive values so expNeg(w) ≈ exp(-1) ≈ 0.37 initially.
        layer.w = randTensor([dModel], std, true, rng);
        // u initialized near 0 so the time-first bonus starts small.
        layer.u = randTensor([dModel], std, true, rng);
        layer.Wr = randTensor([dModel, dModel], std, true, rng);
        layer.br = zeros([dModel], true);
      }
      this.layers.push(layer);
    }
    this.lnfg = onesTensor(dModel);
    this.lnfb = zeros([dModel], true);
  }

  freeze(freezeEmbeddings = true, numFrozenLayers = null) {
    this.freezeEmbeddings = freezeEmbeddings;
    this.numFrozenLayers = numFrozenLayers ?? Math.max(0, this.numLayers - 1);
  }

  parameters(unfrozenOnly = false) {
    const ps = [];
    if (!unfrozenOnly || !this.freezeEmbeddings) {
      ps.push(this.tokEmb);
      if (this.mixerType === "attention") ps.push(this.posEmb);
    }
    
    ps.push(this.lnfg, this.lnfb);
    
    const startLayer = (unfrozenOnly && this.numFrozenLayers > 0) ? this.numFrozenLayers : 0;
    
    for (let i = startLayer; i < this.layers.length; i++) {
      const l = this.layers[i];
      ps.push(l.ln1g, l.ln1b, l.Wq, l.bq, l.Wk, l.bk, l.Wv, l.bv, l.Wo, l.bo, l.ln2g, l.ln2b, l.W1, l.b1, l.W2, l.b2);
      if (this.mixerType === "rwkv") ps.push(l.mu_k, l.mu_v, l.mu_r, l.w, l.u, l.Wr, l.br);
    }
    return ps;
  }

  zeroGrad() {
    for (const p of this.parameters()) p.zeroGrad();
  }

  paramCount() {
    return this.parameters().reduce((sum, p) => sum + p.data.length, 0);
  }

  /**
   * @param {Int32Array|number[]} idsFlat - flattened (B, T) token ids, row-major
   * @param {number} B, {number} T
   * @returns {Promise<Tensor>} logits, shape (B*T, vocabSize)
   */
  async forward(idsFlat, B, T) {
    const finalNormed = await this.encode(idsFlat, B, T);
    // Weight-tied output projection: reuse the token embedding as the
    // unembedding matrix.
    return matmul(finalNormed, this.tokEmb, false, true);
  }

  /**
   * The trunk: everything forward() does except the projection to vocab
   * logits. Returns the final layer-normed hidden states, shape
   * (B*T, dModel).
   *
   * Split out so heads other than next-token prediction can be attached to
   * the same body — see classifier.js, which pools these states and runs a
   * classification head instead. Language modeling is one task this trunk
   * can do, not the only one it's capable of.
   */
  async encode(idsFlat, B, T) {
    if (T > this.contextLen) throw new Error(`sequence length ${T} exceeds contextLen ${this.contextLen}`);

    const tok = embeddingLookup(this.tokEmb, idsFlat);
    let x;
    if (this.mixerType === "attention") {
      const posIndices = new Int32Array(B * T);
      for (let b = 0; b < B; b++) for (let t = 0; t < T; t++) posIndices[b * T + t] = t;
      const pos = embeddingLookup(this.posEmb, posIndices);
      x = addElem(tok, pos);
    } else {
      x = tok;
    }

    const causalMaskAdd = this.mixerType === "attention" ? buildCausalMaskAdditive(T) : null;
    const causalMask01 = this.mixerType === "linear" ? buildCausalMask01(T) : null;

    for (const layer of this.layers) {
      const normed1 = layerNorm(x, layer.ln1g, layer.ln1b);
      let mixOut;
      if (this.mixerType === "attention") {
        mixOut = await this.attention(normed1, layer, B, T, causalMaskAdd);
      } else if (this.mixerType === "linear") {
        mixOut = await this.linearMixer(normed1, layer, B, T, causalMask01);
      } else {
        mixOut = await this.rwkvMixer(normed1, layer, B, T);
      }
      x = addElem(x, mixOut);

      const normed2 = layerNorm(x, layer.ln2g, layer.ln2b);
      const mlpOut = await this.mlp(normed2, layer);
      x = addElem(x, mlpOut);
    }

    return layerNorm(x, this.lnfg, this.lnfb);
  }

  async attention(x, layer, B, T, causalMaskAdd) {
    const { numHeads, headDim } = this;
    const Q = await linear(x, layer.Wq, layer.bq);
    const K = await linear(x, layer.Wk, layer.bk);
    const V = await linear(x, layer.Wv, layer.bv);

    const pieces = [];
    for (let b = 0; b < B; b++) {
      const r0 = b * T, r1 = r0 + T;
      for (let h = 0; h < numHeads; h++) {
        const c0 = h * headDim, c1 = c0 + headDim;
        const Qh = slice2D(Q, r0, r1, c0, c1);
        const Kh = slice2D(K, r0, r1, c0, c1);
        const Vh = slice2D(V, r0, r1, c0, c1);
        let scores = await matmul(Qh, Kh, false, true); // (T, T)
        scores = scaleConst(scores, 1 / Math.sqrt(headDim));
        scores = addConst(scores, causalMaskAdd);
        const probs = softmaxRows(scores);
        const headOut = await matmul(probs, Vh); // (T, headDim)
        pieces.push({ tensor: headOut, r0, c0 });
      }
    }
    const concat = scatterInto(B * T, this.dModel, pieces);
    return linear(concat, layer.Wo, layer.bo);
  }

  /** Causal linear attention, parallel/cumulative training form. See file header. */
  async linearMixer(x, layer, B, T, causalMask01) {
    const { numHeads, headDim } = this;
    const Q = await linear(x, layer.Wq, layer.bq);
    const K = await linear(x, layer.Wk, layer.bk);
    const V = await linear(x, layer.Wv, layer.bv);

    const pieces = [];
    for (let b = 0; b < B; b++) {
      const r0 = b * T, r1 = r0 + T;
      for (let h = 0; h < numHeads; h++) {
        const c0 = h * headDim, c1 = c0 + headDim;
        const Qh = featureMap(slice2D(Q, r0, r1, c0, c1));
        const Kh = featureMap(slice2D(K, r0, r1, c0, c1));
        const Vh = slice2D(V, r0, r1, c0, c1);
        let scores = await matmul(Qh, Kh, false, true); // (T, T), non-negative
        scores = mulConst(scores, causalMask01);
        const probs = rowNormalize(scores);
        const headOut = await matmul(probs, Vh); // (T, headDim)
        pieces.push({ tensor: headOut, r0, c0 });
      }
    }
    const concat = scatterInto(B * T, this.dModel, pieces);
    return linear(concat, layer.Wo, layer.bo);
  }

  async rwkvMixer(x, layer, B, T) {
    const { dModel } = this;
    const x_prev = shiftTime(x, B, T, dModel);
    const xk = timeMix(x, x_prev, layer.mu_k);
    const xv = timeMix(x, x_prev, layer.mu_v);
    const xr = timeMix(x, x_prev, layer.mu_r);

    const r = sigmoid(await linear(xr, layer.Wr, layer.br));
    const k = await linear(xk, layer.Wk, layer.bk);
    const v = await linear(xv, layer.Wv, layer.bv);

    const scores = rwkvScores(k, layer.w, layer.u, B, T, dModel);
    const probs = softmaxRows(scores);
    const wkv = rwkvAttnSum(probs, v, B, T, dModel);

    const rwkv_out = hadamard(r, wkv);
    return linear(rwkv_out, layer.Wo, layer.bo);
  }

  async mlp(x, layer) {
    const h = await linear(x, layer.W1, layer.b1);
    const a = gelu(h);
    return linear(a, layer.W2, layer.b2);
  }

  /**
   * Autoregressive sampling. promptIds: array of token ids. Returns array of
   * generated token ids (not including the prompt). Dispatches to the best
   * available generation strategy for the mixer type:
   *   'linear' -> generateRecurrent (O(1) memory per token, unbounded length)
   *   'attention' -> generateWithCache (O(T) per step within contextLen)
   *
   * generateBatched is still available directly for compatibility.
   */
  async generate(promptIds, maxNewTokens, opts = {}) {
    if (this.mixerType === "linear") return this.generateRecurrent(promptIds, maxNewTokens, opts);
    if (this.mixerType === "rwkv") return this.generateRecurrentRWKV(promptIds, maxNewTokens, opts);
    // For attention: use the KV cache if the prompt fits in the context window,
    // otherwise fall back to the sliding-window batched path.
    if (promptIds.length < this.contextLen) return this.generateWithCache(promptIds, maxNewTokens, opts);
    return this.generateBatched(promptIds, maxNewTokens, opts);
  }

  /**
   * KV-cache attention generation -- O(T) per new token instead of O(T^2).
   *
   * CONTRACT: hard-capped at contextLen total tokens (prompt + generated).
   * Attempting to generate past this limit throws a clear Error rather than
   * silently truncating or producing NaN. Users who need unbounded generation
   * should use the 'linear' or (future) 'rwkv' mixer.
   *
   * Why no sliding window / eviction: the attention model uses learned absolute
   * positional embeddings. Evicting the oldest K/V rows would require remapping
   * position IDs for everything remaining in the cache -- a non-trivial change
   * to the embedding semantics. The KV cache is a speed improvement, not a
   * context extension.
   */
  async generateWithCache(promptIds, maxNewTokens, { temperature = 0.8, topK = 0, rng = Math.random } = {}) {
    if (this.mixerType !== "attention") throw new Error("generateWithCache is only for the attention mixer");
    if (promptIds.length === 0) throw new Error("generateWithCache needs at least one prompt token");
    if (promptIds.length >= this.contextLen) {
      throw new Error(
        `Prompt length (${promptIds.length}) fills the entire context window (contextLen=${this.contextLen}). ` +
        `Use the 'linear' or 'rwkv' mixer for unbounded generation.`
      );
    }

    const maxNew = Math.min(maxNewTokens, this.contextLen - promptIds.length);
    if (maxNew < maxNewTokens) {
      console.warn(
        `[generateWithCache] capping maxNewTokens from ${maxNewTokens} to ${maxNew} ` +
        `(contextLen=${this.contextLen}, prompt=${promptIds.length} tokens). ` +
        `Use the 'linear' or 'rwkv' mixer for generation past contextLen.`
      );
    }

    // Pre-fill: run full forward over the prompt, extracting K/V per layer.
    const cache = await this._cachePopulate(Array.from(promptIds));

    // Get logits for the last prompt position.
    let lastLogits = cache.lastLogits;

    const generated = [];
    for (let step = 0; step < maxNew; step++) {
      const nextId = sampleFromLogits(lastLogits, temperature, topK, rng);
      generated.push(nextId);
      const pos = promptIds.length + step; // absolute position of the new token
      lastLogits = await this._cacheStep(nextId, pos, cache);
    }
    return generated;
  }

  /**
   * Pre-fill the KV cache by running a full forward pass over promptIds.
   * Returns a cache object containing K and V Float32Array slices per layer,
   * and the logits for the final prompt position.
   * @private
   */
  async _cachePopulate(promptIds) {
    const T = promptIds.length;
    const { dModel, numHeads, headDim, numLayers } = this;

    // Standard forward pass to get all intermediate K/V.
    // We re-implement the relevant parts inline to intercept K and V tensors
    // before they pass through matmul -- forward() doesn't expose them.
    const idsFlat = Int32Array.from(promptIds);
    const tok = embeddingLookup(this.tokEmb, idsFlat);
    const posIndices = new Int32Array(T);
    for (let t = 0; t < T; t++) posIndices[t] = t;
    const pos = embeddingLookup(this.posEmb, posIndices);
    let x = addElem(tok, pos);

    const causalMaskAdd = buildCausalMaskAdditive(T);

    // Per-layer K/V caches. Each is a Float32Array of shape (T, dModel),
    // stored row-major. We'll grow them by one row per generation step.
    const layerCaches = [];

    for (let li = 0; li < numLayers; li++) {
      const layer = this.layers[li];
      const normed1 = layerNorm(x, layer.ln1g, layer.ln1b);

      // Compute Q, K, V projections.
      const Q = await linear(normed1, layer.Wq, layer.bq);
      const K = await linear(normed1, layer.Wk, layer.bk);
      const V = await linear(normed1, layer.Wv, layer.bv);

      // Store K and V as plain Float32Arrays (no grad needed at inference).
      const Kdata = K.data.slice(); // (T, dModel)
      const Vdata = V.data.slice();

      // Run the attention forward using cached K/V (same as attention() but
      // we already have K/V computed).
      const Qdata = Q.data;
      const pieces = [];
      for (let h = 0; h < numHeads; h++) {
        const c0 = h * headDim, c1 = c0 + headDim;
        // Extract head slices from the flat (T, dModel) arrays.
        const Qh_data = new Float32Array(T * headDim);
        const Kh_data = new Float32Array(T * headDim);
        const Vh_data = new Float32Array(T * headDim);
        for (let t = 0; t < T; t++) {
          Qh_data.set(Qdata.subarray(t * dModel + c0, t * dModel + c1), t * headDim);
          Kh_data.set(Kdata.subarray(t * dModel + c0, t * dModel + c1), t * headDim);
          Vh_data.set(Vdata.subarray(t * dModel + c0, t * dModel + c1), t * headDim);
        }
        // Use the existing slice2D/matmul/softmax flow by wrapping in Tensors.
        const Qh = new Tensor(Qh_data, [T, headDim], false);
        const Kh = new Tensor(Kh_data, [T, headDim], false);
        const Vh = new Tensor(Vh_data, [T, headDim], false);
        let scores = await matmul(Qh, Kh, false, true);
        scores = scaleConst(scores, 1 / Math.sqrt(headDim));
        scores = addConst(scores, causalMaskAdd);
        const probs = softmaxRows(scores);
        const headOut = await matmul(probs, Vh);
        pieces.push({ tensor: headOut, r0: 0, c0 });
      }
      const concat = scatterInto(T, dModel, pieces);
      const mixOut = await linear(concat, layer.Wo, layer.bo);
      x = addElem(x, mixOut);

      const normed2 = layerNorm(x, layer.ln2g, layer.ln2b);
      const mlpOut = await this.mlp(normed2, layer);
      x = addElem(x, mlpOut);

      layerCaches.push({ K: Kdata, V: Vdata, len: T }); // len = filled rows
    }

    // Final LN + weight-tied output projection for the last token's logits.
    const finalNormed = layerNorm(x, this.lnfg, this.lnfb);
    const logitsTensor = await matmul(finalNormed, this.tokEmb, false, true);
    const lastStart = (T - 1) * this.vocabSize;
    const lastLogits = logitsTensor.data.slice(lastStart, lastStart + this.vocabSize);

    return { layerCaches, lastLogits };
  }

  /**
   * Extend the KV cache by one token and return that token's logits.
   * @param {number} tokenId - the new token id
   * @param {number} pos - its absolute position (promptLen, promptLen+1, ...)
   * @param {object} cache - the cache object returned by _cachePopulate
   * @private
   */
  async _cacheStep(tokenId, pos, cache) {
    const { dModel, numHeads, headDim, numLayers } = this;
    const { layerCaches } = cache;

    // Embed the single new token + its position.
    const tokVec = this.tokEmb.data.slice(tokenId * dModel, tokenId * dModel + dModel);
    const posVec = this.posEmb.data.slice(pos * dModel, pos * dModel + dModel);
    let xVec = new Float32Array(dModel);
    for (let d = 0; d < dModel; d++) xVec[d] = tokVec[d] + posVec[d];

    for (let li = 0; li < numLayers; li++) {
      const layer = this.layers[li];
      const lc = layerCaches[li];
      const T_cur = lc.len; // current cache length (prompt + steps so far)

      // LN on single vector
      const normed1 = layerNormVec(xVec, layer.ln1g.data, layer.ln1b.data, dModel);

      // Q, K, V projections for just this one token.
      const qVec = matVec(layer.Wq.data, dModel, dModel, normed1, layer.bq.data);
      const kVec = matVec(layer.Wk.data, dModel, dModel, normed1, layer.bk.data);
      const vVec = matVec(layer.Wv.data, dModel, dModel, normed1, layer.bv.data);

      // Append new K and V rows to the cache.
      const newK = new Float32Array((T_cur + 1) * dModel);
      const newV = new Float32Array((T_cur + 1) * dModel);
      newK.set(lc.K); newK.set(kVec, T_cur * dModel);
      newV.set(lc.V); newV.set(vVec, T_cur * dModel);
      lc.K = newK; lc.V = newV; lc.len = T_cur + 1;

      // Attention: compute scores between the new Q and ALL cached K rows.
      const concatVec = new Float32Array(dModel);
      for (let h = 0; h < numHeads; h++) {
        const c0 = h * headDim;
        const qh = qVec.slice(c0, c0 + headDim);

        // Dot Q_h with every cached K_h row.
        const T_now = lc.len; // = T_cur + 1
        const scores = new Float32Array(T_now);
        const scale = 1 / Math.sqrt(headDim);
        for (let t = 0; t < T_now; t++) {
          let dot = 0;
          for (let d = 0; d < headDim; d++) dot += qh[d] * lc.K[t * dModel + c0 + d];
          scores[t] = dot * scale;
        }

        // Causal mask: only attend to t <= pos, which is all T_now entries
        // (we never call _cacheStep for future positions).
        // Stable softmax over scores.
        let maxS = -Infinity;
        for (let t = 0; t < T_now; t++) if (scores[t] > maxS) maxS = scores[t];
        let sumExp = 0;
        const attnW = new Float32Array(T_now);
        for (let t = 0; t < T_now; t++) { attnW[t] = Math.exp(scores[t] - maxS); sumExp += attnW[t]; }
        for (let t = 0; t < T_now; t++) attnW[t] /= sumExp;

        // Weighted sum of cached V rows.
        const headOut = new Float32Array(headDim);
        for (let t = 0; t < T_now; t++) {
          const w = attnW[t];
          for (let d = 0; d < headDim; d++) headOut[d] += w * lc.V[t * dModel + c0 + d];
        }
        concatVec.set(headOut, c0);
      }

      const mixOut = matVec(layer.Wo.data, dModel, dModel, concatVec, layer.bo.data);
      xVec = addVec(xVec, mixOut);

      // MLP
      const normed2 = layerNormVec(xVec, layer.ln2g.data, layer.ln2b.data, dModel);
      const hidden = matVec(layer.W1.data, layer.W1.shape[0], layer.W1.shape[1], normed2, layer.b1.data);
      const act = geluVec(hidden);
      const mlpOut = matVec(layer.W2.data, layer.W2.shape[0], layer.W2.shape[1], act, layer.b2.data);
      xVec = addVec(xVec, mlpOut);
    }

    // Final LN + weight-tied projection -> logits for this single token.
    const finalNormed = layerNormVec(xVec, this.lnfg.data, this.lnfb.data, dModel);
    const logits = new Float32Array(this.vocabSize);
    for (let v = 0; v < this.vocabSize; v++) {
      let s = 0;
      for (let d = 0; d < dModel; d++) s += finalNormed[d] * this.tokEmb.data[v * dModel + d];
      logits[v] = s;
    }
    return logits;
  }

  async generateBatched(promptIds, maxNewTokens, { temperature = 0.8, topK = 0, rng = Math.random } = {}) {
    let ids = Array.from(promptIds);
    const generated = [];
    for (let step = 0; step < maxNewTokens; step++) {
      const windowIds = ids.slice(Math.max(0, ids.length - this.contextLen));
      const T = windowIds.length;
      const logits = await this.forward(Int32Array.from(windowIds), 1, T);
      const lastRowStart = (T - 1) * this.vocabSize;
      const rowLogits = logits.data.subarray(lastRowStart, lastRowStart + this.vocabSize);
      const nextId = sampleFromLogits(rowLogits, temperature, topK, rng);
      ids.push(nextId);
      generated.push(nextId);
    }
    return generated;
  }

  /**
   * Initializes and returns a fresh, empty recurrent state object based on `this.mixerType`.
   * @returns {Array} A nested array of Float32Arrays representing the layer states.
   */
  createEmptyState() {
    if (this.mixerType === 'linear') {
      return this.layers.map(() =>
        Array.from({ length: this.numHeads }, () => ({
          S: new Float32Array(this.headDim * this.headDim),
          z: new Float32Array(this.headDim),
        }))
      );
    } else if (this.mixerType === 'rwkv') {
      return this.layers.map(() => ({
        x_prev: new Float32Array(this.dModel),
        num: new Float32Array(this.dModel),
        den: new Float32Array(this.dModel),
        max: new Float32Array(this.dModel).fill(-Infinity),
      }));
    }
    throw new Error(`createEmptyState not supported for mixerType: ${this.mixerType}`);
  }

  /**
   * Instance-level state management for continuous generation sessions.
   * Allows the UI to pause, inspect, and resume.
   */
  getRecurrentState() {
    if (!this._currentState) {
      this._currentState = this.createEmptyState();
    }
    return this._currentState;
  }

  setRecurrentState(state) {
    this._currentState = state;
  }

  /**
   * Advances the recurrent state by exactly one token.
   * Note: For performance in JS, this mutates `state` in-place rather than deeply 
   * cloning it every step. It returns the logits for the next token.
   * 
   * @param {number} tokenId - The input token ID
   * @param {Array} state - The current recurrent state (mutated in-place)
   * @returns {Float32Array} The output logits of shape (vocabSize,)
   */
  stepRecurrentToken(tokenId, state) {
    if (this.mixerType === 'linear') {
      return this.stepToken(tokenId, state);
    } else if (this.mixerType === 'rwkv') {
      return this.stepTokenRWKV(tokenId, state);
    }
    throw new Error(`stepRecurrentToken not supported for mixerType: ${this.mixerType}`);
  }

  /**
   * Pure-numeric (no autograd, no GPU round-trip) token-by-token generation
   * for 'linear'-mixer models: carries one (headDim x headDim) state matrix
   * S and one (headDim,) normalizer z *per head, per layer*, updated
   * incrementally as each new token is fed in. Memory and per-token compute
   * are both independent of how much has already been generated -- unlike
   * generateBatched, there is no growing window to recompute. Mathematically
   * this is exactly the same computation as linearMixer()'s parallel form
   * (see test/linear_mixer_smoke.mjs for the numerical equivalence check),
   * just reassociated into a running sum instead of a materialized T*T matrix.
   */
  async generateRecurrent(promptIds, maxNewTokens, { temperature = 0.8, topK = 0, rng = Math.random } = {}) {
    if (promptIds.length === 0) throw new Error("generateRecurrent needs at least one prompt token");
    const states = this.createEmptyState();

    let lastLogits = null;
    for (const id of promptIds) lastLogits = this.stepRecurrentToken(id, states);

    const generated = [];
    for (let i = 0; i < maxNewTokens; i++) {
      const nextId = sampleFromLogits(lastLogits, temperature, topK, rng);
      generated.push(nextId);
      lastLogits = this.stepRecurrentToken(nextId, states);
    }
    return generated;
  }

  /**
   * Recurrent generation for RWKV.
   */
  async generateRecurrentRWKV(promptIds, maxNewTokens, { temperature = 0.8, topK = 0, rng = Math.random } = {}) {
    if (promptIds.length === 0) throw new Error("generateRecurrentRWKV needs at least one prompt token");
    const states = this.createEmptyState();

    let lastLogits = null;
    for (const id of promptIds) lastLogits = this.stepRecurrentToken(id, states);

    const generated = [];
    for (let i = 0; i < maxNewTokens; i++) {
      const nextId = sampleFromLogits(lastLogits, temperature, topK, rng);
      generated.push(nextId);
      lastLogits = this.stepRecurrentToken(nextId, states);
    }
    return generated;
  }

  /** Advance every layer's recurrent state by exactly one token; returns that token's output logits. */
  stepToken(tokenId, states) {
    const { dModel, vocabSize } = this;
    let x = this.tokEmb.data.slice(tokenId * dModel, tokenId * dModel + dModel);

    for (let l = 0; l < this.numLayers; l++) {
      const layer = this.layers[l];
      const normed1 = layerNormVec(x, layer.ln1g.data, layer.ln1b.data, dModel);
      const mixOut = this.linearMixerStep(normed1, layer, states[l]);
      x = addVec(x, mixOut);

      const normed2 = layerNormVec(x, layer.ln2g.data, layer.ln2b.data, dModel);
      const hidden = matVec(layer.W1.data, layer.W1.shape[0], layer.W1.shape[1], normed2, layer.b1.data);
      const act = geluVec(hidden);
      const mlpOut = matVec(layer.W2.data, layer.W2.shape[0], layer.W2.shape[1], act, layer.b2.data);
      x = addVec(x, mlpOut);
    }

    const finalNormed = layerNormVec(x, this.lnfg.data, this.lnfb.data, dModel);
    const logits = new Float32Array(vocabSize);
    for (let v = 0; v < vocabSize; v++) {
      let s = 0;
      for (let d = 0; d < dModel; d++) s += finalNormed[d] * this.tokEmb.data[v * dModel + d];
      logits[v] = s;
    }
    return logits;
  }

  /** Advance every layer's RWKV state by exactly one token; returns that token's output logits. */
  stepTokenRWKV(tokenId, states) {
    const { dModel, vocabSize } = this;
    let x = this.tokEmb.data.slice(tokenId * dModel, tokenId * dModel + dModel);

    for (let l = 0; l < this.numLayers; l++) {
      const layer = this.layers[l];
      const normed1 = layerNormVec(x, layer.ln1g.data, layer.ln1b.data, dModel);
      const mixOut = this.rwkvMixerStep(normed1, layer, states[l]);
      x = addVec(x, mixOut);

      const normed2 = layerNormVec(x, layer.ln2g.data, layer.ln2b.data, dModel);
      const hidden = matVec(layer.W1.data, layer.W1.shape[0], layer.W1.shape[1], normed2, layer.b1.data);
      const act = geluVec(hidden);
      const mlpOut = matVec(layer.W2.data, layer.W2.shape[0], layer.W2.shape[1], act, layer.b2.data);
      x = addVec(x, mlpOut);
    }

    const finalNormed = layerNormVec(x, this.lnfg.data, this.lnfb.data, dModel);
    const logits = new Float32Array(vocabSize);
    for (let v = 0; v < vocabSize; v++) {
      let s = 0;
      for (let d = 0; d < dModel; d++) s += finalNormed[d] * this.tokEmb.data[v * dModel + d];
      logits[v] = s;
    }
    return logits;
  }

  /** One token's worth of the linear-attention recurrence, per head, mutating `layerState` in place. */
  linearMixerStep(x, layer, layerState) {
    const { numHeads, headDim, dModel } = this;
    const q = matVec(layer.Wq.data, dModel, dModel, x, layer.bq.data);
    const k = matVec(layer.Wk.data, dModel, dModel, x, layer.bk.data);
    const v = matVec(layer.Wv.data, dModel, dModel, x, layer.bv.data);
    const concat = new Float32Array(dModel);

    for (let h = 0; h < numHeads; h++) {
      const c0 = h * headDim;
      const qh = featureMapVec(q.slice(c0, c0 + headDim));
      const kh = featureMapVec(k.slice(c0, c0 + headDim));
      const vh = v.slice(c0, c0 + headDim);
      const st = layerState[h];

      for (let i = 0; i < headDim; i++) {
        st.z[i] += kh[i];
        for (let j = 0; j < headDim; j++) st.S[i * headDim + j] += kh[i] * vh[j];
      }

      let denom = 1e-6;
      for (let i = 0; i < headDim; i++) denom += qh[i] * st.z[i];
      const numerator = new Float32Array(headDim);
      for (let j = 0; j < headDim; j++) {
        let s = 0;
        for (let i = 0; i < headDim; i++) s += qh[i] * st.S[i * headDim + j];
        numerator[j] = s / denom;
      }
      concat.set(numerator, c0);
    }
    return matVec(layer.Wo.data, dModel, dModel, concat, layer.bo.data);
  }

  /** One token's worth of the RWKV recurrence, mutating `state` in place. */
  rwkvMixerStep(x, layer, state) {
    const { dModel } = this;
    
    // time-mix
    const xk = new Float32Array(dModel);
    const xv = new Float32Array(dModel);
    const xr = new Float32Array(dModel);
    for (let d = 0; d < dModel; d++) {
      xk[d] = x[d] * layer.mu_k.data[d] + state.x_prev[d] * (1 - layer.mu_k.data[d]);
      xv[d] = x[d] * layer.mu_v.data[d] + state.x_prev[d] * (1 - layer.mu_v.data[d]);
      xr[d] = x[d] * layer.mu_r.data[d] + state.x_prev[d] * (1 - layer.mu_r.data[d]);
    }
    
    // update x_prev for next step
    state.x_prev.set(x);

    // projections
    const r_pre = matVec(layer.Wr.data, dModel, dModel, xr, layer.br.data);
    const r = new Float32Array(dModel);
    for (let d = 0; d < dModel; d++) r[d] = 1 / (1 + Math.exp(-r_pre[d]));
    
    const k = matVec(layer.Wk.data, dModel, dModel, xk, layer.bk.data);
    const v = matVec(layer.Wv.data, dModel, dModel, xv, layer.bv.data);

    // WKV with log-space stabilization
    const wkv = new Float32Array(dModel);
    for (let d = 0; d < dModel; d++) {
      const u = layer.u.data[d];
      const w_decay_log = -Math.exp(layer.w.data[d]);
      
      const k_val = k[d];
      const v_val = v[d];
      
      const max_t = Math.max(u + k_val, state.max[d]);
      const exp_uk = Math.exp(u + k_val - max_t);
      const exp_state = Math.exp(state.max[d] - max_t);
      
      const num = exp_uk * v_val + exp_state * state.num[d];
      const den = exp_uk + exp_state * state.den[d];
      wkv[d] = num / den;
      
      // Update state for next step
      const max_next = Math.max(state.max[d] + w_decay_log, k_val);
      const exp_state_next = Math.exp(state.max[d] + w_decay_log - max_next);
      const exp_k_next = Math.exp(k_val - max_next);
      
      state.num[d] = exp_state_next * state.num[d] + exp_k_next * v_val;
      state.den[d] = exp_state_next * state.den[d] + exp_k_next;
      state.max[d] = max_next;
    }
    
    const rwkv_out = new Float32Array(dModel);
    for (let d = 0; d < dModel; d++) rwkv_out[d] = r[d] * wkv[d];
    
    return matVec(layer.Wo.data, dModel, dModel, rwkv_out, layer.bo.data);
  }
}

function onesTensor(n) {
  return new Tensor(new Float32Array(n).fill(1), [n], true);
}

function buildCausalMaskAdditive(T) {
  const mask = new Float32Array(T * T);
  for (let i = 0; i < T; i++)
    for (let j = 0; j < T; j++)
      mask[i * T + j] = j > i ? -1e9 : 0;
  return mask;
}

function buildCausalMask01(T) {
  const mask = new Float32Array(T * T);
  for (let i = 0; i < T; i++)
    for (let j = 0; j < T; j++)
      mask[i * T + j] = j <= i ? 1 : 0;
  return mask;
}

function sampleFromLogits(rowLogits, temperature, topK, rng) {
  const V = rowLogits.length;
  const scaled = new Float32Array(V);
  const t = Math.max(temperature, 1e-6);
  for (let i = 0; i < V; i++) scaled[i] = rowLogits[i] / t;

  let candidates = Array.from({ length: V }, (_, i) => i);
  if (topK > 0 && topK < V) {
    candidates = candidates.sort((a, b) => scaled[b] - scaled[a]).slice(0, topK);
  }

  let max = -Infinity;
  for (const i of candidates) max = Math.max(max, scaled[i]);
  let sum = 0;
  const probs = new Map();
  for (const i of candidates) {
    const e = Math.exp(scaled[i] - max);
    probs.set(i, e);
    sum += e;
  }
  let r = rng() * sum;
  for (const [i, p] of probs) {
    r -= p;
    if (r <= 0) return i;
  }
  return candidates[candidates.length - 1];
}

// --- plain-numeric (non-autograd) vector helpers used only by the recurrent
// generation path (stepToken / linearMixerStep). Kept intentionally separate
// from tensor.js's Tensor ops: at inference time there's no graph to build,
// so a synchronous vector implementation is simpler and avoids a GPU
// round-trip per generated token. ---

function matVec(weightData, outDim, inDim, x, bias) {
  const y = new Float32Array(outDim);
  for (let o = 0; o < outDim; o++) {
    let s = bias ? bias[o] : 0;
    const rowStart = o * inDim;
    for (let i = 0; i < inDim; i++) s += weightData[rowStart + i] * x[i];
    y[o] = s;
  }
  return y;
}

function addVec(a, b) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
  return out;
}

function layerNormVec(x, gamma, beta, D, eps = 1e-5) {
  let mean = 0;
  for (let i = 0; i < D; i++) mean += x[i];
  mean /= D;
  let variance = 0;
  for (let i = 0; i < D; i++) {
    const d = x[i] - mean;
    variance += d * d;
  }
  variance /= D;
  const invstd = 1 / Math.sqrt(variance + eps);
  const out = new Float32Array(D);
  for (let i = 0; i < D; i++) out[i] = (x[i] - mean) * invstd * gamma[i] + beta[i];
  return out;
}

function geluVec(x) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const inner = GELU_C1 * (v + GELU_C2 * v * v * v);
    out[i] = 0.5 * v * (1 + Math.tanh(inner));
  }
  return out;
}

function featureMapVec(x) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    out[i] = v > 0 ? v + 1 : Math.exp(v);
  }
  return out;
}

// --- Custom Tensor Ops for RWKV Parallel Form ---

function shiftTime(x, B, T, D) {
  const out = new Tensor(new Float32Array(x.data.length), x.shape, x.requiresGrad);
  for (let b = 0; b < B; b++) {
    for (let t = 1; t < T; t++) {
      for (let d = 0; d < D; d++) {
        out.data[(b * T + t) * D + d] = x.data[(b * T + t - 1) * D + d];
      }
    }
  }
  out._parents = [x];
  out._backward = async () => {
    if (!x.requiresGrad) return;
    for (let b = 0; b < B; b++) {
      for (let t = 1; t < T; t++) {
        for (let d = 0; d < D; d++) {
          x.grad[(b * T + t - 1) * D + d] += out.grad[(b * T + t) * D + d];
        }
      }
    }
  };
  return out;
}

function timeMix(x, x_prev, mu) {
  const out = new Tensor(new Float32Array(x.data.length), x.shape, x.requiresGrad || mu.requiresGrad);
  const D = mu.shape[0];
  for (let i = 0; i < x.data.length; i++) {
    const d = i % D;
    const m = mu.data[d];
    out.data[i] = x.data[i] * m + x_prev.data[i] * (1 - m);
  }
  out._parents = [x, x_prev, mu];
  out._backward = async () => {
    for (let i = 0; i < x.data.length; i++) {
      const d = i % D;
      const m = mu.data[d];
      const g = out.grad[i];
      if (x.requiresGrad) x.grad[i] += g * m;
      if (x_prev.requiresGrad) x_prev.grad[i] += g * (1 - m);
      if (mu.requiresGrad) mu.grad[d] += g * (x.data[i] - x_prev.data[i]);
    }
  };
  return out;
}

function rwkvScores(k, w, u, B, T, D) {
  const out = new Tensor(new Float32Array(B * D * T * T), [B * D * T, T], true);
  for (let b = 0; b < B; b++) {
    for (let d = 0; d < D; d++) {
      const w_decay_log = -Math.exp(w.data[d]);
      const u_val = u.data[d];
      for (let t = 0; t < T; t++) {
        for (let i = 0; i < T; i++) {
          let val = -1e9;
          if (i === t) val = u_val + k.data[(b * T + i) * D + d];
          else if (i < t) val = (t - 1 - i) * w_decay_log + k.data[(b * T + i) * D + d];
          out.data[(b * D * T + t * T) + i] = val;
        }
      }
    }
  }
  out._parents = [k, w, u];
  out._backward = async () => {
    for (let b = 0; b < B; b++) {
      for (let d = 0; d < D; d++) {
        const w_val = w.data[d];
        const dw_decay_log_dw = -Math.exp(w_val);
        let u_grad = 0;
        let w_grad = 0;
        for (let t = 0; t < T; t++) {
          for (let i = 0; i <= t; i++) {
            const g = out.grad[(b * D * T + t * T) + i];
            if (g === 0) continue;
            if (i === t) {
              u_grad += g;
              if (k.requiresGrad) k.grad[(b * T + i) * D + d] += g;
            } else {
              w_grad += g * (t - 1 - i) * dw_decay_log_dw;
              if (k.requiresGrad) k.grad[(b * T + i) * D + d] += g;
            }
          }
        }
        if (u.requiresGrad) u.grad[d] += u_grad;
        if (w.requiresGrad) w.grad[d] += w_grad;
      }
    }
  };
  return out;
}

function rwkvAttnSum(probs, v, B, T, D) {
  const out = new Tensor(new Float32Array(B * T * D), [B * T, D], probs.requiresGrad || v.requiresGrad);
  for (let b = 0; b < B; b++) {
    for (let d = 0; d < D; d++) {
      for (let t = 0; t < T; t++) {
        let sum = 0;
        for (let i = 0; i <= t; i++) {
          sum += probs.data[(b * D * T + t * T) + i] * v.data[(b * T + i) * D + d];
        }
        out.data[(b * T + t) * D + d] = sum;
      }
    }
  }
  out._parents = [probs, v];
  out._backward = async () => {
    for (let b = 0; b < B; b++) {
      for (let d = 0; d < D; d++) {
        for (let t = 0; t < T; t++) {
          const g = out.grad[(b * T + t) * D + d];
          if (g === 0) continue;
          for (let i = 0; i <= t; i++) {
            if (probs.requiresGrad) probs.grad[(b * D * T + t * T) + i] += g * v.data[(b * T + i) * D + d];
            if (v.requiresGrad) v.grad[(b * T + i) * D + d] += g * probs.data[(b * D * T + t * T) + i];
          }
        }
      }
    }
  };
  return out;
}

export { crossEntropyLoss };
