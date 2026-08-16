// Two sources of reasoning blocks, handled identically:
//   <think>    — emitted natively by reasoning models (qwen3.6-27b here)
//   <reasoning> — asked for explicitly by GLASS_BOX_CONTRACT in lib/agents.ts
// Both are separated from the answer so the UI can show them collapsed
// rather than inline. If a tag were missed here it wouldn't be hidden —
// it would render as clutter in the reply. Every surface that renders a
// model's raw reply needs to split that off, so this lives here instead of
// being duplicated per app — apps/AIChat.tsx shows it in a collapsible
// block, apps/MultiAgentWorkspace.tsx just drops it.
//
// Handles the unclosed case too: while a response is still streaming, the
// opening <think> arrives long before its closing tag, and treating that
// partial text as the answer makes a pane look like it's replying with its
// own scratchpad.

const TAG_BLOCK_RE = /<(think|reasoning)>[\s\S]*?<\/\1>/g;
const TAG_OPEN_OR_CLOSE_RE = /<\/?(?:think|reasoning)>/g;
// Still-streaming block whose closing tag hasn't arrived yet. The inner
// group is capturing so the partial content can be kept as reasoning
// rather than discarded.
const TAG_UNCLOSED_RE = /<(?:think|reasoning)>([\s\S]*)$/;

export interface SplitThinking {
  thinking: string;
  response: string;
}

export function extractThinking(text: string): SplitThinking {
  let thinking = '';
  let response = text;

  const thinkMatches = text.match(TAG_BLOCK_RE);
  if (thinkMatches) {
    thinking = thinkMatches
      .map(m => m.replace(TAG_OPEN_OR_CLOSE_RE, '').trim())
      .join('\n\n');
    response = text.replace(TAG_BLOCK_RE, '').trim();
  }

  // Still-streaming block with no closing tag yet.
  const unclosed = response.match(TAG_UNCLOSED_RE);
  if (unclosed) {
    thinking += (thinking ? '\n\n' : '') + unclosed[1].trim();
    response = response.replace(TAG_UNCLOSED_RE, '').trim();
  }

  return { thinking, response };
}
