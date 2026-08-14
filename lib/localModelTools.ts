// The bnlm.* agent tool-call contract (see lib/agents.ts's BNLM_TOOL_CONTRACT)
// — shared between AIChat.tsx (parses a tool block out of a streamed chat
// reply) and lib/taskEngine.ts (a DAG node whose command is "bnlm.train" /
// "bnlm.generate" runs through the exact same executor). One place that
// knows how to turn a tool call into a local-model action.

import { localModel } from './localModel';

export interface ToolCall {
  tool: string;
  args?: Record<string, any>;
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

/** Executes a bnlm.* tool call against the in-browser LocalModelService and returns a human-readable result. Throws on failure — callers decide how to surface that. */
export async function runLocalModelTool(toolCall: ToolCall): Promise<string> {
  if (toolCall.tool === 'bnlm.train') {
    const { corpus, steps = 200 } = toolCall.args || {};
    if (!corpus || typeof corpus !== 'string') throw new Error('Tool call is missing "corpus" text to train on.');
    const clampedSteps = Math.min(Math.max(Math.round(Number(steps) || 200), 1), 500);
    const { init, train } = await localModel.ensureInitAndTrain(corpus, clampedSteps);
    return (
      `Trained a local model right here in the browser: ${init.paramCount.toLocaleString()} params, ` +
      `vocab ${init.vocabSize}, ${train.steps} steps, final loss ${train.finalLoss.toFixed(3)}.`
    );
  }

  if (toolCall.tool === 'bnlm.generate') {
    const { prompt = '', maxTokens = 60 } = toolCall.args || {};
    if (!localModel.isReady) throw new Error('No local model has been trained yet in this tab — train one first.');
    const clampedTokens = Math.min(Math.max(Math.round(Number(maxTokens) || 60), 1), 300);
    const { text } = await localModel.generate(String(prompt), clampedTokens);
    return `Local model output:\n\n${text}`;
  }

  if (toolCall.tool === 'bnlm.score') {
    const { text = '' } = toolCall.args || {};
    if (!localModel.isReady) throw new Error('No local model has been trained yet in this tab — train one first.');
    if (!text || typeof text !== 'string') throw new Error('Tool call is missing "text" to score.');
    const result = await localModel.score(text);
    return (
      `Score for that text against the trained model: loss ${result.loss.toFixed(3)}, ` +
      `perplexity ${result.perplexity.toFixed(2)} (lower = closer to what it learned), ` +
      `over ${result.tokensScored} tokens.`
    );
  }

  throw new Error(`Unknown local model tool: "${toolCall.tool}"`);
}
