// Real (not mocked) service-layer test — explainSimilarity's occlusion
// logic lives in this file, not just a thin wrapper around the engine, so
// it deserves direct coverage the way lib/localClassifier.ts's
// attributeByOcclusion gets exercised through the real engine.
import { describe, it, expect, vi } from 'vitest';
import { localEmbedder } from './localEmbedder';

describe('localEmbedder.explainSimilarity', () => {
  it('requires a trained embedder', async () => {
    await expect(localEmbedder.explainSimilarity('a', 'b')).rejects.toThrow(/trained/i);
  });

  it('returns no contributions for a single-character side, rather than throwing', async () => {
    localEmbedder.init(
      [{ a: 'the cat sat', b: 'a cat was sitting' }, { a: 'it rained hard', b: 'there was heavy rain' }],
      { dModel: 8, numLayers: 1, numHeads: 2, contextLen: 32 }
    );
    const result = await localEmbedder.explainSimilarity('a', 'the cat sat');
    expect(result.contributionsA).toEqual([]);
    expect(result.contributionsB.length).toBeGreaterThan(0);
  });

  // The real sanity check: train a tiny embedder where the ONLY reliable
  // signal tying each pair together is a shared marker substring (distinct
  // per pair, so it can't be learned as "any fixed string" — it has to be
  // learned as "whatever substring the two sides share"), then confirm
  // occluding that marker's characters drops similarity more than
  // occluding the surrounding filler does, on a HELD-OUT probe the model
  // never trained on.
  it('attributes similarity more to a shared marker phrase than to surrounding filler', async () => {
    const pairs = [
      { a: 'xyz ALPHAKEY qqq', b: 'mmm ALPHAKEY nnn' },
      { a: 'aaa BETAKEY bbb', b: 'ccc BETAKEY ddd eee' },
      { a: 'fff GAMMAKEY ggg', b: 'hhh GAMMAKEY iii' },
      { a: 'jjj DELTAKEY kkk lll', b: 'mmn DELTAKEY ooo' },
    ];
    // LocalEmbedderService.init() seeds the trunk with `Date.now() & 0xffff`
    // (deliberate for real use — retraining shouldn't always start from the
    // literal same random init) but that makes a test asserting on trained
    // BEHAVIOR flaky against wall-clock timing unless pinned. Date.now() = 1
    // gives seed 1, verified separately (see the plan/commit) to reach the
    // asserted marker-over-filler gap by 60 steps.
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(1);
    try {
      localEmbedder.init(pairs, { dModel: 16, numLayers: 1, numHeads: 2, contextLen: 32, temperature: 0.1 });
    } finally {
      dateNowSpy.mockRestore();
    }
    await localEmbedder.train(60);

    // Probe: new filler, same marker substring the model trained on,
    // positioned away from the string's end so the comparison isn't
    // confounded by last-token pooling always weighting the final
    // character heavily regardless of semantic content. Filler words are
    // built only from characters that actually appear somewhere in the
    // training pairs above — toKnownText silently strips anything else,
    // which would desync these hand-computed indices from what
    // explainSimilarity actually attributed.
    const probeA = 'add ALPHAKEY cage';
    const probeB = 'bag ALPHAKEY def';
    const { contributionsA } = await localEmbedder.explainSimilarity(probeA, probeB);

    const markerStart = probeA.indexOf('ALPHAKEY');
    const markerEnd = markerStart + 'ALPHAKEY'.length;
    const markerContribs = contributionsA.filter(c => c.index >= markerStart && c.index < markerEnd);
    const fillerContribs = contributionsA.filter(c => c.index < markerStart || c.index >= markerEnd);

    expect(markerContribs.length).toBe(8); // "ALPHAKEY".length
    expect(fillerContribs.length).toBe(probeA.length - 8);

    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const markerAvg = avg(markerContribs.map(c => c.score));
    const fillerAvg = avg(fillerContribs.map(c => c.score));

    expect(markerAvg).toBeGreaterThan(fillerAvg);
  }, 20000);
});
