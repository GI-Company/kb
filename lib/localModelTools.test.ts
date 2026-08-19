// Scoped to bnlm.buildGenerative — the rest of runLocalModelTool's tools
// don't have coverage here yet either; this file starts with the newest one
// rather than backfilling the whole dispatcher in one unrelated change.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ensureInitAndTrain = vi.fn();
vi.mock('./localModel', () => ({
  localModel: {
    get isReady() { return false; },
    ensureInitAndTrain: (...a: any[]) => ensureInitAndTrain(...a),
  },
}));

const generateProseCorpus = vi.fn();
vi.mock('./datasetGen', () => ({
  generateProseCorpus: (...a: any[]) => generateProseCorpus(...a),
  generateLabeledExamples: vi.fn(),
  describeDataset: vi.fn(),
}));

vi.mock('./localClassifier', () => ({
  localClassifier: {},
}));

import { runLocalModelTool } from './localModelTools';

describe('bnlm.buildGenerative', () => {
  beforeEach(() => {
    ensureInitAndTrain.mockReset();
    generateProseCorpus.mockReset();
  });

  it('rejects a call with no topic', async () => {
    await expect(runLocalModelTool({ tool: 'bnlm.buildGenerative', args: {} }))
      .rejects.toThrow(/topic/i);
    expect(generateProseCorpus).not.toHaveBeenCalled();
  });

  it('generates a corpus via Groq once, then trains locally on it', async () => {
    generateProseCorpus.mockResolvedValue('a story\n\nanother story');
    ensureInitAndTrain.mockResolvedValue({
      init: { paramCount: 12345, vocabSize: 200, documents: 2 },
      train: { steps: 50, finalLoss: 1.234, lossHistory: [], elapsedMs: 10 },
    });

    const result = await runLocalModelTool({
      tool: 'bnlm.buildGenerative',
      args: { topic: 'a robot learning to paint', count: 10, steps: 50 },
    });

    expect(generateProseCorpus).toHaveBeenCalledTimes(1);
    expect(generateProseCorpus).toHaveBeenCalledWith('a robot learning to paint', 10);
    expect(ensureInitAndTrain).toHaveBeenCalledTimes(1);
    expect(ensureInitAndTrain).toHaveBeenCalledWith('a story\n\nanother story', 50);
    expect(result.text).toContain('a robot learning to paint');
    expect(result.text).toContain('12,345');
    expect(result.text).toContain('1.234');
  });

  it('clamps count and steps into their allowed ranges rather than passing raw input through', async () => {
    generateProseCorpus.mockResolvedValue('a story');
    ensureInitAndTrain.mockResolvedValue({
      init: { paramCount: 1, vocabSize: 1, documents: 1 },
      train: { steps: 500, finalLoss: 0, lossHistory: [], elapsedMs: 0 },
    });

    await runLocalModelTool({
      tool: 'bnlm.buildGenerative',
      args: { topic: 'x', count: 99999, steps: -5 },
    });

    // count clamps to 100, steps clamps up to at least 1
    expect(generateProseCorpus).toHaveBeenCalledWith('x', 100);
    expect(ensureInitAndTrain).toHaveBeenCalledWith('a story', 1);
  });

  it('refuses to train on an empty corpus rather than silently training on nothing', async () => {
    generateProseCorpus.mockResolvedValue('   \n  ');

    await expect(runLocalModelTool({
      tool: 'bnlm.buildGenerative',
      args: { topic: 'x' },
    })).rejects.toThrow(/empty/i);

    expect(ensureInitAndTrain).not.toHaveBeenCalled();
  });
});
