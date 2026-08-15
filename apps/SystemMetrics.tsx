// Live metrics for what this app actually is: a browser process holding a
// window manager, a client-side VFS/chat store, and an in-tab language
// model. The previous version of this file rendered Go runtime stats
// (heapAlloc_mb, numGoroutine, numClients) fed by a `sys.metrics` bus topic
// that the Go microkernel used to publish — nothing publishes it on this
// architecture, so every bar sat at zero permanently. Everything below is
// read from a source that genuinely exists in this build.
//
// Refresh model: store-derived numbers (open windows, guest quota) come
// from useOS and re-render on their own; the async ones (VFS, chat, saved
// models) are polled on an interval, since nothing emits change events for
// them today and a metrics panel doesn't warrant wiring one up.

import React, { useEffect, useState } from 'react';
import { useOS } from '../store';
import { kernel } from '../services/kernel';
import { vfs, VfsStats } from '../lib/vfs';
import { chatStore, ChatStats } from '../lib/chatStore';
import { modelRegistry } from '../lib/modelRegistry';
import { localModel } from '../lib/localModel';
import { runHistoryStore, genHistoryStore } from '../lib/localModelHistory';
import { getCurrentUserId, getSession, isSupabaseConfigured, AppUser } from '../lib/auth';
import { isAnalyticsConfigured } from '../lib/analytics';
import { getSetting, subscribeSettings } from '../lib/settings';
import { formatRemaining } from '../lib/guestUsage';
import {
  Activity, HardDrive, Layers, MessageSquare, Brain, Database, Cpu,
  ShieldCheck, ShieldOff, Radio, Globe, Timer, Save,
} from 'lucide-react';

const REFRESH_MS = 4000;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const Bar: React.FC<{ label: string; value: number; max: number; color: string; icon: React.ReactNode; display: string; note?: string }> =
  ({ label, value, max, color, icon, display, note }) => {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-xs font-mono text-gray-400 uppercase tracking-wider">{label}</span>
        </div>
        <span className="text-sm font-mono text-white font-bold">{display}</span>
      </div>
      <div className="w-full h-2.5 bg-white/5 rounded-full overflow-hidden border border-white/5">
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${color}80, ${color})`, boxShadow: `0 0 12px ${color}40` }}
        />
      </div>
      {note && <div className="text-[10px] text-gray-600 mt-1">{note}</div>}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: React.ReactNode; icon?: React.ReactNode }> = ({ label, value, icon }) => (
  <div className="bg-black/30 rounded-lg p-2.5 border border-white/5">
    <div className="text-[9px] text-gray-600 uppercase tracking-wider flex items-center gap-1 mb-1">
      {icon}{label}
    </div>
    <div className="text-sm text-white font-mono">{value}</div>
  </div>
);

const Section: React.FC<{ title: string; icon: React.ReactNode; children: React.ReactNode }> = ({ title, icon, children }) => (
  <div className="mb-5">
    <div className="flex items-center gap-2 mb-2">
      {icon}
      <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">{title}</span>
    </div>
    {children}
  </div>
);

export const SystemMetricsApp: React.FC = () => {
  const windows = useOS(s => s.windows);
  const currentDesktop = useOS(s => s.currentDesktop);
  const guestRemaining = useOS(s => s.guestRemainingSeconds);

  const [vfsStats, setVfsStats] = useState<VfsStats | null>(null);
  const [chatStats, setChatStats] = useState<ChatStats | null>(null);
  const [savedModels, setSavedModels] = useState<{ count: number; params: number } | null>(null);
  const [heap, setHeap] = useState<{ used: number; limit: number } | null>(null);
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const [user, setUser] = useState<AppUser | null>(null);
  const [userId, setUserId] = useState<string>('');
  const [busCount, setBusCount] = useState(0);
  const [msgRate, setMsgRate] = useState(0);
  const [optOut, setOptOut] = useState(() => getSetting('analyticsOptOut'));
  const [lastUpdate, setLastUpdate] = useState('—');
  const [historyCounts, setHistoryCounts] = useState({ runs: 0, gens: 0 });

  useEffect(() => subscribeSettings(s => setOptOut(s.analyticsOptOut)), []);

  useEffect(() => {
    getSession().then(setUser);
    getCurrentUserId().then(setUserId);
  }, []);

  // Bus throughput — counted the same way Monitor.tsx does, since the bus
  // is genuinely the app's message backbone even without a server behind it.
  useEffect(() => {
    let sinceLastTick = 0;
    const unsub = kernel.subscribe(() => { sinceLastTick++; });
    const rateTimer = setInterval(() => {
      setMsgRate(sinceLastTick);
      sinceLastTick = 0;
      setBusCount(kernel.getTrafficLog().length);
    }, 1000);
    return () => { unsub(); clearInterval(rateTimer); };
  }, []);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const refresh = async () => {
      // performance.memory is Chromium-only and not in the standard lib
      // types — absent entirely on Firefox/Safari, where the heap row is
      // hidden rather than shown as a fake zero.
      const mem = (performance as any).memory;
      if (mem?.usedJSHeapSize) {
        setHeap({ used: mem.usedJSHeapSize, limit: mem.jsHeapSizeLimit });
      }

      if (navigator.storage?.estimate) {
        try {
          const est = await navigator.storage.estimate();
          if (!cancelled) setQuota({ usage: est.usage ?? 0, quota: est.quota ?? 0 });
        } catch { /* not available in this context — the row just stays hidden */ }
      }

      try {
        const [v, c, models] = await Promise.all([
          vfs.stat(userId),
          chatStore.stat(userId),
          modelRegistry.list(),
        ]);
        if (cancelled) return;
        setVfsStats(v);
        setChatStats(c);
        setSavedModels({ count: models.length, params: models.reduce((s, m) => s + (m.paramCount || 0), 0) });
      } catch {
        // A Supabase hiccup shouldn't blank the whole panel — keep the last
        // good numbers and try again on the next tick.
      }

      if (cancelled) return;
      setHistoryCounts({ runs: runHistoryStore.list().length, gens: genHistoryStore.list().length });
      setLastUpdate(new Date().toLocaleTimeString());
    };

    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [userId]);

  const openWindows = windows.filter(w => !w.isMinimized).length;
  const isGuest = !user;
  const modelReady = localModel.isReady;
  const modelConfig = localModel.currentConfig;

  return (
    <div className="h-full bg-[#0a0a0f] text-white p-5 overflow-y-auto">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <Activity className="text-cyan-400" size={18} />
          <h2 className="text-sm font-bold uppercase tracking-widest text-gray-300">System Metrics</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-[10px] text-gray-500 font-mono">{lastUpdate}</span>
        </div>
      </div>

      <Section title="Runtime" icon={<Cpu size={11} className="text-cyan-500" />}>
        {heap ? (
          <Bar
            label="JS Heap"
            value={heap.used}
            max={heap.limit}
            color="#00f0ff"
            icon={<Cpu size={14} className="text-cyan-500" />}
            display={formatBytes(heap.used)}
            note={`of ${formatBytes(heap.limit)} limit`}
          />
        ) : (
          <div className="text-[11px] text-gray-600 mb-4">
            JS heap size isn't exposed by this browser (Chromium-only API).
          </div>
        )}

        {quota && quota.quota > 0 && (
          <Bar
            label="Browser Storage"
            value={quota.usage}
            max={quota.quota}
            color="#7000df"
            icon={<Database size={14} className="text-purple-500" />}
            display={formatBytes(quota.usage)}
            note={`of ~${formatBytes(quota.quota)} available (localStorage + IndexedDB)`}
          />
        )}

        <div className="grid grid-cols-3 gap-2">
          <Stat label="Bus Rate" value={<>{msgRate}<span className="text-[10px] text-gray-500 ml-1">/s</span></>} icon={<Radio size={9} />} />
          <Stat label="Bus Log" value={busCount} icon={<Radio size={9} />} />
          <Stat label="Viewport" value={`${window.innerWidth}×${window.innerHeight}`} />
        </div>
      </Section>

      <Section title="Workspace" icon={<Layers size={11} className="text-green-500" />}>
        <div className="grid grid-cols-3 gap-2 mb-2">
          <Stat label="Open Windows" value={openWindows} icon={<Layers size={9} />} />
          <Stat label="Total Windows" value={windows.length} icon={<Layers size={9} />} />
          <Stat label="Desktop" value={`${currentDesktop + 1} / 4`} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Stat label="VFS Files" value={vfsStats?.fileCount ?? '—'} icon={<HardDrive size={9} />} />
          <Stat label="VFS Folders" value={vfsStats?.dirCount ?? '—'} icon={<HardDrive size={9} />} />
          <Stat label="VFS Size" value={vfsStats ? formatBytes(vfsStats.totalBytes) : '—'} icon={<HardDrive size={9} />} />
        </div>
      </Section>

      <Section title="Conversations" icon={<MessageSquare size={11} className="text-blue-400" />}>
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Saved Chats" value={chatStats?.conversationCount ?? '—'} icon={<MessageSquare size={9} />} />
          <Stat label="Messages" value={chatStats?.messageCount ?? '—'} icon={<MessageSquare size={9} />} />
        </div>
      </Section>

      <Section title="Local Model (BNLM)" icon={<Brain size={11} className="text-pink-400" />}>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <Stat
            label="Session Model"
            value={modelReady
              ? <span className="text-green-400">{modelConfig.mixerType} · d{modelConfig.dModel}</span>
              : <span className="text-gray-600">not initialized</span>}
            icon={<Brain size={9} />}
          />
          <Stat label="Saved Models" value={savedModels?.count ?? '—'} icon={<Save size={9} />} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Saved Params" value={savedModels ? savedModels.params.toLocaleString() : '—'} />
          <Stat label="Train Runs" value={historyCounts.runs} />
          <Stat label="Generations" value={historyCounts.gens} />
        </div>
      </Section>

      <Section title="Session & Capabilities" icon={<ShieldCheck size={11} className="text-orange-400" />}>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <Stat
            label="Account"
            value={isGuest
              ? <span className="text-yellow-400">Guest</span>
              : <span className="text-green-400">{user?.username}</span>}
            icon={<ShieldCheck size={9} />}
          />
          <Stat
            label="Sync Backend"
            value={isSupabaseConfigured
              ? (isGuest ? <span className="text-gray-500">local only</span> : <span className="text-green-400">Supabase</span>)
              : <span className="text-gray-500">local only</span>}
            icon={<Database size={9} />}
          />
        </div>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <Stat
            label="Network Commands"
            value={isGuest
              ? <span className="text-gray-500">sign in to use</span>
              : <span className="text-green-400">enabled</span>}
            icon={<Globe size={9} />}
          />
          <Stat
            label="Guest Time Left"
            value={guestRemaining !== null
              ? <span className="text-yellow-400">{formatRemaining(guestRemaining)}</span>
              : <span className="text-gray-500">unlimited</span>}
            icon={<Timer size={9} />}
          />
        </div>
        <Stat
          label="Analytics"
          value={!isAnalyticsConfigured
            ? <span className="text-gray-500">not configured</span>
            : optOut
            ? <span className="text-red-400">opted out</span>
            : <span className="text-green-400">enabled</span>}
          icon={optOut ? <ShieldOff size={9} /> : <ShieldCheck size={9} />}
        />
      </Section>
    </div>
  );
};
