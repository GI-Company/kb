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

  // Faster/lower-overhead mode, not a feature-reduced one: skips the
  // cinematic boot animation, hides decorative desktop chrome, and
  // disables window open/close/drag spring physics. Persisted so it
  // survives a reload.
  liteMode: boolean;
  setLiteMode: (v: boolean) => void;

  // components/ui/Walkthrough.tsx reads this — App.tsx opens it once
  // automatically on a user's first desktop visit; Settings.tsx's
  // "Take the Tour" button re-opens it manually any time after.
  walkthroughOpen: boolean;
  openWalkthrough: () => void;
  closeWalkthrough: () => void;
}

function readLiteModePref(): boolean {
  try {
    return localStorage.getItem('kernos_lite_mode') === 'true';
  } catch {
    return false;
  }
}

export const useOS = create<OSStore>((set) => ({
  windows: [],
  shortcuts: [],
  activeWindowId: '3',
  currentDesktop: 0,
  walkthroughOpen: false,
  openWalkthrough: () => set({ walkthroughOpen: true }),
  closeWalkthrough: () => set({ walkthroughOpen: false }),
  liteMode: readLiteModePref(),
  setLiteMode: (v) => {
    try { localStorage.setItem('kernos_lite_mode', String(v)); } catch { /* best-effort */ }
    set({ liteMode: v });
  },

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
    if (appId === 'local-model') { width = 1020; height = 660; }

    const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const viewportH = typeof window !== 'undefined' ? window.innerHeight - 52 : 800; // minus taskbar

    // Cap the window's actual size to the viewport too, not just its
    // position — the fixed per-app sizes above (CDE 1100x700, Local Model
    // 1020x660, ...) are upper bounds, not requirements. Without this a
    // wide window on a smaller screen kept its full fixed size and either
    // visually dominated the viewport or overflowed it outright, even
    // though the earlier position-clamping fix kept its top-left corner
    // on screen.
    width = Math.min(width, viewportW - 40);
    height = Math.min(height, viewportH - 40);

    // Cascade new windows down-right, but wrap around and clamp to the
    // viewport instead of drifting further off-screen with every open —
    // previously this grew unbounded (100 + count*20 forever), so the 5th+
    // window could spawn already partly or fully off-screen.
    const cascade = state.windows.length % 8;
    const x = Math.min(80 + cascade * 24, Math.max(20, viewportW - width - 20));
    const y = Math.min(60 + cascade * 24, Math.max(20, viewportH - height - 20));

    const newWindow: WindowState = {
      id,
      appId,
      title: title || appId.charAt(0).toUpperCase() + appId.slice(1),
      x,
      y,
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

  // Clamped so a window can never be dragged fully off-screen with no way
  // back — at least `minVisible` px of its width, and its whole title bar
  // height, always stay within the viewport.
  moveWindow: (id, x, y) => set((state) => {
    const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const viewportH = typeof window !== 'undefined' ? window.innerHeight - 52 : 800;
    const minVisible = 80;
    return {
      windows: state.windows.map(w => {
        if (w.id !== id) return w;
        const clampedX = Math.min(Math.max(x, minVisible - w.width), viewportW - minVisible);
        const clampedY = Math.min(Math.max(y, 0), Math.max(0, viewportH - 40));
        return { ...w, x: clampedX, y: clampedY };
      })
    };
  }),

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