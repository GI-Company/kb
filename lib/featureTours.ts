export interface TourStep {
  selector: string;
  title: string;
  description: string;
}

// Keyed by WindowState['appId']. Only apps with an entry here get a "?"
// tour button in their window title bar (see components/ui/Window.tsx).
// Selectors target data-tour="..." attributes added directly in each app
// file, kept stable and independent of styling classes.
export const FEATURE_TOURS: Record<string, TourStep[]> = {
  'ai-chat': [
    {
      selector: '[data-tour="chat-new"]',
      title: 'Start a fresh conversation',
      description: 'Clears the thread and gives you a new, separately-saved chat. Old ones stay in history.',
    },
    {
      selector: '[data-tour="chat-history"]',
      title: 'Chat history',
      description: 'Every conversation auto-saves as you go. Click here to browse, reopen, or delete past chats.',
    },
    {
      selector: '[data-tour="chat-agent-selector"]',
      title: 'Pick your agent',
      description: 'Six Groq-backed personas, each routed to a model suited to its job — Dispatcher, Architect, DevOps, Security, Code Review, and the general Kernos Assistant.',
    },
    {
      selector: '[data-tour="chat-image"]',
      title: 'Attach an image',
      description: 'Drop in a screenshot or photo and ask a vision-capable agent about it.',
    },
    {
      selector: '[data-tour="chat-input"]',
      title: 'Train or run your local model from here too',
      description: 'Ask an agent to "train a tiny model on this text" or "generate from my model" — it can call your in-browser BNLM model as a tool, right in this thread.',
    },
  ],
  'local-model': [
    {
      selector: '[data-tour="lm-dataset"]',
      title: 'Generate a training set',
      description: 'No corpus handy? Ask Groq to write one on any topic, then review and tweak it before training.',
    },
    {
      selector: '[data-tour="lm-corpus"]',
      title: 'Training text',
      description: 'The raw text your model learns from — paste your own or use the generated one above.',
    },
    {
      selector: '[data-tour="lm-config"]',
      title: 'Model shape',
      description: 'Dimensions, layers, heads, context length, and the mixer type (attention / linear / rwkv) — all tunable before you initialize.',
    },
    {
      selector: '[data-tour="lm-init"]',
      title: 'Initialize',
      description: 'Builds a fresh model from your current config and corpus. Do this first, and again any time you change the shape.',
    },
    {
      selector: '[data-tour="lm-train"]',
      title: 'Train',
      description: 'Runs real gradient steps, entirely in this browser tab — optionally spread across multiple workers. Watch the loss sparkline update live.',
    },
    {
      selector: '[data-tour="lm-generate"]',
      title: 'Generate',
      description: 'Sample text from your trained model given a prompt.',
    },
    {
      selector: '[data-tour="lm-score"]',
      title: 'Score',
      description: "Beyond generation — check how well a piece of text fits what the model learned (loss and perplexity), without sampling anything new.",
    },
    {
      selector: '[data-tour="lm-saved"]',
      title: 'Save and reuse',
      description: 'Name and save a trained model to reload later — or hand off to an agent in AI Chat via the bnlm.* tools.',
    },
  ],
  'terminal': [
    {
      selector: '[data-tour="terminal-input"]',
      title: 'Real, sandboxed commands',
      description: 'Runs real, ephemeral, allowlisted shell commands — nothing persists between calls.',
    },
    {
      selector: '[data-tour="terminal-input"]',
      title: 'Natural language shell',
      description: 'Prefix with "?" — e.g. "? show large files" — and it\'ll be translated into a real command and run automatically.',
    },
    {
      selector: '[data-tour="terminal-input"]',
      title: 'Real network access, for signed-in accounts',
      description: 'curl, dig, ping, and render (a real headless-browser page load, optionally as a screenshot) — sign in to unlock these; guests keep the sandboxed commands only.',
    },
  ],
  'files': [
    {
      selector: '[data-tour="fs-toolbar"]',
      title: 'File toolbar',
      description: 'Create files/folders, rename, delete, and refresh — select an item first for rename/delete.',
    },
    {
      selector: '[data-tour="fs-grid"]',
      title: 'Your browser-native filesystem',
      description: 'Double-click a folder to open it, or a file to edit it. Everything lives in this browser — nothing leaves unless you send it somewhere yourself.',
    },
  ],
  'cde': [
    {
      selector: '[data-tour="cde-explorer"]',
      title: 'Explorer',
      description: 'Same files as the File System app, browsable and editable right here.',
    },
    {
      selector: '[data-tour="cde-ai-review"]',
      title: 'AI code review',
      description: 'Sends the open file to the Code Review agent for a concise pass on bugs, performance, and best practices.',
    },
    {
      selector: '[data-tour="cde-terminal-toggle"]',
      title: 'Integrated terminal',
      description: 'The same sandboxed exec as the Terminal app, docked right into the IDE.',
    },
    {
      selector: '[data-tour="cde-editor"]',
      title: 'Editor',
      description: '⌘S to save, ⌘F to find. Open a file from the Explorer to get started.',
    },
  ],
};
