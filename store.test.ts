import { describe, it, expect, afterEach } from 'vitest';
import { computeIsMobile, MOBILE_BREAKPOINT } from './store';

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
