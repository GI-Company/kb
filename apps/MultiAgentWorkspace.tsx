import React, { useEffect, useState } from 'react';
import { kernel } from '../services/kernel';
import { Envelope } from '../types';
import { Bot, Cpu, Shield, Code, Wrench, MessageSquare, Loader } from 'lucide-react';

interface AgentCard {
  id: string;
  name: string;
  specialty: string;
  status: 'idle' | 'working' | 'done' | 'error';
  icon: string;
  lastOutput: string;
  color: string;
}

const AGENT_ICONS: Record<string, React.ReactNode> = {
  'security': <Shield size={18} />,
  'code': <Code size={18} />,
  'devops': <Wrench size={18} />,
  'general': <Bot size={18} />,
  'system': <Cpu size={18} />,
};

const DEFAULT_AGENTS: AgentCard[] = [
  { id: 'agent-security', name: 'Security Auditor', specialty: 'Scans for vulnerabilities and permission issues', status: 'idle', icon: 'security', lastOutput: '', color: '#ff4444' },
  { id: 'agent-reviewer', name: 'Code Reviewer', specialty: 'Reviews code quality and suggests improvements', status: 'idle', icon: 'code', lastOutput: '', color: '#00f0ff' },
  { id: 'agent-devops', name: 'DevOps Bot', specialty: 'Manages builds, deployments, and infrastructure', status: 'idle', icon: 'devops', lastOutput: '', color: '#00ff9d' },
  { id: 'agent-architect', name: 'Architect', specialty: 'Designs system structure and resolves tech debt', status: 'idle', icon: 'general', lastOutput: '', color: '#7000df' },
];

export const MultiAgentWorkspace: React.FC = () => {
  const [agents, setAgents] = useState<AgentCard[]>(DEFAULT_AGENTS);
  const [sharedGoal, setSharedGoal] = useState('');
  const [chatLog, setChatLog] = useState<{ from: string; text: string; color: string }[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  const dispatchGoal = () => {
    if (!sharedGoal.trim()) return;
    setIsRunning(true);
    setChatLog([{ from: 'system', text: `Goal dispatched: "${sharedGoal}"`, color: '#888' }]);

    // Set all agents to working
    setAgents(prev => prev.map(a => ({ ...a, status: 'working' as const, lastOutput: 'Analyzing goal...' })));

    // Dispatch to each agent via the bus
    agents.forEach(agent => {
      kernel.sendToAgent(agent.id, 'ai.chat', {
        _request_id: `multi-${agent.id}-${Date.now()}`,
        prompt: `[${agent.name}] You are a specialized ${agent.specialty} agent. Analyze this goal and provide your specific recommendations: "${sharedGoal}"`,
      });
    });
  };

  useEffect(() => {
    const unsubscribe = kernel.subscribe((env: Envelope) => {
      // Agent responses from the bus
      if (env.topic === 'ai.stream' && env.payload._request_id?.startsWith('multi-')) {
        const agentId = env.payload._request_id.split('-').slice(1, 3).join('-');
        const agent = agents.find(a => a.id === agentId);
        if (agent) {
          setAgents(prev => prev.map(a => 
            a.id === agentId ? { ...a, lastOutput: (a.lastOutput === 'Analyzing goal...' ? '' : a.lastOutput) + (env.payload.chunk || '') } : a
          ));
        }
      }

      if (env.topic === 'ai.done' && env.payload._request_id?.startsWith('multi-')) {
        const agentId = env.payload._request_id.split('-').slice(1, 3).join('-');
        const agent = agents.find(a => a.id === agentId);
        if (agent) {
          setAgents(prev => prev.map(a =>
            a.id === agentId ? { ...a, status: 'done' as const } : a
          ));
          setChatLog(prev => [...prev, { from: agent.name, text: agents.find(a => a.id === agentId)?.lastOutput || 'Done.', color: agent.color }]);
        }

        // Check if all agents are done
        setAgents(prev => {
          const allDone = prev.every(a => a.status === 'done' || a.id === agentId);
          if (allDone) setIsRunning(false);
          return prev;
        });
      }
    });
    return unsubscribe;
  }, [agents]);

  return (
    <div className="h-full bg-[#0a0a0f] text-white flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-5 pt-4 pb-3 border-b border-white/5">
        <div className="flex items-center gap-2 mb-3">
          <Bot className="text-purple-400" size={18} />
          <h2 className="text-sm font-bold uppercase tracking-widest text-gray-300">Multi-Agent Workspace</h2>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={sharedGoal}
            onChange={e => setSharedGoal(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && dispatchGoal()}
            placeholder="Shared goal for all agents..."
            className="flex-1 bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-purple-500/50 font-mono"
            disabled={isRunning}
          />
          <button
            onClick={dispatchGoal}
            disabled={isRunning || !sharedGoal.trim()}
            className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-600 text-sm font-medium transition-colors"
          >
            {isRunning ? <Loader size={16} className="animate-spin" /> : 'Dispatch'}
          </button>
        </div>
      </div>

      {/* Agent Cards Grid */}
      <div className="grid grid-cols-2 gap-3 p-4 flex-shrink-0">
        {agents.map(agent => (
          <div
            key={agent.id}
            className="p-3 rounded-lg bg-white/5 border border-white/5 hover:border-white/10 transition-colors"
            style={{ borderLeftColor: agent.color, borderLeftWidth: '3px' }}
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="text-gray-400">{AGENT_ICONS[agent.icon]}</div>
              <span className="text-xs font-bold uppercase tracking-wider" style={{ color: agent.color }}>{agent.name}</span>
              {agent.status === 'working' && <Loader size={12} className="text-yellow-400 animate-spin ml-auto" />}
              {agent.status === 'done' && <div className="w-2 h-2 rounded-full bg-green-500 ml-auto" />}
            </div>
            <p className="text-[10px] text-gray-500 mb-1">{agent.specialty}</p>
            {agent.lastOutput && (
              <p className="text-[11px] text-gray-400 font-mono line-clamp-3 mt-1 bg-black/30 p-2 rounded">
                {agent.lastOutput}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Shared Chat Log */}
      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
        <div className="text-[10px] text-gray-500 font-mono uppercase tracking-wider mb-1">
          <MessageSquare size={10} className="inline mr-1" /> Agent Communication Log
        </div>
        {chatLog.map((msg, i) => (
          <div key={i} className="text-xs font-mono">
            <span style={{ color: msg.color }} className="font-bold">[{msg.from}]</span>{' '}
            <span className="text-gray-400 line-clamp-2">{msg.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
