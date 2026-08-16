import { describe, it, expect } from 'vitest';
import { localClassifier } from './localClassifier';

// The "measure before naming" experiment BUILTINS.md called for on embed /
// similar, made permanent instead of a one-off browser console session.
//
// The question: is the pooled vector this trunk already computes on every
// predict() (dModel=24, 1 layer, char-level, linear mixer) any good as a
// retrieval representation? Precision@1 (leave-one-out nearest neighbor by
// cosine, does the top match share the true cluster) on two HELD-OUT sets —
// neither was in the training data:
//
//   IN-DOMAIN    — new phrasings of the same files/network/model clusters
//                  the classifier was trained to route between.
//   OUT-OF-DOMAIN — ordinary topics (fruit, greetings, weather) it never
//                  saw at all.
//
// The training set itself is deliberately NOT one of the measured sets.
// An earlier version of this test measured precision on the training data
// and got 1.0 — which is guaranteed, not informative: Wcls is directly
// optimized to make those exact pooled vectors separable, so near-perfect
// self-precision says nothing about whether the representation generalizes.
// Held-out is the only version of this question worth asking.
//
// Both weight init and the training shuffle are seeded (see randTensor's
// rng in src/bnlm/tensor.js and train()'s local rngState), so this is
// exactly reproducible — the thresholds below are real numbers with
// headroom, not guesses.

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

/** Leave-one-out precision@1: does each item's nearest OTHER item share its cluster? */
function precisionAt1(items: { text: string; cluster: string; vec: number[] }[]): number {
  let hits = 0;
  for (const item of items) {
    let best: typeof items[0] | null = null;
    let bestSim = -Infinity;
    for (const other of items) {
      if (other.text === item.text) continue;
      const sim = cosine(item.vec, other.vec);
      if (sim > bestSim) { bestSim = sim; best = other; }
    }
    if (best?.cluster === item.cluster) hits++;
  }
  return hits / items.length;
}

describe('pooled vector as a retrieval representation (embed/similar decision)', () => {
  it('trains a router-shaped classifier, then measures precision@1 on held-out sets only', async () => {
    const trainSet = [
      { text: 'list my files', cluster: 'files' },
      { text: 'show me my files', cluster: 'files' },
      { text: 'open the readme', cluster: 'files' },
      { text: 'read notes.md', cluster: 'files' },
      { text: 'ping the server', cluster: 'network' },
      { text: 'ping the host', cluster: 'network' },
      { text: 'curl the api', cluster: 'network' },
      { text: 'check my connection', cluster: 'network' },
      { text: 'train a classifier', cluster: 'model' },
      { text: 'run the local model', cluster: 'model' },
      { text: 'generate some text', cluster: 'model' },
      { text: 'score this sentence', cluster: 'model' },
    ];
    // New phrasings of the same three clusters — never appear in trainSet.
    const heldOutInDomain = [
      { text: 'what files do I have', cluster: 'files' },
      { text: 'cat the log file', cluster: 'files' },
      { text: 'browse my directory', cluster: 'files' },
      { text: 'download the report', cluster: 'network' },
      { text: 'fetch the url', cluster: 'network' },
      { text: 'is the host reachable', cluster: 'network' },
      { text: 'classify this input', cluster: 'model' },
      { text: 'explain the last prediction', cluster: 'model' },
      { text: 'retrain on new examples', cluster: 'model' },
    ];
    // Ordinary topics this classifier's training data never touches at
    // all. If the representation were genuinely semantic, it should still
    // separate these — a real embedder generalizes past its fine-tuning
    // task, not just past its exact training sentences.
    const outOfDomain = [
      { text: 'apple', cluster: 'fruit' },
      { text: 'banana', cluster: 'fruit' },
      { text: 'cherry', cluster: 'fruit' },
      { text: 'grape', cluster: 'fruit' },
      { text: 'hello there', cluster: 'greeting' },
      { text: 'good morning', cluster: 'greeting' },
      { text: 'hi friend', cluster: 'greeting' },
      { text: 'nice to meet you', cluster: 'greeting' },
      { text: 'it is raining', cluster: 'weather' },
      { text: 'sunny today', cluster: 'weather' },
      { text: 'snow outside', cluster: 'weather' },
      { text: 'a cold wind', cluster: 'weather' },
    ];

    localClassifier.init(
      trainSet.map(({ text, cluster }) => ({ text, label: cluster })),
      { dModel: 24, numLayers: 1, numHeads: 2, contextLen: 48, mixerType: 'linear', batchSize: 8 }
    );
    await localClassifier.train(150);

    const embedAll = async (items: { text: string; cluster: string }[]) =>
      Promise.all(items.map(async i => ({ ...i, vec: await localClassifier.embed(i.text) })));

    const inDomainVecs = await embedAll(heldOutInDomain);
    const outDomainVecs = await embedAll(outOfDomain);

    const inDomainPrecision = precisionAt1(inDomainVecs);
    const outDomainPrecision = precisionAt1(outDomainVecs);

    // eslint-disable-next-line no-console
    console.log(`embed precision@1 (held-out) — in-domain: ${inDomainPrecision.toFixed(3)}, out-of-domain: ${outDomainPrecision.toFixed(3)}`);

    // Measured on 2026-08-16: in-domain 0.222, out-of-domain 0.333.
    // Random-baseline leave-one-out precision@1 (cluster size minus one,
    // over pool size minus one): in-domain 3 items/cluster over 9 total ≈
    // 0.25; out-of-domain 4/cluster over 12 total ≈ 0.27. So in-domain
    // measured AT OR BELOW chance, and out-of-domain barely above it —
    // this representation did not reliably separate its own trained
    // clusters once the phrasing wasn't verbatim from training, let alone
    // generalize to topics it never saw. Thresholds below carry headroom
    // for float arithmetic differing slightly across Node versions; the
    // finding is unchanged from that run either way. Neither clears a bar
    // worth shipping as "similar", under any name.
    expect(inDomainPrecision).toBeLessThan(0.7);
    expect(outDomainPrecision).toBeLessThan(0.6);

    // The sharper problem, and the reason this isn't "ship it as lexical
    // matching instead": wrong matches carry HIGH cosine similarity, not
    // low. A real retrieval failure mode looks like low-confidence noise;
    // this looks like near-collapsed representations that agree with each
    // other regardless of content. Assert that directly on the combined
    // held-out pool — at least one wrong-cluster nearest-neighbor above
    // 0.9 similarity, a property "just rename it match/index" does not fix.
    const combined = [...inDomainVecs, ...outDomainVecs];
    const wrongButConfident = combined.some(item => {
      const rest = combined.filter(o => o.text !== item.text);
      const nearest = rest.reduce((a, b) => (cosine(item.vec, b.vec) > cosine(item.vec, a.vec) ? b : a));
      return nearest.cluster !== item.cluster && cosine(item.vec, nearest.vec) > 0.9;
    });
    expect(wrongButConfident).toBe(true);
  }, 20000);
});
