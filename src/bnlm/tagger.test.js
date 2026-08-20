import { describe, it, expect } from 'vitest';
import { BNLMTagger, padTaggedBatch } from './tagger.js';
import { CharTokenizer } from './tokenizer.js';
import { Adam } from './optim.js';

function tinyTagger(vocabSize, numTags = 2, seed = 1) {
  return new BNLMTagger(vocabSize, numTags, { dModel: 16, numLayers: 1, numHeads: 2, contextLen: 32, mixerType: 'attention', seed });
}

describe('padTaggedBatch', () => {
  it('pads ids and tags to a common length and reports true lengths', () => {
    const { idsFlat, tagsFlat, B, T, lengths } = padTaggedBatch(
      [Int32Array.from([1, 2, 3]), Int32Array.from([4, 5])],
      [Int32Array.from([0, 1, 0]), Int32Array.from([1, 1])],
      10
    );
    expect(B).toBe(2);
    expect(T).toBe(3);
    expect(Array.from(lengths)).toEqual([3, 2]);
    expect(Array.from(idsFlat)).toEqual([1, 2, 3, 4, 5, 0]);
    expect(Array.from(tagsFlat)).toEqual([0, 1, 0, 1, 1, 0]);
  });

  it('keeps the tail, not the head, when a sequence exceeds contextLen', () => {
    const { idsFlat, tagsFlat, lengths } = padTaggedBatch(
      [Int32Array.from([1, 2, 3, 4, 5])],
      [Int32Array.from([0, 0, 0, 1, 1])],
      3
    );
    expect(Array.from(lengths)).toEqual([3]);
    expect(Array.from(idsFlat)).toEqual([3, 4, 5]);
    expect(Array.from(tagsFlat)).toEqual([0, 1, 1]);
  });
});

describe('BNLMTagger', () => {
  it('rejects fewer than 2 tags', () => {
    expect(() => new BNLMTagger(10, 1, { dModel: 8, numLayers: 1, numHeads: 2, contextLen: 16 }))
      .toThrow(/numTags/);
  });

  it('forwardLogits produces one row of tag logits per input position, not per sequence', async () => {
    const tokenizer = new CharTokenizer('abcdef');
    const tagger = tinyTagger(tokenizer.vocabSize);
    const { idsFlat, B, T } = padTaggedBatch(
      [tokenizer.encode('abc'), tokenizer.encode('de')],
      [Int32Array.from([0, 0, 0]), Int32Array.from([1, 1])],
      16
    );
    const logits = await tagger.forwardLogits(idsFlat, B, T);
    expect(logits.shape).toEqual([B * T, 2]);
  });

  it('predict returns exactly one tag per input character', async () => {
    const tokenizer = new CharTokenizer('abcdef');
    const tagger = tinyTagger(tokenizer.vocabSize);
    const tags = await tagger.predict(tokenizer.encode('abcde'));
    expect(tags).toHaveLength(5);
    for (const t of tags) expect([0, 1]).toContain(t);
  });

  // The real test: does gradient flow correctly through the compacted-
  // valid-positions loss()? A wrong index in the padding-exclusion gather
  // would still "run" without throwing — the only thing that reveals it is
  // whether the loss actually goes down on a learnable pattern.
  it('learns a real per-character pattern over real Adam steps', async () => {
    // Digits are tag 1 ("risky"), letters are tag 0 ("normal") — a trivial,
    // perfectly learnable per-character rule.
    const examples = [
      'rm 42 now', 'delete file 7', 'run job 100', 'open port 8080', 'set id 5',
    ];
    const tagOf = (ch) => (/[0-9]/.test(ch) ? 1 : 0);

    const allText = examples.join('\n');
    const tokenizer = new CharTokenizer(allText);
    const tagger = tinyTagger(tokenizer.vocabSize, 2, 42);
    const optimizer = new Adam(tagger.parameters(), { lr: 1e-2 });

    const idsList = examples.map(s => tokenizer.encode(s));
    const tagsList = examples.map(s => Int32Array.from(Array.from(s).map(tagOf)));
    const { idsFlat, tagsFlat, B, T, lengths } = padTaggedBatch(idsList, tagsList, 32);

    async function step() {
      optimizer.zeroGrad();
      const { loss, value } = await tagger.loss(idsFlat, B, T, lengths, tagsFlat);
      await loss.backward();
      optimizer.step();
      return value;
    }

    const first = await step();
    let last = first;
    for (let i = 0; i < 39; i++) last = await step();

    expect(Number.isFinite(first)).toBe(true);
    expect(last).toBeLessThan(first);

    // Sanity-check actual predictions on a held-in example after training —
    // not a generalization claim, just confirming the learned pattern is
    // reflected in predict(), not only in the reported loss number.
    const predicted = await tagger.predict(tokenizer.encode('run job 100'));
    const expected = Array.from('run job 100').map(tagOf);
    const correct = predicted.filter((p, i) => p === expected[i]).length;
    expect(correct / predicted.length).toBeGreaterThan(0.7);
  });

  it('excludes padding from the loss rather than training on it', async () => {
    // Two sequences of very different length in one batch, so the short
    // one gets padded out to the long one's length. If loss() changes when
    // ONLY the padding region's tag values change — everything else held
    // identical — padding is leaking into the loss; it should not, since
    // those positions carry no real supervision.
    const tokenizer = new CharTokenizer('ab');
    const tagger = tinyTagger(tokenizer.vocabSize);
    const batchA = padTaggedBatch(
      [Int32Array.from([0]), Int32Array.from([0, 1, 0, 1, 0, 1, 0, 1])],
      [Int32Array.from([1]), Int32Array.from([0, 0, 0, 0, 0, 0, 0, 0])],
      16
    );
    const { value: valueA } = await tagger.loss(batchA.idsFlat, batchA.B, batchA.T, batchA.lengths, batchA.tagsFlat);

    // Same real data, but every padding-region tag (row 0, positions 1..T-1)
    // is flipped to the other tag instead of left at 0.
    const tagsFlatB = Int32Array.from(batchA.tagsFlat);
    for (let t = batchA.lengths[0]; t < batchA.T; t++) tagsFlatB[0 * batchA.T + t] = 1;
    const { value: valueB } = await tagger.loss(batchA.idsFlat, batchA.B, batchA.T, batchA.lengths, tagsFlatB);

    expect(valueB).toBeCloseTo(valueA, 10);
  });
});
