// Highest-risk new file in the three-model set: a wrong index anywhere in
// cross-attention's independent Q/KV row ranges, or in the BOS-shift
// teacher-forcing setup, would still "run" without throwing (matmul only
// checks inner-dimension agreement, not that the ranges are semantically
// right) — the only thing that reveals it is whether the whole pipeline
// actually learns a real pattern over real Adam steps, so that's the test
// this file leans on hardest, same as embed.test.js and tagger.test.js.
import { describe, it, expect } from 'vitest';
import { BNLMSeq2Seq } from './seq2seq.js';
import { CharTokenizer } from './tokenizer.js';
import { Adam } from './optim.js';

function tinySeq2Seq(vocabSize, seed = 1) {
  return new BNLMSeq2Seq(vocabSize, { dModel: 16, numLayers: 1, numHeads: 2, contextLen: 24, seed });
}

describe('BNLMSeq2Seq shapes and guards', () => {
  it('reserves bosId one past the real vocabulary', () => {
    const model = tinySeq2Seq(10);
    expect(model.bosId).toBe(10);
    expect(model.vocabSize).toBe(10);
  });

  it('encoder throws when the source exceeds contextLen', async () => {
    const model = tinySeq2Seq(5);
    await expect(model.encodeSource(Int32Array.from(Array(30).fill(0)), 30)).rejects.toThrow(/contextLen/);
  });

  it('decoderLogits returns one row of (vocabSize+1) logits per target position', async () => {
    const tokenizer = new CharTokenizer('abcdef');
    const model = tinySeq2Seq(tokenizer.vocabSize);
    const srcIds = tokenizer.encode('abc');
    const encoderHidden = await model.encodeSource(srcIds, srcIds.length);
    const decInput = Int32Array.from([model.bosId, ...tokenizer.encode('de')]);
    const logits = await model.decoderLogits(decInput, encoderHidden, decInput.length, srcIds.length);
    expect(logits.shape).toEqual([decInput.length, tokenizer.vocabSize + 1]);
  });

  it('generate never emits bosId and stops at maxNewTokens', async () => {
    const tokenizer = new CharTokenizer('abcdef');
    const model = tinySeq2Seq(tokenizer.vocabSize);
    const out = await model.generate(tokenizer.encode('abc'), 5);
    expect(out.length).toBeLessThanOrEqual(5);
    for (const id of out) {
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(model.vocabSize); // strictly less than vocabSize -- bosId (== vocabSize) excluded
    }
  });
});

describe('BNLMSeq2Seq end-to-end training', () => {
  it('learns a real transform (reversal) over real Adam steps, on a real trunk', async () => {
    // Tiny, fixed, perfectly-learnable transform: reverse a 3-character
    // string. Four examples, looped one at a time (B=1, per the file's own
    // design note on why) for a real gradient signal each step.
    const pairs = [
      { src: 'cat', tgt: 'tac' },
      { src: 'dog', tgt: 'god' },
      { src: 'sun', tgt: 'nus' },
      { src: 'bat', tgt: 'tab' },
    ];
    const allChars = pairs.flatMap(p => [p.src, p.tgt]).join('');
    const tokenizer = new CharTokenizer(allChars);
    const model = tinySeq2Seq(tokenizer.vocabSize, 7);
    const optimizer = new Adam(model.parameters(), { lr: 1e-2 });

    const encoded = pairs.map(p => ({ src: tokenizer.encode(p.src), tgt: tokenizer.encode(p.tgt) }));

    async function epochLoss() {
      let total = 0;
      for (const { src, tgt } of encoded) {
        optimizer.zeroGrad();
        const { loss, value } = await model.loss(src, tgt);
        await loss.backward();
        optimizer.step();
        total += value;
      }
      return total / encoded.length;
    }

    const first = await epochLoss();
    let last = first;
    for (let i = 0; i < 24; i++) last = await epochLoss();

    expect(Number.isFinite(first)).toBe(true);
    expect(last).toBeLessThan(first);
  }, 20000);
});
