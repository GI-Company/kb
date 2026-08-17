// Local intent classifier — the piece that makes a browser-trained model
// usable as a *tool* rather than a text generator.
//
// The generative BNLM (lib/localModel.ts) answers "what comes next?". This
// answers "which of these N things is it?", which is a far better fit for
// the jobs a tiny model can actually do well: routing a request to a
// handler, tagging input, deciding whether something needs the cloud model
// at all. A ~150k-parameter model has no capacity to spare on producing
// well-formed text AND being correct; removing the text-generation burden
// entirely is what makes it reliable.
//
// The intended composition, none of which touches Groq at inference time:
//
//   user input → classifier (intent) → deterministic handler / another
//                                       local model / a specific tool
//
// Multiple classifiers compose directly: route on one, then tag with
// another. Each is a few hundred KB and runs in single-digit milliseconds,
// so chaining several is still effectively free.
//
// Training data is labeled examples, not prose — see LabeledExample. Groq
// is useful for *generating* that training set once (see the dataset modes
// in apps/LocalModel.tsx), but plays no part afterwards.

import { CharTokenizer } from '../src/bnlm/tokenizer.js';
import { BNLMClassifier, padBatch } from '../src/bnlm/classifier.js';
import { Adam } from '../src/bnlm/optim.js';
import { classifierRegistry, SavedClassifierMeta } from './classifierRegistry';

export interface LabeledExample {
  text: string;
  label: string;
}

export interface ClassifierConfig {
  dModel: number;
  numLayers: number;
  numHeads: number;
  contextLen: number;
  mixerType: 'attention' | 'linear' | 'rwkv';
  lr: number;
  batchSize: number;
}

// Deliberately small. Measured on a 3-way intent router with a held-out
// split: 102,147 params over 24 examples scored 33% (chance) while
// reporting 100% training accuracy; 7,995 params over 668 examples scored
// 91%. Thirteen times fewer parameters, three times the real accuracy.
// Capacity is not the constraint at this scale — data is — and an
// oversized model silently converts a small dataset into memorization.
// Raise dModel/numLayers only with several thousand examples in hand.
export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  dModel: 24,
  numLayers: 1,
  numHeads: 4,
  // Classification needs enough context to see a whole utterance, but not
  // the long horizon generation wants — and it's cheap here because nothing
  // is generated token by token.
  contextLen: 96,
  // Recurrent by default: no positional-embedding ceiling, so an input
  // longer than contextLen degrades by dropping its head rather than
  // throwing (see padBatch).
  mixerType: 'linear',
  lr: 3e-3,
  batchSize: 16,
};

/**
 * Deterministic 80/20 split so a re-run is comparable rather than noise.
 *
 * Shared between the Classifier app and the terminal's `train
 * --from-corrections` so "held-out accuracy" means the same measurement
 * everywhere it's reported, not a slightly different split per call site.
 */
export function splitHeldOut(
  examples: LabeledExample[],
  seedValue = 20260816
): { train: LabeledExample[]; test: LabeledExample[] } {
  let seed = seedValue;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;
  const shuffled = examples.map(e => [rnd(), e] as const).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const cut = Math.floor(shuffled.length * 0.8);
  return { train: shuffled.slice(0, cut), test: shuffled.slice(cut) };
}

export interface ClassifierTrainResult {
  steps: number;
  finalLoss: number;
  lossHistory: number[];
  trainAccuracy: number;
  paramCount: number;
  vocabSize: number;
  labels: string[];
}

export interface PredictResult {
  label: string;
  confidence: number;
  /** Every label with its probability, highest first. */
  ranked: { label: string; probability: number }[];
  /** Raw logits before softmax, in label order. */
  logits: number[];
  /** L2 norm of the pooled representation the decision was read from. */
  pooledNorm: number;
  /** Gap between the top label and the runner-up. Small = borderline. */
  margin: number;
  /** One sentence a person can read, including whether it's borderline. */
  explanation: string;
}

export interface Attribution {
  /** The label these scores explain. */
  label: string;
  /** The target label's probability on the unmodified input. */
  baseline: number;
  /**
   * Per-character causal contribution: how far the target label's
   * probability falls when that character is removed. Positive means the
   * character was holding the prediction up.
   */
  contributions: { token: string; index: number; score: number }[];
}

function shuffled<T>(arr: T[], rand: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

class LocalClassifierService {
  private tokenizer: CharTokenizer | null = null;
  private model: BNLMClassifier | null = null;
  private optimizer: Adam | null = null;
  private labels: string[] = [];
  private config: ClassifierConfig = { ...DEFAULT_CLASSIFIER_CONFIG };
  private encoded: { ids: Int32Array; label: number }[] = [];
  /** Kept alongside the encoded form so a saved classifier stays inspectable and retrainable. */
  private examples: LabeledExample[] = [];

  get isReady(): boolean {
    return !!this.model && !!this.tokenizer;
  }

  get currentLabels(): string[] {
    return [...this.labels];
  }

  get currentConfig(): ClassifierConfig {
    return { ...this.config };
  }

  /**
   * Builds the vocabulary and label set from the training examples and
   * initializes a fresh model. Must be called before train().
   */
  init(examples: LabeledExample[], overrides: Partial<ClassifierConfig> = {}) {
    const config: ClassifierConfig = { ...DEFAULT_CLASSIFIER_CONFIG, ...overrides };
    if (config.dModel % config.numHeads !== 0) {
      throw new Error(`dModel (${config.dModel}) must be divisible by numHeads (${config.numHeads}).`);
    }
    if (examples.length === 0) {
      throw new Error('No training examples — add some labeled lines first.');
    }

    const labels = Array.from(new Set(examples.map(e => e.label))).sort();
    if (labels.length < 2) {
      throw new Error(
        `A classifier needs at least 2 distinct labels to have anything to decide between — found only "${labels[0]}".`
      );
    }

    // Vocabulary comes from the training text alone, so anything unseen at
    // predict time has to be filtered rather than encoded (see predict).
    const tokenizer = new CharTokenizer(examples.map(e => e.text).join('\n'));
    const labelIndex = new Map(labels.map((l, i) => [l, i]));

    this.examples = [...examples];
    this.encoded = examples.map(e => ({
      ids: tokenizer.encode(e.text),
      label: labelIndex.get(e.label)!,
    }));

    const model = new BNLMClassifier(tokenizer.vocabSize, labels.length, {
      dModel: config.dModel,
      numLayers: config.numLayers,
      numHeads: config.numHeads,
      contextLen: config.contextLen,
      mixerType: config.mixerType,
    });

    this.tokenizer = tokenizer;
    this.model = model;
    this.labels = labels;
    this.config = config;
    this.optimizer = new Adam(model.parameters(), { lr: config.lr });

    return {
      vocabSize: tokenizer.vocabSize,
      paramCount: model.paramCount(),
      labels,
      examples: examples.length,
    };
  }

  async train(steps = 400, onProgress?: (step: number, loss: number) => void): Promise<ClassifierTrainResult> {
    if (!this.model || !this.optimizer) throw new Error('Classifier not initialized — call init() first.');
    const model = this.model;
    const lossHistory: number[] = [];
    let rngState = 987654321;
    const rand = () => {
      rngState = (rngState * 1664525 + 1013904223) >>> 0;
      return rngState / 0x100000000;
    };

    const batchSize = Math.min(this.config.batchSize, this.encoded.length);
    let lastLoss = 0;

    for (let step = 0; step < steps; step++) {
      // Sample a batch. With small labeled sets the same examples recur
      // often, which is fine — the point is to memorize a decision boundary
      // over a narrow domain, not to generalize broadly.
      const batch = shuffled(this.encoded, rand).slice(0, batchSize);
      const { idsFlat, B, T, lengths } = padBatch(batch.map(b => b.ids), this.config.contextLen);
      const labels = Int32Array.from(batch.map(b => b.label));

      model.zeroGrad();
      const { loss, value } = await model.loss(idsFlat, B, T, lengths, labels);
      await loss.backward();
      this.optimizer.step();

      lastLoss = value;
      lossHistory.push(value);
      onProgress?.(step + 1, value);

      // Yield so a long run doesn't lock the tab.
      if (step % 10 === 0) await new Promise(r => setTimeout(r, 0));
    }

    return {
      steps,
      finalLoss: lastLoss,
      lossHistory,
      trainAccuracy: await this.evaluate(),
      paramCount: model.paramCount(),
      vocabSize: this.tokenizer!.vocabSize,
      labels: [...this.labels],
    };
  }

  /** Accuracy over a set of examples — defaults to the training set. Pass a held-out set to measure generalization rather than memorization. */
  async evaluate(examples?: LabeledExample[]): Promise<number> {
    if (!this.model) throw new Error('Classifier not initialized.');
    if (examples) {
      if (examples.length === 0) return 0;
      let correct = 0;
      for (const ex of examples) {
        const pred = await this.predict(ex.text);
        if (pred.label === ex.label) correct++;
      }
      return correct / examples.length;
    }

    if (this.encoded.length === 0) return 0;
    let correct = 0;
    for (const ex of this.encoded) {
      const { label } = await this.model.predict(ex.ids);
      if (label === ex.label) correct++;
    }
    return correct / this.encoded.length;
  }

  /**
   * Filters input down to characters the tokenizer actually knows. The
   * char vocabulary only covers training text, so a router shouldn't fall
   * over because the user typed a character it never saw.
   */
  private toKnownText(text: string): string {
    const known = Array.from(text).filter(c => this.tokenizer!.stoi.has(c)).join('');
    if (!known) {
      throw new Error('None of that input\'s characters appear in the training data, so there is nothing to classify.');
    }
    return known;
  }

  /**
   * Persist the trained classifier under a name so it survives a reload.
   * Training costs ~20s and several Groq calls to build a dataset; without
   * this that is re-paid every session, which defeats the point of a local
   * specialist being cheap after the first time.
   *
   * `heldOutAccuracy` is stored when the caller has measured it, because
   * training accuracy alone has already proven misleading here (100% train,
   * 33% held-out on the first attempt).
   */
  async saveAs(name: string, heldOutAccuracy?: number, heldOutExamples?: LabeledExample[]): Promise<void> {
    if (!this.model || !this.tokenizer) throw new Error('No classifier has been trained yet in this tab.');
    if (!name.trim()) throw new Error('Give the classifier a name to save it under.');

    const params = this.model.parameters();
    await classifierRegistry.save({
      name: name.trim(),
      savedAt: new Date().toISOString(),
      labels: [...this.labels],
      paramCount: this.model.paramCount(),
      vocabSize: this.tokenizer.vocabSize,
      exampleCount: this.encoded.length,
      heldOutAccuracy,
      heldOutExamples,
      config: this.config,
      vocabChars: this.tokenizer.itos.join(''),
      examples: [...this.examples],
      paramShapes: params.map((p: any) => p.shape),
      paramBuffers: params.map((p: any) =>
        p.data.buffer.slice(p.data.byteOffset, p.data.byteOffset + p.data.byteLength)
      ),
    });
  }

  /**
   * The examples the currently loaded classifier was built or restored
   * from. Exposed so a caller can merge in new examples and retrain without
   * having to keep its own copy of the seed set in sync — see the
   * terminal's `train --from-corrections`.
   */
  get currentExamples(): LabeledExample[] {
    return [...this.examples];
  }

  async listSaved(): Promise<SavedClassifierMeta[]> {
    return classifierRegistry.list();
  }

  async deleteSaved(name: string): Promise<void> {
    return classifierRegistry.remove(name);
  }

  /** Restores a saved classifier, ready to predict immediately — no retraining. */
  async loadSaved(name: string): Promise<{ labels: string[]; paramCount: number; exampleCount: number }> {
    const record = await classifierRegistry.load(name);
    if (!record) throw new Error(`No saved classifier named "${name}".`);

    const tokenizer = new CharTokenizer(record.vocabChars);
    const model = new BNLMClassifier(tokenizer.vocabSize, record.labels.length, {
      dModel: record.config.dModel,
      numLayers: record.config.numLayers,
      numHeads: record.config.numHeads,
      contextLen: record.config.contextLen,
      mixerType: record.config.mixerType,
    });

    const params = model.parameters();
    if (params.length !== record.paramBuffers.length) {
      throw new Error(
        `Saved classifier "${name}" doesn't match the current engine (expected ${params.length} ` +
        `parameter tensors, found ${record.paramBuffers.length}). It was saved by an older build.`
      );
    }
    params.forEach((p: any, i: number) => p.data.set(new Float32Array(record.paramBuffers[i])));

    this.tokenizer = tokenizer;
    this.model = model;
    this.labels = [...record.labels];
    this.config = record.config;
    this.examples = [...record.examples];
    this.optimizer = new Adam(model.parameters(), { lr: record.config.lr });
    // Re-encode so evaluate() and further training work against the restored
    // vocabulary rather than a stale one.
    const labelIndex = new Map(this.labels.map((l, i) => [l, i]));
    this.encoded = record.examples
      .filter(e => labelIndex.has(e.label))
      .map(e => ({ ids: tokenizer.encode(e.text), label: labelIndex.get(e.label)! }));

    return { labels: [...this.labels], paramCount: model.paramCount(), exampleCount: this.encoded.length };
  }

  /**
   * The pooled trunk representation for `text` — length dModel, no label
   * attached. NOT exposed as a terminal command yet: see BUILTINS.md's
   * "embed / similar" section. This exists so that question can be
   * measured (precision@k against a small labelled set) rather than
   * guessed at from the architecture alone.
   */
  async embed(text: string): Promise<number[]> {
    if (!this.model || !this.tokenizer) throw new Error('No classifier has been trained yet in this tab.');
    const known = this.toKnownText(text);
    return Array.from(await this.model.embed(this.tokenizer.encode(known)));
  }

  async predict(text: string): Promise<PredictResult> {
    if (!this.model || !this.tokenizer) throw new Error('No classifier has been trained yet in this tab.');
    const known = this.toKnownText(text);

    const { label, probs, logits, pooledNorm } = await this.model.predict(this.tokenizer.encode(known));
    const ranked = this.labels
      .map((name, i) => ({ label: name, probability: probs[i] }))
      .sort((a, b) => b.probability - a.probability);

    const top = ranked[0];
    const second = ranked[1];
    const margin = top.probability - (second?.probability ?? 0);

    // Stated plainly, and honest about a borderline call — a confident
    // wrong answer is the failure mode that matters for a router, so the
    // margin is reported rather than left for the caller to infer.
    let explanation = `Predicted "${top.label}" at ${(top.probability * 100).toFixed(1)}% confidence`;
    explanation += second ? `, ahead of "${second.label}" at ${(second.probability * 100).toFixed(1)}%.` : '.';
    if (margin < 0.15) explanation += ' The margin is narrow — treat this as uncertain.';
    else if (margin > 0.4) explanation += ' Clear separation from the alternatives.';

    return { label: this.labels[label], confidence: probs[label], ranked, logits, pooledNorm, margin, explanation };
  }

  /**
   * Why the classifier said what it said, by occlusion — each unit is
   * removed in turn and the drop in the target label's probability is
   * measured. A real counterfactual ("remove this evidence, does the answer
   * change?"), not a similarity heuristic.
   *
   * Defaults to WORD granularity, and that default is load-bearing.
   * Character-level occlusion measured near-zero on a confident prediction
   * (scores spanning 0.000–0.002 on a 99.6%-confidence call): deleting one
   * letter from "ping the server" leaves the rest of the word intact and the
   * model is robust to it. Technically true, useless to read. Removing whole
   * words shows what actually carries the decision.
   *
   * Separate from predict() because it costs one forward pass per unit.
   * Routing stays single-pass; only a user asking "why?" pays for this.
   */
  async explain(
    text: string,
    opts: { forLabel?: string; granularity?: 'word' | 'char' } = {}
  ): Promise<Attribution> {
    if (!this.model || !this.tokenizer) throw new Error('No classifier has been trained yet in this tab.');
    const known = this.toKnownText(text);
    const granularity = opts.granularity ?? 'word';

    let targetIndex: number | undefined;
    if (opts.forLabel !== undefined) {
      targetIndex = this.labels.indexOf(opts.forLabel);
      if (targetIndex < 0) {
        throw new Error(`Unknown label "${opts.forLabel}". This classifier knows: ${this.labels.join(', ')}.`);
      }
    }

    if (granularity === 'char') {
      const chars = Array.from(known);
      const res = await this.model.attributeByOcclusion(this.tokenizer.encode(known), targetIndex);
      return {
        label: this.labels[res.targetClass],
        baseline: res.baseline,
        contributions: res.contributions.map(({ index, score }) => ({ token: chars[index] ?? '?', index, score })),
      };
    }

    // Word granularity: rebuild the string without each word and re-run.
    const units = known.split(/(\s+)/).filter(u => u.length > 0);
    const wordPositions = units
      .map((u, i) => ({ u, i }))
      .filter(({ u }) => !/^\s+$/.test(u));

    const base = await this.model.predict(this.tokenizer.encode(known));
    const target = targetIndex ?? base.label;
    const baseline = base.probs[target];

    const contributions: Attribution['contributions'] = [];
    for (let n = 0; n < wordPositions.length; n++) {
      const { u, i } = wordPositions[n];
      const withoutWord = units.filter((_, j) => j !== i).join('').replace(/\s+/g, ' ').trim();
      // Nothing left to classify — skip rather than report a bogus score.
      if (!withoutWord) continue;
      const { probs } = await this.model.predict(this.tokenizer.encode(withoutWord));
      contributions.push({ token: u, index: n, score: baseline - probs[target] });
    }

    return { label: this.labels[target], baseline, contributions };
  }
}

export const localClassifier = new LocalClassifierService();
