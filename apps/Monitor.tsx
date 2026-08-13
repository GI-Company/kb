import React, { useEffect, useState, useRef } from 'react';
import { kernel } from '../services/kernel';
import { Envelope } from '../types';
import { Activity, Server, Globe, Wifi, WifiOff, Trash2, Search, Filter } from 'lucide-react';

const TOPIC_COLORS: Record<string, string> = {
  'vm.': 'text-cyan-400',
  'ai.': 'text-purple-400',
  'sys.': 'text-orange-400',
  'vfs': 'text-green-400',
  'task.': 'text-yellow-400',
  'p2p.': 'text-blue-400',
  'pkg.': 'text-pink-400',
  'terminal.': 'text-cyan-300',
  'editor.': 'text-indigo-400',
  'agent.': 'text-emerald-400',
  'system.': 'text-gray-400',
};

const getTopicColor = (topic: string): string => {
  for (const [prefix, color] of Object.entries(TOPIC_COLORS)) {
    if (topic.startsWith(prefix) || topic.includes(prefix)) return color;
  }
  return 'text-gray-400';
};

export const MonitorApp: React.FC = () => {
  const [traffic, setTraffic] = useState<Envelope[]>([]);
  const [isLive, setIsLive] = useState(kernel.isLive);
  const [filter, setFilter] = useState('');
  const [msgRate, setMsgRate] = useState(0);
  const [paused, setPaused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const msgCountRef = useRef(0);

  useEffect(() => {
    setTraffic(kernel.getTrafficLog());

    const unsub = kernel.subscribe((env) => {
      if (!paused) {
        setTraffic(prev => [env, ...prev].slice(0, 100));
      }
      msgCountRef.current++;
    });

    // Poll connection status + calculate msg rate
    const interval = setInterval(() => {
      setIsLive(kernel.isLive);
      setMsgRate(msgCountRef.current);
      msgCountRef.current = 0;
    }, 1000);

    return () => {
      unsub();
      clearInterval(interval);
    };
  }, [paused]);

  const filtered = filter
    ? traffic.filter(env => env.topic.toLowerCase().includes(filter.toLowerCase()) || env.from.toLowerCase().includes(filter.toLowerCase()))
    : traffic;

  return (
    <div className="h-full bg-[#0a0a0f] text-gray-300 flex flex-col font-mono text-xs">
      {/* Header */}
      <div className="p-3 border-b border-white/5 bg-white/[0.03] space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity size={16} className="text-orange-400" />
            <span className="font-bold text-sm text-white font-sans">Bus Monitor</span>
          </div>
          <div className={`flex items-center gap-2 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
            isLive
              ? 'bg-green-500/10 border border-green-500/20 text-green-400'
              : 'bg-yellow-500/10 border border-yellow-500/20 text-yellow-400'
          }`}>
            {isLive ? <Wifi size={10} /> : <WifiOff size={10} />}
            {isLive ? 'LIVE' : 'RECONNECTING'}
          </div>
        </div>

        {/* Filter */}
        <div className="flex gap-2">
          <div className="flex-1 flex items-center gap-2 bg-black/40 border border-white/10 rounded-lg px-3">
            <Search size={12} className="text-gray-600" />
            <input
              type="text"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter topics... (e.g. vm, ai, sys)"
              className="flex-1 bg-transparent py-1.5 text-gray-300 placeholder-gray-600 outline-none text-xs"
            />
            {filter && (
              <button onClick={() => setFilter('')} className="text-gray-600 hover:text-white">✕</button>
            )}
          </div>
          <button
            onClick={() => setPaused(!paused)}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase transition-colors ${
              paused ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/20' : 'bg-white/5 text-gray-400 border border-white/5 hover:bg-white/10'
            }`}
          >
            {paused ? '▶ Resume' : '⏸ Pause'}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 border-b border-white/5 divide-x divide-white/5">
        <div className="p-3 flex items-center gap-3">
          <Server size={14} className="text-purple-400" />
          <div>
            <div className="text-[10px] text-gray-600 uppercase">Rate</div>
            <div className="text-lg font-bold text-white">{msgRate}<span className="text-xs text-gray-500 ml-1">msg/s</span></div>
          </div>
        </div>
        <div className="p-3 flex items-center gap-3">
          <Globe size={14} className="text-cyan-400" />
          <div>
            <div className="text-[10px] text-gray-600 uppercase">Total</div>
            <div className="text-lg font-bold text-white">{traffic.length}</div>
          </div>
        </div>
        <div className="p-3 flex items-center gap-3">
          <Filter size={14} className="text-green-400" />
          <div>
            <div className="text-[10px] text-gray-600 uppercase">Shown</div>
            <div className="text-lg font-bold text-white">{filtered.length}</div>
          </div>
        </div>
      </div>

      {/* Column Headers */}
      <div className="px-3 py-1.5 bg-white/[0.02] border-b border-white/5 flex items-center justify-between text-[10px] text-gray-600 uppercase tracking-wider">
        <span>Event Stream</span>
        <button onClick={() => setTraffic([])} className="hover:text-white flex items-center gap-1">
          <Trash2 size={10} /> Clear
        </button>
      </div>

      {/* Traffic Log */}
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5" ref={scrollRef}>
        {filtered.map((env, i) => (
          <div key={i} className="group flex flex-col gap-0.5 px-2 py-1.5 hover:bg-white/[0.03] rounded transition-colors border border-transparent hover:border-white/5">
            <div className="flex items-center gap-2">
              <div className="w-[60px] text-gray-600 text-[10px] flex-shrink-0">
                {env.time.split('T')[1]?.split('.')[0] || env.time}
              </div>
              <div className={`font-bold ${getTopicColor(env.topic)}`}>{env.topic}</div>
              <div className="text-gray-600 text-[10px] ml-auto flex-shrink-0">
                from: <span className="text-gray-500">{env.from}</span>
              </div>
            </div>
            <div className="text-gray-500 break-all pl-[60px] text-[10px] opacity-0 group-hover:opacity-100 transition-opacity max-h-20 overflow-hidden">
              {JSON.stringify(env.payload).substring(0, 300)}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="p-8 text-center text-gray-600 italic font-sans">
            {filter ? `No matching events for "${filter}"` : 'Waiting for traffic on the bus...'}
          </div>
        )}
      </div>
    </div>
  );
};