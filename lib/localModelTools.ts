// The bnlm.* agent tool-call contract (see lib/agents.ts's BNLM_TOOL_CONTRACT)
// — shared between AIChat.tsx (parses a tool block out of a streamed chat
// reply) and lib/taskEngine.ts (a DAG node whose command is "bnlm.train" /
// "bnlm.generate" runs through the exact same executor). One place that
// knows how to turn a tool call into a local-model action.

import { localModel } from './localModel';
import { localClassifier, LabeledExample } from './localClassifier';
import { localEmbedder } from './localEmbedder';
import { localTagger } from './localTagger';
import { localSeq2Seq } from './localSeq2Seq';
import { generateLabeledExamples, describeDataset, generateProseCorpus, generateParaphrasePairs, generateTaggedExamples, generateTransformPairs } from './datasetGen';
import { cosineSimilarity } from '../src/bnlm/embed.js';
import { vfs } from './vfs';
import { resolveDir, ROOT_CWD } from './terminalFs';

export interface ToolCall {
  tool: string;
  args?: Record<string, any>;
}

/**
 * Structured detail behind a tool result, for the UI's "Why?" panel.
 * A classification (or similarity score, or tagged span, or transform) that
 * can only be read as prose isn't inspectable — the caller needs the
 * distribution and the attribution as data. One variant per model type that
 * has attribution machinery; grows as each one gets it (see
 * lib/localEmbedder.ts's explainSimilarity for the first non-classifier
 * kind, 'similarity').
 */
export type GlassBoxDetail =
  | {
      kind: 'classification';
      label: string;
      confidence: number;
      margin: number;
      ranked: { label: string; probability: number }[];
      /** Per-word causal contribution, when an explanation was computed. */
      contributions?: { token: string; score: number }[];
    }
  | {
      kind: 'similarity';
      score: number;
      /** Per-character occlusion contribution on each side — see lib/localEmbedder.ts's explainSimilarity. */
      contributionsA: { token: string; index: number; score: number }[];
      contributionsB: { token: string; index: number; score: number }[];
    }
  | {
      kind: 'tagging';
      /** Confidence per span is genuinely free — the softmax was already computed to pick the tag, see src/bnlm/tagger.js's predict(). */
      spans: { tag: string; start: number; end: number; text: string; confidence: number }[];
    }
  | {
      kind: 'score';
      perplexity: number;
      /** Per-character surprise — see lib/localModel.ts's explainScore. */
      perCharacter: { char: string; index: number; actualProb: number; surprise: number; topAlternatives: { char: string; prob: number }[] }[];
    };

export interface ToolRunResult {
  /** What goes into the chat thread. */
  text: string;
  /** Machine-readable detail; rendered as an expandable panel when present. */
  glassBox?: GlassBoxDetail;
}

/**
 * Every tool.tool value runLocalModelTool actually handles, in one place —
 * exported so lib/terminalCapabilities.test.ts can check AGENT_TOOL_CAPABILITIES
 * against the real list instead of a second, hand-maintained copy that could
 * silently drift from it. Not consumed by runLocalModelTool itself, which
 * stays a plain if-chain below; this is documentation with a test attached,
 * not a second source of truth for dispatch.
 */
export const LOCAL_MODEL_TOOL_NAMES = [
  'bnlm.train',
  'bnlm.generate',
  'bnlm.score',
  'bnlm.buildGenerative',
  'bnlm.buildClassifier',
  'bnlm.trainClassifier',
  'bnlm.classify',
  'bnlm.buildEmbeddingIndex',
  'bnlm.similarity',
  'bnlm.semanticSearch',
  'bnlm.buildTagger',
  'bnlm.tag',
  'bnlm.buildTransform',
  'bnlm.transform',
] as const;

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

/** Recursive walk cap for bnlm.semanticSearch — an agent tool call is a bad place to accidentally read someone's entire filesystem. */
const MAX_SEARCH_FILES = 200;

/**
 * Recursively collects every readable text file under a VFS directory, for
 * bnlm.semanticSearch. Base64-encoded (binary) files are skipped — embedding
 * raw base64 text would be meaningless. Stops early past MAX_SEARCH_FILES
 * rather than walking an entire large tree just to discard most of it.
 */
async function collectVfsFiles(dirId: string, userId: string, dirPath: string): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  const children = await vfs.list(dirId, userId);
  for (const child of children) {
    if (out.length >= MAX_SEARCH_FILES) break;
    const childPath = `${dirPath}/${child.name}`;
    if (child.type === 'directory') {
      out.push(...await collectVfsFiles(child.id, userId, childPath));
    } else if (!child.encoding) {
      const content = await vfs.read(child.id, userId);
      if (content.trim()) out.push({ path: childPath, content });
    }
  }
  return out.slice(0, MAX_SEARCH_FILES);
}

/** Executes a bnlm.* tool call against the in-browser models. Throws on failure — callers decide how to surface that. `userId` is only needed by tools that touch the VFS (bnlm.semanticSearch) — see lib/kernosTools.ts's runTool, the sole caller, which resolves it once via getCurrentUserId(). */
export async function runLocalModelTool(toolCall: ToolCall, userId?: string): Promise<ToolRunResult> {
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
    const { overall, perCharacter } = await localModel.explainScore(text);
    return {
      text:
        `Score for that text against the trained model: loss ${overall.loss.toFixed(3)}, ` +
        `perplexity ${overall.perplexity.toFixed(2)} (lower = closer to what it learned), ` +
        `over ${overall.tokensScored} tokens.`,
      glassBox: { kind: 'score', perplexity: overall.perplexity, perCharacter },
    };
  }

  // Generates its own training corpus via Groq, then trains locally — the
  // generative counterpart to bnlm.buildClassifier below. Groq is spent
  // once, here, writing the stories; the trained model then runs with no
  // further cloud calls at all.
  if (toolCall.tool === 'bnlm.buildGenerative') {
    const { topic, count = 30, steps = 200 } = toolCall.args || {};
    if (!topic || typeof topic !== 'string') {
      throw new Error('bnlm.buildGenerative needs a "topic" describing what to generate stories about.');
    }
    const clampedCount = Math.min(Math.max(Math.round(Number(count) || 30), 5), 100);
    const clampedSteps = Math.min(Math.max(Math.round(Number(steps) || 200), 1), 500);
    const corpus = await generateProseCorpus(topic, clampedCount);
    if (!corpus.trim()) throw new Error('Groq returned an empty corpus.');
    const { init, train } = await localModel.ensureInitAndTrain(corpus, clampedSteps);
    return { text:
      `Generated a ${clampedCount}-story corpus about "${topic}" via Groq, then trained a local model ` +
      `right here in the browser: ${init.paramCount.toLocaleString()} params, vocab ${init.vocabSize}, ` +
      `${train.steps} steps, final loss ${train.finalLoss.toFixed(3)}.`
    };
  }

  // ── Embedder tools ──────────────────────────────────────────────────
  // Answers "how similar is this to that?" — the primitive underneath
  // semantic search. Same spend-Groq-once-then-run-local shape as
  // bnlm.buildGenerative/bnlm.buildClassifier above.

  if (toolCall.tool === 'bnlm.buildEmbeddingIndex') {
    const { topic, count = 30, steps = 300 } = toolCall.args || {};
    if (!topic || typeof topic !== 'string') {
      throw new Error('bnlm.buildEmbeddingIndex needs a "topic" describing what kind of text to build the embedding space around.');
    }
    const clampedCount = Math.min(Math.max(Math.round(Number(count) || 30), 5), 100);
    const clampedSteps = Math.min(Math.max(Math.round(Number(steps) || 300), 1), 800);
    const pairs = await generateParaphrasePairs(topic, clampedCount);
    if (pairs.length < 2) {
      throw new Error('Groq returned too few usable paraphrase pairs to train an embedder on — try a broader topic.');
    }
    const { init, train } = await localEmbedder.ensureInitAndTrain(pairs, clampedSteps);
    return { text:
      `Generated ${pairs.length} paraphrase pairs about "${topic}" via Groq, then trained a local embedder ` +
      `right here in the browser: ${init.paramCount.toLocaleString()} params, vocab ${init.vocabSize}, ` +
      `${train.steps} steps, final loss ${train.finalLoss.toFixed(3)}. It's ready for bnlm.similarity or ` +
      `bnlm.semanticSearch now.`
    };
  }

  if (toolCall.tool === 'bnlm.similarity') {
    const { textA, textB } = toolCall.args || {};
    if (!textA || typeof textA !== 'string' || !textB || typeof textB !== 'string') {
      throw new Error('bnlm.similarity needs both "textA" and "textB" strings to compare.');
    }
    if (!localEmbedder.isReady) {
      throw new Error('No embedder has been trained yet in this tab — call bnlm.buildEmbeddingIndex first.');
    }
    const { score, contributionsA, contributionsB } = await localEmbedder.explainSimilarity(textA, textB);
    return {
      text: `Cosine similarity: ${score.toFixed(3)} (1.0 = identical meaning, 0 = unrelated, -1.0 = opposite).`,
      glassBox: { kind: 'similarity', score, contributionsA, contributionsB },
    };
  }

  if (toolCall.tool === 'bnlm.semanticSearch') {
    const { query, path = '/', topK = 5 } = toolCall.args || {};
    if (!query || typeof query !== 'string') {
      throw new Error('bnlm.semanticSearch needs a "query" string to search for.');
    }
    if (!localEmbedder.isReady) {
      throw new Error('No embedder has been trained yet in this tab — call bnlm.buildEmbeddingIndex first.');
    }
    if (!userId) {
      throw new Error('bnlm.semanticSearch needs a signed-in user to know whose files to search.');
    }
    const resolved = await resolveDir(ROOT_CWD, path, userId);
    if (typeof resolved === 'string') {
      throw new Error(`bnlm.semanticSearch: ${resolved}`);
    }
    const startId = resolved.length ? resolved[resolved.length - 1].id : 'home';
    const files = await collectVfsFiles(startId, userId, path === '/' ? '' : path.replace(/\/+$/, ''));
    if (files.length === 0) {
      return { text: `No readable text files found under "${path}".` };
    }
    const clampedTopK = Math.min(Math.max(Math.round(Number(topK) || 5), 1), 20);
    const queryVec = await localEmbedder.embed(query);
    const scored = await Promise.all(files.map(async f => {
      // Embed only the opening of the file, not the whole thing: the
      // embedder pools its LAST token (see src/bnlm/embed.js's doc comment
      // on why — every mixer here is causal), and padBatch keeps a
      // sequence's tail when it's longer than contextLen. Feeding the full
      // file would end up representing wherever it happens to end, not
      // what it's about — truncating to a head slice keeps the embedded
      // region anchored to the file's opening/topic instead.
      const head = f.content.slice(0, 300);
      return {
        path: f.path,
        snippet: f.content.slice(0, 160).replace(/\s+/g, ' ').trim(),
        score: cosineSimilarity(queryVec, await localEmbedder.embed(head)),
      };
    }));
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, clampedTopK);
    const lines = top.map(r => `${r.score.toFixed(3)}  ${r.path}\n    ${r.snippet}${r.snippet.length >= 160 ? '…' : ''}`);
    return { text: `Top ${top.length} match${top.length === 1 ? '' : 'es'} for "${query}" under "${path}" (${files.length} file${files.length === 1 ? '' : 's'} searched):\n\n${lines.join('\n\n')}` };
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

  // ── Tagger tools ────────────────────────────────────────────────────
  // Answers "which PARTS of this matter?" — supervised per-character
  // labels in one forward pass, rather than one label for the whole input
  // (the classifier) or a pooled similarity score (the embedder).

  if (toolCall.tool === 'bnlm.buildTagger') {
    const { tags, defaultTag, domain, count = 20, steps = 300 } = toolCall.args || {};
    if (!Array.isArray(tags) || tags.length === 0) {
      throw new Error('bnlm.buildTagger needs a "tags" array with at least 1 tag to mark up.');
    }
    if (!defaultTag || typeof defaultTag !== 'string') {
      throw new Error('bnlm.buildTagger needs a "defaultTag" describing untagged text.');
    }
    if (!domain || typeof domain !== 'string') {
      throw new Error('bnlm.buildTagger needs a "domain" describing what kind of text to generate.');
    }
    const clampedCount = Math.min(Math.max(Math.round(Number(count) || 20), 5), 60);
    const clampedSteps = Math.min(Math.max(Math.round(Number(steps) || 300), 1), 800);
    const examples = await generateTaggedExamples(tags.map(String), defaultTag, domain, clampedCount);
    if (examples.length === 0) {
      throw new Error('Groq returned no usable tagged examples — try rewording the domain or tags.');
    }
    const { init, train } = await localTagger.ensureInitAndTrain(examples, clampedSteps);
    return { text:
      `Generated ${examples.length} tagged examples about "${domain}" via Groq, then trained a local tagger ` +
      `right here in the browser: ${init.paramCount.toLocaleString()} params, vocab ${init.vocabSize}, ` +
      `tags [${init.tagLabels.join(', ')}], ${train.steps} steps, final loss ${train.finalLoss.toFixed(3)}. ` +
      `It's ready for bnlm.tag now.`
    };
  }

  if (toolCall.tool === 'bnlm.tag') {
    const { text: input } = toolCall.args || {};
    if (!input || typeof input !== 'string') throw new Error('bnlm.tag is missing "text" to tag.');
    if (!localTagger.isReady) {
      throw new Error('No tagger has been trained yet in this tab — call bnlm.buildTagger first.');
    }
    const spans = await localTagger.tag(input);
    const lines = spans.map(s => `[${s.tag}] "${s.text}" (${(s.confidence * 100).toFixed(0)}%)`);
    return {
      text: `Tagged spans:\n${lines.join('\n')}`,
      glassBox: { kind: 'tagging', spans },
    };
  }

  // ── Seq2seq tools ───────────────────────────────────────────────────
  // Answers "turn this into that": summarize, rephrase, restyle — reading
  // a whole source passage and generating a genuinely new output
  // conditioned on it, not just continuing a prompt the way bnlm.generate
  // does.

  if (toolCall.tool === 'bnlm.buildTransform') {
    const { task, count = 20, steps = 400 } = toolCall.args || {};
    if (!task || typeof task !== 'string') {
      throw new Error('bnlm.buildTransform needs a "task" describing the transformation to learn.');
    }
    const clampedCount = Math.min(Math.max(Math.round(Number(count) || 20), 5), 50);
    const clampedSteps = Math.min(Math.max(Math.round(Number(steps) || 400), 1), 1200);
    const pairs = await generateTransformPairs(task, clampedCount);
    if (pairs.length === 0) {
      throw new Error('Groq returned no usable transform pairs — try rewording the task.');
    }
    const { init, train } = await localSeq2Seq.ensureInitAndTrain(pairs, clampedSteps);
    return { text:
      `Generated ${pairs.length} example pairs for "${task}" via Groq, then trained a local encoder-decoder ` +
      `right here in the browser: ${init.paramCount.toLocaleString()} params, vocab ${init.vocabSize}, ` +
      `${train.steps} steps, final loss ${train.finalLoss.toFixed(3)}. It's ready for bnlm.transform now.`
    };
  }

  if (toolCall.tool === 'bnlm.transform') {
    const { text: input, maxTokens = 80 } = toolCall.args || {};
    if (!input || typeof input !== 'string') throw new Error('bnlm.transform is missing "text" to transform.');
    if (!localSeq2Seq.isReady) {
      throw new Error('No seq2seq model has been trained yet in this tab — call bnlm.buildTransform first.');
    }
    const clampedTokens = Math.min(Math.max(Math.round(Number(maxTokens) || 80), 1), 200);
    const output = await localSeq2Seq.transform(input, clampedTokens);
    return { text: `Transformed output:\n\n${output}` };
  }

  throw new Error(`Unknown local model tool: "${toolCall.tool}"`);
}
