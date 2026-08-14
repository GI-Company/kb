// Groq-backed chat endpoint — replaces server/embedded_agents.go's calls to a
// locally-hosted LM Studio server. Runs on Vercel's Edge Runtime for low
// latency streaming. GROQ_API_KEY never leaves this function.
//
// Request:  POST { agentId?, message, image?, history? }
// Response: newline-delimited JSON stream of { chunk } objects, terminated
// by a final { done: true } (or { error } on failure). Kept deliberately
// simple (not raw SSE) so the client doesn't need to know Groq's wire format.

import { getAgentById, DEFAULT_AGENTS } from '../lib/agents';
import { checkRateLimit, getClientIp, rateLimitResponseHeaders } from '../lib/rateLimit';

export const config = { runtime: 'edge' };

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_CHAT_PER_MIN) || 20;

interface ChatRequestBody {
  agentId?: string;
  message: string;
  image?: string; // base64, with or without a data: prefix
  history?: { role: 'user' | 'agent'; content: string }[];
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return jsonError(500, 'GROQ_API_KEY is not configured on the server. Set it in your Vercel project env vars.');
  }

  const rl = checkRateLimit(`chat:${getClientIp(req)}`, RATE_LIMIT_PER_MIN);
  if (!rl.allowed) {
    return jsonError(429, `Rate limit exceeded (${RATE_LIMIT_PER_MIN}/min). Try again shortly.`, rateLimitResponseHeaders(rl));
  }

  let body: ChatRequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'Invalid JSON body');
  }

  const { agentId, message, image, history = [] } = body;
  if (!message || typeof message !== 'string') {
    return jsonError(400, 'Missing "message"');
  }

  const persona = (agentId && getAgentById(agentId)) || DEFAULT_AGENTS.find(a => a.id === 'agent-chat')!;

  const messages: Array<{ role: string; content: unknown }> = [
    { role: 'system', content: persona.systemPrompt },
  ];

  // Sliding window, same shape as the original Go agent's history trimming.
  for (const turn of history.slice(-10)) {
    messages.push({ role: turn.role === 'user' ? 'user' : 'assistant', content: turn.content });
  }

  if (image) {
    const dataUrl = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: message },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    });
  } else {
    messages.push({ role: 'user', content: message });
  }

  // process.env.GROQ_MODEL, when set, is a global override (forces every
  // persona to one model — useful for testing/debugging a specific model).
  // Otherwise each persona routes to the model picked for its job (see
  // lib/agents.ts's routing rationale).
  const envOverride = process.env.GROQ_MODEL;
  const model = envOverride || persona.model || DEFAULT_MODEL;

  const callGroq = (modelId: string) =>
    fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: modelId, messages, stream: true }),
    });

  let usedModel = model;
  let groqResp: Response;
  try {
    groqResp = await callGroq(model);
  } catch (err: any) {
    return jsonError(502, `Failed to reach Groq: ${err?.message || err}`);
  }

  // Rate-limited on the primary model — spread load onto the persona's
  // fallback rather than failing outright. Skipped when GROQ_MODEL is an
  // explicit override, since that's a deliberate single-model choice.
  if (groqResp.status === 429 && !envOverride && persona.fallbackModel) {
    usedModel = persona.fallbackModel;
    try {
      groqResp = await callGroq(usedModel);
    } catch (err: any) {
      return jsonError(502, `Failed to reach Groq: ${err?.message || err}`);
    }
  }

  if (!groqResp.ok || !groqResp.body) {
    const errText = await groqResp.text().catch(() => '');
    return jsonError(502, `Groq API error (${groqResp.status}) using model ${usedModel}: ${errText}`);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = groqResp.body!.getReader();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                controller.enqueue(encoder.encode(JSON.stringify({ chunk: delta }) + '\n'));
              }
            } catch {
              // Malformed/partial SSE line — skip it.
            }
          }
        }
      } catch (err: any) {
        controller.enqueue(encoder.encode(JSON.stringify({ error: err?.message || 'stream error' }) + '\n'));
      } finally {
        controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + '\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
    },
  });
}

function jsonError(status: number, message: string, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}
