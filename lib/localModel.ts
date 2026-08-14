// Thin service wrapping the vendored BNLM engine (src/bnlm/*) — init/train/
// generate/export, callable both from the standalone Local Model app
// (apps/LocalModel.tsx) and from the agent tool-call contract in AIChat.tsx
// (see lib/agents.ts's BNLM_TOOL_CONTRACT). Single-threaded training runs on
// the main thread, same as the original index.html's default (numWorkers=1)
// path; numWorkers>1 hands gradient computation off to src/bnlm/worker_pool.js
// exactly like the original UI's parallel mode did.

// @ts-ignore - plain JS module, no type declarations
import { BNLM } from '../src/bnlm/model.js';
// @ts-ignore - plain JS module, no type declarations
import { CharTokenizer } from '../src/bnlm/tokenizer.js';
// @ts-ignore - plain JS module, no type declarations
import { Adam, clipGradNorm } from '../src/bnlm/optim.js';
// @ts-ignore - plain JS module, no type declarations
import { trainStep } from '../src/bnlm/train.js';
// @ts-ignore - plain JS module, no type declarations
import { splitDocuments, tokenizeDocuments, sampleDocBatch } from '../src/bnlm/dataset.js';
// @ts-ignore - plain JS module, no type declarations
import { quantizeModel, serializeQuantized } from '../src/bnlm/quantize.js';
// @ts-ignore - plain JS module, no type declarations
import { TrainingWorkerPool } from '../src/bnlm/worker_pool.js';
// @ts-ignore - plain JS module, no type declarations
import { crossEntropyLoss } from '../src/bnlm/tensor.js';
import { runHistoryStore, genHistoryStore } from './localModelHistory';
import { modelStore, SavedModelMeta } from './modelStore';

export type MixerType = 'attention' | 'linear' | 'rwkv';

export interface LocalModelConfig {
  dModel: number;
  numLayers: number;
  numHeads: number;
  contextLen: number;
  mixerType: MixerType;
  lr: number;
  batchSize: number;
  numWorkers: number;
}

export const DEFAULT_LOCAL_MODEL_CONFIG: LocalModelConfig = {
  dModel: 48,
  numLayers: 3,
  numHeads: 4,
  contextLen: 48,
  mixerType: 'attention',
  lr: 3e-3,
  batchSize: 16,
  numWorkers: 1,
};

export interface InitResult {
  vocabSize: number;
  paramCount: number;
  documents: number;
}

export interface TrainResult {
  steps: number;
  finalLoss: number;
  lossHistory: number[];
  paramCount: number;
  vocabSize: number;
}

export interface GenerateResult {
  text: string;
  tokensGenerated: number;
}

export interface ScoreResult {
  loss: number;
  perplexity: number;
  tokensScored: number;
}

class LocalModelService {
  private tokenizer: any = null;
  private model: any = null;
  private optimizer: any = null;
  private tokenizedDocs: Int32Array[] = [];
  private config: LocalModelConfig = { ...DEFAULT_LOCAL_MODEL_CONFIG };
  private corpusText = '';
  private pool: any = null;

  get isReady(): boolean {
    return !!this.model && !!this.tokenizer;
  }

  get currentConfig(): LocalModelConfig {
    return { ...this.config };
  }

  get currentCorpusText(): string {
    return this.corpusText;
  }

  /** (Re)initializes the tokenizer and a fresh model from the given corpus text. */
  async init(corpusText: string, configOverrides: Partial<LocalModelConfig> = {}): Promise<InitResult> {
    const config: LocalModelConfig = { ...DEFAULT_LOCAL_MODEL_CONFIG, ...configOverrides };
    if (config.dModel % config.numHeads !== 0) {
      throw new Error(`dModel (${config.dModel}) must be divisible by numHeads (${config.numHeads}).`);
    }

    const documents = splitDocuments(corpusText);
    if (documents.length === 0) {
      throw new Error('No trainable text found — paste in some text first.');
    }

    const tokenizer = new CharTokenizer(corpusText);
    const tokenizedDocs = tokenizeDocuments(documents, tokenizer) as Int32Array[];
    const eligible = tokenizedDocs.filter(d => d.length >= config.contextLen + 1).length;
    if (eligible === 0) {
      throw new Error(
        `No document is long enough for context length ${config.contextLen} (need at least ${config.contextLen + 1} characters). Lower it or paste in longer text.`
      );
    }

    const modelConfig = {
      dModel: config.dModel,
      numLayers: config.numLayers,
      numHeads: config.numHeads,
      contextLen: config.contextLen,
      mixerType: config.mixerType,
      seed: Date.now() & 0xffff,
    };
    this.model = new BNLM(tokenizer.vocabSize, modelConfig);
    this.optimizer = new Adam(this.model.parameters(), { lr: config.lr });
    this.tokenizer = tokenizer;
    this.tokenizedDocs = tokenizedDocs;
    this.corpusText = corpusText;
    this.config = config;

    await this.setupPool(tokenizer.vocabSize, modelConfig);

    return { vocabSize: tokenizer.vocabSize, paramCount: this.model.paramCount(), documents: documents.length };
  }

  private async setupPool(vocabSize: number, modelConfig: Record<string, unknown>): Promise<void> {
    if (this.pool) {
      this.pool.destroy();
      this.pool = null;
    }
    if (this.config.numWorkers > 1) {
      const pool = new TrainingWorkerPool(this.config.numWorkers);
      await pool.init(vocabSize, modelConfig);
      this.pool = pool;
    }
  }

  /** If there's no model yet, initializes one from `corpusText` first (with any overrides), then trains. Lets a single agent tool-call go straight from raw text to a trained model. */
  async ensureInitAndTrain(
    corpusText: string,
    steps: number,
    configOverrides: Partial<LocalModelConfig> = {},
    onProgress?: (step: number, loss: number) => void
  ): Promise<{ init: InitResult; train: TrainResult }> {
    const init = await this.init(corpusText, configOverrides);
    const train = await this.train(steps, onProgress);
    return { init, train };
  }

  /** Runs `steps` training steps, either on the main thread or fanned out across a Worker pool (see numWorkers), yielding periodically so the tab doesn't freeze. Auto-logs the run to runHistoryStore. */
  async train(steps: number, onProgress?: (step: number, loss: number) => void, clipNorm = 0): Promise<TrainResult> {
    if (!this.model || !this.optimizer || !this.tokenizer) {
      throw new Error('Local model not initialized — call init() first.');
    }
    const t0 = performance.now();
    const { batchSize, contextLen } = this.config;
    const lossHistory: number[] = [];

    if (this.pool) {
      const workers = this.pool.numWorkers;
      for (let i = 0; i < steps; i++) {
        const batches = Array.from({ length: workers }, () => sampleDocBatch(this.tokenizedDocs, batchSize, contextLen));
        const avgLoss: number = await this.pool.step(this.model, batches, batchSize, contextLen);
        if (clipNorm > 0) clipGradNorm(this.model.parameters(), clipNorm);
        this.optimizer.step();
        lossHistory.push(avgLoss);
        onProgress?.(i + 1, avgLoss);
        if (i % 3 === 0) await yieldToUI();
      }
    } else {
      for (let i = 0; i < steps; i++) {
        const loss: number = await trainStep(this.model, this.optimizer, this.tokenizedDocs, batchSize, contextLen, Math.random, clipNorm);
        lossHistory.push(loss);
        onProgress?.(i + 1, loss);
        if (i % 5 === 0) await yieldToUI();
      }
    }

    const durationSec = (performance.now() - t0) / 1000;
    const finalLoss = lossHistory[lossHistory.length - 1] ?? NaN;

    if (!Number.isNaN(finalLoss)) {
      runHistoryStore.log({
        time: new Date().toLocaleTimeString(),
        mixer: this.pool ? `${this.config.mixerType} (×${this.pool.numWorkers} workers)` : this.config.mixerType,
        dModel: this.config.dModel,
        numLayers: this.config.numLayers,
        numHeads: this.config.numHeads,
        contextLen: this.config.contextLen,
        params: this.model.paramCount(),
        totalSteps: steps,
        finalLoss,
        durationSec,
      });
    }

    return {
      steps,
      finalLoss,
      lossHistory,
      paramCount: this.model.paramCount(),
      vocabSize: this.tokenizer.vocabSize,
    };
  }

  async generate(prompt: string, maxNewTokens = 60, opts: { temperature?: number; topK?: number } = {}): Promise<GenerateResult> {
    if (!this.model || !this.tokenizer) {
      throw new Error('Local model not initialized — train one first.');
    }
    // Character-level vocab is exactly the characters seen during training —
    // a prompt containing anything else would throw on encode(), so filter
    // down to what the tokenizer actually knows first.
    const safePrompt = this.filterToVocab(prompt) || this.tokenizer.itos[0];
    const promptIds = this.tokenizer.encode(safePrompt);
    const generatedIds: number[] = await this.model.generate(promptIds, maxNewTokens, opts);
    const text = this.tokenizer.decode(generatedIds);

    genHistoryStore.log({
      time: new Date().toLocaleTimeString(),
      mixer: this.config.mixerType,
      prompt: safePrompt,
      output: text,
    });

    return { text, tokensGenerated: generatedIds.length };
  }

  /**
   * Scores text against the trained model instead of generating from it —
   * how surprised is the model by this text, on the same next-token-
   * prediction objective it was trained on? Lower loss/perplexity means
   * the text looks more like what it learned. Useful for ranking
   * candidates, spotting outliers, or a lightweight style-match check —
   * the "more than just creating new text" use of a trained local model,
   * built from the same forward pass + cross-entropy loss training
   * already uses, just without the backward/optimizer step.
   */
  async score(text: string): Promise<ScoreResult> {
    if (!this.model || !this.tokenizer) {
      throw new Error('Local model not initialized — train one first.');
    }
    const safeText = this.filterToVocab(text);
    if (safeText.length < 2) {
      throw new Error('Not enough recognizable text to score (needs at least 2 characters from the trained vocabulary).');
    }
    const ids: Int32Array = this.tokenizer.encode(safeText);
    const T = Math.min(ids.length - 1, this.config.contextLen);
    if (T < 1) {
      throw new Error('Text too short to score.');
    }
    const input = Int32Array.from(ids.slice(0, T));
    const target = Int32Array.from(ids.slice(1, T + 1));
    const logits = await this.model.forward(input, 1, T);
    const { value } = crossEntropyLoss(logits, target);
    return { loss: value, perplexity: Math.exp(value), tokensScored: T };
  }

  exportInt8(): { blob: Blob; filename: string } {
    if (!this.model) {
      throw new Error('Local model not initialized — train one first.');
    }
    const qmodel = quantizeModel(this.model);
    const buffer: ArrayBuffer = serializeQuantized(qmodel);
    const filename = `bnlm_${this.config.mixerType}_d${this.config.dModel}_l${this.config.numLayers}.qlm1`;
    return { blob: new Blob([buffer], { type: 'application/octet-stream' }), filename };
  }

  // ── Named persistence — "first class citizen" of the OS: a trained model
  // survives a reload and can be switched between multiple saved ones.
  // Dispatched per-user by lib/modelStore.ts: guests get IndexedDB, real
  // accounts get Supabase's local_models table + Storage bucket. ──

  async listSaved(userId: string): Promise<SavedModelMeta[]> {
    return modelStore.list(userId);
  }

  async saveAs(userId: string, name: string): Promise<void> {
    if (!this.model || !this.tokenizer) {
      throw new Error('Local model not initialized — train one first.');
    }
    const params = this.model.parameters();
    const paramBuffers: ArrayBuffer[] = params.map((p: any) => p.data.buffer.slice(p.data.byteOffset, p.data.byteOffset + p.data.byteLength));
    const paramShapes: number[][] = params.map((p: any) => p.shape);
    await modelStore.save(userId, {
      name,
      savedAt: new Date().toISOString(),
      config: this.config,
      vocabSize: this.tokenizer.vocabSize,
      paramCount: this.model.paramCount(),
      vocabChars: this.tokenizer.itos.join(''),
      corpusText: this.corpusText,
      paramShapes,
      paramBuffers,
    });
  }

  async loadSaved(userId: string, name: string): Promise<InitResult> {
    const record = await modelStore.load(userId, name);
    if (!record) throw new Error(`No saved model named "${name}".`);

    const tokenizer = new CharTokenizer(record.vocabChars);
    const modelConfig = {
      dModel: record.config.dModel,
      numLayers: record.config.numLayers,
      numHeads: record.config.numHeads,
      contextLen: record.config.contextLen,
      mixerType: record.config.mixerType,
      seed: 1234,
    };
    const model = new BNLM(tokenizer.vocabSize, modelConfig);
    const params = model.parameters();
    if (params.length !== record.paramBuffers.length) {
      throw new Error('Saved model is incompatible with the current BNLM engine version (parameter count mismatch).');
    }
    params.forEach((p: any, i: number) => p.data.set(new Float32Array(record.paramBuffers[i])));

    this.model = model;
    this.optimizer = new Adam(model.parameters(), { lr: record.config.lr });
    this.tokenizer = tokenizer;
    this.corpusText = record.corpusText;
    const documents = splitDocuments(record.corpusText);
    this.tokenizedDocs = tokenizeDocuments(documents, tokenizer) as Int32Array[];
    this.config = record.config;

    await this.setupPool(tokenizer.vocabSize, modelConfig);

    return { vocabSize: tokenizer.vocabSize, paramCount: model.paramCount(), documents: documents.length };
  }

  async deleteSaved(userId: string, name: string): Promise<void> {
    await modelStore.remove(userId, name);
  }

  private filterToVocab(text: string): string {
    if (!this.tokenizer) return '';
    const vocab = new Set<string>(this.tokenizer.itos);
    return Array.from(text).filter(ch => vocab.has(ch)).join('');
  }
}

function yieldToUI(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

export const localModel = new LocalModelService();
