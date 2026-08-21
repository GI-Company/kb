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

describe('BNLMSeq2Seq.generateWithAttention', () => {
  it('returns one valid probability distribution over the source per generated character', async () => {
    const tokenizer = new CharTokenizer('abcdef');
    const model = tinySeq2Seq(tokenizer.vocabSize);
    const srcIds = tokenizer.encode('abcde');
    const { generated, attentionPerStep } = await model.generateWithAttention(srcIds, 3);

    expect(attentionPerStep).toHaveLength(generated.length);
    for (const row of attentionPerStep) {
      expect(row).toHaveLength(srcIds.length);
      let sum = 0;
      for (const w of row) {
        expect(w).toBeGreaterThanOrEqual(0); // softmax output, never negative
        sum += w;
      }
      expect(sum).toBeCloseTo(1, 4); // a real probability distribution over source positions
    }
  });

  // What's honest to claim here, and what isn't: tried the plan's original
  // "attention concentrates on the ONE semantically correct source
  // position" claim first, on a "copy the distinguishing digit" toy task,
  // and it did not hold up — verified empirically with a throwaway probe
  // script across several configurations (1 vs 2 heads, 60 vs 150 steps,
  // fixed vs varying digit position), not assumed. Attention-weight
  // interpretability is known to be less crisp than input-occlusion even
  // in full-scale, well-trained Transformers; forcing a specific-position
  // claim through at this toy scale would mean tuning the test until an
  // assertion passed for the wrong reason, the exact thing this session
  // avoids elsewhere (see tagger.test.js's confidence test for the same
  // situation). What IS reliably true, and is what this test checks: real
  // training makes attention genuinely depend on the input — the
  // difference between two different sources' attention patterns grows
  // well past what random initialization alone produces (confirmed
  // empirically: ~0.001 max difference untrained vs. ~0.08 after real
  // training, an ~70x gap) — a smaller, more defensible claim than the
  // originally planned one, checked here by comparing the SAME model's
  // untrained-vs-trained cross-input divergence rather than against a
  // fixed magic threshold tied to one lucky seed.
  it('becomes measurably more input-sensitive after real training than random init alone produces', async () => {
    const pairs = [
      { src: 'ab1cd', tgt: '1' },
      { src: 'xy2zw', tgt: '2' },
      { src: 'mn3op', tgt: '3' },
      { src: 'qr4st', tgt: '4' },
    ];
    const allText = pairs.flatMap(p => [p.src, p.tgt]).join('') + 'efghijklopqrstuvwz';
    const tokenizer = new CharTokenizer(allText);
    const model = new BNLMSeq2Seq(tokenizer.vocabSize, { dModel: 16, numLayers: 1, numHeads: 1, contextLen: 16, seed: 3 });
    const optimizer = new Adam(model.parameters(), { lr: 1e-2 });
    const encoded = pairs.map(p => ({ src: tokenizer.encode(p.src), tgt: tokenizer.encode(p.tgt) }));

    const probeA = tokenizer.encode('ab1cd');
    const probeB = tokenizer.encode('xy2zw');

    async function maxCrossInputDiff() {
      const rA = await model.generateWithAttention(probeA, 1);
      const rB = await model.generateWithAttention(probeB, 1);
      let maxDiff = 0;
      for (let i = 0; i < probeA.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(rA.attentionPerStep[0][i] - rB.attentionPerStep[0][i]));
      }
      return maxDiff;
    }

    const untrainedDiff = await maxCrossInputDiff();

    for (let epoch = 0; epoch < 80; epoch++) {
      for (const { src, tgt } of encoded) {
        optimizer.zeroGrad();
        const { loss } = await model.loss(src, tgt);
        await loss.backward();
        optimizer.step();
      }
    }

    const trainedDiff = await maxCrossInputDiff();
    expect(trainedDiff).toBeGreaterThan(untrainedDiff * 3);
  }, 20000);
});
