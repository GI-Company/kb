// Local per-character tagger — a fourth question alongside the generative
// model's "what comes next?" (lib/localModel.ts), the classifier's "which of
// these N things is it?" (lib/localClassifier.ts), and the embedder's "how
// similar is this to that?" (lib/localEmbedder.ts). This one answers "which
// PARTS of this matter?" — supervised per-character labels in one forward
// pass, rather than one label for the whole input.
//
// Character-level, not word-level — see src/bnlm/tagger.js's header for why.
// A caller wanting word/phrase-shaped output gets it from tag()'s span-
// merging below, not from the model understanding word boundaries.

import { CharTokenizer } from '../src/bnlm/tokenizer.js';
import { BNLMTagger, padTaggedBatch } from '../src/bnlm/tagger.js';
import { Adam } from '../src/bnlm/optim.js';
import { taggerRegistry, SavedTaggerMeta } from './taggerRegistry';

export interface TaggerConfig {
  dModel: number;
  numLayers: number;
  numHeads: number;
  contextLen: number;
  mixerType: 'attention' | 'linear' | 'rwkv';
  lr: number;
  batchSize: number;
}

export interface TaggedExample {
  text: string;
  /** One tag per character of text — must have the same length as Array.from(text). */
  tags: string[];
}

// Same small default as DEFAULT_CLASSIFIER_CONFIG and DEFAULT_EMBEDDER_CONFIG
// — a per-position head over a small trunk is plenty for a task this
// narrow, and an oversized model just memorizes a small dataset instead of
// learning the pattern (see localClassifier.ts's measured comment on this).
export const DEFAULT_TAGGER_CONFIG: TaggerConfig = {
  dModel: 24,
  numLayers: 1,
  numHeads: 4,
  contextLen: 96,
  mixerType: 'linear',
  lr: 3e-3,
  batchSize: 16,
};

export interface InitResult {
  vocabSize: number;
  paramCount: number;
  tagLabels: string[];
  examples: number;
}

export interface TaggerTrainResult {
  steps: number;
  finalLoss: number;
  lossHistory: number[];
  paramCount: number;
  vocabSize: number;
  tagLabels: string[];
}

export interface TagSpan {
  tag: string;
  start: number;
  end: number;
  text: string;
}

function shuffled<T>(arr: T[], rand: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

class LocalTaggerService {
  private tokenizer: CharTokenizer | null = null;
  private model: BNLMTagger | null = null;
  private optimizer: Adam | null = null;
  private tagLabels: string[] = [];
  private config: TaggerConfig = { ...DEFAULT_TAGGER_CONFIG };
  private encoded: { ids: Int32Array; tags: Int32Array }[] = [];
  /** Kept alongside the encoded form so a saved tagger stays inspectable and retrainable. */
  private examples: TaggedExample[] = [];

  get isReady(): boolean {
    return !!this.model && !!this.tokenizer;
  }

  get currentTagLabels(): string[] {
    return [...this.tagLabels];
  }

  get currentConfig(): TaggerConfig {
    return { ...this.config };
  }

  /** Builds the vocabulary and tag set from the training examples and initializes a fresh model. Must be called before train(). */
  init(examples: TaggedExample[], overrides: Partial<TaggerConfig> = {}): InitResult {
    const config: TaggerConfig = { ...DEFAULT_TAGGER_CONFIG, ...overrides };
    if (config.dModel % config.numHeads !== 0) {
      throw new Error(`dModel (${config.dModel}) must be divisible by numHeads (${config.numHeads}).`);
    }
    if (examples.length === 0) {
      throw new Error('No training examples — add some tagged text first.');
    }
    for (const e of examples) {
      const chars = Array.from(e.text).length;
      if (e.tags.length !== chars) {
        throw new Error(`"${e.text}" has ${chars} characters but ${e.tags.length} tags — they must match one-for-one.`);
      }
    }

    const tagLabels = Array.from(new Set(examples.flatMap(e => e.tags))).sort();
    if (tagLabels.length < 2) {
      throw new Error(`A tagger needs at least 2 distinct tags to have anything to decide between — found only "${tagLabels[0]}".`);
    }

    // Vocabulary comes from the training text alone, so anything unseen at
    // tag() time has to be filtered rather than encoded.
    const tokenizer = new CharTokenizer(examples.map(e => e.text).join('\n'));
    const tagIndex = new Map(tagLabels.map((l, i) => [l, i]));

    this.examples = [...examples];
    this.encoded = examples.map(e => ({
      ids: tokenizer.encode(e.text),
      tags: Int32Array.from(e.tags.map(t => tagIndex.get(t)!)),
    }));

    const model = new BNLMTagger(tokenizer.vocabSize, tagLabels.length, {
      dModel: config.dModel,
      numLayers: config.numLayers,
      numHeads: config.numHeads,
      contextLen: config.contextLen,
      mixerType: config.mixerType,
    });

    this.tokenizer = tokenizer;
    this.model = model;
    this.tagLabels = tagLabels;
    this.config = config;
    this.optimizer = new Adam(model.parameters(), { lr: config.lr });

    return { vocabSize: tokenizer.vocabSize, paramCount: model.paramCount(), tagLabels, examples: examples.length };
  }

  async train(steps = 300, onProgress?: (step: number, loss: number) => void): Promise<TaggerTrainResult> {
    if (!this.model || !this.optimizer) throw new Error('Tagger not initialized — call init() first.');
    const model = this.model;
    const lossHistory: number[] = [];
    let rngState = 20260819;
    const rand = () => {
      rngState = (rngState * 1664525 + 1013904223) >>> 0;
      return rngState / 0x100000000;
    };

    const batchSize = Math.min(this.config.batchSize, this.encoded.length);
    let lastLoss = 0;

    for (let step = 0; step < steps; step++) {
      const batch = shuffled(this.encoded, rand).slice(0, batchSize);
      const { idsFlat, tagsFlat, B, T, lengths } = padTaggedBatch(
        batch.map(b => b.ids),
        batch.map(b => b.tags),
        this.config.contextLen
      );

      model.zeroGrad();
      const { loss, value } = await model.loss(idsFlat, B, T, lengths, tagsFlat);
      await loss.backward();
      this.optimizer.step();

      lastLoss = value;
      lossHistory.push(value);
      onProgress?.(step + 1, value);

      if (step % 10 === 0) await new Promise(r => setTimeout(r, 0));
    }

    return {
      steps,
      finalLoss: lastLoss,
      lossHistory,
      paramCount: model.paramCount(),
      vocabSize: this.tokenizer!.vocabSize,
      tagLabels: [...this.tagLabels],
    };
  }

  /** Initializes on the given examples (if not already trained) and trains in one call — the shape an agent tool-call wants. */
  async ensureInitAndTrain(
    examples: TaggedExample[],
    steps: number,
    overrides: Partial<TaggerConfig> = {},
    onProgress?: (step: number, loss: number) => void
  ): Promise<{ init: InitResult; train: TaggerTrainResult }> {
    const init = this.init(examples, overrides);
    const train = await this.train(steps, onProgress);
    return { init, train };
  }

  /**
   * Tags every character of text, then merges consecutive same-tag runs
   * into spans — a caller almost always wants "which stretch of text got
   * flagged," not a raw array of one tag per character.
   */
  async tag(text: string): Promise<TagSpan[]> {
    if (!this.model || !this.tokenizer) throw new Error('No tagger has been trained yet in this tab.');
    const chars = Array.from(text);
    const known = chars.filter(c => this.tokenizer!.stoi.has(c));
    if (known.length === 0) {
      throw new Error('None of that input\'s characters appear in the training data, so there is nothing to tag.');
    }
    // Filtering to known chars (same convention as classifier/embedder)
    // changes the string being tagged, so indices below are reported
    // against the FILTERED string, not the original — documented via the
    // returned span's own `text` field rather than left implicit.
    const knownText = known.join('');
    const ids = this.tokenizer.encode(knownText);
    const tagIds = await this.model.predict(ids);

    const spans: TagSpan[] = [];
    let start = 0;
    for (let i = 1; i <= known.length; i++) {
      if (i === known.length || tagIds[i] !== tagIds[start]) {
        spans.push({
          tag: this.tagLabels[tagIds[start]],
          start,
          end: i,
          text: known.slice(start, i).join(''),
        });
        start = i;
      }
    }
    return spans;
  }

  // ── Named persistence, mirroring lib/localClassifier.ts's and
  // lib/localEmbedder.ts's precedent — IndexedDB-only via
  // lib/taggerRegistry.ts, no Supabase sync. ──

  async listSaved(): Promise<SavedTaggerMeta[]> {
    return taggerRegistry.list();
  }

  async saveAs(name: string): Promise<void> {
    if (!this.model || !this.tokenizer) throw new Error('No tagger has been trained yet in this tab.');
    if (!name.trim()) throw new Error('Give the tagger a name to save it under.');
    const params = this.model.parameters();
    const paramBuffers: ArrayBuffer[] = params.map((p: any) => p.data.buffer.slice(p.data.byteOffset, p.data.byteOffset + p.data.byteLength));
    const paramShapes: number[][] = params.map((p: any) => p.shape);
    await taggerRegistry.save({
      name: name.trim(),
      savedAt: new Date().toISOString(),
      config: this.config,
      tagLabels: this.tagLabels,
      vocabSize: this.tokenizer.vocabSize,
      paramCount: this.model.paramCount(),
      exampleCount: this.examples.length,
      vocabChars: this.tokenizer.itos.join(''),
      examples: [...this.examples],
      paramShapes,
      paramBuffers,
    });
  }

  async loadSaved(name: string): Promise<InitResult> {
    const record = await taggerRegistry.load(name);
    if (!record) throw new Error(`No saved tagger named "${name}".`);

    const tokenizer = new CharTokenizer(record.vocabChars);
    const model = new BNLMTagger(tokenizer.vocabSize, record.tagLabels.length, {
      dModel: record.config.dModel,
      numLayers: record.config.numLayers,
      numHeads: record.config.numHeads,
      contextLen: record.config.contextLen,
      mixerType: record.config.mixerType,
      seed: 1234,
    });
    const params = model.parameters();
    if (params.length !== record.paramBuffers.length) {
      throw new Error('Saved tagger is incompatible with the current BNLM engine version (parameter count mismatch).');
    }
    params.forEach((p: any, i: number) => p.data.set(new Float32Array(record.paramBuffers[i])));

    const tagIndex = new Map(record.tagLabels.map((l, i) => [l, i]));
    this.tokenizer = tokenizer;
    this.model = model;
    this.tagLabels = record.tagLabels;
    this.examples = record.examples;
    this.encoded = record.examples.map(e => ({
      ids: tokenizer.encode(e.text),
      tags: Int32Array.from(e.tags.map(t => tagIndex.get(t) ?? 0)),
    }));
    this.config = record.config;
    this.optimizer = new Adam(model.parameters(), { lr: record.config.lr });

    return { vocabSize: tokenizer.vocabSize, paramCount: model.paramCount(), tagLabels: record.tagLabels, examples: record.examples.length };
  }

  async deleteSaved(name: string): Promise<void> {
    await taggerRegistry.remove(name);
  }
}

export const localTagger = new LocalTaggerService();
