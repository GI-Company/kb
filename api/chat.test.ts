import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Same trick as services/kernel.test.ts: control exactly how bytes split
// across reader.read() calls, since that split point — not the content —
// is what this bug depends on.
function sseStreamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

async function readNdjson(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split('\n')) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      if (parsed.chunk) full += parsed.chunk;
    }
  }
  return full;
}

describe('api/chat.ts stream forwarding', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GROQ_API_KEY;

  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-key';
    vi.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.GROQ_API_KEY = originalKey;
  });

  it('does not drop the final Groq SSE line when its trailing newline never arrives before stream close', async () => {
    // Mirrors a real Groq SSE stream: each event is "data: {...}\n\n", but
    // the last content delta's newline arrives right at connection close —
    // the exact split that silently dropped reply tails in production.
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: sseStreamFromChunks([
        'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}', // no trailing newline
      ]),
    })) as any;

    const { default: handler } = await import('./chat.js');
    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'agent-chat', message: 'hi', history: [] }),
    });
    const res = await handler(req);
    const full = await readNdjson(res);

    expect(full).toBe('hello world');
  });

  it('still works when every SSE line arrives with its own trailing newline', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: sseStreamFromChunks([
        'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    })) as any;

    const { default: handler } = await import('./chat.js');
    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'agent-chat', message: 'hi', history: [] }),
    });
    const res = await handler(req);
    const full = await readNdjson(res);

    expect(full).toBe('hello world');
  });
});
