import React, { useState, useRef, useEffect } from 'react';
import { useOS } from '../../store';
import { WindowState, COLORS } from '../../types';
import { X, Minus, Square, Terminal, Monitor, FileCode, HardDrive, Cpu, Workflow, Package, Bot, Brain, FolderGit2, Activity, Settings, HelpCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { FEATURE_TOURS } from '../../lib/featureTours';

interface WindowProps {
  data: WindowState;
  children: React.ReactNode;
  liteMode?: boolean;
}

export const Window: React.FC<WindowProps> = ({ data, children, liteMode }) => {
  const { closeWindow, focusWindow, moveWindow, resizeWindow, minimizeWindow, maximizeWindow, openFeatureTour, isMobile } = useOS();
  const hasTour = !!FEATURE_TOURS[data.appId];
  const [isDragging, setIsDragging] = useState(false);
  const [snapZone, setSnapZone] = useState<'left' | 'right' | 'top' | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const preSnapSize = useRef({ width: data.width, height: data.height, x: data.x, y: data.y });

  const SNAP_THRESHOLD = 20;

  // Pointer Events (not Mouse Events) so this same handler drives mouse,
  // touch, AND pen uniformly — mousedown/mousemove/mouseup never fire for
  // touch input at all, which left window dragging completely non-
  // functional on any touchscreen (tablets in particular, since phones get
  // their own full-screen mode below and never drag windows in the first
  // place).
  const handlePointerDown = (e: React.PointerEvent) => {
    focusWindow(data.id);
    if (!data.isMaximized && !isMobile) {
      setIsDragging(true);
      preSnapSize.current = { width: data.width, height: data.height, x: data.x, y: data.y };
      dragOffset.current = {
        x: e.clientX - data.x,
        y: e.clientY - data.y
      };
    }
  };

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      if (isDragging) {
        const newX = e.clientX - dragOffset.current.x;
        const newY = e.clientY - dragOffset.current.y;
        moveWindow(data.id, newX, newY);

        // Detect snap zones
        const vw = window.innerWidth;
        if (e.clientX <= SNAP_THRESHOLD) {
          setSnapZone('left');
        } else if (e.clientX >= vw - SNAP_THRESHOLD) {
          setSnapZone('right');
        } else if (e.clientY <= SNAP_THRESHOLD) {
          setSnapZone('top');
        } else {
          setSnapZone(null);
        }
      }
    };

    const handlePointerUp = () => {
      if (isDragging && snapZone) {
        const vw = window.innerWidth;
        const vh = window.innerHeight - 52; // subtract taskbar height

        if (snapZone === 'left') {
          moveWindow(data.id, 0, 0);
          resizeWindow(data.id, vw / 2, vh);
        } else if (snapZone === 'right') {
          moveWindow(data.id, vw / 2, 0);
          resizeWindow(data.id, vw / 2, vh);
        } else if (snapZone === 'top') {
          maximizeWindow(data.id);
        }
      }
      setIsDragging(false);
      setSnapZone(null);
    };

    if (isDragging) {
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    }
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isDragging, snapZone, data.id, moveWindow, resizeWindow, maximizeWindow]);

  const getIcon = () => {
    switch (data.appId) {
      case 'terminal': return <Terminal size={14} className="text-cyan-400" />;
      case 'editor': return <FileCode size={14} className="text-purple-400" />;
      case 'monitor': return <Monitor size={14} className="text-orange-400" />;
      case 'packages': return <Package size={16} className="text-gray-400" />;
      case 'ai-chat': return <Brain size={16} className="text-pink-400" />;
      case 'agents': return <Bot size={16} className="text-blue-400" />;
      case 'semantic-vfs': return <FolderGit2 size={16} className="text-pink-400" />;
      case 'metrics': return <Activity size={16} className="text-cyan-400" />;
      case 'settings': return <Settings size={16} className="text-yellow-400" />;
      case 'multi-agents': return <Bot size={16} className="text-purple-400" />;
      default: return <Terminal size={16} className="text-gray-400" />;
    }
  };

  const isActive = data.id === useOS.getState().activeWindowId;
  const borderClass = isActive
    ? 'border-cyan-500/30 shadow-[0_0_50px_rgba(0,240,255,0.15)] ring-1 ring-cyan-500/20'
    : 'border-white/10 shadow-2xl shadow-black/80';

  // Mobile ignores the stored x/y/width/height entirely and fits exactly
  // between Taskbar.tsx's mobile top status strip (h-7 = 28px, plus
  // whatever safe-area-inset-top a notch adds) and bottom nav (h-16 =
  // 64px, plus safe-area-inset-bottom) — expressed as env()/calc() rather
  // than hardcoded pixels so it stays correct across rotation, viewport
  // changes, and notched devices without the two components needing to
  // agree on numbers any other way than "read the same CSS env vars".
  const style = isMobile
    ? {
        top: 'calc(env(safe-area-inset-top, 0px) + 28px)',
        left: 0,
        width: '100%',
        height: 'calc(100% - env(safe-area-inset-top, 0px) - 28px - env(safe-area-inset-bottom, 0px) - 64px)',
      }
    : data.isMaximized
    ? { top: 0, left: 0, width: '100%', height: 'calc(100% - 52px)' }
    : { top: data.y, left: data.x, width: data.width, height: data.height };

  return (
    <AnimatePresence>
      {!data.isMinimized && (
        <motion.div
          initial={liteMode ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 10 }}
          animate={liteMode ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
          exit={liteMode ? { opacity: 0, transition: { duration: 0.05 } } : { opacity: 0, scale: 0.95, y: 20, transition: { duration: 0.15 } }}
          transition={liteMode ? { duration: 0.08 } : { type: 'spring', damping: 25, stiffness: 300 }}
          style={{ ...style, zIndex: data.zIndex, position: 'absolute' }}
          className={`flex flex-col bg-[#0f0f13]/85 backdrop-blur-2xl ${isMobile ? '' : 'rounded-xl'} overflow-hidden ${liteMode ? '' : 'transition-[box-shadow,border-color] duration-300'} ${isMobile ? 'border-0' : borderClass}`}
          onPointerDown={() => focusWindow(data.id)}
        >
          {/* Title Bar - Glassmorphic */}
          <div
            onPointerDown={handlePointerDown}
            className={`h-10 flex items-center justify-between px-3 bg-gradient-to-b from-white/[0.08] to-transparent border-b border-white/[0.06] select-none backdrop-blur-md transition-colors duration-300 ${isMobile ? '' : 'touch-none cursor-default active:cursor-grabbing'} ${isActive ? 'bg-white/[0.05]' : 'bg-transparent'}`}
          >
            {/* Window Controls (Traffic Lights) */}
            <div className="flex items-center gap-2 group w-[60px]">
              <button
                onClick={(e) => { e.stopPropagation(); closeWindow(data.id); }}
                className="w-3 h-3 rounded-full bg-red-500/80 hover:bg-red-400 flex items-center justify-center border border-red-500/50 shadow-[0_0_10px_rgba(239,68,68,0.4)] transition-all"
              >
                <X size={8} className="text-red-900 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); minimizeWindow(data.id); }}
                className="w-3 h-3 rounded-full bg-yellow-500/80 hover:bg-yellow-400 flex items-center justify-center border border-yellow-500/50 shadow-[0_0_10px_rgba(234,179,8,0.4)] transition-all"
                title={isMobile ? 'Home' : 'Minimize'}
              >
                <Minus size={8} className="text-yellow-900 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
              {!isMobile && (
                <button
                  onClick={(e) => { e.stopPropagation(); maximizeWindow(data.id); }}
                  className="w-3 h-3 rounded-full bg-green-500/80 hover:bg-green-400 flex items-center justify-center border border-green-500/50 shadow-[0_0_10px_rgba(34,197,94,0.4)] transition-all"
                >
                  <Square size={6} className="text-green-900 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              )}
            </div>

            {/* Title */}
            <div className="flex flex-1 items-center justify-center gap-2 pointer-events-none">
              {getIcon()}
              <span className={`text-[11px] font-semibold tracking-wider ${isActive ? 'text-gray-200' : 'text-gray-500'} transition-colors duration-300`}>
                {data.title}
              </span>
            </div>

            {/* Balances the traffic-light cluster's width; also hosts the
                per-app tour trigger when this app has one registered. */}
            <div className="w-[60px] flex items-center justify-end">
              {hasTour && (
                <button
                  onClick={(e) => { e.stopPropagation(); openFeatureTour(data.appId); }}
                  className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-purple-400 transition-colors"
                  title="Feature tour"
                >
                  <HelpCircle size={13} />
                </button>
              )}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-hidden relative bg-black/20">
            {children}
          </div>

          {/* Minimalist Footer */}
          <div className={`h-4 border-t border-white/5 flex items-center px-2 transition-colors duration-300 ${isActive ? 'bg-white/[0.02]' : 'bg-transparent'}`}>
            <div className="text-[9px] text-gray-500/50 font-mono tracking-widest uppercase">
              PID: {data.id.split('-')[0]}
            </div>
          </div>

          {/* Visual Snap Indicator */}
          {isDragging && snapZone && (
            <div 
              className="fixed pointer-events-none bg-cyan-500/20 border-2 border-cyan-400/50 rounded-xl shadow-[0_0_40px_rgba(0,240,255,0.3)] backdrop-blur-sm transition-all duration-200 z-[9999]"
              style={{
                top: 4,
                left: snapZone === 'right' ? 'calc(50% + 2px)' : 4,
                width: snapZone === 'top' ? 'calc(100% - 8px)' : 'calc(50% - 6px)',
                height: snapZone === 'top' ? 'calc(100% - 56px)' : 'calc(100% - 56px)',
              }}
            />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};