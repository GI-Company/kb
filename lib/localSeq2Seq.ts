// Local sequence-to-sequence transformer — a fifth question alongside the
// generative model's "what comes next?" (lib/localModel.ts), the
// classifier's "which of N things is it?" (lib/localClassifier.ts), the
// embedder's "how similar is this to that?" (lib/localEmbedder.ts), and the
// tagger's "which parts of this matter?" (lib/localTagger.ts). This one
// answers "turn this into that": summarize, rephrase, restyle — reading a
// whole source passage and generating a genuinely different output
// conditioned on it, which a decoder-only model (bnlm.generate) can't do —
// it only ever continues whatever prompt it's given.
//
// See src/bnlm/seq2seq.js for the encoder/decoder/cross-attention
// architecture itself, including why training runs one (source, target)
// pair at a time rather than batched (no padding-mask machinery needed
// anywhere as a result) and why the decoder reserves a synthetic BOS id.

import { CharTokenizer } from '../src/bnlm/tokenizer.js';
import { BNLMSeq2Seq } from '../src/bnlm/seq2seq.js';
import { Adam } from '../src/bnlm/optim.js';
import { seq2seqRegistry, SavedSeq2SeqMeta } from './seq2seqRegistry';

export interface Seq2SeqConfig {
  dModel: number;
  numLayers: number;
  numHeads: number;
  contextLen: number;
  lr: number;
}

export interface TransformPair {
  input: string;
  output: string;
}

// Smaller than even the classifier/embedder/tagger defaults: this
// architecture has TWO trunks (encoder + decoder) plus cross-attention
// weights, so parameter count grows faster with dModel/numLayers than a
// single-trunk model's does for the same config values. Kept small enough
// that a few hundred steps of one-pair-at-a-time training stays fast in a
// browser tab.
export const DEFAULT_SEQ2SEQ_CONFIG: Seq2SeqConfig = {
  dModel: 24,
  numLayers: 1,
  numHeads: 4,
  contextLen: 64,
  lr: 3e-3,
};

export interface InitResult {
  vocabSize: number;
  paramCount: number;
  pairs: number;
}

export interface Seq2SeqTrainResult {
  steps: number;
  finalLoss: number;
  lossHistory: number[];
  paramCount: number;
  vocabSize: number;
}

class LocalSeq2SeqService {
  private tokenizer: CharTokenizer | null = null;
  private model: BNLMSeq2Seq | null = null;
  private optimizer: Adam | null = null;
  private pairs: TransformPair[] = [];
  private config: Seq2SeqConfig = { ...DEFAULT_SEQ2SEQ_CONFIG };

  get isReady(): boolean {
    return !!this.model && !!this.tokenizer;
  }

  get currentConfig(): Seq2SeqConfig {
    return { ...this.config };
  }

  /** Builds a shared vocabulary from both sides of every pair and initializes a fresh model. Must be called before train(). */
  init(pairs: TransformPair[], overrides: Partial<Seq2SeqConfig> = {}): InitResult {
    const config: Seq2SeqConfig = { ...DEFAULT_SEQ2SEQ_CONFIG, ...overrides };
    if (config.dModel % config.numHeads !== 0) {
      throw new Error(`dModel (${config.dModel}) must be divisible by numHeads (${config.numHeads}).`);
    }
    if (pairs.length === 0) {
      throw new Error('No training pairs — add some (input, output) examples first.');
    }
    for (const p of pairs) {
      if (!p.output) throw new Error(`Pair with input "${p.input}" has an empty output — every target needs at least 1 character.`);
    }

    // One shared vocabulary for both sides: input and output are the same
    // "language" here (e.g. English in, English out for a rephrasing
    // task), so a dual-vocab setup would add real complexity for no
    // benefit at this scale.
    const tokenizer = new CharTokenizer(pairs.flatMap(p => [p.input, p.output]).join('\n'));
    const model = new BNLMSeq2Seq(tokenizer.vocabSize, {
      dModel: config.dModel,
      numLayers: config.numLayers,
      numHeads: config.numHeads,
      contextLen: config.contextLen,
    });

    this.tokenizer = tokenizer;
    this.model = model;
    this.pairs = [...pairs];
    this.config = config;
    this.optimizer = new Adam(model.parameters(), { lr: config.lr });

    return { vocabSize: tokenizer.vocabSize, paramCount: model.paramCount(), pairs: pairs.length };
  }

  /**
   * One (source, target) pair per step — see src/bnlm/seq2seq.js's header
   * for why this model trains unbatched. A "step" here is a single pair,
   * not a batch, so this typically wants more steps than the other model
   * types' train() to see comparable total gradient signal.
   */
  async train(steps = 400, onProgress?: (step: number, loss: number) => void): Promise<Seq2SeqTrainResult> {
    if (!this.model || !this.tokenizer || !this.optimizer) {
      throw new Error('Seq2seq model not initialized — call init() first.');
    }
    const model = this.model;
    const tokenizer = this.tokenizer;
    const lossHistory: number[] = [];
    let rngState = 20260820;
    const rand = () => {
      rngState = (rngState * 1664525 + 1013904223) >>> 0;
      return rngState / 0x100000000;
    };

    const encoded = this.pairs.map(p => ({
      src: clipToContext(tokenizer.encode(p.input), this.config.contextLen),
      tgt: clipToContext(tokenizer.encode(p.output), this.config.contextLen),
    }));

    let lastLoss = 0;
    for (let step = 0; step < steps; step++) {
      const pick = encoded[Math.floor(rand() * encoded.length)];
      this.optimizer.zeroGrad();
      const { loss, value } = await model.loss(pick.src, pick.tgt);
      await loss.backward();
      this.optimizer.step();

      lastLoss = value;
      lossHistory.push(value);
      onProgress?.(step + 1, value);

      if (step % 10 === 0) await new Promise(r => setTimeout(r, 0));
    }

    return { steps, finalLoss: lastLoss, lossHistory, paramCount: model.paramCount(), vocabSize: tokenizer.vocabSize };
  }

  /** Initializes on the given pairs (if not already trained) and trains in one call — the shape an agent tool-call wants. */
  async ensureInitAndTrain(
    pairs: TransformPair[],
    steps: number,
    overrides: Partial<Seq2SeqConfig> = {},
    onProgress?: (step: number, loss: number) => void
  ): Promise<{ init: InitResult; train: Seq2SeqTrainResult }> {
    const init = this.init(pairs, overrides);
    const train = await this.train(steps, onProgress);
    return { init, train };
  }

  /** Applies the trained transform to new input text. */
  async transform(text: string, maxNewTokens = 80): Promise<string> {
    if (!this.model || !this.tokenizer) throw new Error('No seq2seq model has been trained yet in this tab.');
    const known = this.toKnownText(text);
    const srcIds = clipToContext(this.tokenizer.encode(known), this.config.contextLen);
    const clampedTokens = Math.min(Math.max(Math.round(maxNewTokens), 1), this.config.contextLen);
    const outIds = await this.model.generate(srcIds, clampedTokens);
    return this.tokenizer.decode(outIds);
  }

  private toKnownText(text: string): string {
    const known = Array.from(text).filter(c => this.tokenizer!.stoi.has(c)).join('');
    if (!known) {
      throw new Error('None of that input\'s characters appear in the training data, so there is nothing to transform.');
    }
    return known;
  }

  // ── Named persistence, mirroring lib/localClassifier.ts's,
  // lib/localEmbedder.ts's, and lib/localTagger.ts's precedent —
  // IndexedDB-only via lib/seq2seqRegistry.ts, no Supabase sync. ──

  async listSaved(): Promise<SavedSeq2SeqMeta[]> {
    return seq2seqRegistry.list();
  }

  async saveAs(name: string): Promise<void> {
    if (!this.model || !this.tokenizer) throw new Error('No seq2seq model has been trained yet in this tab.');
    if (!name.trim()) throw new Error('Give the model a name to save it under.');
    const params = this.model.parameters();
    const paramBuffers: ArrayBuffer[] = params.map((p: any) => p.data.buffer.slice(p.data.byteOffset, p.data.byteOffset + p.data.byteLength));
    const paramShapes: number[][] = params.map((p: any) => p.shape);
    await seq2seqRegistry.save({
      name: name.trim(),
      savedAt: new Date().toISOString(),
      config: this.config,
      vocabSize: this.tokenizer.vocabSize,
      paramCount: this.model.paramCount(),
      pairCount: this.pairs.length,
      vocabChars: this.tokenizer.itos.join(''),
      pairs: [...this.pairs],
      paramShapes,
      paramBuffers,
    });
  }

  async loadSaved(name: string): Promise<InitResult> {
    const record = await seq2seqRegistry.load(name);
    if (!record) throw new Error(`No saved seq2seq model named "${name}".`);

    const tokenizer = new CharTokenizer(record.vocabChars);
    const model = new BNLMSeq2Seq(tokenizer.vocabSize, {
      dModel: record.config.dModel,
      numLayers: record.config.numLayers,
      numHeads: record.config.numHeads,
      contextLen: record.config.contextLen,
    });
    const params = model.parameters();
    if (params.length !== record.paramBuffers.length) {
      throw new Error('Saved seq2seq model is incompatible with the current BNLM engine version (parameter count mismatch).');
    }
    params.forEach((p: any, i: number) => p.data.set(new Float32Array(record.paramBuffers[i])));

    this.tokenizer = tokenizer;
    this.model = model;
    this.pairs = record.pairs;
    this.config = record.config;
    this.optimizer = new Adam(model.parameters(), { lr: record.config.lr });

    return { vocabSize: tokenizer.vocabSize, paramCount: model.paramCount(), pairs: record.pairs.length };
  }

  async deleteSaved(name: string): Promise<void> {
    await seq2seqRegistry.remove(name);
  }
}

/** Keeps the TAIL when a sequence exceeds contextLen — same truncation convention as padBatch/padTaggedBatch elsewhere in this codebase. */
function clipToContext(ids: Int32Array, contextLen: number): Int32Array {
  return ids.length > contextLen ? ids.slice(-contextLen) : ids;
}

export const localSeq2Seq = new LocalSeq2SeqService();
