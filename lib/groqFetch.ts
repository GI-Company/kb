// One-off calls to /api/chat for callers that just want the full
// accumulated text and aren't rendering a live streaming chat thread
// (dataset generation, goal-to-DAG planning). AIChat.tsx and kernel.ts's
// agent.chat handling have their own streaming consumers since they need
// to render token-by-token; this is for everything else.

export async function fetchGroqText(agentId: string, message: string): Promise<string> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId, message }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(text || res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: any;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed.error) throw new Error(parsed.error);
      if (parsed.chunk) full += parsed.chunk;
    }
  }

  return full.trim();
}
