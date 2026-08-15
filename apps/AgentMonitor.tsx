// Live view of the six Groq-backed personas and what they're actually
// doing. The previous version of this file listened for `sys.client_list`
// (a roster the Go microkernel used to push) and pinged agents over an
// `agent.ping`/`agent.pong` protocol — neither exists on this
// architecture, so it permanently showed "No agents connected" under an
// empty state telling the user to run `go run scripts/agent_configs.go`,
// a script from a backend this build doesn't have.
//
// Agents here aren't processes that connect or disconnect: they're system
// prompts in lib/agents.ts routed to Groq models (see that file's routing
// table). So the roster is static and always "configured", and the live
// part is activity — derived entirely from bus traffic that already flows:
//
//   agent.chat        (env.to)   a request going out to a persona
//   agent.chat:stream (env.from) tokens streaming back
//   agent.chat:reply  (env.from) final reply — an error if it starts "⚠️"
//   agent.tool:*      (payload)  tool invocations (see apps/AIChat.tsx)
//
// Direct mode (ai.chat/ai.stream/ai.done) always goes to agent-chat, which
// kernel.ts's handleDirectChat hardcodes, so it's attributed there.

import React, { useEffect, useRef, useState } from 'react';
import { kernel } from '../services/kernel';
import { Envelope } from '../types';
import { DEFAULT_AGENTS } from '../lib/agents';
import { Bot, Zap, Clock, Radio, Send, Wrench, AlertTriangle, Loader2, Activity } from 'lucide-react';

type AgentStatus = 'idle' | 'streaming' | 'error';

interface AgentActivity {
  status: AgentStatus;
  lastSeen?: number;
  requests: number;
  replies: number;
  errors: number;
  toolCalls: number;
  charsStreamed: number;
  lastReply?: string;
  lastError?: string;
  lastTool?: string;
  /** Set when a request goes out, cleared on reply — used for round-trip latency. */
  pendingSince?: number;
  lastLatencyMs?: number;
}

interface FeedEntry {
  id: string;
  time: string;
  agentId: string;
  kind: 'request' | 'reply' | 'tool' | 'error';
  detail: string;
}

const EMPTY: AgentActivity = { status: 'idle', requests: 0, replies: 0, errors: 0, toolCalls: 0, charsStreamed: 0 };

const KIND_STYLE: Record<FeedEntry['kind'], { color: string; icon: React.ReactNode }> = {
  request: { color: 'text-cyan-400', icon: <Send size={9} /> },
  reply: { color: 'text-green-400', icon: <Bot size={9} /> },
  tool: { color: 'text-purple-400', icon: <Wrench size={9} /> },
  error: { color: 'text-red-400', icon: <AlertTriangle size={9} /> },
};

function timeSince(ts?: number): string {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export const AgentMonitorApp: React.FC = () => {
  const [activity, setActivity] = useState<Record<string, AgentActivity>>({});
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  // Re-render on a timer purely so the "last seen" relative labels stay
  // accurate while nothing is happening on the bus.
  const [, setTick] = useState(0);
  const activityRef = useRef<Record<string, AgentActivity>>({});

  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    // Buffers so the initial replay below can fold the whole backlog and
    // commit once, instead of one setState per historical envelope.
    let pendingFeed: FeedEntry[] = [];
    let live = false;

    // Cleared per effect run, not just on first mount: React 18 StrictMode
    // invokes this effect twice in development, and a ref (unlike state)
    // survives between the two runs — so without this reset the replay
    // below folds the same backlog into the same accumulator twice and
    // every counter reads double.
    activityRef.current = {};

    const update = (agentId: string, fn: (a: AgentActivity) => AgentActivity, at: number) => {
      const current = activityRef.current[agentId] || EMPTY;
      const next = { ...fn(current), lastSeen: at };
      activityRef.current = { ...activityRef.current, [agentId]: next };
      if (live) setActivity(activityRef.current);
    };

    const pushFeed = (agentId: string, kind: FeedEntry['kind'], detail: string, at: number) => {
      const entry: FeedEntry = {
        id: `${at}-${Math.random().toString(36).slice(2, 7)}`,
        time: new Date(at).toLocaleTimeString(),
        agentId,
        kind,
        detail,
      };
      if (live) setFeed(prev => [entry, ...prev].slice(0, 40));
      else pendingFeed = [entry, ...pendingFeed];
    };

    const handle = (env: Envelope) => {
      const p = env.payload as any;
      // Envelopes carry an ISO timestamp, so replayed history keeps its
      // original times instead of all appearing to have happened at mount.
      const at = Date.parse(env.time) || Date.now();

      // Outgoing request — `to` carries the target persona.
      if (env.topic === 'agent.chat' && env.to) {
        update(env.to, a => ({ ...a, status: 'streaming', requests: a.requests + 1, pendingSince: at }), at);
        pushFeed(env.to, 'request', String(p?.msg ?? '').slice(0, 70) || '(no text)', at);
      }

      // ai.chat carries its target in `to` when one was named (that's how
      // MultiAgentWorkspace addresses a specific persona); AIChat's direct
      // mode omits it, which kernel.ts resolves to agent-chat.
      if (env.topic === 'ai.chat') {
        const target = env.to || 'agent-chat';
        update(target, a => ({ ...a, status: 'streaming', requests: a.requests + 1, pendingSince: at }), at);
        pushFeed(target, 'request', String(p?.prompt ?? '').slice(0, 70) || '(no text)', at);
      }

      if (env.topic === 'agent.chat:stream' && env.from) {
        const chunk = String(p?.chunk ?? '');
        update(env.from, a => ({ ...a, status: 'streaming', charsStreamed: a.charsStreamed + chunk.length }), at);
      }

      // kernel.ts sets `from` to the persona that produced the chunk, so
      // concurrent requests to different personas (MultiAgentWorkspace) are
      // attributed correctly instead of all landing on agent-chat.
      if (env.topic === 'ai.stream' && env.from) {
        const chunk = String(p?.chunk ?? '');
        update(env.from, a => ({ ...a, status: 'streaming', charsStreamed: a.charsStreamed + chunk.length }), at);
      }

      if (env.topic === 'agent.chat:reply' && env.from) {
        const reply = String(p?.reply ?? '');
        // kernel.ts's handleAgentChat prefixes failures with "⚠️" rather
        // than emitting a distinct topic, so that prefix is the only
        // available error signal on this path.
        const failed = reply.startsWith('⚠️');
        update(env.from, a => ({
          ...a,
          status: failed ? 'error' : 'idle',
          replies: a.replies + 1,
          errors: failed ? a.errors + 1 : a.errors,
          lastReply: failed ? a.lastReply : reply.slice(0, 120),
          lastError: failed ? reply.replace(/^⚠️\s*/, '').slice(0, 120) : a.lastError,
          pendingSince: undefined,
          lastLatencyMs: a.pendingSince ? at - a.pendingSince : a.lastLatencyMs,
        }), at);
        pushFeed(env.from, failed ? 'error' : 'reply', reply.replace(/^⚠️\s*/, '').slice(0, 70), at);
      }

      if (env.topic === 'ai.done' && env.from) {
        update(env.from, a => ({
          ...a,
          status: 'idle',
          replies: a.replies + 1,
          pendingSince: undefined,
          lastLatencyMs: a.pendingSince ? at - a.pendingSince : a.lastLatencyMs,
        }), at);
      }

      if (env.topic === 'agent.tool:start' && p?.agentId) {
        update(p.agentId, a => ({ ...a, toolCalls: a.toolCalls + 1, lastTool: p.tool }), at);
        pushFeed(p.agentId, 'tool', `${p.tool} started`, at);
      }
      if (env.topic === 'agent.tool:done' && p?.agentId) {
        pushFeed(p.agentId, 'tool', `${p.tool} completed`, at);
      }
      if (env.topic === 'agent.tool:error' && p?.agentId) {
        update(p.agentId, a => ({ ...a, errors: a.errors + 1, lastError: String(p.error ?? '').slice(0, 120) }), at);
        pushFeed(p.agentId, 'error', `${p.tool}: ${String(p.error ?? '').slice(0, 55)}`, at);
      }
    };

    // Replay what already happened before this window opened — the kernel
    // keeps the last 200 envelopes, and without this the panel would look
    // empty after any activity the user triggered before opening it.
    // getTrafficLog() is newest-first, so walk it in reverse for
    // chronological order.
    kernel.getTrafficLog().slice().reverse().forEach(handle);
    // Anything still streaming when the log was captured is stale by now.
    Object.keys(activityRef.current).forEach(id => {
      if (activityRef.current[id].status === 'streaming') {
        activityRef.current[id] = { ...activityRef.current[id], status: 'idle', pendingSince: undefined };
      }
    });
    setActivity({ ...activityRef.current });
    setFeed(pendingFeed.slice(0, 40));

    live = true;
    return kernel.subscribe(handle);
  }, []);

  const allActivity: AgentActivity[] = Object.values(activity);
  const totalRequests = allActivity.reduce((s, a) => s + a.requests, 0);
  const activeCount = allActivity.filter(a => a.status === 'streaming').length;

  return (
    <div className="h-full flex flex-col bg-[#0c0c10] text-gray-300 font-mono text-xs">
      <div className="p-4 border-b border-white/5 bg-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-green-400" />
          <span className="text-sm font-bold text-white font-sans">Agent Monitor</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/5 border border-white/5">
            <Radio size={10} className={activeCount > 0 ? 'text-green-400 animate-pulse' : 'text-gray-600'} />
            <span className="text-[10px] text-gray-400 uppercase tracking-wider">
              {DEFAULT_AGENTS.length} configured
            </span>
          </div>
          <div className="px-2 py-1 rounded bg-white/5 border border-white/5 text-[10px] text-gray-400 uppercase tracking-wider">
            {totalRequests} req
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {DEFAULT_AGENTS.map(agent => {
          const a = activity[agent.id] || EMPTY;
          const busy = a.status === 'streaming';
          const errored = a.status === 'error';
          return (
            <div key={agent.id} className="bg-white/[0.03] border border-white/5 rounded-xl p-4 hover:border-white/10 transition-colors">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-green-500/20 to-cyan-500/20 border border-green-500/20 flex items-center justify-center">
                    {busy
                      ? <Loader2 size={14} className="text-cyan-400 animate-spin" />
                      : <Bot size={14} className={errored ? 'text-red-400' : 'text-green-400'} />}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-white font-sans">{agent.displayName}</div>
                    <div className="text-[10px] text-gray-500">{agent.id}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full ${busy ? 'bg-cyan-400 animate-pulse' : errored ? 'bg-red-500' : a.lastSeen ? 'bg-green-500' : 'bg-gray-600'}`} />
                  <span className={`text-[10px] uppercase ${busy ? 'text-cyan-400' : errored ? 'text-red-400' : a.lastSeen ? 'text-green-400' : 'text-gray-600'}`}>
                    {busy ? 'Streaming' : errored ? 'Error' : a.lastSeen ? 'Ready' : 'Idle'}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 mb-2">
                <div className="bg-black/30 rounded-lg p-2">
                  <div className="text-[9px] text-gray-600 uppercase">Model</div>
                  <div className="text-[10px] text-cyan-400 mt-0.5 truncate" title={agent.model}>{agent.model}</div>
                </div>
                <div className="bg-black/30 rounded-lg p-2">
                  <div className="text-[9px] text-gray-600 uppercase">Fallback</div>
                  <div className="text-[10px] text-gray-500 mt-0.5 truncate" title={agent.fallbackModel || 'none'}>
                    {agent.fallbackModel || '—'}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-2 mb-2">
                <div className="bg-black/30 rounded-lg p-2">
                  <div className="text-[9px] text-gray-600 uppercase flex items-center gap-1"><Zap size={8} />Req</div>
                  <div className="text-sm text-white mt-0.5">{a.requests}</div>
                </div>
                <div className="bg-black/30 rounded-lg p-2">
                  <div className="text-[9px] text-gray-600 uppercase flex items-center gap-1"><Wrench size={8} />Tools</div>
                  <div className="text-sm text-white mt-0.5">{a.toolCalls}</div>
                </div>
                <div className="bg-black/30 rounded-lg p-2">
                  <div className="text-[9px] text-gray-600 uppercase flex items-center gap-1"><Activity size={8} />Chars</div>
                  <div className="text-sm text-white mt-0.5">{a.charsStreamed.toLocaleString()}</div>
                </div>
                <div className="bg-black/30 rounded-lg p-2">
                  <div className="text-[9px] text-gray-600 uppercase flex items-center gap-1"><Clock size={8} />Seen</div>
                  <div className="text-[10px] text-gray-400 mt-1">{timeSince(a.lastSeen)}</div>
                </div>
              </div>

              {a.lastLatencyMs !== undefined && (
                <div className="text-[10px] text-gray-600 mb-1">
                  Last round trip: <span className="text-gray-400">{(a.lastLatencyMs / 1000).toFixed(1)}s</span>
                  {a.errors > 0 && <span className="text-red-400 ml-3">{a.errors} error{a.errors === 1 ? '' : 's'}</span>}
                </div>
              )}

              {errored && a.lastError && (
                <div className="text-[10px] text-red-400/80 bg-red-500/5 border border-red-500/10 rounded p-2 mt-1">
                  {a.lastError}
                </div>
              )}
              {!errored && a.lastReply && (
                <div className="text-[10px] text-gray-500 bg-black/20 rounded p-2 mt-1 line-clamp-2">
                  {a.lastReply}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-white/5 bg-black/30 max-h-48 flex flex-col">
        <div className="px-4 py-2 text-[10px] text-gray-600 uppercase tracking-widest flex items-center justify-between">
          <span>Activity Feed</span>
          {feed.length > 0 && (
            <button onClick={() => setFeed([])} className="hover:text-gray-300 transition-colors">Clear</button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-3 space-y-1">
          {feed.length === 0 ? (
            <div className="text-[11px] text-gray-600 italic pb-2">
              No agent activity yet — open AI Chat and send a message to see it here.
            </div>
          ) : feed.map(entry => {
            const style = KIND_STYLE[entry.kind];
            const name = DEFAULT_AGENTS.find(x => x.id === entry.agentId)?.displayName || entry.agentId;
            return (
              <div key={entry.id} className="flex items-start gap-2 text-[10px]">
                <span className="text-gray-700 shrink-0">{entry.time}</span>
                <span className={`${style.color} shrink-0 flex items-center gap-1`}>{style.icon}{name}</span>
                <span className="text-gray-500 truncate">{entry.detail}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
