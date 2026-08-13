import React, { useState, useRef, useEffect } from 'react';
import { useOS } from '../../store';
import { WindowState, COLORS } from '../../types';
import { X, Minus, Square, Terminal, Monitor, FileCode, HardDrive, Cpu, Workflow, Package, Bot, Brain, FolderGit2, Activity, Settings } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface WindowProps {
  data: WindowState;
  children: React.ReactNode;
}

export const Window: React.FC<WindowProps> = ({ data, children }) => {
  const { closeWindow, focusWindow, moveWindow, resizeWindow, minimizeWindow, maximizeWindow } = useOS();
  const [isDragging, setIsDragging] = useState(false);
  const [snapZone, setSnapZone] = useState<'left' | 'right' | 'top' | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const preSnapSize = useRef({ width: data.width, height: data.height, x: data.x, y: data.y });

  const SNAP_THRESHOLD = 20;

  const handleMouseDown = (e: React.MouseEvent) => {
    focusWindow(data.id);
    if (!data.isMaximized) {
      setIsDragging(true);
      preSnapSize.current = { width: data.width, height: data.height, x: data.x, y: data.y };
      dragOffset.current = {
        x: e.clientX - data.x,
        y: e.clientY - data.y
      };
    }
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
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

    const handleMouseUp = () => {
      if (isDragging && snapZone) {
        const vw = window.innerWidth;
        const vh = window.innerHeight - 48; // subtract taskbar height

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
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
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

  const style = data.isMaximized
    ? { top: 0, left: 0, width: '100%', height: 'calc(100% - 48px)' }
    : { top: data.y, left: data.x, width: data.width, height: data.height };

  return (
    <AnimatePresence>
      {!data.isMinimized && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20, transition: { duration: 0.15 } }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          style={{ ...style, zIndex: data.zIndex, position: 'absolute' }}
          className={`flex flex-col bg-[#0f0f13]/85 backdrop-blur-2xl rounded-xl overflow-hidden transition-[box-shadow,border-color] duration-300 ${borderClass}`}
          onMouseDown={() => focusWindow(data.id)}
        >
          {/* Title Bar - Glassmorphic */}
          <div
            onMouseDown={handleMouseDown}
            className={`h-10 flex items-center justify-between px-3 bg-gradient-to-b from-white/[0.08] to-transparent border-b border-white/[0.06] select-none cursor-default active:cursor-grabbing backdrop-blur-md transition-colors duration-300 ${isActive ? 'bg-white/[0.05]' : 'bg-transparent'}`}
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
              >
                <Minus size={8} className="text-yellow-900 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
              <button 
                onClick={(e) => { e.stopPropagation(); maximizeWindow(data.id); }} 
                className="w-3 h-3 rounded-full bg-green-500/80 hover:bg-green-400 flex items-center justify-center border border-green-500/50 shadow-[0_0_10px_rgba(34,197,94,0.4)] transition-all"
              >
                <Square size={6} className="text-green-900 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            </div>

            {/* Title */}
            <div className="flex flex-1 items-center justify-center gap-2 pointer-events-none">
              {getIcon()}
              <span className={`text-[11px] font-semibold tracking-wider ${isActive ? 'text-gray-200' : 'text-gray-500'} transition-colors duration-300`}>
                {data.title}
              </span>
            </div>

            {/* Placeholder to balance the flex layout */}
            <div className="w-[60px]" />
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