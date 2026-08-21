// Real (not mocked) service-layer test — explainScore's per-character
// surprise logic lives in this file, exercised against the real engine.
import { describe, it, expect, vi } from 'vitest';
import { localModel } from './localModel';

describe('localModel.explainScore', () => {
  // localModel is a singleton with module-level state; vitest gives each
  // test FILE a fresh module graph, so at the start of this file it's
  // genuinely untrained — this only holds because it runs before the
  // training test below in this same file, not because of any reset.
  it('requires a trained model', async () => {
    await expect(localModel.explainScore('test')).rejects.toThrow(/train/i);
  });

  // The real test: on a corpus with a single, perfectly deterministic
  // local pattern (strict a/b alternation — an easy target for a tiny
  // model in a handful of steps), a character that breaks the pattern
  // should score far higher surprise than one that continues it. Verified
  // empirically with a throwaway probe script before writing these
  // specific assertions, not guessed — the gap is large (~0.03 vs ~3.4
  // nats in the probe), so this isn't a knife-edge threshold.
  it('scores a pattern-breaking character as far more surprising than an in-pattern one', async () => {
    const corpus = 'ab'.repeat(40);
    // LocalModelService.init() seeds with `Date.now() & 0xffff` (same
    // deliberate-for-real-use, bad-for-tests pattern as
    // LocalEmbedderService — see lib/localEmbedder.test.ts). Pin it so the
    // trained model's behavior is reproducible.
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(1);
    try {
      await localModel.init(corpus, { dModel: 16, numLayers: 1, numHeads: 2, contextLen: 16, mixerType: 'attention', numWorkers: 1 });
    } finally {
      dateNowSpy.mockRestore();
    }
    await localModel.train(60);

    // "ababaabab" — a deliberate break (the double "aa") after four clean
    // a/b alternations.
    const { overall, perCharacter } = await localModel.explainScore('ababaabab');

    expect(overall.tokensScored).toBe(8);
    expect(perCharacter).toHaveLength(8);

    const inPatternSurprise = perCharacter[0].surprise; // predicts 'b' after "a" — the rule every training step reinforces
    const breakSurprise = perCharacter[4].surprise; // predicts 'a' after "ababa" — the rule says 'b' here, this is the injected break

    expect(perCharacter[4].char).toBe('a');
    expect(breakSurprise).toBeGreaterThan(inPatternSurprise * 5);

    // topAlternatives should be real probabilities, not a decorative list.
    for (const p of perCharacter) {
      expect(p.actualProb).toBeGreaterThan(0);
      expect(p.actualProb).toBeLessThanOrEqual(1);
      expect(p.topAlternatives.length).toBeGreaterThan(0);
      expect(p.topAlternatives[0].prob).toBeGreaterThanOrEqual(p.actualProb - 1e-6); // the top alternative can't be less likely than the actual pick
    }
  }, 20000);
});
