import React, { useEffect, useState } from 'react';
import { kernel } from '../services/kernel';
import { Envelope } from '../types';
import { Cpu, HardDrive, Users, Zap, Activity } from 'lucide-react';

interface Metrics {
  heapAlloc_mb: number;
  sysAlloc_mb: number;
  numGoroutine: number;
  numClients: number;
  activeProcs: number;
}

const MetricBar: React.FC<{ label: string; value: number; max: number; color: string; icon: React.ReactNode; unit?: string }> = 
  ({ label, value, max, color, icon, unit = '' }) => {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-xs font-mono text-gray-400 uppercase tracking-wider">{label}</span>
        </div>
        <span className="text-sm font-mono text-white font-bold">{value}{unit}</span>
      </div>
      <div className="w-full h-2.5 bg-white/5 rounded-full overflow-hidden border border-white/5">
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${color}80, ${color})`,
            boxShadow: `0 0 12px ${color}40`,
          }}
        />
      </div>
    </div>
  );
};

export const SystemMetricsApp: React.FC = () => {
  const [metrics, setMetrics] = useState<Metrics>({
    heapAlloc_mb: 0,
    sysAlloc_mb: 0,
    numGoroutine: 0,
    numClients: 0,
    activeProcs: 0,
  });
  const [lastUpdate, setLastUpdate] = useState<string>('—');

  useEffect(() => {
    const unsubscribe = kernel.subscribe((env: Envelope) => {
      if (env.topic === 'sys.metrics') {
        const p = env.payload as any;
        setMetrics({
          heapAlloc_mb: p.heapAlloc_mb || 0,
          sysAlloc_mb: p.sysAlloc_mb || 0,
          numGoroutine: p.numGoroutine || 0,
          numClients: p.numClients || 0,
          activeProcs: p.activeProcs || 0,
        });
        setLastUpdate(new Date().toLocaleTimeString());
      }
    });
    return unsubscribe;
  }, []);

  return (
    <div className="h-full bg-[#0a0a0f] text-white p-5 overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Activity className="text-cyan-400" size={18} />
          <h2 className="text-sm font-bold uppercase tracking-widest text-gray-300">Live System Metrics</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-[10px] text-gray-500 font-mono">{lastUpdate}</span>
        </div>
      </div>

      <MetricBar
        label="Heap Memory"
        value={metrics.heapAlloc_mb}
        max={512}
        color="#00f0ff"
        icon={<HardDrive size={14} className="text-cyan-500" />}
        unit=" MB"
      />
      <MetricBar
        label="System Memory"
        value={metrics.sysAlloc_mb}
        max={1024}
        color="#7000df"
        icon={<HardDrive size={14} className="text-purple-500" />}
        unit=" MB"
      />
      <MetricBar
        label="Goroutines"
        value={metrics.numGoroutine}
        max={200}
        color="#00ff9d"
        icon={<Zap size={14} className="text-green-500" />}
      />
      <MetricBar
        label="WebSocket Clients"
        value={metrics.numClients}
        max={50}
        color="#ff9d00"
        icon={<Users size={14} className="text-orange-400" />}
      />
      <MetricBar
        label="Active Processes"
        value={metrics.activeProcs}
        max={20}
        color="#ff4444"
        icon={<Cpu size={14} className="text-red-400" />}
      />

      <div className="mt-6 p-3 rounded-lg bg-white/5 border border-white/5">
        <div className="text-[10px] text-gray-500 font-mono uppercase tracking-wider mb-2">Raw Telemetry</div>
        <pre className="text-xs text-gray-400 font-mono">{JSON.stringify(metrics, null, 2)}</pre>
      </div>
    </div>
  );
};
