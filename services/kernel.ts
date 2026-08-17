import { Envelope } from '../types';
import { DEFAULT_AGENTS } from '../lib/agents';
import { chatStore } from '../lib/chatStore';
import { getDemoPipeline, planGoal, runTaskGraph, TaskNode } from '../lib/taskEngine';
import { supabase } from '../lib/supabaseClient';
import { compileApplet } from '../lib/appletCompiler';

type BusListener = (envelope: Envelope) => void;

/**
 * The Kernel is now a purely client-side Envelope bus — there is no
 * persistent backend process to connect to on Vercel. `publish` /
 * `sendToAgent` / `subscribe` keep the exact same shape the Go-backed
 * version had, so every app (AIChat, Terminal, ...) works unmodified; only
 * the transport changed. A handful of topics that used to hit the Go
 * microkernel are now routed to Vercel functions (`/api/chat`, `/api/exec`)
 * or answered locally from static config; everything else is just
 * broadcast back to local listeners (UI-only echo), matching the graceful
 * "backend offline" fallback the original client already had.
 */
class Kernel {
  private listeners: Set<BusListener> = new Set();
  private clientId: string = `client-${Math.random().toString(36).substring(2, 9)}`;
  private messageLog: Envelope[] = [];
  // In-flight cancellable requests, keyed by _request_id. Ctrl+C in the
  // terminal publishes vm.cancel, which aborts the underlying fetch — the
  // request is genuinely dropped, not merely ignored while it finishes.
  private inflight: Map<string, AbortController> = new Map();

  // Always true: there's nothing to connect/reconnect to anymore. Kept so
  // callers that still check `kernel.isLive` (or guard on `kernel.socket`)
  // keep working without modification.
  public isLive: boolean = true;

  constructor() {
    setTimeout(() => {
      this.broadcast({ topic: 'system.connect', from: 'kernel', payload: { status: 'connected' }, time: now() });
    }, 0);
  }

  public getClientId() { return this.clientId; }

  public subscribe(listener: BusListener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  public publish(topic: string, payload: any) {
    const envelope: Envelope = { topic, from: this.clientId, payload, time: now() };
    this.log(envelope);
    this.route(envelope);
  }

  public sendToAgent(agentId: string, topic: string, payload: any) {
    const envelope: Envelope = { topic, from: this.clientId, to: agentId, payload, time: now() };
    this.log(envelope);
    this.route(envelope);
  }

  public getTrafficLog() { return this.messageLog; }

  // Legacy no-op — some callers guard on `(kernel as any).socket` before
  // using it directly; leaving this undefined means those guards just
  // short-circuit rather than throwing.
  public getSocket(): null { return null; }

  private log(envelope: Envelope) {
    this.messageLog = [envelope, ...this.messageLog].slice(0, 200);
  }

  private broadcast(envelope: Envelope) {
    this.log(envelope);
    this.notify(envelope);
  }

  /** Delivers to subscribers without logging — for envelopes publish()/sendToAgent() already logged. */
  private notify(envelope: Envelope) {
    this.listeners.forEach(l => l(envelope));
  }

  // ── Routing ──────────────────────────────────────────────────────────

  private route(env: Envelope) {
    // Subscribers see outgoing envelopes too, not just the responses they
    // produce. Previously anything with a handler below returned before
    // reaching the catch-all broadcast, so `agent.chat`, `ai.chat`,
    // `vm.spawn` and `task.run` were visible in getTrafficLog() but never
    // delivered live to a subscriber — which made "who asked for this?"
    // underivable from the bus (apps/AgentMonitor.tsx needs exactly that,
    // and apps/TimelineSlider.tsx already listed vm.spawn as a tracked
    // topic that could never actually fire). Nothing else keys off these
    // request topics, so this only adds visibility.
    this.notify(env);

    if (env.topic === 'agent.roster') return this.handleAgentRoster(env);
    if (env.topic === 'agent.chat' && env.to) return void this.handleAgentChat(env);
    if (env.topic === 'ai.chat') return void this.handleDirectChat(env);
    if (env.topic === 'vm.spawn') return void this.handleExec(env);
    if (env.topic === 'vm.cancel') return this.handleCancel(env);
    if (env.topic === 'vm.render') return void this.handleRender(env);
    if (env.topic === 'sys.terminal.intent') return void this.handleTerminalIntent(env);
    if (env.topic.startsWith('chat.')) return void this.handleChatHistory(env);
    if (env.topic === 'applet.compile') return this.handleAppletCompile(env);
    if (env.topic === 'task.run') return void this.handleTaskRun(env);

    // Everything else (bios.*, p2p.*, pkg.*, vfs:*, sys.ps, editor.typing,
    // terminal.typing, ...) has no backend anymore in v1 — the notify()
    // above already delivered the local echo, so listeners see their own
    // message instead of silently hanging. vfs:read/write/create in
    // particular are handled by lib/vfs.ts directly inside the apps that
    // need them, not over the bus; user preferences that used to ride
    // sys.config:* now live in lib/settings.ts, off the bus entirely.
  }

  private handleAgentRoster(env: Envelope) {
    // Internal personas (the shell translator) are single-purpose prompts
    // the system calls itself, not people to chat with — so they stay out
    // of the roster the UI builds its persona list from.
    const agents = DEFAULT_AGENTS
      .filter(a => !a.internal)
      .map(a => ({ id: a.id, name: a.displayName, model: a.model, role: 'agent' }));
    setTimeout(() => {
      this.broadcast({ topic: 'agent.roster:resp', from: 'kernel', to: env.from, payload: { agents }, time: now() });
    }, 0);
  }

  private async handleAgentChat(env: Envelope) {
    const agentId = env.to!;
    const payload = env.payload as { msg: string; image?: string; history?: { role: 'user' | 'agent'; content: string }[] };

    let full = '';
    let error: string | undefined;
    try {
      const result = await this.streamChatChunks(
        { agentId, message: payload.msg, image: payload.image, history: payload.history || [] },
        (chunk) => this.broadcast({ topic: 'agent.chat:stream', from: agentId, to: this.clientId, payload: { chunk }, time: now() })
      );
      full = result.full;
      error = result.error;
    } catch (err: any) {
      error = err?.message || String(err);
    }

    this.broadcast({
      topic: 'agent.chat:reply',
      from: agentId,
      to: this.clientId,
      payload: { reply: error ? `⚠️ ${error}` : full },
      time: now(),
    });
  }

  /**
   * `ai.chat` — a one-shot prompt with no conversation history, used by
   * AIChat's direct mode and by MultiAgentWorkspace's panes.
   *
   * Two things here are load-bearing for any caller running more than one
   * of these at once:
   *  - `env.to` selects the persona. This used to be hardcoded to
   *    agent-chat, so a workspace fanning one goal out to four specialist
   *    personas silently got four identical answers from the same one.
   *  - `_request_id` is echoed back on every ai.stream/ai.done. Without it
   *    a caller can't tell which of its own in-flight requests a chunk
   *    belongs to, and concurrent requests interleave into one stream.
   * `from` carries the persona too, so subscribers (apps/AgentMonitor.tsx)
   * can attribute activity without parsing the request id.
   */
  private async handleDirectChat(env: Envelope) {
    const payload = env.payload as { _request_id?: string; prompt: string; image?: string };
    const agentId = env.to || 'agent-chat';
    const _request_id = payload._request_id;
    try {
      const { error } = await this.streamChatChunks(
        { agentId, message: payload.prompt, image: payload.image },
        (chunk) => this.broadcast({ topic: 'ai.stream', from: agentId, payload: { _request_id, chunk }, time: now() })
      );
      if (error) {
        this.broadcast({ topic: 'ai.stream', from: agentId, payload: { _request_id, chunk: `⚠️ ${error}`, error }, time: now() });
      }
    } catch (err: any) {
      const message = `Failed to reach the model: ${err?.message || err}`;
      this.broadcast({ topic: 'ai.stream', from: agentId, payload: { _request_id, chunk: `⚠️ ${message}`, error: message }, time: now() });
    } finally {
      this.broadcast({ topic: 'ai.done', from: agentId, payload: { _request_id }, time: now() });
    }
  }

  /** Reads /api/chat's newline-delimited JSON stream, invoking onChunk per token and returning the full accumulated text. */
  private async streamChatChunks(
    requestBody: { agentId: string; message: string; image?: string; history?: { role: 'user' | 'agent'; content: string }[] },
    onChunk: (chunk: string) => void
  ): Promise<{ full: string; error?: string }> {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      return { full: '', error: text || res.statusText };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let error: string | undefined;

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
        if (parsed.chunk) {
          full += parsed.chunk;
          onChunk(parsed.chunk);
        } else if (parsed.error) {
          error = parsed.error;
        }
      }
    }

    // The line left in `buffer` after the loop is real, unprocessed data,
    // not a partial fragment to discard: the server always terminates each
    // JSON object with '\n', but there's no guarantee that trailing newline
    // arrives in the same read() as the JSON before it — read() can end
    // exactly at the object boundary, leaving the last object (sometimes
    // the sentence-ending chunk itself) parked in `buffer` waiting for a
    // read() that never comes because the stream just closed. Dropping it
    // here is what silently truncated replies mid-sentence.
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer);
        if (parsed.chunk) {
          full += parsed.chunk;
          onChunk(parsed.chunk);
        } else if (parsed.error) {
          error = parsed.error;
        }
      } catch { /* genuinely incomplete fragment — nothing left to recover */ }
    }

    return { full, error };
  }

  private async handleExec(env: Envelope) {
    const payload = env.payload as { _request_id?: string; cmd: string; args?: string[] };
    try {
      // Attaches the caller's Supabase access token when a real (non-guest)
      // session exists, so api/exec.ts can gate network commands (curl,
      // dig, ...) to signed-in accounts only — guests still get the
      // existing coreutils-only sandbox with no auth at all, silently.
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (supabase) {
        const { data } = await supabase.auth.getSession();
        if (data.session?.access_token) {
          headers.authorization = `Bearer ${data.session.access_token}`;
        }
      }
      const res = await fetch('/api/exec', {
        method: 'POST',
        headers,
        body: JSON.stringify({ cmd: payload.cmd, args: payload.args || [] }),
        signal: this.register(payload._request_id),
      });
      const data = await res.json();
      if (data.stdout) {
        this.broadcast({ topic: 'vm.stdout', from: 'kernel', to: this.clientId, payload: { _request_id: payload._request_id, text: data.stdout }, time: now() });
      }
      if (data.stderr) {
        this.broadcast({ topic: 'vm.stderr', from: 'kernel', to: this.clientId, payload: { _request_id: payload._request_id, text: data.stderr }, time: now() });
      }
      this.broadcast({ topic: 'vm.exit', from: 'kernel', to: this.clientId, payload: { _request_id: payload._request_id, code: data.code ?? 0 }, time: now() });
    } catch (err: any) {
      // A cancel already reported itself; re-reporting it as a failure to
      // reach the sandbox would be misleading.
      if (err?.name === 'AbortError') return;
      this.broadcast({ topic: 'vm.stderr', from: 'kernel', to: this.clientId, payload: { _request_id: payload._request_id, text: `Failed to reach exec sandbox: ${err?.message || err}\n` }, time: now() });
      this.broadcast({ topic: 'vm.exit', from: 'kernel', to: this.clientId, payload: { _request_id: payload._request_id, code: 1 }, time: now() });
    } finally {
      this.clear(payload._request_id);
    }
  }

  /** Registers a cancellable request and returns the signal to pass to fetch. */
  private register(requestId?: string): AbortSignal | undefined {
    if (!requestId) return undefined;
    const controller = new AbortController();
    this.inflight.set(requestId, controller);
    return controller.signal;
  }

  private clear(requestId?: string) {
    if (requestId) this.inflight.delete(requestId);
  }

  /**
   * Ctrl+C. Aborts the fetch and reports the interrupt itself, so the
   * caller's exit handling runs exactly once rather than racing the
   * request's own error path.
   */
  private handleCancel(env: Envelope) {
    const { _request_id } = env.payload as { _request_id?: string };
    if (!_request_id) return;
    const controller = this.inflight.get(_request_id);
    if (!controller) return;
    controller.abort();
    this.inflight.delete(_request_id);
    this.broadcast({ topic: 'vm.stderr', from: 'kernel', to: this.clientId, payload: { _request_id, text: '^C\n' }, time: now() });
    // 130 is the conventional shell exit code for SIGINT.
    this.broadcast({ topic: 'vm.exit', from: 'kernel', to: this.clientId, payload: { _request_id, code: 130 }, time: now() });
  }

  /** Terminal's `render <url> [--screenshot]` — a real headless-browser page load, separate endpoint from vm.spawn/api/exec.ts since it needs a much longer budget (see api/browser-render.ts). Screenshot results go out as a distinct 'vm.render:image' topic since vm.stdout is plain text — Terminal.tsx renders that one specially instead of as terminal text. */
  private async handleRender(env: Envelope) {
    const payload = env.payload as { _request_id?: string; url: string; mode?: 'text' | 'screenshot' };
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (supabase) {
        const { data } = await supabase.auth.getSession();
        if (data.session?.access_token) {
          headers.authorization = `Bearer ${data.session.access_token}`;
        }
      }
      const res = await fetch('/api/browser-render', {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: payload.url, mode: payload.mode || 'text' }),
        signal: this.register(payload._request_id),
      });
      const data = await res.json();

      if (data.stderr) {
        this.broadcast({ topic: 'vm.stderr', from: 'kernel', to: this.clientId, payload: { _request_id: payload._request_id, text: data.stderr }, time: now() });
      } else if (data.screenshot) {
        this.broadcast({ topic: 'vm.stdout', from: 'kernel', to: this.clientId, payload: { _request_id: payload._request_id, text: `${data.title || payload.url}\n` }, time: now() });
        this.broadcast({ topic: 'vm.render:image', from: 'kernel', to: this.clientId, payload: { _request_id: payload._request_id, dataUrl: `data:image/png;base64,${data.screenshot}` }, time: now() });
      } else if (data.text !== undefined) {
        this.broadcast({ topic: 'vm.stdout', from: 'kernel', to: this.clientId, payload: { _request_id: payload._request_id, text: `${data.title ? data.title + '\n\n' : ''}${data.text}\n` }, time: now() });
      }
      this.broadcast({ topic: 'vm.exit', from: 'kernel', to: this.clientId, payload: { _request_id: payload._request_id, code: data.code ?? 0 }, time: now() });
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      this.broadcast({ topic: 'vm.stderr', from: 'kernel', to: this.clientId, payload: { _request_id: payload._request_id, text: `Failed to reach render service: ${err?.message || err}\n` }, time: now() });
      this.broadcast({ topic: 'vm.exit', from: 'kernel', to: this.clientId, payload: { _request_id: payload._request_id, code: 1 }, time: now() });
    } finally {
      this.clear(payload._request_id);
    }
  }

  private async handleTerminalIntent(env: Envelope) {
    const payload = env.payload as { intent: string };
    try {
      const { full } = await this.streamChatChunks(
        // agent-shell, not agent-dispatcher: the Dispatcher's prompt permits
        // only a JSON plan or a ```tool fence, so it could never answer with
        // a command line. See lib/agents.ts.
        { agentId: 'agent-shell', message: payload.intent },
        () => {}
      );
      const command = extractCommand(full);
      if (command) {
        this.broadcast({ topic: 'sys.terminal.intent:ack', from: 'kernel', payload: { command }, time: now() });
      } else {
        this.broadcast({
          topic: 'sys.terminal.intent:ack',
          from: 'kernel',
          payload: { error: `No command here does that. Type "help" to see what this shell can do.` },
          time: now(),
        });
      }
    } catch {
      // No translation this time — Terminal.tsx simply won't show one.
    }
  }

  /** DAG task execution — see lib/taskEngine.ts. Supports an explicit `nodes` array, a natural-language `goal` (planned via the Dispatcher persona), or the graphId "build-pipeline" demo, matching the three modes TaskRunner.tsx's UI offers. */
  private async handleTaskRun(env: Envelope) {
    const payload = env.payload as { graphId?: string; goal?: string; nodes?: TaskNode[] };
    const runId = payload.graphId || `run-${Date.now()}`;

    this.broadcast({ topic: 'task.run:ack', from: 'kernel', payload: { runId }, time: now() });

    let nodes: TaskNode[];
    try {
      if (payload.nodes) {
        nodes = payload.nodes;
      } else if (payload.goal) {
        nodes = await planGoal(payload.goal);
      } else if (payload.graphId === 'build-pipeline') {
        nodes = getDemoPipeline();
      } else {
        nodes = [];
      }
    } catch (err: any) {
      this.broadcast({
        topic: 'task.event',
        from: 'kernel',
        payload: { runId, step: 'plan', status: 'failed', progress: 100, output: err?.message || String(err) },
        time: now(),
      });
      this.broadcast({ topic: 'task.done', from: 'kernel', payload: { runId }, time: now() });
      return;
    }

    if (nodes.length > 0) {
      await runTaskGraph(runId, nodes, event => {
        this.broadcast({ topic: 'task.event', from: 'kernel', payload: event, time: now() });
      });
    }

    this.broadcast({ topic: 'task.done', from: 'kernel', payload: { runId }, time: now() });
  }

  // Compiles entirely client-side (lib/appletCompiler.ts, Sucrase) — no
  // server round-trip, matching the original Go backend's applet_engine.go
  // in spirit (dynamic TSX -> runnable component) but running in-browser.
  // Success/error topics match what Editor.tsx (and now CDE.tsx) already
  // listen for.
  private handleAppletCompile(env: Envelope) {
    const payload = env.payload as { appletId?: string; code?: string };
    setTimeout(() => {
      try {
        const { code } = compileApplet(payload.code || '');
        this.broadcast({
          topic: 'applet.compile:success',
          from: 'kernel',
          payload: { appletId: payload.appletId, code },
          time: now(),
        });
      } catch (err: any) {
        this.broadcast({
          topic: 'applet.compile:error',
          from: 'kernel',
          payload: { appletId: payload.appletId, error: err?.message || String(err) },
          time: now(),
        });
      }
    }, 0);
  }

  private async handleChatHistory(env: Envelope) {
    const payload = env.payload as any;
    try {
      switch (env.topic) {
        case 'chat.list': {
          const conversations = await chatStore.list(payload.user_id);
          this.broadcast({ topic: 'chat.list:resp', from: 'kernel', payload: { conversations }, time: now() });
          break;
        }
        case 'chat.save': {
          await chatStore.save(payload);
          this.broadcast({ topic: 'chat.save:resp', from: 'kernel', payload: { id: payload.id }, time: now() });
          break;
        }
        case 'chat.load': {
          const conv = await chatStore.load(payload.id, payload.user_id);
          this.broadcast({ topic: 'chat.load:resp', from: 'kernel', payload: conv || {}, time: now() });
          break;
        }
        case 'chat.delete': {
          await chatStore.delete(payload.id, payload.user_id);
          this.broadcast({ topic: 'chat.delete:resp', from: 'kernel', payload: { id: payload.id }, time: now() });
          break;
        }
      }
    } catch (err: any) {
      this.broadcast({ topic: 'sys.notify:toast', from: 'kernel', payload: { message: `Chat history error: ${err?.message || err}` }, time: now() });
    }
  }
}

function now() { return new Date().toISOString(); }

/** Commands a translation is allowed to produce. See handleTerminalIntent. */
const TRANSLATABLE = new Set([
  'ls', 'cat', 'cd', 'pwd', 'mkdir', 'touch', 'write', 'rm', 'mv', 'cp',
  'grep', 'wc', 'head', 'tail', 'sort', 'uniq', 'echo', 'cut', 'sed', 'awk',
  'tr', 'diff', 'stat', 'python', 'python3', 'pip', 'curl', 'dig', 'ping',
  'render', 'date', 'whoami', 'uname', 'id', 'env', 'df', 'du',
]);

/**
 * Pulls a runnable command line out of a chat reply.
 *
 * The old version took the first non-empty line and stripped backticks off
 * it, which turned a fenced reply's opening ```tool into the command
 * `tool` — the model was answering in its tool-call format and the parser
 * handed the fence language to the shell. Fence lines are now skipped
 * rather than unwrapped, and the result is checked against the commands
 * this shell actually has, so a confident wrong answer fails here instead
 * of at the allowlist with a permission error that blames the user.
 */
export function extractCommand(reply: string): string | null {
  const line = reply
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0 && !l.startsWith('```') && !l.startsWith('#'));
  if (!line || line === 'UNSUPPORTED') return null;

  // Inline single-backtick wrapping is still unwrapped: `ls -la` is a
  // command, unlike a fence line, which is a delimiter.
  const command = line.replace(/^`|`$/g, '').trim();
  const head = command.split(/\s+/)[0];
  return TRANSLATABLE.has(head) ? command : null;
}

export const kernel = new Kernel();
