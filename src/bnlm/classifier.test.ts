import { describe, it, expect } from 'vitest';
import { BNLMClassifier, padBatch } from './classifier.js';

describe('padBatch', () => {
  it('pads to the longest sequence and records true lengths', () => {
    const { idsFlat, B, T, lengths } = padBatch([[1, 2, 3], [4], [5, 6]], 32);
    expect(B).toBe(3);
    expect(T).toBe(3);
    expect(Array.from(lengths)).toEqual([3, 1, 2]);
    // Row-major (B, T) with zero padding after each sequence's real tokens.
    expect(Array.from(idsFlat)).toEqual([1, 2, 3, 4, 0, 0, 5, 6, 0]);
  });

  it('keeps the TAIL when a sequence exceeds contextLen', () => {
    // Last-token pooling classifies the final positions, so the front is
    // what should be dropped.
    const { idsFlat, T, lengths } = padBatch([[1, 2, 3, 4, 5]], 3);
    expect(T).toBe(3);
    expect(Array.from(lengths)).toEqual([3]);
    expect(Array.from(idsFlat)).toEqual([3, 4, 5]);
  });

  it('never reports a length below 1 for an empty sequence', () => {
    const { lengths, T } = padBatch([[], [7]], 8);
    expect(T).toBe(1);
    expect(Array.from(lengths)).toEqual([1, 1]);
  });
});

describe('BNLMClassifier', () => {
  const config = { dModel: 16, numLayers: 1, numHeads: 2, contextLen: 12, mixerType: 'linear' as const };

  it('rejects a single-class problem', () => {
    expect(() => new BNLMClassifier(10, 1, config)).toThrow(/numClasses must be an integer >= 2/);
  });

  it('exposes head parameters alongside the trunk', () => {
    const trunkOnly = new BNLMClassifier(10, 3, config).trunk.paramCount();
    const clf = new BNLMClassifier(10, 3, config);
    // head = Wcls (numClasses x dModel) + bcls (numClasses)
    expect(clf.paramCount()).toBe(trunkOnly + 3 * config.dModel + 3);
  });

  it('produces one logit row per batch item', async () => {
    const clf = new BNLMClassifier(10, 4, config);
    const { idsFlat, B, T, lengths } = padBatch([[1, 2], [3], [4, 5, 6]], config.contextLen);
    const logits = await clf.forwardLogits(idsFlat, B, T, lengths);
    expect(logits.shape).toEqual([3, 4]);
  });

  it('pools each sequence at its own final token, ignoring padding', async () => {
    const clf = new BNLMClassifier(10, 3, config);
    // [1,2] padded to width 3 must classify identically to [1,2] unpadded:
    // if padding leaked into the pooled representation, these would differ.
    const padded = padBatch([[1, 2], [9, 9, 9]], config.contextLen);
    const paddedLogits = await clf.forwardLogits(padded.idsFlat, padded.B, padded.T, padded.lengths);

    const alone = padBatch([[1, 2]], config.contextLen);
    const aloneLogits = await clf.forwardLogits(alone.idsFlat, alone.B, alone.T, alone.lengths);

    for (let c = 0; c < 3; c++) {
      expect(paddedLogits.data[c]).toBeCloseTo(aloneLogits.data[c], 5);
    }
  });

  // Shape tests alone would still pass if the head were detached from the
  // graph and nothing ever learned. This asserts the loss actually falls and
  // the model separates two trivially distinct classes.
  it('learns a separable task end to end', async () => {
    const { Adam } = await import('./optim.js');
    const clf = new BNLMClassifier(6, 2, { ...config, dModel: 16, numLayers: 1 });
    const opt = new Adam(clf.parameters(), { lr: 0.02 });

    // Class 0 is runs of token 1; class 1 is runs of token 4.
    const seqs = [[1, 1, 1], [1, 1], [1, 1, 1, 1], [4, 4, 4], [4, 4], [4, 4, 4, 4]];
    const labels = Int32Array.from([0, 0, 0, 1, 1, 1]);
    const { idsFlat, B, T, lengths } = padBatch(seqs, config.contextLen);

    let firstLoss = 0;
    let lastLoss = 0;
    for (let step = 0; step < 60; step++) {
      clf.zeroGrad();
      const { loss, value } = await clf.loss(idsFlat, B, T, lengths, labels);
      await loss.backward();
      opt.step();
      if (step === 0) firstLoss = value;
      lastLoss = value;
    }

    expect(lastLoss).toBeLessThan(firstLoss);
    expect((await clf.predict([1, 1, 1])).label).toBe(0);
    expect((await clf.predict([4, 4, 4])).label).toBe(1);
  }, 20000);

  it('returns a normalized distribution from predict', async () => {
    const clf = new BNLMClassifier(10, 3, config);
    const { probs, label, confidence } = await clf.predict([1, 2, 3]);
    expect(probs).toHaveLength(3);
    expect(probs.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(1, 5);
    expect(confidence).toBeCloseTo(probs[label], 10);
    expect(probs.every((p: number) => p >= 0 && p <= 1)).toBe(true);
  });
});
