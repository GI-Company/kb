import React, { useEffect, useState } from 'react';
import { kernel } from '../services/kernel';
import { Envelope } from '../types';
import { Bot, Zap, Clock, Radio, Send } from 'lucide-react';

interface AgentInfo {
    id: string;
    name: string;
    model: string;
    role: string;
    lastSeen?: number;
    msgCount?: number;
}

export const AgentMonitorApp: React.FC = () => {
    const [agents, setAgents] = useState<Map<string, AgentInfo>>(new Map());
    const [pingResults, setPingResults] = useState<Map<string, string>>(new Map());

    useEffect(() => {
        const unsub = kernel.subscribe((env: Envelope) => {
            if (env.topic === 'sys.client_list') {
                const payload = env.payload as any;
                const clients = (payload?.clients || []) as AgentInfo[];
                setAgents(prev => {
                    const next = new Map<string, AgentInfo>(prev);
                    // Mark all as potentially stale
                    const seen = new Set<string>();
                    clients.forEach((c: AgentInfo) => {
                        if (c.role === 'agent') {
                            const existing: AgentInfo | undefined = next.get(c.id);
                            next.set(c.id, {
                                ...c,
                                lastSeen: Date.now(),
                                msgCount: existing ? (existing.msgCount || 0) : 0
                            });
                            seen.add(c.id);
                        }
                    });
                    // Remove agents no longer in the list
                    for (const key of Array.from(next.keys())) {
                        if (!seen.has(key)) next.delete(key);
                    }
                    return next;
                });
            }

            // Count messages from agents
            if (env.from && env.from.startsWith('agent-')) {
                setAgents(prev => {
                    const next = new Map<string, AgentInfo>(prev);
                    const existing: AgentInfo | undefined = next.get(env.from);
                    if (existing) {
                        next.set(env.from, { ...existing, msgCount: (existing.msgCount || 0) + 1 });
                    }
                    return next;
                });
            }

            // Pong replies
            if (env.topic === 'agent.pong') {
                setPingResults(prev => new Map(prev).set(env.from, `Pong @ ${new Date().toLocaleTimeString()}`));
            }
        });
        return unsub;
    }, []);

    const pingAgent = (agentId: string) => {
        kernel.sendToAgent(agentId, 'agent.ping', { msg: 'ping' });
        setPingResults(prev => new Map(prev).set(agentId, 'Pinging...'));
    };

    const agentList: AgentInfo[] = Array.from(agents.values());

    const timeSince = (ts?: number) => {
        if (!ts) return 'never';
        const s = Math.floor((Date.now() - ts) / 1000);
        if (s < 5) return 'just now';
        if (s < 60) return `${s}s ago`;
        return `${Math.floor(s / 60)}m ago`;
    };

    return (
        <div className="h-full flex flex-col bg-[#0c0c10] text-gray-300 font-mono text-xs">
            {/* Header */}
            <div className="p-4 border-b border-white/5 bg-white/5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Bot size={16} className="text-green-400" />
                    <span className="text-sm font-bold text-white font-sans">Agent Monitor</span>
                </div>
                <div className="flex items-center gap-2 px-2 py-1 rounded bg-white/5 border border-white/5">
                    <Radio size={10} className="text-green-400 animate-pulse" />
                    <span className="text-[10px] text-gray-400 uppercase tracking-wider">{agentList.length} Agent{agentList.length !== 1 ? 's' : ''}</span>
                </div>
            </div>

            {/* Agent Cards */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {agentList.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-center opacity-40">
                        <Bot size={36} className="text-gray-600 mb-3" />
                        <p className="text-sm text-gray-500 font-sans">No agents connected</p>
                        <p className="text-[10px] text-gray-600 mt-1 font-sans">Start agent proxies with: go run scripts/agent_configs.go</p>
                    </div>
                )}

                {agentList.map(agent => (
                    <div key={agent.id} className="bg-white/[0.03] border border-white/5 rounded-xl p-4 hover:border-white/10 transition-colors">
                        {/* Agent Header */}
                        <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-green-500/20 to-cyan-500/20 border border-green-500/20 flex items-center justify-center">
                                    <Bot size={14} className="text-green-400" />
                                </div>
                                <div>
                                    <div className="text-sm font-medium text-white font-sans">{agent.name || agent.id}</div>
                                    <div className="text-[10px] text-gray-500">{agent.id}</div>
                                </div>
                            </div>
                            <div className="flex items-center gap-1.5">
                                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                                <span className="text-[10px] text-green-400 uppercase">Online</span>
                            </div>
                        </div>

                        {/* Stats */}
                        <div className="grid grid-cols-3 gap-2 mb-3">
                            <div className="bg-black/30 rounded-lg p-2">
                                <div className="text-[9px] text-gray-600 uppercase">Model</div>
                                <div className="text-[10px] text-cyan-400 mt-0.5 truncate" title={agent.model}>{agent.model}</div>
                            </div>
                            <div className="bg-black/30 rounded-lg p-2">
                                <div className="text-[9px] text-gray-600 uppercase flex items-center gap-1"><Zap size={8} />Messages</div>
                                <div className="text-sm text-white mt-0.5">{agent.msgCount || 0}</div>
                            </div>
                            <div className="bg-black/30 rounded-lg p-2">
                                <div className="text-[9px] text-gray-600 uppercase flex items-center gap-1"><Clock size={8} />Last Seen</div>
                                <div className="text-[10px] text-gray-400 mt-0.5">{timeSince(agent.lastSeen)}</div>
                            </div>
                        </div>

                        {/* Ping Button */}
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => pingAgent(agent.id)}
                                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-green-600/10 border border-green-500/20 text-green-400 hover:bg-green-600/20 transition-colors text-[11px]"
                            >
                                <Send size={10} /> Ping
                            </button>
                            {pingResults.get(agent.id) && (
                                <span className="text-[10px] text-gray-500">{pingResults.get(agent.id)}</span>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
