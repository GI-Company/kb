import { describe, it, expect, afterEach } from 'vitest';
import { computeIsMobile, MOBILE_BREAKPOINT, useOS } from './store';
import { setSetting } from './lib/settings';

// Reported live: "I can't do anything... all I see is the time and
// countdown timer" — then, separately, "needs to work in landscape mode".
// Traced to computeIsMobile() checking window.innerWidth alone. A phone
// rotated to landscape is commonly wider than MOBILE_BREAKPOINT (iPhone 14
// Pro: 926px; most Android phones: ~780-915px), so it fell into desktop
// mode — hover-dependent menus that never open on a touchscreen, and a
// taskbar layout with too little width for its own content, which is what
// "only the clock is visible" actually looks like.

function stubViewport(width: number, height: number, touchPoints: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { value: touchPoints, configurable: true });
}

afterEach(() => {
  stubViewport(1280, 800, 0); // restore a plain desktop-shaped environment
});

describe('computeIsMobile', () => {
  it('is true for a narrow width regardless of touch', () => {
    stubViewport(375, 812, 0); // portrait phone, but also: a narrowed desktop window
    expect(window.innerWidth).toBeLessThan(MOBILE_BREAKPOINT);
    expect(computeIsMobile()).toBe(true);
  });

  // The actual bug: width alone said "desktop" here.
  it('is true for a touch device in landscape, even though it is wider than the breakpoint', () => {
    stubViewport(926, 428, 5); // iPhone 14 Pro, landscape
    expect(window.innerWidth).toBeGreaterThan(MOBILE_BREAKPOINT);
    expect(computeIsMobile()).toBe(true);
  });

  it('is true for a smaller Android phone in landscape', () => {
    stubViewport(780, 360, 5);
    expect(computeIsMobile()).toBe(true);
  });

  // The reason this isn't just "touch => mobile": tablets are touch
  // devices too, and are meant to keep the floating/draggable desktop-style
  // windows (see Window.tsx's Pointer Events handling, built for tablet
  // drag/resize) rather than the phone's full-screen single-app mode.
  it('stays desktop mode for a touch tablet, in either orientation', () => {
    stubViewport(768, 1024, 5); // iPad mini, portrait — short edge 768
    expect(computeIsMobile()).toBe(false);
    stubViewport(1024, 768, 5); // iPad mini, landscape
    expect(computeIsMobile()).toBe(false);
  });

  it('stays desktop mode for a wide non-touch window (a real desktop browser)', () => {
    stubViewport(926, 428, 0); // same pixels as the iPhone case above, no touch
    expect(computeIsMobile()).toBe(false);
  });

  it('stays desktop mode for an ordinary desktop viewport', () => {
    stubViewport(1440, 900, 0);
    expect(computeIsMobile()).toBe(false);
  });
});

// Settings' "Force Desktop Mode" — store.ts's isMobile field is the AND of
// computeIsMobile() and this setting, kept live via a subscribeSettings
// listener rather than only recomputed on resize/rotation, so toggling it
// takes effect immediately without the user having to also resize the
// window to trigger a recheck.
describe('Force Desktop Mode overrides the device-detected isMobile', () => {
  afterEach(() => {
    setSetting('forceDesktopMode', false);
    stubViewport(1280, 800, 0);
    window.dispatchEvent(new Event('resize'));
  });

  it('a mobile-shaped viewport reports isMobile true by default', () => {
    stubViewport(375, 812, 0);
    window.dispatchEvent(new Event('resize'));
    expect(useOS.getState().isMobile).toBe(true);
  });

  it('enabling Force Desktop Mode flips isMobile to false immediately, without a resize', () => {
    stubViewport(375, 812, 0);
    window.dispatchEvent(new Event('resize'));
    expect(useOS.getState().isMobile).toBe(true);

    setSetting('forceDesktopMode', true);
    expect(useOS.getState().isMobile).toBe(false);
  });

  it('disabling it again restores mobile detection on the next resize', () => {
    stubViewport(375, 812, 0);
    setSetting('forceDesktopMode', true);
    window.dispatchEvent(new Event('resize'));
    expect(useOS.getState().isMobile).toBe(false);

    setSetting('forceDesktopMode', false);
    expect(useOS.getState().isMobile).toBe(true);
  });

  it('has no effect on an already-desktop-shaped viewport', () => {
    stubViewport(1440, 900, 0);
    window.dispatchEvent(new Event('resize'));
    expect(useOS.getState().isMobile).toBe(false);

    setSetting('forceDesktopMode', true);
    expect(useOS.getState().isMobile).toBe(false);
  });
});

// A window used to be draggable all the way to y: 0, which put its own
// title bar (with its own close/minimize/maximize controls) underneath
// Taskbar.tsx's WCO title-bar strip once window-controls-overlay was
// active — see lib/windowControlsOverlay.ts. moveWindow's Y clamp now
// respects that area's height instead of a hardcoded 0.
describe('moveWindow clamps Y to the WCO title bar height when it is active', () => {
  afterEach(() => {
    delete (navigator as any).windowControlsOverlay;
  });

  function stubWco(height: number) {
    (navigator as any).windowControlsOverlay = {
      visible: true,
      getTitlebarAreaRect: () => ({ height }),
    };
  }

  it('still clamps to 0 when WCO is not active (today\'s behavior, unchanged)', () => {
    useOS.getState().openWindow('terminal');
    const id = useOS.getState().activeWindowId!;
    useOS.getState().moveWindow(id, 100, -50);
    expect(useOS.getState().windows.find(w => w.id === id)!.y).toBe(0);
  });

  it('clamps to the WCO title bar height instead of 0 once WCO is active', () => {
    stubWco(33);
    useOS.getState().openWindow('terminal');
    const id = useOS.getState().activeWindowId!;
    useOS.getState().moveWindow(id, 100, 0);
    expect(useOS.getState().windows.find(w => w.id === id)!.y).toBe(33);
  });

  it('does not clamp a drag that is already below the title bar area', () => {
    stubWco(33);
    useOS.getState().openWindow('terminal');
    const id = useOS.getState().activeWindowId!;
    useOS.getState().moveWindow(id, 100, 200);
    expect(useOS.getState().windows.find(w => w.id === id)!.y).toBe(200);
  });

  it('reverts to clamping at 0 once WCO reports not visible again', () => {
    stubWco(33);
    useOS.getState().openWindow('terminal');
    const id = useOS.getState().activeWindowId!;
    (navigator as any).windowControlsOverlay.visible = false;
    useOS.getState().moveWindow(id, 100, 0);
    expect(useOS.getState().windows.find(w => w.id === id)!.y).toBe(0);
  });
});
