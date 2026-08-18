// Window Controls Overlay (see public/manifest.webmanifest's
// display_override) — desktop-only, and only real once the app is actually
// installed with WCO honored by the browser/OS. A normal browser tab, and
// most installed contexts before the browser supports this, report
// navigator.windowControlsOverlay as undefined or .visible: false; every
// export here is inert (0 / false) in exactly those cases, so nothing that
// reads them needs its own feature-detection.
//
// Two consumers: components/ui/Taskbar.tsx's TitleBarOverlay draws Kernos's
// own strip into the title bar area, and components/ui/Window.tsx /
// store.ts's moveWindow need the same area's height so a window's own
// title bar (with its own close/minimize/maximize controls) never ends up
// rendered underneath that strip — maximizing in particular used to put it
// at a hardcoded top: 0, exactly where the overlay strip sits.

import { useState, useEffect } from 'react';

/**
 * Synchronous — usable outside React (store.ts's moveWindow drag clamp
 * isn't a component). 0 whenever WCO isn't active, so every caller's math
 * degrades to today's behavior for free in every non-WCO context.
 */
export function getTitlebarOverlayHeight(): number {
  if (typeof navigator === 'undefined') return 0;
  const wco = (navigator as any).windowControlsOverlay;
  if (!wco?.visible) return 0;
  return wco.getTitlebarAreaRect?.()?.height ?? 0;
}

/** Reactive version for components — re-renders on the API's own geometrychange event (window resize, or the OS controls moving for an RTL layout). */
export function useWindowControlsOverlay(): { visible: boolean; height: number } {
  const [state, setState] = useState(() => ({
    visible: !!(typeof navigator !== 'undefined' && (navigator as any).windowControlsOverlay?.visible),
    height: getTitlebarOverlayHeight(),
  }));
  useEffect(() => {
    const wco = (navigator as any).windowControlsOverlay;
    if (!wco) return;
    const update = () => setState({ visible: wco.visible, height: getTitlebarOverlayHeight() });
    update();
    wco.addEventListener('geometrychange', update);
    return () => wco.removeEventListener('geometrychange', update);
  }, []);
  return state;
}
