// Text embeddings — a third head on the same transformer trunk classifier.js
// already reuses (see that file's header for why "reuse the trunk" is the
// established pattern here). Unlike the classifier, this one needs no head
// weights at all: an embedding IS the trunk's pooled, L2-normalized output.
//
// WHAT IT'S FOR
//
// The generative model answers "what comes next?" and the classifier answers
// "which of these N things is it?" This answers a third question: "how
// similar is this to that?" — the primitive underneath semantic search.
// Turning text into a vector means ranking a whole file tree against a query
// is a handful of dot products, entirely local, no cloud call at inference.
//
// TRAINING OBJECTIVE
//
// In-batch-negative contrastive loss (SimCSE/CLIP-style InfoNCE), trained on
// pairs of text that should embed close together (paraphrases, near-
// duplicates). For a batch of N pairs {a_i, b_i}, all 2N texts are pooled
// and L2-normalized, then matmul(pooled, pooled^T) gives every pairwise
// cosine similarity in one matmul (that's what l2Normalize buys: no separate
// division step). Row i's positive is the OTHER half of its pair (a_i's
// target is b_i's row, at index i+N); its own self-similarity (always
// exactly 1.0) is masked out of the softmax, since an unmasked diagonal
// would make the true positive mathematically unreachable as the argmax —
// see buildDiagonalMask below.
//
// Same pooling choice as classifier.js and the same reason: every mixer in
// this engine is causal, so the last real token is the only position that
// has seen the whole sequence.

import { embeddingLookup, l2Normalize, matmul, scaleConst, addConst, crossEntropyLoss } from './tensor.js';

/**
 * Pools a batch of encoded sequences down to one L2-normalized vector each.
 * @param {import('./model.js').BNLM} trunk
 * @param {Int32Array} idsFlat padded (B, T) token ids, row-major
 * @param {number} B batch size
 * @param {number} T padded sequence length
 * @param {Int32Array|number[]} lengths true length of each sequence, 1..T
 * @returns {Promise<Tensor>} (B, dModel), each row unit-norm
 */
export async function pooledEmbedding(trunk, idsFlat, B, T, lengths) {
  const hidden = await trunk.encode(idsFlat, B, T);

  // Same differentiable last-token gather as classifier.js's forwardLogits.
  const poolIndices = new Int32Array(B);
  for (let b = 0; b < B; b++) {
    const len = Math.min(Math.max(lengths[b], 1), T);
    poolIndices[b] = b * T + (len - 1);
  }
  const pooled = embeddingLookup(hidden, poolIndices);
  return l2Normalize(pooled);
}

/**
 * Additive mask that zeroes out row i's own similarity to itself, leaving
 * every other pair's similarity untouched. Built once per batch size and
 * reused across the whole training run (same convention as model.js's
 * buildCausalMaskAdditive, which is likewise recomputed per distinct T
 * rather than cached beyond that).
 */
export function buildDiagonalMask(N) {
  const mask = new Float32Array(N * N);
  for (let i = 0; i < N; i++) mask[i * N + i] = -1e9;
  return mask;
}

/**
 * In-batch-negative contrastive loss over a batch of already-pooled,
 * L2-normalized vectors.
 * @param {Tensor} pooled (N, dModel), each row unit-norm
 * @param {Int32Array|number[]} positiveIndices length N; positiveIndices[i]
 *   is the row index of i's positive pair (never i itself)
 * @param {number} temperature lower sharpens the softmax over candidates
 * @returns {Promise<{loss: Tensor, value: number}>}
 */
export async function contrastiveLoss(pooled, positiveIndices, temperature = 0.05) {
  const N = pooled.shape[0];
  let scores = await matmul(pooled, pooled, false, true); // (N, N) cosine similarities
  scores = scaleConst(scores, 1 / temperature);
  scores = addConst(scores, buildDiagonalMask(N));
  return crossEntropyLoss(scores, positiveIndices);
}

/**
 * Cosine similarity between two plain vectors. Computes the true formula
 * (not just a dot product) so it's correct even for vectors that weren't
 * L2-normalized upstream — e.g. ones reloaded from a saved model record.
 * @param {Float32Array|number[]} a
 * @param {Float32Array|number[]} b
 * @returns {number} in [-1, 1]
 */
export function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 1e-12 ? dot / denom : 0;
}
