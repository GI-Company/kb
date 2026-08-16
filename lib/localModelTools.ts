// The bnlm.* agent tool-call contract (see lib/agents.ts's BNLM_TOOL_CONTRACT)
// — shared between AIChat.tsx (parses a tool block out of a streamed chat
// reply) and lib/taskEngine.ts (a DAG node whose command is "bnlm.train" /
// "bnlm.generate" runs through the exact same executor). One place that
// knows how to turn a tool call into a local-model action.

import { localModel } from './localModel';
import { localClassifier, LabeledExample } from './localClassifier';
import { generateLabeledExamples, describeDataset } from './datasetGen';

export interface ToolCall {
  tool: string;
  args?: Record<string, any>;
}

/**
 * Structured detail behind a tool result, for the UI's "Why?" panel.
 * A classification that can only be read as prose isn't inspectable — the
 * caller needs the distribution and the attribution as data.
 */
export interface GlassBoxDetail {
  kind: 'classification';
  label: string;
  confidence: number;
  margin: number;
  ranked: { label: string; probability: number }[];
  /** Per-word causal contribution, when an explanation was computed. */
  contributions?: { token: string; score: number }[];
}

export interface ToolRunResult {
  /** What goes into the chat thread. */
  text: string;
  /** Machine-readable detail; rendered as an expandable panel when present. */
  glassBox?: GlassBoxDetail;
}

export function extractToolCall(text: string): ToolCall | null {
  const match = text.match(/```tool\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    return parsed && typeof parsed.tool === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function stripToolBlock(text: string): string {
  return text.replace(/```tool\s*[\s\S]*?```/, '').trim();
}

/** Executes a bnlm.* tool call against the in-browser models. Throws on failure — callers decide how to surface that. */
export async function runLocalModelTool(toolCall: ToolCall): Promise<ToolRunResult> {
  if (toolCall.tool === 'bnlm.train') {
    const { corpus, steps = 200 } = toolCall.args || {};
    if (!corpus || typeof corpus !== 'string') throw new Error('Tool call is missing "corpus" text to train on.');
    const clampedSteps = Math.min(Math.max(Math.round(Number(steps) || 200), 1), 500);
    const { init, train } = await localModel.ensureInitAndTrain(corpus, clampedSteps);
    return { text:
      `Trained a local model right here in the browser: ${init.paramCount.toLocaleString()} params, ` +
      `vocab ${init.vocabSize}, ${train.steps} steps, final loss ${train.finalLoss.toFixed(3)}.`
    };
  }

  if (toolCall.tool === 'bnlm.generate') {
    const { prompt = '', maxTokens = 60 } = toolCall.args || {};
    if (!localModel.isReady) throw new Error('No local model has been trained yet in this tab — train one first.');
    const clampedTokens = Math.min(Math.max(Math.round(Number(maxTokens) || 60), 1), 300);
    const { text, cappedBy } = await localModel.generate(String(prompt), clampedTokens);
    // Say so when the context window shortened the output, so the agent (and
    // the user reading the thread) isn't left thinking generation is stuck at
    // some fixed length.
    const note = cappedBy
      ? `\n\n(Output capped at ${cappedBy.limit} tokens: the attention mixer's context window is ` +
        `${cappedBy.contextLen} and the prompt used ${cappedBy.promptTokens}. Retrain with a larger ` +
        `context length, or with the "linear" or "rwkv" mixer, for unbounded generation.)`
      : '';
    return { text: `Local model output:\n\n${text}${note}` };
  }

  if (toolCall.tool === 'bnlm.score') {
    const { text = '' } = toolCall.args || {};
    if (!localModel.isReady) throw new Error('No local model has been trained yet in this tab — train one first.');
    if (!text || typeof text !== 'string') throw new Error('Tool call is missing "text" to score.');
    const result = await localModel.score(text);
    return { text:
      `Score for that text against the trained model: loss ${result.loss.toFixed(3)}, ` +
      `perplexity ${result.perplexity.toFixed(2)} (lower = closer to what it learned), ` +
      `over ${result.tokensScored} tokens.`
    };
  }

  // ── Classifier tools ────────────────────────────────────────────────
  // Discrete decisions (routing, tagging, tool selection) go through the
  // classifier rather than being coaxed out of generated text: the output
  // is a distribution over known labels, so it can't be malformed and it
  // comes with a confidence the caller can act on.

  // Generates its own training data, then trains on it — the whole point
  // being that Groq is used once here and never again at inference.
  if (toolCall.tool === 'bnlm.buildClassifier') {
    const { labels, domain, perLabel = 60, steps = 250 } = toolCall.args || {};
    if (!Array.isArray(labels) || labels.length < 2) {
      throw new Error('bnlm.buildClassifier needs a "labels" array with at least 2 labels.');
    }
    if (!domain || typeof domain !== 'string') {
      throw new Error('bnlm.buildClassifier needs a "domain" describing what is being classified.');
    }
    const clampedPer = Math.min(Math.max(Math.round(Number(perLabel) || 60), 10), 150);
    const examples = await generateLabeledExamples(labels.map(String), clampedPer, domain);
    const stats = describeDataset(examples);

    const init = localClassifier.init(examples);
    const result = await localClassifier.train(
      Math.min(Math.max(Math.round(Number(steps) || 250), 1), 600)
    );

    const warn = stats.warnings.length ? `\n\nData quality: ${stats.warnings.join(' ')}` : '';
    return { text:
      `Generated ${stats.total} examples across ${init.labels.length} labels ` +
      `(${Object.entries(stats.perLabel).map(([l, n]) => `${l}: ${n}`).join(', ')}) and trained a ` +
      `${init.paramCount.toLocaleString()}-param classifier. Final loss ` +
      `${result.finalLoss.toFixed(3)}, training accuracy ${(result.trainAccuracy * 100).toFixed(1)}% ` +
      `(training accuracy is not generalization).${warn}`
    };
  }

  if (toolCall.tool === 'bnlm.trainClassifier') {
    const { examples, steps = 250 } = toolCall.args || {};
    if (!Array.isArray(examples) || examples.length === 0) {
      throw new Error('bnlm.trainClassifier needs an "examples" array of {text, label} objects.');
    }
    const clean: LabeledExample[] = examples
      .filter((e: any) => e && typeof e.text === 'string' && typeof e.label === 'string')
      .map((e: any) => ({ text: e.text, label: e.label }));
    if (clean.length !== examples.length) {
      throw new Error('Every example needs a string "text" and a string "label".');
    }
    const clampedSteps = Math.min(Math.max(Math.round(Number(steps) || 250), 1), 600);
    const init = localClassifier.init(clean);
    const result = await localClassifier.train(clampedSteps);
    return { text:
      `Trained a local classifier: ${init.paramCount.toLocaleString()} params over ` +
      `${clean.length} examples across ${init.labels.length} labels (${init.labels.join(', ')}). ` +
      `Final loss ${result.finalLoss.toFixed(3)}, training accuracy ` +
      `${(result.trainAccuracy * 100).toFixed(1)}%. Note that training accuracy is not ` +
      `generalization — hold examples back to measure that.`
    };
  }

  if (toolCall.tool === 'bnlm.classify') {
    const { text: input, explain = true } = toolCall.args || {};
    if (!input || typeof input !== 'string') throw new Error('bnlm.classify is missing "text" to classify.');
    if (!localClassifier.isReady) {
      throw new Error('No classifier has been trained yet in this tab — call bnlm.trainClassifier first.');
    }
    const p = await localClassifier.predict(input);
    let contributions: { token: string; score: number }[] | undefined;
    if (explain) {
      try {
        const a = await localClassifier.explain(input);
        contributions = a.contributions.map(c => ({ token: c.token, score: c.score }));
      } catch {
        // Attribution is a nice-to-have; a failure here must not lose the
        // classification the caller actually asked for.
      }
    }
    return {
      text: p.explanation,
      glassBox: {
        kind: 'classification',
        label: p.label,
        confidence: p.confidence,
        margin: p.margin,
        ranked: p.ranked,
        contributions,
      },
    };
  }

  throw new Error(`Unknown local model tool: "${toolCall.tool}"`);
}
