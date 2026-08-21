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
const generateTaggedExamples = vi.fn();
const generateTransformPairs = vi.fn();
vi.mock('./datasetGen', () => ({
  generateProseCorpus: (...a: any[]) => generateProseCorpus(...a),
  generateParaphrasePairs: (...a: any[]) => generateParaphrasePairs(...a),
  generateTaggedExamples: (...a: any[]) => generateTaggedExamples(...a),
  generateTransformPairs: (...a: any[]) => generateTransformPairs(...a),
  generateLabeledExamples: vi.fn(),
  describeDataset: vi.fn(),
}));

vi.mock('./localClassifier', () => ({
  localClassifier: {},
}));

let embedderReady = false;
const embedderEnsureInitAndTrain = vi.fn();
const embedderEmbed = vi.fn();
const embedderExplainSimilarity = vi.fn();
vi.mock('./localEmbedder', () => ({
  localEmbedder: {
    get isReady() { return embedderReady; },
    ensureInitAndTrain: (...a: any[]) => embedderEnsureInitAndTrain(...a),
    embed: (...a: any[]) => embedderEmbed(...a),
    explainSimilarity: (...a: any[]) => embedderExplainSimilarity(...a),
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

let taggerReady = false;
const taggerEnsureInitAndTrain = vi.fn();
const taggerTag = vi.fn();
vi.mock('./localTagger', () => ({
  localTagger: {
    get isReady() { return taggerReady; },
    ensureInitAndTrain: (...a: any[]) => taggerEnsureInitAndTrain(...a),
    tag: (...a: any[]) => taggerTag(...a),
  },
}));

let seq2seqReady = false;
const seq2seqEnsureInitAndTrain = vi.fn();
const seq2seqTransform = vi.fn();
vi.mock('./localSeq2Seq', () => ({
  localSeq2Seq: {
    get isReady() { return seq2seqReady; },
    ensureInitAndTrain: (...a: any[]) => seq2seqEnsureInitAndTrain(...a),
    transform: (...a: any[]) => seq2seqTransform(...a),
  },
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
    embedderExplainSimilarity.mockReset();
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

  it('reports the cosine similarity and a similarity glassBox from the trained embedder', async () => {
    embedderExplainSimilarity.mockResolvedValue({
      score: 0.8234,
      contributionsA: [{ token: 'a', index: 0, score: 0.1 }],
      contributionsB: [{ token: 'b', index: 0, score: 0.05 }],
    });
    const result = await runLocalModelTool({ tool: 'bnlm.similarity', args: { textA: 'a', textB: 'b' } });
    expect(embedderExplainSimilarity).toHaveBeenCalledWith('a', 'b');
    expect(result.text).toContain('0.823');
    expect(result.glassBox).toEqual({
      kind: 'similarity',
      score: 0.8234,
      contributionsA: [{ token: 'a', index: 0, score: 0.1 }],
      contributionsB: [{ token: 'b', index: 0, score: 0.05 }],
    });
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

describe('bnlm.buildTagger', () => {
  beforeEach(() => {
    generateTaggedExamples.mockReset();
    taggerEnsureInitAndTrain.mockReset();
  });

  it('rejects a call missing tags, defaultTag, or domain', async () => {
    await expect(runLocalModelTool({ tool: 'bnlm.buildTagger', args: {} }))
      .rejects.toThrow(/tags/i);
    await expect(runLocalModelTool({ tool: 'bnlm.buildTagger', args: { tags: ['risky'] } }))
      .rejects.toThrow(/defaultTag/i);
    await expect(runLocalModelTool({ tool: 'bnlm.buildTagger', args: { tags: ['risky'], defaultTag: 'safe' } }))
      .rejects.toThrow(/domain/i);
    expect(generateTaggedExamples).not.toHaveBeenCalled();
  });

  it('generates tagged examples via Groq once, then trains the tagger locally', async () => {
    const examples = [{ text: 'rm now', tags: ['risky', 'risky', 'safe', 'safe', 'safe', 'safe'] }];
    generateTaggedExamples.mockResolvedValue(examples);
    taggerEnsureInitAndTrain.mockResolvedValue({
      init: { vocabSize: 10, paramCount: 999, tagLabels: ['risky', 'safe'], examples: 1 },
      train: { steps: 200, finalLoss: 0.4, lossHistory: [], paramCount: 999, vocabSize: 10, tagLabels: ['risky', 'safe'] },
    });

    const result = await runLocalModelTool({
      tool: 'bnlm.buildTagger',
      args: { tags: ['risky'], defaultTag: 'safe', domain: 'shell commands', count: 10, steps: 200 },
    });

    expect(generateTaggedExamples).toHaveBeenCalledWith(['risky'], 'safe', 'shell commands', 10);
    expect(taggerEnsureInitAndTrain).toHaveBeenCalledWith(examples, 200);
    expect(result.text).toContain('shell commands');
    expect(result.text).toContain('999');
    expect(result.text).toContain('risky, safe');
  });

  it('refuses to train when Groq returns no usable examples', async () => {
    generateTaggedExamples.mockResolvedValue([]);

    await expect(runLocalModelTool({
      tool: 'bnlm.buildTagger',
      args: { tags: ['risky'], defaultTag: 'safe', domain: 'x' },
    })).rejects.toThrow(/no usable/i);

    expect(taggerEnsureInitAndTrain).not.toHaveBeenCalled();
  });
});

describe('bnlm.tag', () => {
  beforeEach(() => {
    taggerReady = true;
    taggerTag.mockReset();
  });

  it('rejects a call with no text', async () => {
    await expect(runLocalModelTool({ tool: 'bnlm.tag', args: {} }))
      .rejects.toThrow(/text/i);
  });

  it('requires a trained tagger', async () => {
    taggerReady = false;
    await expect(runLocalModelTool({ tool: 'bnlm.tag', args: { text: 'rm -rf /' } }))
      .rejects.toThrow(/buildTagger/);
  });

  it('reports every tagged span, with confidence, and a tagging glassBox', async () => {
    const spans = [
      { tag: 'risky', start: 0, end: 8, text: 'rm -rf /', confidence: 0.97 },
      { tag: 'safe', start: 8, end: 24, text: ' deletes everything', confidence: 0.85 },
    ];
    taggerTag.mockResolvedValue(spans);

    const result = await runLocalModelTool({ tool: 'bnlm.tag', args: { text: 'rm -rf / deletes everything' } });

    expect(taggerTag).toHaveBeenCalledWith('rm -rf / deletes everything');
    expect(result.text).toContain('[risky] "rm -rf /" (97%)');
    expect(result.text).toContain('[safe] " deletes everything" (85%)');
    expect(result.glassBox).toEqual({ kind: 'tagging', spans });
  });
});

describe('bnlm.buildTransform', () => {
  beforeEach(() => {
    generateTransformPairs.mockReset();
    seq2seqEnsureInitAndTrain.mockReset();
  });

  it('rejects a call with no task', async () => {
    await expect(runLocalModelTool({ tool: 'bnlm.buildTransform', args: {} }))
      .rejects.toThrow(/task/i);
    expect(generateTransformPairs).not.toHaveBeenCalled();
  });

  it('generates transform pairs via Groq once, then trains the encoder-decoder locally', async () => {
    const pairs = [{ input: 'hey whats up', output: 'Hello, how are you?' }];
    generateTransformPairs.mockResolvedValue(pairs);
    seq2seqEnsureInitAndTrain.mockResolvedValue({
      init: { vocabSize: 20, paramCount: 5555, pairs: 1 },
      train: { steps: 400, finalLoss: 0.2, lossHistory: [], paramCount: 5555, vocabSize: 20 },
    });

    const result = await runLocalModelTool({
      tool: 'bnlm.buildTransform',
      args: { task: 'formalize casual messages', count: 10, steps: 400 },
    });

    expect(generateTransformPairs).toHaveBeenCalledWith('formalize casual messages', 10);
    expect(seq2seqEnsureInitAndTrain).toHaveBeenCalledWith(pairs, 400);
    expect(result.text).toContain('formalize casual messages');
    expect(result.text).toContain('5,555');
  });

  it('refuses to train when Groq returns no usable pairs', async () => {
    generateTransformPairs.mockResolvedValue([]);

    await expect(runLocalModelTool({
      tool: 'bnlm.buildTransform',
      args: { task: 'x' },
    })).rejects.toThrow(/no usable/i);

    expect(seq2seqEnsureInitAndTrain).not.toHaveBeenCalled();
  });
});

describe('bnlm.transform', () => {
  beforeEach(() => {
    seq2seqReady = true;
    seq2seqTransform.mockReset();
  });

  it('rejects a call with no text', async () => {
    await expect(runLocalModelTool({ tool: 'bnlm.transform', args: {} }))
      .rejects.toThrow(/text/i);
  });

  it('requires a trained seq2seq model', async () => {
    seq2seqReady = false;
    await expect(runLocalModelTool({ tool: 'bnlm.transform', args: { text: 'hi' } }))
      .rejects.toThrow(/buildTransform/);
  });

  it('reports the transformed output from the trained model', async () => {
    seq2seqTransform.mockResolvedValue('Hello, how are you?');
    const result = await runLocalModelTool({ tool: 'bnlm.transform', args: { text: 'hey whats up', maxTokens: 40 } });
    expect(seq2seqTransform).toHaveBeenCalledWith('hey whats up', 40);
    expect(result.text).toContain('Hello, how are you?');
  });
});
