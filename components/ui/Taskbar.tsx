import React, { useState, useEffect, useRef } from 'react';
import { useOS } from '../../store';
import { Terminal, Monitor, FileCode, HardDrive, Cpu, Menu, Workflow, Bot, Brain, Sparkles, Activity, Settings, Users, Clock as ClockIcon, X, Pin, PinOff, LogOut, Maximize, Minus, Play, Timer, Home, Grid3x3, Tags, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useContextMenu } from './ContextMenu';
import { formatRemaining } from '../../lib/guestUsage';
import { getSetting, subscribeSettings } from '../../lib/settings';
import { useWindowControlsOverlay } from '../../lib/windowControlsOverlay';

// Guest-only daily quota countdown (see lib/guestUsage.ts / api/guest-usage.ts).
// Renders nothing once guestRemainingSeconds is null — real accounts, and
// guest sessions before the server-configured check comes back, show no chip.
const GuestUsageChip: React.FC = () => {
  const remaining = useOS(s => s.guestRemainingSeconds);
  const checking = useOS(s => s.guestCheckingQuota);
  const [warningThreshold, setWarningThreshold] = useState(() => getSetting('guestQuotaWarningSeconds'));
  useEffect(() => subscribeSettings(s => setWarningThreshold(s.guestQuotaWarningSeconds)), []);
  if (remaining === null) return null;
  // The 15:00 lib/guestUsage.ts starts at is a display default, not a
  // verified number — a guest who already used up today's quota in an
  // earlier session shouldn't see a confident countdown for however long
  // the first heartbeat's round trip takes. This is that window, made
  // honest rather than silently showing a number that might be wrong.
  if (checking) {
    return (
      <div
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border backdrop-blur-sm bg-black/40 border-white/5 text-gray-500"
        title="Confirming daily guest access"
      >
        <Timer size={11} className="animate-pulse" />
        <span className="text-[10px] font-mono tracking-widest">checking…</span>
      </div>
    );
  }
  const low = remaining <= warningThreshold;
  return (
    <div
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border backdrop-blur-sm ${
        low ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-black/40 border-white/5 text-gray-400'
      }`}
      title="Daily guest access remaining"
    >
      <Timer size={11} className={low ? 'animate-pulse' : ''} />
      <span className="text-[10px] font-mono tracking-widest">{formatRemaining(remaining)}</span>
    </div>
  );
};

// Set by index.tsx once the service worker's controller changes with one
// already present at page load — a real update, not first-ever activation.
// Deliberately NOT a self-dismissing toast (see components/ui/ToastSystem.tsx):
// an installed standalone window has no other way back to this, and losing
// it after 5 seconds would mean losing the only path to actually picking up
// the new build until the next full quit-and-relaunch.
const UpdateAvailableChip: React.FC = () => {
  const updateAvailable = useOS(s => s.updateAvailable);
  if (!updateAvailable) return null;
  return (
    <button
      onClick={() => window.location.reload()}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border backdrop-blur-sm bg-cyan-500/10 border-cyan-500/20 text-cyan-400 hover:bg-cyan-500/20 transition-colors animate-pulse"
      title="A new version is ready — click to reload"
    >
      <RefreshCw size={11} />
      <span className="text-[10px] font-mono tracking-widest hidden sm:inline">UPDATE</span>
    </button>
  );
};

const Clock = () => {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="text-[11px] font-mono tracking-widest text-gray-400">
      {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </div>
  );
};

// Draws Kernos's own top strip into the OS title bar's space instead of
// leaving it blank behind the window controls — the whole point of
// declaring window-controls-overlay rather than just standalone. Sized
// and positioned via the titlebar-area-* env vars the browser exposes
// only while WCO is actually active, which already account for which
// side the OS drew its own minimize/maximize/close controls on (right on
// Windows/Linux, left on macOS) — hardcoding either side here would put
// this strip's content under those buttons on the other platform.
// -webkit-app-region: drag makes the strip itself move the window like a
// native title bar; interactive children need the no-drag override below
// or they'd become part of the drag surface instead of clickable.
const TitleBarOverlay: React.FC = () => {
  const { visible } = useWindowControlsOverlay();
  if (!visible) return null;
  return (
    <div
      className="fixed z-[9999] flex items-center px-3 gap-2 bg-[var(--kernos-bg-taskbar)] border-b border-white/5 select-none"
      style={{
        top: 'env(titlebar-area-y, 0)',
        left: 'env(titlebar-area-x, 0)',
        width: 'env(titlebar-area-width, 100%)',
        height: 'env(titlebar-area-height, 33px)',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <span className="text-[11px] font-bold tracking-widest text-gray-300">KERNOS</span>
      <div className="w-1 h-1 rounded-full bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.8)]" />
    </div>
  );
};

/* Tooltip wrapper — shows label on hover */
const TipButton: React.FC<{ label: string; onClick: () => void; onContextMenu?: (e: React.MouseEvent) => void; className?: string; children: React.ReactNode }> = ({ label, onClick, onContextMenu, className, children }) => (
  <div className="relative group flex items-center justify-center">
    <motion.button 
      whileHover={{ scale: 1.15, y: -2 }}
      whileTap={{ scale: 0.9 }}
      onClick={onClick} 
      onContextMenu={onContextMenu} 
      className={className} 
      aria-label={label}
    >
      {children}
    </motion.button>
    <div className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-all duration-200 z-[999]">
      <div className="bg-[var(--kernos-bg-taskbar-solid)] backdrop-blur-md border border-white/10 px-2.5 py-1 rounded shadow-xl text-[10px] text-gray-300 font-mono whitespace-nowrap transform scale-95 group-hover:scale-100 transition-transform origin-bottom">
        {label}
        <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 border-l-4 border-r-4 border-t-4 border-transparent border-t-[#0f0f13]/95" />
      </div>
    </div>
  </div>
);

// All available apps with their icons and colors
const APP_REGISTRY = [
  { id: 'terminal',     label: 'Terminal',              color: 'text-cyan-400' },
  { id: 'cde',          label: 'CDE',                   color: 'text-white' },
  { id: 'editor',       label: 'Code Editor',           color: 'text-purple-400' },
  { id: 'files',        label: 'File System',            color: 'text-green-400' },
  { id: 'monitor',      label: 'System Monitor',         color: 'text-orange-400' },
  { id: 'ai-chat',      label: 'AI Chat',                color: 'text-pink-400' },
  { id: 'local-model',  label: 'Local Model (BNLM)',     color: 'text-cyan-300' },
  { id: 'classifier',   label: 'Intent Classifier',      color: 'text-emerald-400' },
  { id: 'agents',       label: 'Agent Monitor',          color: 'text-blue-400' },
  { id: 'tasks',        label: 'Task Engine',            color: 'text-white' },
  { id: 'metrics',      label: 'System Metrics',         color: 'text-cyan-400' },
  { id: 'settings',     label: 'Settings',               color: 'text-yellow-400' },
  { id: 'multi-agents', label: 'Multi-Agent Workspace',  color: 'text-purple-400' },
  { id: 'timeline',     label: 'Timeline',               color: 'text-orange-400' },
];

const DEFAULT_PINNED = ['terminal', 'cde', 'editor', 'files', 'ai-chat', 'local-model', 'monitor'];

const iconForAppId = (appId: string, size = 16) => {
  switch (appId) {
    case 'terminal':     return <Terminal size={size} />;
    case 'cde':          return <Sparkles size={size} />;
    case 'editor':       return <FileCode size={size} />;
    case 'monitor':      return <Monitor size={size} />;
    case 'files':        return <HardDrive size={size} />;
    case 'tasks':        return <Workflow size={size} />;
    case 'ai-chat':      return <Brain size={size} />;
    case 'local-model':  return <Cpu size={size} />;
    case 'classifier':   return <Tags size={size} />;
    case 'agents':       return <Bot size={size} />;
    case 'metrics':      return <Activity size={size} />;
    case 'settings':     return <Settings size={size} />;
    case 'multi-agents': return <Users size={size} />;
    case 'timeline':     return <ClockIcon size={size} />;
    default:             return <Cpu size={size} />;
  }
};

export const Taskbar: React.FC = () => {
  const { windows, activeWindowId, focusWindow, minimizeWindow, openWindow, isMobile } = useOS();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { showMenu } = useContextMenu();

  // Load pinned apps from localStorage
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('kernos_pinned_apps');
      return saved ? JSON.parse(saved) : DEFAULT_PINNED;
    } catch { return DEFAULT_PINNED; }
  });

  // Persist pinned apps
  useEffect(() => {
    localStorage.setItem('kernos_pinned_apps', JSON.stringify(pinnedIds));
  }, [pinnedIds]);

  // Close menus on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const togglePin = (appId: string) => {
    setPinnedIds(prev =>
      prev.includes(appId)
        ? prev.filter(id => id !== appId)
        : [...prev, appId]
    );
  };

  const handleContextMenu = (e: React.MouseEvent, appId: string, isRunning: boolean, windowId?: string) => {
    e.preventDefault();
    const isPinned = pinnedIds.includes(appId);
    
    const items = [];
    items.push({ label: 'Open', icon: <Play size={14}/>, onClick: () => openWindow(appId as any, APP_REGISTRY.find(a=>a.id===appId)?.label || appId) });
    
    if (isPinned) {
      items.push({ label: 'Unpin from Taskbar', icon: <PinOff size={14}/>, onClick: () => togglePin(appId) });
    } else {
      items.push({ label: 'Pin to Taskbar', icon: <Pin size={14}/>, onClick: () => togglePin(appId) });
    }
    
    if (isRunning && windowId) {
      items.push({ divider: true, onClick: () => {} });
      items.push({ label: 'Close Window', icon: <X size={14}/>, danger: true, onClick: () => useOS.getState().closeWindow(windowId) });
    }

    showMenu(e, items);
  };

  const pinnedApps = pinnedIds
    .map(id => APP_REGISTRY.find(a => a.id === id))
    .filter(Boolean) as typeof APP_REGISTRY;

  // ─── Mobile: thin top status strip + bottom nav bar with a full-screen
  // app grid instead of the desktop's small floating popover — everything
  // here uses much larger tap targets (44px+) and drops desktop-only
  // concepts that don't translate to a phone screen (virtual desktops, the
  // separate "running windows" strip — moot when only one app is ever
  // visible at a time, see Window.tsx's full-screen mobile mode). ───────
  if (isMobile) {
    const activeWin = windows.find(w => w.id === activeWindowId && !w.isMinimized);
    const goHome = () => { if (activeWin) minimizeWindow(activeWin.id); };

    return (
      <>
        {/* Top status strip */}
        <div className="h-7 w-full bg-[var(--kernos-bg-taskbar)] backdrop-blur-2xl flex items-center justify-end gap-2 px-3 z-[9000] absolute top-0 select-none" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
          <UpdateAvailableChip />
          <GuestUsageChip />
          <Clock />
        </div>

        {/* Bottom nav */}
        <div
          className="h-16 w-full bg-[var(--kernos-bg-taskbar)] backdrop-blur-2xl border-t border-white/5 flex items-center px-2 gap-1 justify-between z-[9000] absolute bottom-0 select-none shadow-[0_-10px_40px_rgba(0,0,0,0.5)]"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <button
            onClick={goHome}
            className="flex flex-col items-center justify-center gap-0.5 w-14 h-12 rounded-xl text-gray-400 active:bg-white/10 active:text-cyan-400 transition-colors"
            aria-label="Home"
          >
            <Home size={20} />
          </button>

          <div className="flex-1 flex items-center gap-1 overflow-x-auto px-1">
            {pinnedApps.slice(0, 5).map(app => {
              const isRunning = windows.some(w => w.appId === app.id);
              return (
                <button
                  key={app.id}
                  onClick={() => openWindow(app.id as any, app.label)}
                  className={`relative flex flex-col items-center justify-center gap-0.5 w-14 h-12 shrink-0 rounded-xl transition-colors ${app.color} ${isRunning ? 'bg-white/5' : 'active:bg-white/10'}`}
                  aria-label={app.label}
                >
                  {iconForAppId(app.id, 20)}
                  <div className={`absolute bottom-1 w-1 h-1 rounded-full ${isRunning ? 'bg-cyan-400 shadow-[0_0_6px_rgba(0,240,255,0.8)]' : 'bg-transparent'}`} />
                </button>
              );
            })}
          </div>

          <button
            onClick={() => setMenuOpen(true)}
            className="flex flex-col items-center justify-center gap-0.5 w-14 h-12 rounded-xl text-cyan-400 active:bg-white/10 transition-colors"
            aria-label="All Apps"
          >
            <Grid3x3 size={20} />
          </button>
        </div>

        {/* Full-screen app grid */}
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
              className="fixed inset-0 z-[9500] bg-[var(--kernos-bg-taskbar)] backdrop-blur-2xl flex flex-col"
              style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
            >
              <div className="flex items-center justify-between px-5 pt-4 pb-2">
                <span className="text-xs font-mono uppercase tracking-widest text-gray-500">Applications</span>
                <button onClick={() => setMenuOpen(false)} className="p-2 -mr-2 text-gray-400 active:text-white" aria-label="Close">
                  <X size={22} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto grid grid-cols-4 gap-2 p-4 content-start">
                {APP_REGISTRY.map(app => {
                  const isPinned = pinnedIds.includes(app.id);
                  return (
                    <button
                      key={app.id}
                      onClick={() => { openWindow(app.id as any, app.label); setMenuOpen(false); }}
                      onContextMenu={(e) => { e.preventDefault(); togglePin(app.id); }}
                      className="flex flex-col items-center gap-1.5 p-3 rounded-xl active:bg-white/10 transition-colors"
                    >
                      <span className={`${app.color} ${isPinned ? 'opacity-100' : 'opacity-70'}`}>{iconForAppId(app.id, 28)}</span>
                      <span className="text-[10px] text-gray-400 text-center leading-tight font-mono">{app.label}</span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  }

  return (
    <>
      <TitleBarOverlay />
      <motion.div
      initial={{ y: 50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: 'spring', damping: 20, stiffness: 200, delay: 0.2 }}
      className="h-[52px] w-full bg-[var(--kernos-bg-taskbar)] backdrop-blur-2xl border-t border-white/5 flex items-center px-4 justify-between z-[9000] absolute bottom-0 select-none shadow-[0_-10px_40px_rgba(0,0,0,0.5)]"
    >
      <div className="flex items-center h-full gap-2">
        {/* Hamburger / App Launcher — ALL apps */}
        <div className="relative flex items-center" ref={menuRef}>
          <TipButton label="All Apps" onClick={() => setMenuOpen(o => !o)} className="p-2 rounded-lg hover:bg-white/10 text-cyan-400 transition-colors">
            {menuOpen ? <X size={22} /> : <Menu size={22} />}
          </TipButton>

          <AnimatePresence>
            {menuOpen && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10, transition: { duration: 0.15 } }}
                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                className="absolute bottom-[60px] left-0 w-64 bg-[var(--kernos-bg-taskbar-solid)] backdrop-blur-3xl border border-white/10 rounded-xl shadow-2xl shadow-black/80 p-2 flex flex-col gap-0.5 z-[999]"
              >
                <div className="px-3 py-2 text-[10px] text-gray-500 font-mono uppercase tracking-widest border-b border-white/5 mb-2">Applications</div>
                {APP_REGISTRY.map(app => {
                  const isPinned = pinnedIds.includes(app.id);
                  return (
                    <div key={app.id} className="flex items-center group">
                      <button
                        onClick={() => { openWindow(app.id as any, app.label); setMenuOpen(false); }}
                        className="flex-1 flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
                      >
                        <span className={app.color}>{iconForAppId(app.id, 16)}</span>
                        <span className="font-mono text-[11px] tracking-wide">{app.label}</span>
                      </button>
                      <button
                        onClick={() => togglePin(app.id)}
                        className={`p-2 rounded-md opacity-0 group-hover:opacity-100 transition-opacity ${isPinned ? 'text-cyan-400 hover:text-red-400 hover:bg-red-500/10' : 'text-gray-600 hover:text-cyan-400 hover:bg-cyan-500/10'}`}
                        title={isPinned ? 'Unpin from taskbar' : 'Pin to taskbar'}
                      >
                        {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
                      </button>
                    </div>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="h-6 w-px bg-white/10 mx-2" />

        {/* Pinned Apps — user customizable */}
        <div className="flex gap-1 h-full items-center">
          {pinnedApps.map(app => {
            const runningWin = windows.find(w => w.appId === app.id);
            const isRunning = !!runningWin;
            return (
              <div key={app.id} className="relative h-full flex items-center justify-center w-12 group">
                <TipButton
                  label={`${app.label}`}
                  onClick={() => openWindow(app.id as any, app.label)}
                  onContextMenu={(e) => handleContextMenu(e, app.id, isRunning, runningWin?.id)}
                  className={`p-2.5 rounded-xl transition-colors ${isRunning ? 'bg-white/5' : 'hover:bg-white/5'} ${app.color} opacity-80 group-hover:opacity-100`}
                >
                  {iconForAppId(app.id, 20)}
                </TipButton>
                {/* Active Indicator */}
                <div className={`absolute bottom-0 w-1.5 h-1.5 rounded-full transition-all duration-300 ${isRunning ? 'bg-cyan-400 shadow-[0_0_8px_rgba(0,240,255,0.8)]' : 'bg-transparent'}`} />
              </div>
            );
          })}
        </div>

        <div className="h-6 w-px bg-white/10 mx-2" />

        {/* Running Windows (Not Pinned, Current Desktop) */}
        <div className="flex gap-1 h-full items-center">
          <AnimatePresence mode="popLayout">
            {windows
              .filter(win => win.desktopIndex === useOS.getState().currentDesktop && !pinnedIds.includes(win.appId))
              .map(win => {
                const appDef = APP_REGISTRY.find(a => a.id === win.appId);
                const isActive = win.id === activeWindowId && !win.isMinimized;
                return (
                  <motion.div 
                    key={win.id}
                    initial={{ opacity: 0, width: 0, scale: 0.8 }}
                    animate={{ opacity: 1, width: 'auto', scale: 1 }}
                    exit={{ opacity: 0, width: 0, scale: 0.8, transition: { duration: 0.2 } }}
                    className="relative h-full flex items-center group"
                  >
                    <TipButton
                      label={win.title}
                      onClick={() => win.id === activeWindowId && !win.isMinimized ? minimizeWindow(win.id) : focusWindow(win.id)}
                      onContextMenu={(e) => handleContextMenu(e, win.appId, true, win.id)}
                      className={`
                        mx-1 px-3 py-1.5 rounded-xl flex items-center gap-2 text-sm border transition-all duration-300
                        ${isActive
                          ? 'bg-white/10 border-white/20 text-white shadow-[0_0_15px_rgba(255,255,255,0.05)]'
                          : 'bg-transparent border-transparent text-gray-400 hover:bg-white/5 hover:text-gray-200'}
                      `}
                    >
                      <span className={appDef?.color || 'text-cyan-400'}>{iconForAppId(win.appId, 16)}</span>
                      <span className="truncate max-w-[120px] font-mono text-[11px] tracking-wide">{win.title}</span>
                    </TipButton>
                    {/* Active Indicator */}
                    <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-8 h-[2px] rounded-t-full bg-cyan-400/80 shadow-[0_0_8px_rgba(0,240,255,0.8)]" />
                  </motion.div>
                );
              })}
          </AnimatePresence>
        </div>
      </div>

      <div className="flex items-center gap-4">
        {/* Virtual Desktops (Moved to right side for balance) */}
        <div className="flex gap-1 bg-[#1a1a20]/80 rounded-lg p-1 border border-white/5">
          {[0, 1, 2, 3].map(idx => (
            <button
              key={idx}
              onClick={() => useOS.getState().switchDesktop(idx)}
              className={`w-7 h-6 rounded flex items-center justify-center text-[10px] font-mono transition-all duration-200 ${
                useOS.getState().currentDesktop === idx
                  ? 'bg-cyan-500 text-white shadow-[0_0_10px_rgba(0,240,255,0.4)]'
                  : 'text-gray-500 hover:bg-white/10 hover:text-white'
              }`}
            >
              {idx + 1}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-black/40 border border-white/5 backdrop-blur-sm">
          <div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)] animate-pulse" />
          <span className="text-[10px] text-gray-400 font-mono tracking-widest hidden sm:block">ONLINE</span>
        </div>
        <UpdateAvailableChip />
        <GuestUsageChip />
        <Clock />
      </div>
      </motion.div>
    </>
  );
};