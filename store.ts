import { create } from 'zustand';
import { WindowState, DesktopShortcut } from './types';

interface OSStore {
  windows: WindowState[];
  shortcuts: DesktopShortcut[];
  activeWindowId: string | null;

  openWindow: (appId: WindowState['appId'], title?: string, data?: any) => void;
  closeWindow: (id: string) => void;
  focusWindow: (id: string) => void;
  moveWindow: (id: string, x: number, y: number) => void;
  resizeWindow: (id: string, width: number, height: number) => void;
  minimizeWindow: (id: string) => void;
  maximizeWindow: (id: string) => void;
  currentDesktop: number;
  switchDesktop: (index: number) => void;
  moveWindowToDesktop: (id: string, index: number) => void;
}

export const useOS = create<OSStore>((set) => ({
  windows: [],
  shortcuts: [],
  activeWindowId: '3',
  currentDesktop: 0,

  openWindow: (appId, title, data) => set((state) => {
    const id = Math.random().toString(36).substring(2, 9);

    // Default dimensions based on app type
    let width = 600;
    let height = 400;
    if (appId === 'monitor') { width = 400; height = 300; }
    if (appId === 'ai-chat') { width = 500; height = 500; }
    if (appId === 'agents') { width = 450; height = 500; }
    if (appId === 'metrics') { width = 450; height = 500; }
    if (appId === 'settings') { width = 450; height = 500; }
    if (appId === 'multi-agents') { width = 700; height = 550; }
    if (appId === 'cde') { width = 1100; height = 700; }
    if (appId === 'local-model') { width = 900; height = 600; }

    const newWindow: WindowState = {
      id,
      appId,
      title: title || appId.charAt(0).toUpperCase() + appId.slice(1),
      x: 100 + (state.windows.length * 20),
      y: 100 + (state.windows.length * 20),
      width,
      height,
      zIndex: state.windows.length + 1,
      isMinimized: false,
      isMaximized: false,
      desktopIndex: state.currentDesktop,
      data
    };
    return { windows: [...state.windows, newWindow], activeWindowId: id };
  }),

  closeWindow: (id) => set((state) => ({
    windows: state.windows.filter(w => w.id !== id),
    activeWindowId: state.windows.length > 1 ? state.windows[state.windows.length - 2].id : null
  })),

  focusWindow: (id) => set((state) => {
    const maxZ = Math.max(...state.windows.map(w => w.zIndex), 0);
    return {
      activeWindowId: id,
      windows: state.windows.map(w => w.id === id ? { ...w, zIndex: maxZ + 1, isMinimized: false } : w)
    };
  }),

  moveWindow: (id, x, y) => set((state) => ({
    windows: state.windows.map(w => w.id === id ? { ...w, x, y } : w)
  })),

  resizeWindow: (id, width, height) => set((state) => ({
    windows: state.windows.map(w => w.id === id ? { ...w, width, height } : w)
  })),

  minimizeWindow: (id) => set((state) => ({
    windows: state.windows.map(w => w.id === id ? { ...w, isMinimized: true } : w),
    activeWindowId: null
  })),

  maximizeWindow: (id) => set((state) => ({
    windows: state.windows.map(w => w.id === id ? { ...w, isMaximized: !w.isMaximized } : w)
  })),

  switchDesktop: (index: number) => set((state) => {
    // Bring focus to the top window of the new desktop
    const desktopWindows = state.windows.filter(w => w.desktopIndex === index && !w.isMinimized);
    let topWinId = null;
    let maxZ = -1;
    for (const w of desktopWindows) {
      if (w.zIndex > maxZ) {
        maxZ = w.zIndex;
        topWinId = w.id;
      }
    }
    return { currentDesktop: index, activeWindowId: topWinId };
  }),

  moveWindowToDesktop: (id: string, index: number) => set((state) => ({
    windows: state.windows.map(w => w.id === id ? { ...w, desktopIndex: index } : w)
  }))
}));