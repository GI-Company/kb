// Several Groq models (qwen3.6-27b in particular) emit their reasoning in
// <think>...</think> before the actual answer. Every surface that renders a
// model's raw reply needs to split that off, so this lives here instead of
// being duplicated per app — apps/AIChat.tsx shows it in a collapsible
// block, apps/MultiAgentWorkspace.tsx just drops it.
//
// Handles the unclosed case too: while a response is still streaming, the
// opening <think> arrives long before its closing tag, and treating that
// partial text as the answer makes a pane look like it's replying with its
// own scratchpad.

export interface SplitThinking {
  thinking: string;
  response: string;
}

export function extractThinking(text: string): SplitThinking {
  let thinking = '';
  let response = text;

  const thinkMatches = text.match(/<think>([\s\S]*?)<\/think>/g);
  if (thinkMatches) {
    thinking = thinkMatches
      .map(m => m.replace(/<\/?think>/g, '').trim())
      .join('\n\n');
    response = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }

  // Still-streaming block with no closing tag yet.
  const unclosed = response.match(/<think>([\s\S]*)$/);
  if (unclosed) {
    thinking += (thinking ? '\n\n' : '') + unclosed[1].trim();
    response = response.replace(/<think>[\s\S]*$/, '').trim();
  }

  return { thinking, response };
}
