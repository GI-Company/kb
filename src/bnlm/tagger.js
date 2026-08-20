// BNLMTagger — a third head on the same transformer trunk classifier.js and
// embed.js already reuse (see classifier.js's header for why "reuse the
// trunk" is the established pattern here). Where the classifier pools an
// entire sequence down to one label, this tags EVERY position — supervised
// per-character labels in one forward pass, rather than the classifier's
// one-label-per-document.
//
// WHY CHARACTER-LEVEL, NOT WORD-LEVEL: the tokenizer everywhere else in this
// engine (CharTokenizer) is character-level, and there's no word-boundary
// bookkeeping anywhere in this codebase to build tokens from. Tagging
// characters is a direct reuse of the existing tokenizer with zero new
// tokenization code. A caller wanting word/phrase-shaped output merges
// consecutive same-tag characters into spans afterward (see
// lib/localTagger.ts's tag() method) rather than the model needing to
// understand word boundaries itself.
//
// ARCHITECTURE
//
//   tokens → [shared BNLM trunk] → hidden states (B*T, dModel)
//          → linear head, EVERY position → (B*T, numTags)
//
// No pooling gather at all — that's the entire difference from
// classifier.js's forwardLogits. Padding positions still can't be allowed
// into the loss, though (unlike the classifier, where poolIndices only ever
// selects the one true last position and padding never enters the
// computation at all) — see loss() below for how that's handled.

import { BNLM } from './model.js';
import {
  zeros, randTensor, makeRng, embeddingLookup, crossEntropyLoss, matmul, addBias,
} from './tensor.js';

export class BNLMTagger {
  /**
   * @param {number} vocabSize
   * @param {number} numTags
   * @param {{dModel:number, numLayers:number, numHeads:number, contextLen:number, mixerType?:string, seed?:number}} config
   */
  constructor(vocabSize, numTags, config) {
    if (!Number.isInteger(numTags) || numTags < 2) {
      throw new Error(`numTags must be an integer >= 2, got ${numTags}`);
    }
    this.trunk = new BNLM(vocabSize, config);
    this.vocabSize = vocabSize;
    this.numTags = numTags;
    this.contextLen = config.contextLen;
    this.dModel = config.dModel;

    // Offset the seed so the head doesn't mirror the trunk's first matrix —
    // same convention as classifier.js's Wcls.
    const rng = makeRng((config.seed ?? 1234) + 7919);
    this.Wtag = randTensor([numTags, config.dModel], 0.02, true, rng);
    this.btag = zeros([numTags], true);
  }

  parameters() {
    return [...this.trunk.parameters(), this.Wtag, this.btag];
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
   * @returns {Promise<Tensor>} per-position tag logits, shape (B*T, numTags)
   */
  async forwardLogits(idsFlat, B, T) {
    const hidden = await this.trunk.encode(idsFlat, B, T);
    const logits = await matmul(hidden, this.Wtag, false, true);
    return addBias(logits, this.btag);
  }

  /**
   * Cross-entropy against per-CHARACTER integer tag ids, padding excluded.
   *
   * Unlike the classifier, whose poolIndices gather means padding never
   * reaches the loss at all, a tagger's (B*T, numTags) logits include every
   * padded position by construction. crossEntropyLoss has no ignore_index,
   * so padding has to be compacted OUT before it gets there — using the
   * same "embeddingLookup is a differentiable row-gather" trick
   * classifier.js documents (forwardLogits there gathers ONE index per
   * sequence; this gathers every VALID index across the whole batch).
   *
   * @param {Int32Array} idsFlat padded (B, T) token ids, row-major
   * @param {number} B
   * @param {number} T
   * @param {Int32Array|number[]} lengths true length of each sequence, 1..T
   * @param {Int32Array|number[]} tagsFlat padded (B, T) tag ids, row-major — same layout as idsFlat, values at padding positions are ignored
   * @returns {Promise<{loss: Tensor, value: number}>}
   */
  async loss(idsFlat, B, T, lengths, tagsFlat) {
    const logits = await this.forwardLogits(idsFlat, B, T);

    const validIndices = [];
    const validTags = [];
    for (let b = 0; b < B; b++) {
      const len = Math.min(Math.max(lengths[b], 1), T);
      for (let t = 0; t < len; t++) {
        validIndices.push(b * T + t);
        validTags.push(tagsFlat[b * T + t]);
      }
    }

    const compacted = embeddingLookup(logits, Int32Array.from(validIndices));
    return crossEntropyLoss(compacted, Int32Array.from(validTags));
  }

  /**
   * Inference for a single sequence — one tag id per input character.
   * @param {Int32Array|number[]} ids
   * @returns {Promise<number[]>} length ids.length, one tag index per character
   */
  async predict(ids) {
    const truncated = ids.length > this.contextLen ? ids.slice(-this.contextLen) : ids;
    const T = Math.max(truncated.length, 1);
    const idsFlat = new Int32Array(T);
    idsFlat.set(truncated.length ? truncated : [0]);

    const logits = await this.forwardLogits(idsFlat, 1, T);
    const tags = [];
    for (let t = 0; t < truncated.length; t++) {
      let best = 0;
      let bestVal = logits.data[t * this.numTags];
      for (let c = 1; c < this.numTags; c++) {
        const v = logits.data[t * this.numTags + c];
        if (v > bestVal) { bestVal = v; best = c; }
      }
      tags.push(best);
    }
    return tags;
  }
}

/**
 * Pads a batch of variable-length id/tag arrays into flat (B, T) buffers,
 * returning the true lengths — same shape and same tail-keeping truncation
 * rule as classifier.js's padBatch (a tagger has no single "last position
 * that matters" the way last-token pooling does, but keeping the tail is
 * still the right default: it's what padBatch already does everywhere else
 * in this engine, and there's no reason a tagger's truncation should behave
 * differently from every other command's).
 *
 * ids and tags must be parallel: tags[i] is the tag sequence for ids[i], the
 * same length, truncated identically.
 */
export function padTaggedBatch(ids, tags, contextLen) {
  const clippedIds = ids.map(s => (s.length > contextLen ? s.slice(-contextLen) : s));
  const clippedTags = tags.map((s, i) => (ids[i].length > contextLen ? s.slice(-contextLen) : s));
  const T = Math.max(1, ...clippedIds.map(s => s.length));
  const B = clippedIds.length;
  const idsFlat = new Int32Array(B * T);
  const tagsFlat = new Int32Array(B * T);
  const lengths = new Int32Array(B);
  for (let b = 0; b < B; b++) {
    const seq = clippedIds[b];
    const tagSeq = clippedTags[b];
    lengths[b] = Math.max(seq.length, 1);
    for (let t = 0; t < seq.length; t++) {
      idsFlat[b * T + t] = seq[t];
      tagsFlat[b * T + t] = tagSeq[t];
    }
  }
  return { idsFlat, tagsFlat, B, T, lengths };
}
