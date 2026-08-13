// Thin service wrapping the vendored BNLM engine (src/bnlm/*) — init/train/
// generate/export, callable both from the standalone Local Model app
// (apps/LocalModel.tsx) and from the agent tool-call contract in AIChat.tsx
// (see lib/agents.ts's BNLM_TOOL_CONTRACT). Runs on the main thread, same as
// the original index.html's default (numWorkers=1) path — the data-parallel
// Worker pool (src/bnlm/worker_pool.js) is a fast-follow, not wired up here.

// @ts-ignore - plain JS module, no type declarations
import { BNLM } from '../src/bnlm/model.js';
// @ts-ignore - plain JS module, no type declarations
import { CharTokenizer } from '../src/bnlm/tokenizer.js';
// @ts-ignore - plain JS module, no type declarations
import { Adam } from '../src/bnlm/optim.js';
// @ts-ignore - plain JS module, no type declarations
import { trainStep } from '../src/bnlm/train.js';
// @ts-ignore - plain JS module, no type declarations
import { splitDocuments, tokenizeDocuments } from '../src/bnlm/dataset.js';
// @ts-ignore - plain JS module, no type declarations
import { quantizeModel, serializeQuantized } from '../src/bnlm/quantize.js';

export type MixerType = 'attention' | 'linear' | 'rwkv';

export interface LocalModelConfig {
  dModel: number;
  numLayers: number;
  numHeads: number;
  contextLen: number;
  mixerType: MixerType;
  lr: number;
  batchSize: number;
}

export const DEFAULT_LOCAL_MODEL_CONFIG: LocalModelConfig = {
  dModel: 48,
  numLayers: 3,
  numHeads: 4,
  contextLen: 48,
  mixerType: 'attention',
  lr: 3e-3,
  batchSize: 16,
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

class LocalModelService {
  private tokenizer: any = null;
  private model: any = null;
  private optimizer: any = null;
  private tokenizedDocs: Int32Array[] = [];
  private config: LocalModelConfig = { ...DEFAULT_LOCAL_MODEL_CONFIG };

  get isReady(): boolean {
    return !!this.model && !!this.tokenizer;
  }

  get currentConfig(): LocalModelConfig {
    return { ...this.config };
  }

  /** (Re)initializes the tokenizer and a fresh model from the given corpus text. */
  init(corpusText: string, configOverrides: Partial<LocalModelConfig> = {}): InitResult {
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

    this.model = new BNLM(tokenizer.vocabSize, {
      dModel: config.dModel,
      numLayers: config.numLayers,
      numHeads: config.numHeads,
      contextLen: config.contextLen,
      mixerType: config.mixerType,
      seed: Date.now() & 0xffff,
    });
    this.optimizer = new Adam(this.model.parameters(), { lr: config.lr });
    this.tokenizer = tokenizer;
    this.tokenizedDocs = tokenizedDocs;
    this.config = config;

    return { vocabSize: tokenizer.vocabSize, paramCount: this.model.paramCount(), documents: documents.length };
  }

  /** If there's no model yet, initializes one from `corpusText` first (with any overrides), then trains. Lets a single agent tool-call go straight from raw text to a trained model. */
  async ensureInitAndTrain(
    corpusText: string,
    steps: number,
    configOverrides: Partial<LocalModelConfig> = {},
    onProgress?: (step: number, loss: number) => void
  ): Promise<{ init: InitResult; train: TrainResult }> {
    const init = this.init(corpusText, configOverrides);
    const train = await this.train(steps, onProgress);
    return { init, train };
  }

  /** Runs `steps` training steps on the main thread, yielding periodically so the tab doesn't freeze. */
  async train(steps: number, onProgress?: (step: number, loss: number) => void): Promise<TrainResult> {
    if (!this.model || !this.optimizer || !this.tokenizer) {
      throw new Error('Local model not initialized — call init() first.');
    }
    const { batchSize, contextLen } = this.config;
    const lossHistory: number[] = [];
    for (let i = 0; i < steps; i++) {
      const loss: number = await trainStep(this.model, this.optimizer, this.tokenizedDocs, batchSize, contextLen);
      lossHistory.push(loss);
      onProgress?.(i + 1, loss);
      if (i % 5 === 0) await yieldToUI();
    }
    return {
      steps,
      finalLoss: lossHistory[lossHistory.length - 1] ?? NaN,
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
    return { text, tokensGenerated: generatedIds.length };
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
