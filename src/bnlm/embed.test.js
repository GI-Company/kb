// End-to-end (not mocked) tests against a real, tiny BNLM trunk. l2Normalize
// already has its own gradient-check in tensor.test.js; what matters here is
// that pooling + the contrastive loss actually train something — a wrong
// sign or index in contrastiveLoss's diagonal mask would still "run" without
// throwing, and only show up as loss that never goes down.
import { describe, it, expect } from 'vitest';
import { BNLM } from './model.js';
import { CharTokenizer } from './tokenizer.js';
import { Adam } from './optim.js';
import { padBatch } from './classifier.js';
import { pooledEmbedding, contrastiveLoss, cosineSimilarity, buildDiagonalMask } from './embed.js';

function tinyTrunk(vocabSize, seed = 1) {
  return new BNLM(vocabSize, { dModel: 16, numLayers: 1, numHeads: 2, contextLen: 32, mixerType: 'attention', seed });
}

describe('buildDiagonalMask', () => {
  it('masks only the diagonal', () => {
    const m = buildDiagonalMask(3);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(m[i * 3 + j]).toBe(i === j ? -1e9 : 0);
      }
    }
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors, 0 for orthogonal, -1 for opposite', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });

  it('is scale-invariant, since it normalizes internally', () => {
    expect(cosineSimilarity([2, 0], [0, 5])).toBeCloseTo(cosineSimilarity([1, 0], [0, 1]), 5);
  });

  it('is safe against a zero vector rather than dividing by zero', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('pooledEmbedding', () => {
  it('returns one unit-norm row per sequence', async () => {
    const text = 'a small robot learns to paint pictures with care';
    const tokenizer = new CharTokenizer(text);
    const trunk = tinyTrunk(tokenizer.vocabSize);
    const { idsFlat, B, T, lengths } = padBatch(
      [tokenizer.encode('a small robot'), tokenizer.encode('learns to paint')],
      32
    );
    const pooled = await pooledEmbedding(trunk, idsFlat, B, T, lengths);
    expect(pooled.shape).toEqual([2, trunk.dModel]);
    for (let r = 0; r < 2; r++) {
      let sumSq = 0;
      for (let c = 0; c < trunk.dModel; c++) sumSq += pooled.data[r * trunk.dModel + c] ** 2;
      expect(Math.sqrt(sumSq)).toBeCloseTo(1, 4);
    }
  });
});

describe('contrastiveLoss end-to-end training', () => {
  it('goes down over real Adam steps on a real trunk', async () => {
    // Four paraphrase-style pairs sharing enough character overlap that a
    // 16-dim, 1-layer trunk can plausibly pull each pair together within a
    // handful of steps — this is a gradient-flow smoke test, not a
    // generalization benchmark.
    const pairs = [
      { a: 'the cat sat on the mat', b: 'a cat was sitting on a mat' },
      { a: 'she ran to the store', b: 'she hurried to the shop' },
      { a: 'the sky is blue today', b: 'today the sky looks blue' },
      { a: 'he likes to read books', b: 'he enjoys reading books' },
    ];
    const allText = pairs.flatMap(p => [p.a, p.b]).join('\n');
    const tokenizer = new CharTokenizer(allText);
    const trunk = tinyTrunk(tokenizer.vocabSize, 42);
    const optimizer = new Adam(trunk.parameters(), { lr: 1e-2 });

    const N = pairs.length;
    const seqs = [...pairs.map(p => tokenizer.encode(p.a)), ...pairs.map(p => tokenizer.encode(p.b))];
    const { idsFlat, B, T, lengths } = padBatch(seqs, 32);
    const positiveIndices = new Int32Array(2 * N);
    for (let i = 0; i < N; i++) {
      positiveIndices[i] = i + N;
      positiveIndices[i + N] = i;
    }

    async function step() {
      optimizer.zeroGrad();
      const pooled = await pooledEmbedding(trunk, idsFlat, B, T, lengths);
      const { loss, value } = await contrastiveLoss(pooled, positiveIndices, 0.1);
      await loss.backward();
      optimizer.step();
      return value;
    }

    const first = await step();
    let last = first;
    for (let i = 0; i < 19; i++) last = await step();

    expect(Number.isFinite(first)).toBe(true);
    expect(last).toBeLessThan(first);
  });
});
