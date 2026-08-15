// Fan one goal out to several specialist personas at once and read their
// answers side by side.
//
// This app was previously non-functional for two independent reasons, both
// fixed in services/kernel.ts rather than papered over here:
//   1. It tagged each request `multi-<agentId>-<ts>` and filtered replies on
//      `payload._request_id`, but handleDirectChat never echoed the id back —
//      so no reply ever matched and every pane stayed "working" forever.
//   2. handleDirectChat ignored `env.to` and always used the agent-chat
//      persona, so even had the filtering worked, all four "specialists"
//      would have returned the same generic answer from the same prompt.
//
// Scope for v1: these panes are chat-only. Tool calls (bnlm.*, kernos.exec)
// are deliberately not executed here — the ai.chat path doesn't parse tool
// blocks, and running four sandboxes concurrently off one button press is a
// cost/blast-radius decision that shouldn't be made implicitly. Ask in AI
// Chat when a tool call is what's wanted.

import React, { useEffect, useRef, useState } from 'react';
import { kernel } from '../services/kernel';
import { Envelope } from '../types';
import { DEFAULT_AGENTS } from '../lib/agents';
import { extractThinking } from '../lib/thinking';
import { Bot, Cpu, Shield, Code, Wrench, MessageSquare, Loader2, AlertTriangle, Check } from 'lucide-react';

type PaneStatus = 'idle' | 'working' | 'done' | 'error';

interface PaneConfig {
  agentId: string;
  specialty: string;
  icon: React.ReactNode;
  color: string;
}

interface PaneState {
  status: PaneStatus;
  output: string;
  error?: string;
  startedAt?: number;
  elapsedMs?: number;
}

// Which personas get a pane, and the one-line description shown under each.
// The display name and model come from lib/agents.ts so this never drifts
// from the real roster.
const PANES: PaneConfig[] = [
  { agentId: 'agent-security', specialty: 'Vulnerabilities, authz, and unsafe defaults', icon: <Shield size={16} />, color: '#ff4444' },
  { agentId: 'agent-coder', specialty: 'Correctness, readability, and edge cases', icon: <Code size={16} />, color: '#00f0ff' },
  { agentId: 'agent-devops', specialty: 'Builds, deploys, and infrastructure', icon: <Wrench size={16} />, color: '#00ff9d' },
  { agentId: 'agent-architect', specialty: 'Structure, tradeoffs, and tech debt', icon: <Cpu size={16} />, color: '#7000df' },
];

const EMPTY_PANE: PaneState = { status: 'idle', output: '' };

function displayName(agentId: string): string {
  return DEFAULT_AGENTS.find(a => a.id === agentId)?.displayName || agentId;
}

function modelName(agentId: string): string {
  return DEFAULT_AGENTS.find(a => a.id === agentId)?.model || '—';
}

export const MultiAgentWorkspace: React.FC = () => {
  const [goal, setGoal] = useState('');
  const [panes, setPanes] = useState<Record<string, PaneState>>(() =>
    Object.fromEntries(PANES.map(p => [p.agentId, { ...EMPTY_PANE }]))
  );
  const [isRunning, setIsRunning] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // requestId -> agentId. A map, rather than parsing the agent id back out
  // of the request string, because agent ids contain the same '-' the id
  // format uses (the previous version's split('-').slice(1,3) was already
  // fragile and would break on any id with a different number of segments).
  const pendingRef = useRef<Map<string, string>>(new Map());
  const panesRef = useRef(panes);
  panesRef.current = panes;

  useEffect(() => {
    const setPane = (agentId: string, fn: (p: PaneState) => PaneState) => {
      setPanes(prev => ({ ...prev, [agentId]: fn(prev[agentId] || EMPTY_PANE) }));
    };

    const unsub = kernel.subscribe((env: Envelope) => {
      const p = env.payload as any;
      const rid: string | undefined = p?._request_id;
      if (!rid) return;
      const agentId = pendingRef.current.get(rid);
      if (!agentId) return; // some other window's request

      if (env.topic === 'ai.stream') {
        // kernel.ts sets `error` alongside the ⚠️-prefixed chunk on failure,
        // so a real error is distinguishable from a model that just happens
        // to have written a warning sign.
        if (p.error) {
          setPane(agentId, s => ({ ...s, status: 'error', error: String(p.error) }));
          return;
        }
        setPane(agentId, s => ({ ...s, status: 'working', output: s.output + (p.chunk || '') }));
      }

      if (env.topic === 'ai.done') {
        pendingRef.current.delete(rid);
        setPane(agentId, s => ({
          ...s,
          status: s.status === 'error' ? 'error' : 'done',
          elapsedMs: s.startedAt ? Date.now() - s.startedAt : undefined,
        }));
        if (pendingRef.current.size === 0) setIsRunning(false);
      }
    });

    return unsub;
  }, []);

  const dispatch = () => {
    const trimmed = goal.trim();
    if (!trimmed || isRunning) return;

    pendingRef.current.clear();
    setIsRunning(true);
    setPanes(Object.fromEntries(PANES.map(p => [p.agentId, { ...EMPTY_PANE, status: 'working' as const, startedAt: Date.now() }])));

    for (const pane of PANES) {
      const rid = `multi-${pane.agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      pendingRef.current.set(rid, pane.agentId);
      // `to` selects the persona server-side (see kernel.ts's handleDirectChat).
      // The prompt stays plain — the persona's own system prompt is what makes
      // each answer specialist, not a role preamble stuffed in here.
      kernel.sendToAgent(pane.agentId, 'ai.chat', { _request_id: rid, prompt: trimmed });
    }
  };

  const doneCount = PANES.filter(p => ['done', 'error'].includes(panes[p.agentId]?.status)).length;

  return (
    <div className="h-full bg-[#0a0a0f] text-white flex flex-col overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <Bot className="text-purple-400" size={18} />
          <h2 className="text-sm font-bold uppercase tracking-widest text-gray-300">Multi-Agent Workspace</h2>
          {isRunning && (
            <span className="ml-auto text-[10px] text-gray-500 font-mono">{doneCount}/{PANES.length} done</span>
          )}
        </div>
        <p className="text-[11px] text-gray-600 mb-3">
          Sends the same question to four specialist personas at once, each with its own model.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={goal}
            onChange={e => setGoal(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && dispatch()}
            placeholder="Ask all four agents something..."
            className="flex-1 bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-purple-500/50 font-mono"
            disabled={isRunning}
          />
          <button
            onClick={dispatch}
            disabled={isRunning || !goal.trim()}
            className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-600 text-sm font-medium transition-colors flex items-center gap-2"
          >
            {isRunning ? <Loader2 size={16} className="animate-spin" /> : 'Ask All'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 grid grid-cols-1 md:grid-cols-2 gap-3 content-start">
        {PANES.map(pane => {
          const state = panes[pane.agentId] || EMPTY_PANE;
          const isExpanded = expanded === pane.agentId;
          // Reasoning-style models (qwen3.6-27b here) prepend a <think>
          // block; these panes are a scannable side-by-side comparison, so
          // only the answer is shown. AI Chat is where the reasoning is
          // available if someone wants to read it.
          const { thinking, response } = extractThinking(state.output);
          const visible = response || (thinking ? '' : state.output);
          return (
            <div
              key={pane.agentId}
              className="rounded-lg bg-white/5 border border-white/5 hover:border-white/10 transition-colors flex flex-col min-h-[180px]"
              style={{ borderLeftColor: pane.color, borderLeftWidth: '3px' }}
            >
              <div className="p-3 pb-2">
                <div className="flex items-center gap-2 mb-1">
                  <span style={{ color: pane.color }}>{pane.icon}</span>
                  <span className="text-xs font-bold uppercase tracking-wider" style={{ color: pane.color }}>
                    {displayName(pane.agentId)}
                  </span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {state.status === 'working' && <Loader2 size={12} className="text-yellow-400 animate-spin" />}
                    {state.status === 'done' && <Check size={12} className="text-green-500" />}
                    {state.status === 'error' && <AlertTriangle size={12} className="text-red-400" />}
                    {state.elapsedMs !== undefined && state.status === 'done' && (
                      <span className="text-[9px] text-gray-600 font-mono">{(state.elapsedMs / 1000).toFixed(1)}s</span>
                    )}
                  </span>
                </div>
                <p className="text-[10px] text-gray-500">{pane.specialty}</p>
                <p className="text-[9px] text-gray-700 font-mono mt-0.5">{modelName(pane.agentId)}</p>
              </div>

              <div className="flex-1 px-3 pb-3 min-h-0">
                {state.status === 'error' ? (
                  <div className="text-[11px] text-red-400/90 bg-red-500/5 border border-red-500/10 rounded p-2">
                    {state.error}
                  </div>
                ) : visible ? (
                  <div
                    onClick={() => setExpanded(isExpanded ? null : pane.agentId)}
                    className={`text-[11px] text-gray-300 font-mono bg-black/30 p-2 rounded whitespace-pre-wrap cursor-pointer overflow-y-auto ${
                      isExpanded ? 'max-h-none' : 'max-h-32'
                    }`}
                    title={isExpanded ? 'Click to collapse' : 'Click to expand'}
                  >
                    {visible}
                    {state.status === 'working' && <span className="animate-pulse text-purple-400">▊</span>}
                  </div>
                ) : (
                  <div className="text-[11px] text-gray-700 italic">
                    {state.status === 'working'
                      ? (thinking ? 'Reasoning…' : 'Waiting for first token…')
                      : 'No response yet.'}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="px-4 py-2 border-t border-white/5 text-[10px] text-gray-600 flex items-center gap-1.5 shrink-0">
        <MessageSquare size={10} />
        Each pane is a separate model call — four responses cost four requests.
      </div>
    </div>
  );
};
