import { Envelope } from '../types';
import { DEFAULT_AGENTS } from '../lib/agents';
import { chatStore } from '../lib/chatStore';
import { getDemoPipeline, planGoal, runTaskGraph, TaskNode } from '../lib/taskEngine';

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
    this.listeners.forEach(l => l(envelope));
  }

  // ── Routing ──────────────────────────────────────────────────────────

  private route(env: Envelope) {
    if (env.topic === 'agent.roster') return this.handleAgentRoster(env);
    if (env.topic === 'agent.chat' && env.to) return void this.handleAgentChat(env);
    if (env.topic === 'ai.chat') return void this.handleDirectChat(env);
    if (env.topic === 'vm.spawn') return void this.handleExec(env);
    if (env.topic === 'terminal.check_shadow') return this.handleShadowCheck(env);
    if (env.topic === 'sys.terminal.intent') return void this.handleTerminalIntent(env);
    if (env.topic.startsWith('chat.')) return void this.handleChatHistory(env);
    if (env.topic === 'applet.compile') return this.handleAppletCompile(env);
    if (env.topic === 'task.run') return void this.handleTaskRun(env);

    // Everything else (bios.*, p2p.*, pkg.*, vfs:*, sys.config:*, sys.ps,
    // editor.typing, terminal.typing, ...) has no backend anymore in v1 —
    // broadcast locally so listeners still see their own echo instead of
    // silently hanging. vfs:read/write/create in particular are handled by
    // lib/vfs.ts directly inside the apps that need them, not over the bus.
    this.broadcast(env);
  }

  private handleAgentRoster(env: Envelope) {
    const agents = DEFAULT_AGENTS.map(a => ({ id: a.id, name: a.displayName, model: a.model, role: 'agent' }));
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

  private async handleDirectChat(env: Envelope) {
    const payload = env.payload as { prompt: string; image?: string };
    try {
      const { error } = await this.streamChatChunks(
        { agentId: 'agent-chat', message: payload.prompt, image: payload.image },
        (chunk) => this.broadcast({ topic: 'ai.stream', from: 'kernel', payload: { chunk }, time: now() })
      );
      if (error) {
        this.broadcast({ topic: 'ai.stream', from: 'kernel', payload: { chunk: `⚠️ ${error}` }, time: now() });
      }
    } catch (err: any) {
      this.broadcast({ topic: 'ai.stream', from: 'kernel', payload: { chunk: `⚠️ Failed to reach the model: ${err?.message || err}` }, time: now() });
    } finally {
      this.broadcast({ topic: 'ai.done', from: 'kernel', payload: {}, time: now() });
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

    return { full, error };
  }

  private async handleExec(env: Envelope) {
    const payload = env.payload as { _request_id?: string; cmd: string; args?: string[] };
    try {
      const res = await fetch('/api/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmd: payload.cmd, args: payload.args || [] }),
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
      this.broadcast({ topic: 'vm.stderr', from: 'kernel', to: this.clientId, payload: { _request_id: payload._request_id, text: `Failed to reach exec sandbox: ${err?.message || err}\n` }, time: now() });
      this.broadcast({ topic: 'vm.exit', from: 'kernel', to: this.clientId, payload: { _request_id: payload._request_id, code: 1 }, time: now() });
    }
  }

  private handleShadowCheck(env: Envelope) {
    // No speculative-execution engine in this build (see plan v1 cuts) —
    // always report a miss, which is exactly what makes Terminal.tsx fall
    // through to a normal `vm.spawn`.
    const payload = env.payload as { command: string };
    setTimeout(() => {
      this.broadcast({ topic: 'terminal.shadow:miss', from: 'kernel', payload: { command: payload.command }, time: now() });
    }, 0);
  }

  private async handleTerminalIntent(env: Envelope) {
    const payload = env.payload as { intent: string };
    const instruction = `Translate this into a single shell command using only common Unix commands, nothing else, no explanation, no markdown — just the raw command on one line: ${payload.intent}`;
    try {
      const { full } = await this.streamChatChunks({ agentId: 'agent-dispatcher', message: instruction }, () => {});
      const command = full.split('\n').map(l => l.trim().replace(/^`+|`+$/g, '')).find(l => l.length > 0);
      if (command) {
        this.broadcast({ topic: 'sys.terminal.intent:ack', from: 'kernel', payload: { command }, time: now() });
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

  private handleAppletCompile(env: Envelope) {
    // The dynamic TSX->JS applet compiler lived in the Go backend
    // (applet_engine.go) and has no client-side equivalent in this build —
    // fail fast with a clear error instead of leaving callers (Editor.tsx's
    // "Launch Applet", Desktop.tsx's shortcut launcher) spinning forever.
    const payload = env.payload as { appletId?: string };
    setTimeout(() => {
      this.broadcast({
        topic: 'applet.compile:error',
        from: 'kernel',
        payload: { appletId: payload.appletId, error: 'Dynamic applet compilation is not available in this build (no server-side compiler).' },
        time: now(),
      });
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

export const kernel = new Kernel();
