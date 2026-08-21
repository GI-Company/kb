// Local text embedder — answers "how similar is this to that?", the third
// question alongside the generative model's "what comes next?"
// (lib/localModel.ts) and the classifier's "which of these N things is it?"
// (lib/localClassifier.ts). Turning text into a vector is what makes
// semantic search over your own files possible with zero cloud calls at
// query time — see lib/localModelTools.ts's bnlm.semanticSearch.
//
// Trained on PAIRS of text that should embed close together (paraphrases,
// near-duplicates) rather than labels — see src/bnlm/embed.js for the
// contrastive objective itself. Groq is useful for *generating* those pairs
// once (lib/datasetGen.ts's generateParaphrasePairs), same "spend the cloud
// call once, train, then run locally forever" shape as bnlm.buildClassifier
// and bnlm.buildGenerative.

import { BNLM } from '../src/bnlm/model.js';
import { CharTokenizer } from '../src/bnlm/tokenizer.js';
import { Adam } from '../src/bnlm/optim.js';
import { padBatch } from '../src/bnlm/classifier.js';
import { pooledEmbedding, contrastiveLoss, cosineSimilarity } from '../src/bnlm/embed.js';
import { embedderRegistry, SavedEmbedderMeta } from './embedderRegistry';

export interface EmbedderConfig {
  dModel: number;
  numLayers: number;
  numHeads: number;
  contextLen: number;
  mixerType: 'attention' | 'linear' | 'rwkv';
  lr: number;
  batchSize: number;
  /** Lower sharpens the softmax over in-batch candidates during training. */
  temperature: number;
}

export interface ParaphrasePair {
  a: string;
  b: string;
}

// Small, same spirit as the classifier's deliberately-small default
// (DEFAULT_CLASSIFIER_CONFIG's comment on params-vs-accuracy at this scale):
// an embedder's whole job is squeezing a sequence into one dModel-length
// vector, so there's no benefit to a wider or deeper trunk than the
// classifier already found sufficient for a comparable task.
export const DEFAULT_EMBEDDER_CONFIG: EmbedderConfig = {
  dModel: 24,
  numLayers: 1,
  numHeads: 4,
  contextLen: 96,
  mixerType: 'linear',
  lr: 3e-3,
  batchSize: 16,
  temperature: 0.1,
};

export interface InitResult {
  vocabSize: number;
  paramCount: number;
  pairs: number;
}

export interface EmbedderTrainResult {
  steps: number;
  finalLoss: number;
  lossHistory: number[];
  paramCount: number;
  vocabSize: number;
}

function shuffledIndices(n: number, rand: () => number): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

class LocalEmbedderService {
  private tokenizer: CharTokenizer | null = null;
  private trunk: BNLM | null = null;
  private optimizer: Adam | null = null;
  private pairs: ParaphrasePair[] = [];
  private config: EmbedderConfig = { ...DEFAULT_EMBEDDER_CONFIG };

  get isReady(): boolean {
    return !!this.trunk && !!this.tokenizer;
  }

  get currentConfig(): EmbedderConfig {
    return { ...this.config };
  }

  /** Builds the vocabulary and initializes a fresh trunk from the training pairs. Must be called before train(). */
  init(pairs: ParaphrasePair[], overrides: Partial<EmbedderConfig> = {}): InitResult {
    const config: EmbedderConfig = { ...DEFAULT_EMBEDDER_CONFIG, ...overrides };
    if (config.dModel % config.numHeads !== 0) {
      throw new Error(`dModel (${config.dModel}) must be divisible by numHeads (${config.numHeads}).`);
    }
    if (pairs.length < 2) {
      throw new Error('An embedder needs at least 2 pairs — with only 1, every other row in the batch is its own single negative and there is nothing to contrast against.');
    }

    const tokenizer = new CharTokenizer(pairs.flatMap(p => [p.a, p.b]).join('\n'));
    const trunk = new BNLM(tokenizer.vocabSize, {
      dModel: config.dModel,
      numLayers: config.numLayers,
      numHeads: config.numHeads,
      contextLen: config.contextLen,
      mixerType: config.mixerType,
      seed: Date.now() & 0xffff,
    });

    this.tokenizer = tokenizer;
    this.trunk = trunk;
    this.pairs = [...pairs];
    this.config = config;
    this.optimizer = new Adam(trunk.parameters(), { lr: config.lr });

    return { vocabSize: tokenizer.vocabSize, paramCount: trunk.paramCount(), pairs: pairs.length };
  }

  async train(steps = 300, onProgress?: (step: number, loss: number) => void): Promise<EmbedderTrainResult> {
    if (!this.trunk || !this.tokenizer || !this.optimizer) {
      throw new Error('Embedder not initialized — call init() first.');
    }
    const trunk = this.trunk;
    const tokenizer = this.tokenizer;
    const lossHistory: number[] = [];
    let rngState = 20260819;
    const rand = () => {
      rngState = (rngState * 1664525 + 1013904223) >>> 0;
      return rngState / 0x100000000;
    };

    // At least 2 pairs per batch (so there's a negative to contrast
    // against), capped by how many pairs exist.
    const batchPairs = Math.max(2, Math.min(Math.floor(this.config.batchSize / 2), this.pairs.length));
    let lastLoss = 0;

    for (let step = 0; step < steps; step++) {
      const idx = shuffledIndices(this.pairs.length, rand).slice(0, batchPairs);
      const batch = idx.map(i => this.pairs[i]);
      const N = batch.length;
      const seqs = [...batch.map(p => tokenizer.encode(p.a)), ...batch.map(p => tokenizer.encode(p.b))];
      const { idsFlat, B, T, lengths } = padBatch(seqs, this.config.contextLen);
      const positiveIndices = new Int32Array(2 * N);
      for (let i = 0; i < N; i++) {
        positiveIndices[i] = i + N;
        positiveIndices[i + N] = i;
      }

      this.optimizer.zeroGrad();
      const pooled = await pooledEmbedding(trunk, idsFlat, B, T, lengths);
      const { loss, value } = await contrastiveLoss(pooled, positiveIndices, this.config.temperature);
      await loss.backward();
      this.optimizer.step();

      lastLoss = value;
      lossHistory.push(value);
      onProgress?.(step + 1, value);

      if (step % 10 === 0) await new Promise(r => setTimeout(r, 0));
    }

    return { steps, finalLoss: lastLoss, lossHistory, paramCount: trunk.paramCount(), vocabSize: tokenizer.vocabSize };
  }

  /** Initializes on the given pairs (if not already trained) and trains in one call — the shape an agent tool-call wants. */
  async ensureInitAndTrain(
    pairs: ParaphrasePair[],
    steps: number,
    overrides: Partial<EmbedderConfig> = {},
    onProgress?: (step: number, loss: number) => void
  ): Promise<{ init: InitResult; train: EmbedderTrainResult }> {
    const init = this.init(pairs, overrides);
    const train = await this.train(steps, onProgress);
    return { init, train };
  }

  /** Embeds a single string with the trained trunk. */
  async embed(text: string): Promise<Float32Array> {
    if (!this.trunk || !this.tokenizer) throw new Error('No embedder has been trained yet in this tab.');
    return this.embedKnown(this.toKnownText(text));
  }

  /** Cosine similarity between two strings, via the trained embedder. */
  async similarity(a: string, b: string): Promise<number> {
    const [va, vb] = await Promise.all([this.embed(a), this.embed(b)]);
    return cosineSimilarity(va, vb);
  }

  /**
   * Occlusion-based attribution, mirroring lib/localClassifier.ts's
   * attributeByOcclusion: for each character on each side, remove it,
   * re-embed, and measure how far the OTHER side's fixed embedding moves
   * away — a positive score means that character was holding the
   * similarity up. Cost is O(len(A) + len(B)) embed() calls, the same
   * complexity shape as the classifier's O(len(text)) predict() calls.
   */
  async explainSimilarity(textA: string, textB: string): Promise<{
    score: number;
    contributionsA: { token: string; index: number; score: number }[];
    contributionsB: { token: string; index: number; score: number }[];
  }> {
    if (!this.trunk || !this.tokenizer) throw new Error('No embedder has been trained yet in this tab.');
    const knownA = this.toKnownText(textA);
    const knownB = this.toKnownText(textB);
    const [vecA, vecB] = await Promise.all([this.embedKnown(knownA), this.embedKnown(knownB)]);
    const score = cosineSimilarity(vecA, vecB);
    const [contributionsA, contributionsB] = await Promise.all([
      this.attributeAgainst(knownA, vecB, score),
      this.attributeAgainst(knownB, vecA, score),
    ]);
    return { score, contributionsA, contributionsB };
  }

  private async embedKnown(known: string): Promise<Float32Array> {
    const ids = this.tokenizer!.encode(known);
    const { idsFlat, B, T, lengths } = padBatch([ids], this.config.contextLen);
    const pooled = await pooledEmbedding(this.trunk!, idsFlat, B, T, lengths);
    return pooled.data.slice(0, this.config.dModel);
  }

  /** Removes each character of `known` in turn, re-embeds, and scores the drop in similarity against `fixedVec` — a single-character string has nothing left to occlude, so it returns no contributions rather than throwing. */
  private async attributeAgainst(
    known: string,
    fixedVec: Float32Array,
    baseline: number
  ): Promise<{ token: string; index: number; score: number }[]> {
    const chars = Array.from(known);
    if (chars.length < 2) return [];
    const contributions: { token: string; index: number; score: number }[] = [];
    for (let i = 0; i < chars.length; i++) {
      const occluded = chars.slice(0, i).concat(chars.slice(i + 1)).join('');
      const occludedVec = await this.embedKnown(occluded);
      const occludedScore = cosineSimilarity(occludedVec, fixedVec);
      contributions.push({ token: chars[i], index: i, score: baseline - occludedScore });
    }
    return contributions;
  }

  private toKnownText(text: string): string {
    const known = Array.from(text).filter(c => this.tokenizer!.stoi.has(c)).join('');
    if (!known) {
      throw new Error('None of that input\'s characters appear in the training data, so there is nothing to embed.');
    }
    return known;
  }

  // ── Named persistence, mirroring lib/localClassifier.ts's precedent —
  // IndexedDB-only via lib/embedderRegistry.ts, no Supabase sync (see that
  // file's header). ──

  async listSaved(): Promise<SavedEmbedderMeta[]> {
    return embedderRegistry.list();
  }

  async saveAs(name: string): Promise<void> {
    if (!this.trunk || !this.tokenizer) throw new Error('No embedder has been trained yet in this tab.');
    if (!name.trim()) throw new Error('Give the embedder a name to save it under.');
    const params = this.trunk.parameters();
    const paramBuffers: ArrayBuffer[] = params.map((p: any) => p.data.buffer.slice(p.data.byteOffset, p.data.byteOffset + p.data.byteLength));
    const paramShapes: number[][] = params.map((p: any) => p.shape);
    await embedderRegistry.save({
      name: name.trim(),
      savedAt: new Date().toISOString(),
      config: this.config,
      vocabSize: this.tokenizer.vocabSize,
      paramCount: this.trunk.paramCount(),
      pairCount: this.pairs.length,
      vocabChars: this.tokenizer.itos.join(''),
      pairs: [...this.pairs],
      paramShapes,
      paramBuffers,
    });
  }

  async loadSaved(name: string): Promise<InitResult> {
    const record = await embedderRegistry.load(name);
    if (!record) throw new Error(`No saved embedder named "${name}".`);

    const tokenizer = new CharTokenizer(record.vocabChars);
    const trunk = new BNLM(tokenizer.vocabSize, {
      dModel: record.config.dModel,
      numLayers: record.config.numLayers,
      numHeads: record.config.numHeads,
      contextLen: record.config.contextLen,
      mixerType: record.config.mixerType,
      seed: 1234,
    });
    const params = trunk.parameters();
    if (params.length !== record.paramBuffers.length) {
      throw new Error('Saved embedder is incompatible with the current BNLM engine version (parameter count mismatch).');
    }
    params.forEach((p: any, i: number) => p.data.set(new Float32Array(record.paramBuffers[i])));

    this.tokenizer = tokenizer;
    this.trunk = trunk;
    this.pairs = record.pairs;
    this.config = record.config;
    this.optimizer = new Adam(trunk.parameters(), { lr: record.config.lr });

    return { vocabSize: tokenizer.vocabSize, paramCount: trunk.paramCount(), pairs: record.pairs.length };
  }

  async deleteSaved(name: string): Promise<void> {
    await embedderRegistry.remove(name);
  }
}

export const localEmbedder = new LocalEmbedderService();
