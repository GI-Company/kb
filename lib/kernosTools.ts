// Tool-call dispatcher — routes a parsed ToolCall (lib/localModelTools.ts's
// extractToolCall, which is generic and doesn't care about tool names) to
// the right executor: bnlm.* -> the existing runLocalModelTool,
// kernos.exec -> the new sandboxed lib/kernosExec.ts. Kept as a thin
// dispatcher rather than merging into either implementation file, since
// AIChat.tsx and lib/taskEngine.ts only need "give me a ToolCall, get a
// result string back," not which capability handled it.

import { ToolCall, runLocalModelTool } from './localModelTools';
import { runKernosExec } from './kernosExec';
import { getCurrentUserId } from './auth';

export async function runTool(toolCall: ToolCall): Promise<string> {
  if (toolCall.tool.startsWith('bnlm.')) {
    return runLocalModelTool(toolCall);
  }

  if (toolCall.tool === 'kernos.exec') {
    const code = toolCall.args?.code;
    if (!code || typeof code !== 'string') {
      throw new Error('kernos.exec tool call is missing "code".');
    }
    const timeoutMs = toolCall.args?.timeoutMs;
    const userId = await getCurrentUserId();
    const result = await runKernosExec(code, userId, typeof timeoutMs === 'number' ? timeoutMs : undefined);
    if (!result.ok) throw new Error(result.error || 'kernos.exec failed');
    if (typeof result.value === 'string') return result.value;
    if (result.value === undefined) return '(kernos.exec ran successfully, returned no value)';
    try {
      return JSON.stringify(result.value, null, 2);
    } catch {
      return String(result.value);
    }
  }

  throw new Error(`Unknown tool: "${toolCall.tool}"`);
}
