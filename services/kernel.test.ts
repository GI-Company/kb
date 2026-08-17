import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A ReadableStream whose reader.read() calls are exactly the sequence
// passed in — lets a test control precisely how bytes get split across
// read() calls, which is what this bug actually depends on (the split
// point relative to the trailing '\n', not the content itself).
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
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

describe('Kernel.streamChatChunks (via sendToAgent agent.chat)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('does not drop the final chunk when its trailing newline never arrives in its own read()', async () => {
    // The bug: a real /api/chat response ends each JSON line with '\n', but
    // there's no guarantee the browser's stream reader delivers that '\n'
    // in the same read() as the JSON before it. If the LAST content chunk
    // arrives without its newline, and the very next read() reports the
    // stream closed, the unflushed line used to be silently dropped.
    global.fetch = vi.fn(async () => ({
      ok: true,
      body: streamFromChunks([
        '{"chunk":"hello "}\n',
        '{"chunk":"world"}', // no trailing '\n' — arrives right at stream end
      ]),
    })) as any;

    const { kernel } = await import('./kernel');
    const replies: string[] = [];
    const unsubscribe = kernel.subscribe((env) => {
      if (env.topic === 'agent.chat:reply') replies.push(env.payload.reply);
    });

    kernel.sendToAgent('agent-chat', 'agent.chat', { msg: 'hi', history: [] });

    // handleAgentChat's fetch + stream-read is async; wait for the reply.
    await vi.waitFor(() => expect(replies.length).toBe(1));
    unsubscribe();

    expect(replies[0]).toBe('hello world');
  });

  it('still works when every line arrives with its own trailing newline', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      body: streamFromChunks(['{"chunk":"hello "}\n', '{"chunk":"world"}\n', '{"done":true}\n']),
    })) as any;

    const { kernel } = await import('./kernel');
    const replies: string[] = [];
    const unsubscribe = kernel.subscribe((env) => {
      if (env.topic === 'agent.chat:reply') replies.push(env.payload.reply);
    });

    kernel.sendToAgent('agent-chat', 'agent.chat', { msg: 'hi', history: [] });
    await vi.waitFor(() => expect(replies.length).toBe(1));
    unsubscribe();

    expect(replies[0]).toBe('hello world');
  });
});
