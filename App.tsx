import React, { useEffect, useState } from 'react';
import { useOS } from './store';
import { Taskbar } from './components/ui/Taskbar';
import { Window } from './components/ui/Window';
import { TerminalApp } from './apps/Terminal';
import { EditorApp } from './apps/Editor';
import { CDEApp } from './apps/CDE';
import { MonitorApp } from './apps/Monitor';
import { FileSystemApp } from './apps/FileSystem';
import { TaskRunnerApp } from './apps/TaskRunner';
import { AIChatApp } from './apps/AIChat';
import { AgentMonitorApp } from './apps/AgentMonitor';
import { LocalModelApp } from './apps/LocalModel';
import { DynamicApplet } from './components/apps/DynamicApplet';
import { AudioSystem } from './components/ui/AudioSystem';
import { Desktop } from './components/ui/Desktop';
import { ToastSystem } from './components/ui/ToastSystem';
import { SystemMetricsApp } from './apps/SystemMetrics';
import { SettingsApp } from './apps/Settings';
import { BIOSSetup } from './components/BIOSSetup';
import { LoginScreen } from './components/LoginScreen';
import { MultiAgentWorkspace } from './apps/MultiAgentWorkspace';
import { TimelineSlider } from './apps/TimelineSlider';
import { CinematicBoot } from './components/ui/CinematicBoot';
import { ContextMenuProvider } from './components/ui/ContextMenu';
import { Walkthrough, WALKTHROUGH_SEEN_KEY } from './components/ui/Walkthrough';
import { kernel } from './services/kernel';
import { AppUser, getSession, createGuestUser } from './lib/auth';
import { identifyUser } from './lib/analytics';
import { AnimatePresence } from 'framer-motion';

type BootPhase = 'boot' | 'bios' | 'login' | 'desktop';

const App: React.FC = () => {
  const { windows, liteMode, openWalkthrough } = useOS();
  const [phase, setPhase] = useState<BootPhase>('boot');
  const [bootLines, setBootLines] = useState<string[]>([]);
  const [user, setUser] = useState<AppUser | null>(null);
  const [biosRequested, setBiosRequested] = useState(false);

  // Listen for right-click during boot to enter BIOS
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (e.button === 2 && phase === 'boot') {
        e.preventDefault();
        setBiosRequested(true);
      }
    };
    const preventMenu = (e: MouseEvent) => {
      if (phase === 'boot') e.preventDefault();
    };
    window.addEventListener('mousedown', handler);
    window.addEventListener('contextmenu', preventMenu);
    return () => {
      window.removeEventListener('mousedown', handler);
      window.removeEventListener('contextmenu', preventMenu);
    };
  }, [phase]);

  const enterDesktop = (u: AppUser) => {
    // Guests stay anonymous by design (see lib/analytics.ts's
    // person_profiles: 'identified_only') — only real accounts get tied
    // to a persistent analytics identity.
    if (!u.isGuest) identifyUser(u.id, { username: u.username });
    setUser(u);
    setPhase('desktop');
  };

  // First-ever desktop visit auto-opens the walkthrough — deliberately a
  // separate effect keyed on `phase`, not called inline in enterDesktop,
  // so it only fires once the desktop (and its taskbar, which the tour
  // spotlights) has actually mounted to the DOM.
  useEffect(() => {
    if (phase !== 'desktop') return;
    let seen = true;
    try { seen = localStorage.getItem(WALKTHROUGH_SEEN_KEY) === 'true'; } catch { /* default to seen=true, don't nag if storage is unavailable */ }
    if (!seen) openWalkthrough();
  }, [phase]);

  // Real Supabase session takes priority; otherwise a previously-chosen
  // local guest identity; otherwise show the login screen (which itself
  // offers a no-friction "Continue as Guest" escape hatch).
  const resolveSessionAndEnter = async () => {
    const sessionUser = await getSession();
    if (sessionUser) {
      enterDesktop(sessionUser);
      return;
    }

    const savedGuest = localStorage.getItem('kernos_guest_user');
    if (savedGuest) {
      try {
        enterDesktop(JSON.parse(savedGuest));
        return;
      } catch {
        // Corrupt saved session — fall through to login.
      }
    }

    setPhase('login');
  };

  const handleBootComplete = () => {
    if (biosRequested) {
      setPhase('bios');
      return;
    }
    resolveSessionAndEnter();
  };

  // Lite mode skips the cinematic boot animation entirely (and with it,
  // the right-click-to-enter-BIOS affordance — an acceptable tradeoff for
  // a mode whose whole point is "get to the desktop fast").
  useEffect(() => {
    if (liteMode && phase === 'boot') {
      resolveSessionAndEnter();
    }
  }, [liteMode]);

  const handleLogin = (loggedInUser: AppUser) => {
    enterDesktop(loggedInUser);
  };

  const handleGuestAccess = () => {
    const guest = createGuestUser();
    localStorage.setItem('kernos_guest_user', JSON.stringify(guest));
    enterDesktop(guest);
  };

  const getAppContent = (appId: string, data?: any) => {
    switch (appId) {
      case 'terminal': return <TerminalApp />;
      case 'editor': return <EditorApp {...data} />;
      case 'monitor': return <MonitorApp />;
      case 'files': return <FileSystemApp />;
      case 'tasks': return <TaskRunnerApp />;
      case 'ai-chat': return <AIChatApp />;
      case 'agents': return <AgentMonitorApp />;
      case 'local-model': return <LocalModelApp />;
      case 'applet': return <DynamicApplet appletId={data?.appletId} sourceCode={data?.sourceCode} />;
      case 'metrics': return <SystemMetricsApp />;
      case 'settings': return <SettingsApp />;
      case 'multi-agents': return <MultiAgentWorkspace />;
      case 'cde': return <CDEApp />;
      case 'timeline': return <TimelineSlider />;
      default: return <div className="p-4 text-red-500">App not found</div>;
    }
  };

  // ─── BOOT SCREEN ───
  if (phase === 'boot') {
    if (liteMode) return null; // resolveSessionAndEnter() above takes over immediately
    return (
      <AnimatePresence>
        <CinematicBoot onComplete={handleBootComplete} />
      </AnimatePresence>
    );
  }

  // ─── BIOS SETUP ───
  if (phase === 'bios') {
    return <BIOSSetup onExit={() => { setBiosRequested(false); resolveSessionAndEnter(); }} />;
  }

  // ─── LOGIN SCREEN ───
  if (phase === 'login') {
    return <LoginScreen onLogin={handleLogin} onGuestAccess={handleGuestAccess} />;
  }

  // ─── DESKTOP ───
  return (
    <ContextMenuProvider>
      <div className="w-screen h-screen bg-[#050505] overflow-hidden relative selection:bg-cyan-500/30">
        {/* Dynamic Background Grid — decorative only, skipped in lite mode */}
        {!liteMode && (
          <div
            className="absolute inset-0 pointer-events-none opacity-20"
            style={{
              backgroundImage: `linear-gradient(to right, #1f1f1f 1px, transparent 1px), linear-gradient(to bottom, #1f1f1f 1px, transparent 1px)`,
              backgroundSize: '40px 40px'
            }}
          />
        )}

        {/* Desktop Area */}
        <div className="absolute inset-0 z-0">
          <Desktop />
          {/* Logo / Watermark — decorative only, skipped in lite mode */}
          {!liteMode && (
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none opacity-30">
              <h1 className="text-9xl font-black text-white/15 tracking-tighter">KERNOS</h1>
              <p className="text-white/25 font-mono mt-4 tracking-[1em]">BROWSER NATIVE OS</p>
            </div>
          )}
        </div>

        <ToastSystem />

        {/* Window Layer */}
        {windows.filter(win => win.desktopIndex === useOS.getState().currentDesktop).map(win => (
          <Window key={win.id} data={win} liteMode={liteMode}>
            {getAppContent(win.appId, win.data)}
          </Window>
        ))}

        <Taskbar />
        <AudioSystem />
        <Walkthrough />
      </div>
    </ContextMenuProvider>
  );
};

export default App;