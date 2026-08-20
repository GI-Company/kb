// Scoped to bnlm.buildGenerative and the embedder tools — the rest of
// runLocalModelTool's tools don't have coverage here yet either; this file
// started with the newest tool rather than backfilling the whole dispatcher
// in one unrelated change, and grew alongside it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ensureInitAndTrain = vi.fn();
vi.mock('./localModel', () => ({
  localModel: {
    get isReady() { return false; },
    ensureInitAndTrain: (...a: any[]) => ensureInitAndTrain(...a),
  },
}));

const generateProseCorpus = vi.fn();
const generateParaphrasePairs = vi.fn();
vi.mock('./datasetGen', () => ({
  generateProseCorpus: (...a: any[]) => generateProseCorpus(...a),
  generateParaphrasePairs: (...a: any[]) => generateParaphrasePairs(...a),
  generateLabeledExamples: vi.fn(),
  describeDataset: vi.fn(),
}));

vi.mock('./localClassifier', () => ({
  localClassifier: {},
}));

let embedderReady = false;
const embedderEnsureInitAndTrain = vi.fn();
const embedderEmbed = vi.fn();
const embedderSimilarity = vi.fn();
vi.mock('./localEmbedder', () => ({
  localEmbedder: {
    get isReady() { return embedderReady; },
    ensureInitAndTrain: (...a: any[]) => embedderEnsureInitAndTrain(...a),
    embed: (...a: any[]) => embedderEmbed(...a),
    similarity: (...a: any[]) => embedderSimilarity(...a),
  },
}));

const vfsList = vi.fn();
const vfsRead = vi.fn();
vi.mock('./vfs', () => ({
  vfs: {
    list: (...a: any[]) => vfsList(...a),
    read: (...a: any[]) => vfsRead(...a),
  },
}));

const resolveDir = vi.fn();
vi.mock('./terminalFs', () => ({
  resolveDir: (...a: any[]) => resolveDir(...a),
  ROOT_CWD: [],
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

describe('bnlm.buildEmbeddingIndex', () => {
  beforeEach(() => {
    generateParaphrasePairs.mockReset();
    embedderEnsureInitAndTrain.mockReset();
  });

  it('rejects a call with no topic', async () => {
    await expect(runLocalModelTool({ tool: 'bnlm.buildEmbeddingIndex', args: {} }))
      .rejects.toThrow(/topic/i);
    expect(generateParaphrasePairs).not.toHaveBeenCalled();
  });

  it('generates paraphrase pairs via Groq once, then trains the embedder locally', async () => {
    const pairs = [{ a: 'x', b: 'y' }, { a: 'p', b: 'q' }];
    generateParaphrasePairs.mockResolvedValue(pairs);
    embedderEnsureInitAndTrain.mockResolvedValue({
      init: { vocabSize: 12, paramCount: 4321, pairs: 2 },
      train: { steps: 100, finalLoss: 0.5, lossHistory: [], paramCount: 4321, vocabSize: 12 },
    });

    const result = await runLocalModelTool({
      tool: 'bnlm.buildEmbeddingIndex',
      args: { topic: 'project notes', count: 10, steps: 100 },
    });

    expect(generateParaphrasePairs).toHaveBeenCalledWith('project notes', 10);
    expect(embedderEnsureInitAndTrain).toHaveBeenCalledWith(pairs, 100);
    expect(result.text).toContain('project notes');
    expect(result.text).toContain('4,321');
  });

  it('refuses to train when Groq returns fewer than 2 usable pairs', async () => {
    generateParaphrasePairs.mockResolvedValue([{ a: 'only one', b: 'pair' }]);

    await expect(runLocalModelTool({
      tool: 'bnlm.buildEmbeddingIndex',
      args: { topic: 'x' },
    })).rejects.toThrow(/too few/i);

    expect(embedderEnsureInitAndTrain).not.toHaveBeenCalled();
  });
});

describe('bnlm.similarity', () => {
  beforeEach(() => {
    embedderReady = true;
    embedderSimilarity.mockReset();
  });

  it('rejects a call missing either text argument', async () => {
    await expect(runLocalModelTool({ tool: 'bnlm.similarity', args: { textA: 'only one side' } }))
      .rejects.toThrow(/textA.*textB/i);
  });

  it('requires a trained embedder', async () => {
    embedderReady = false;
    await expect(runLocalModelTool({ tool: 'bnlm.similarity', args: { textA: 'a', textB: 'b' } }))
      .rejects.toThrow(/buildEmbeddingIndex/);
  });

  it('reports the cosine similarity from the trained embedder', async () => {
    embedderSimilarity.mockResolvedValue(0.8234);
    const result = await runLocalModelTool({ tool: 'bnlm.similarity', args: { textA: 'a', textB: 'b' } });
    expect(embedderSimilarity).toHaveBeenCalledWith('a', 'b');
    expect(result.text).toContain('0.823');
  });
});

describe('bnlm.semanticSearch', () => {
  beforeEach(() => {
    embedderReady = true;
    embedderEmbed.mockReset();
    vfsList.mockReset();
    vfsRead.mockReset();
    resolveDir.mockReset();
  });

  it('rejects a call with no query', async () => {
    await expect(runLocalModelTool({ tool: 'bnlm.semanticSearch', args: {} }, 'user-1'))
      .rejects.toThrow(/query/i);
  });

  it('requires a trained embedder', async () => {
    embedderReady = false;
    await expect(runLocalModelTool({ tool: 'bnlm.semanticSearch', args: { query: 'x' } }, 'user-1'))
      .rejects.toThrow(/buildEmbeddingIndex/);
  });

  it('requires a signed-in userId, since it reads the VFS', async () => {
    await expect(runLocalModelTool({ tool: 'bnlm.semanticSearch', args: { query: 'x' } }))
      .rejects.toThrow(/signed-in/i);
  });

  it('surfaces a bad path as an error instead of silently searching nothing', async () => {
    resolveDir.mockResolvedValue('/nope: No such file or directory');
    await expect(runLocalModelTool({ tool: 'bnlm.semanticSearch', args: { query: 'x', path: '/nope' } }, 'user-1'))
      .rejects.toThrow(/No such file or directory/);
  });

  it('walks the VFS, embeds files, and ranks them by similarity to the query', async () => {
    resolveDir.mockResolvedValue([]);
    // Two files at the root, no subdirectories.
    vfsList.mockImplementation(async (dirId: string) => {
      if (dirId === 'home') {
        return [
          { id: 'f1', name: 'a.txt', type: 'file' },
          { id: 'f2', name: 'b.txt', type: 'file' },
          { id: 'bin', name: 'image.png', type: 'file', encoding: 'base64' },
        ];
      }
      return [];
    });
    vfsRead.mockImplementation(async (id: string) => {
      if (id === 'f1') return 'notes about the login bug';
      if (id === 'f2') return 'a grocery list';
      return '';
    });
    // Real cosineSimilarity runs unmocked (see the vi.mock list above — only
    // localEmbedder is mocked, not src/bnlm/embed.js), so these fixed
    // vectors drive a genuine, checkable ranking rather than a fake score.
    embedderEmbed.mockImplementation(async (text: string) => {
      if (text === 'login bug') return new Float32Array([1, 0]);
      if (text.startsWith('notes about the login bug')) return new Float32Array([1, 0]);
      if (text.startsWith('a grocery list')) return new Float32Array([0, 1]);
      return new Float32Array([0, 0]);
    });

    const result = await runLocalModelTool({
      tool: 'bnlm.semanticSearch',
      args: { query: 'login bug', path: '/' },
    }, 'user-1');

    // The base64 file must never reach embed() — embedding raw base64 text
    // would be meaningless.
    expect(embedderEmbed).not.toHaveBeenCalledWith(expect.stringContaining('image'));
    expect(result.text).toMatch(/a\.txt/);
    expect(result.text).toMatch(/b\.txt/);
    // a.txt (cosine 1.0) must rank above b.txt (cosine 0.0).
    expect(result.text.indexOf('a.txt')).toBeLessThan(result.text.indexOf('b.txt'));
  });

  it('reports plainly when no readable files exist under the path', async () => {
    resolveDir.mockResolvedValue([]);
    vfsList.mockResolvedValue([]);

    const result = await runLocalModelTool({
      tool: 'bnlm.semanticSearch',
      args: { query: 'anything', path: '/' },
    }, 'user-1');

    expect(result.text).toMatch(/no readable/i);
    expect(embedderEmbed).not.toHaveBeenCalled();
  });
});
