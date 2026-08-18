import { create } from 'zustand';
import { WindowState, DesktopShortcut } from './types';
import { getSetting, subscribeSettings } from './lib/settings';
import { getTitlebarOverlayHeight } from './lib/windowControlsOverlay';

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

  // components/ui/FeatureTour.tsx reads this — Window.tsx's per-window "?"
  // button sets it to that window's appId to spotlight that app's own
  // controls (distinct from walkthroughOpen, which tours the taskbar).
  activeTourAppId: string | null;
  openFeatureTour: (appId: string) => void;
  closeFeatureTour: () => void;

  // Driven by lib/guestUsage.ts's heartbeat, only while the current user is
  // a guest — see App.tsx's tracking effect. null remainingSeconds means
  // "not a guest" or "server-side limit not configured", not "no time left".
  guestRemainingSeconds: number | null;
  guestLimitReached: boolean;
  /** True only until the first quota heartbeat settles — see lib/guestUsage.ts's GuestUsageState.checking. */
  guestCheckingQuota: boolean;
  setGuestUsage: (remainingSeconds: number | null, limitReached: boolean, checkingQuota: boolean) => void;

  // Below MOBILE_BREAKPOINT, App.tsx/Window.tsx/Taskbar.tsx switch to a
  // full-screen single-app layout instead of freely draggable/overlapping
  // windows — kept synced to the real viewport by the resize listener
  // below rather than read fresh in each component, so every consumer
  // (including openWindow's own sizing math) agrees on it within the same
  // render/action, not just "whichever one checked window.innerWidth last".
  isMobile: boolean;
  setIsMobile: (v: boolean) => void;

  // Set by index.tsx when the service worker's controller changes AFTER
  // one was already controlling this page load — i.e. a real update, not
  // the SW's first-ever activation. An installed standalone window has no
  // natural refresh gesture, so without this the already-loaded JS would
  // just keep running indefinitely against a SW now serving newer assets.
  updateAvailable: boolean;
  setUpdateAvailable: (v: boolean) => void;
}

function readLiteModePref(): boolean {
  try {
    return localStorage.getItem('kernos_lite_mode') === 'true';
  } catch {
    return false;
  }
}

export const MOBILE_BREAKPOINT = 768;

// A phone rotated to landscape is commonly WIDER than MOBILE_BREAKPOINT —
// an iPhone 14 Pro is 926px, most Android phones land around 780-915px —
// so a width-only check put those devices in desktop mode: hover-dependent
// dropdown menus that never open on a touchscreen, drag-to-move windows
// with no full-screen fallback, tiny click targets sized for a mouse.
// Reported live as "I can't do anything... all I see is the time and
// countdown timer" — that's the desktop taskbar's `justify-between` layout
// with too little width for its own content, on a screen with no way to
// trigger the things that would reveal more of it.
//
// The short edge (whichever of width/height is smaller) is what actually
// tells a phone-in-landscape and a tablet apart, which raw width alone
// cannot: a phone's short edge stays under ~430px in EITHER orientation,
// while a tablet's short edge starts around 768px (iPad mini portrait) and
// only gets larger from there. So mobile mode now triggers on width alone
// (portrait phones, and narrowing a desktop browser window for testing)
// OR on a touch-primary device whose short edge is phone-sized — which
// catches phone landscape without also catching tablets, which keep the
// existing floating/draggable desktop-style window mode on purpose (see
// Window.tsx's Pointer Events handling, added for tablet drag/resize).
const PHONE_SHORT_EDGE_MAX = 500;

/** Exported for store.test.ts — the browser-preview tool ties touch
 * emulation strictly to width < 768, so "landscape phone" (wide + touch)
 * isn't reachable through it; this is tested directly instead. */
export function computeIsMobile(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.innerWidth < MOBILE_BREAKPOINT) return true;
  // maxTouchPoints only, not 'ontouchstart' in window — the latter is a
  // known false-positive source, defined by some browsers regardless of
  // whether real touch hardware is present. Caught by this file's own
  // test: a stubbed non-touch, wide viewport still read as mobile until
  // this fallback was removed.
  const isTouchPrimary = navigator.maxTouchPoints > 0;
  const shortEdge = Math.min(window.innerWidth, window.innerHeight);
  return isTouchPrimary && shortEdge < PHONE_SHORT_EDGE_MAX;
}

// The single source every isMobile write below goes through — folds in
// Settings' "Force Desktop Mode" without touching computeIsMobile() itself,
// which is a carefully-tuned device heuristic (see its own comment) that
// has nothing to do with a user's explicit override. Every existing
// consumer of store.ts's isMobile field (Taskbar.tsx, Window.tsx) reads
// this one combined value, so neither needed a change to respect the
// setting.
function computeEffectiveIsMobile(): boolean {
  return computeIsMobile() && !getSetting('forceDesktopMode');
}

export const useOS = create<OSStore>((set) => ({
  windows: [],
  shortcuts: [],
  activeWindowId: '3',
  currentDesktop: 0,
  walkthroughOpen: false,
  openWalkthrough: () => set({ walkthroughOpen: true }),
  closeWalkthrough: () => set({ walkthroughOpen: false }),
  activeTourAppId: null,
  openFeatureTour: (appId) => set({ activeTourAppId: appId }),
  closeFeatureTour: () => set({ activeTourAppId: null }),
  guestRemainingSeconds: null,
  guestLimitReached: false,
  guestCheckingQuota: false,
  setGuestUsage: (remainingSeconds, limitReached, checkingQuota) =>
    set({ guestRemainingSeconds: remainingSeconds, guestLimitReached: limitReached, guestCheckingQuota: checkingQuota }),
  liteMode: readLiteModePref(),
  setLiteMode: (v) => {
    try { localStorage.setItem('kernos_lite_mode', String(v)); } catch { /* best-effort */ }
    set({ liteMode: v });
  },
  isMobile: computeEffectiveIsMobile(),
  setIsMobile: (v) => set({ isMobile: v }),

  updateAvailable: false,
  setUpdateAvailable: (v) => set({ updateAvailable: v }),

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

    let x: number;
    let y: number;

    if (state.isMobile) {
      // No floating/cascading windows on mobile — every window is
      // full-screen (Window.tsx renders it edge-to-edge and skips
      // drag/resize entirely there), so "opening an app" reads as
      // switching to it, phone-home-screen style. zIndex ordering below
      // already governs which one is actually visible.
      width = viewportW;
      height = viewportH;
      x = 0;
      y = 0;
    } else {
      // Cap the window's actual size to the viewport too, not just its
      // position — the fixed per-app sizes above (CDE 1100x700, Local Model
      // 1020x660, ...) are upper bounds, not requirements. A pure
      // viewport-minus-margin cap still lets a window eat ~95%+ of a laptop
      // screen (e.g. CDE's 1100x700 on a 1366x768 display), which reads as
      // "too large" even though nothing technically overflows — so also cap
      // to a fraction of the viewport, leaving visible desktop around it.
      const maxW = Math.min(viewportW - 40, viewportW * 0.82);
      const maxH = Math.min(viewportH - 40, viewportH * 0.82);
      width = Math.min(width, maxW);
      height = Math.min(height, maxH);

      // Cascade new windows down-right, but wrap around and clamp to the
      // viewport instead of drifting further off-screen with every open —
      // previously this grew unbounded (100 + count*20 forever), so the 5th+
      // window could spawn already partly or fully off-screen.
      const cascade = state.windows.length % 8;
      x = Math.min(80 + cascade * 24, Math.max(20, viewportW - width - 20));
      y = Math.min(60 + cascade * 24, Math.max(20, viewportH - height - 20));
    }

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
    // 0 in every non-WCO context (an ordinary tab, or an installed window
    // before WCO is honored) — see lib/windowControlsOverlay.ts. Only when
    // WCO is actually active does this become nonzero, keeping a dragged
    // window's own title bar (and its close/minimize/maximize controls)
    // from ending up rendered underneath Taskbar.tsx's title-bar strip.
    const minY = getTitlebarOverlayHeight();
    return {
      windows: state.windows.map(w => {
        if (w.id !== id) return w;
        const clampedX = Math.min(Math.max(x, minVisible - w.width), viewportW - minVisible);
        const clampedY = Math.min(Math.max(y, minY), Math.max(minY, viewportH - 40));
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

// Kept outside the store body (a plain window listener, not a component
// effect) so isMobile stays live even though nothing about resizing the
// browser is itself a store action — every consumer just reads
// useOS(s => s.isMobile) and re-renders like any other state change.
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    useOS.getState().setIsMobile(computeEffectiveIsMobile());
  });
  // Some mobile browsers have historically fired 'orientationchange'
  // measurably before 'resize' settles to the rotated dimensions (or, on
  // older WebViews, not fired a plain resize at all on rotation) — cheap
  // to also listen directly rather than trust resize alone to cover it.
  window.addEventListener('orientationchange', () => {
    useOS.getState().setIsMobile(computeEffectiveIsMobile());
  });
  // Toggling Force Desktop Mode in Settings should switch layouts
  // immediately, not wait for the next resize/rotation — subscribeSettings
  // fires on every settings change, not just this one, but recomputing
  // isMobile is cheap enough that filtering to just forceDesktopMode isn't
  // worth the extra bookkeeping.
  subscribeSettings(() => {
    useOS.getState().setIsMobile(computeEffectiveIsMobile());
  });
}