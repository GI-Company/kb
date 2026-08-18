import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Window } from './Window';
import { WindowState } from '../../types';

// Mock the Zustand store
vi.mock('../../store', () => ({
  useOS: () => ({
    closeWindow: vi.fn(),
    focusWindow: vi.fn(),
    moveWindow: vi.fn(),
    resizeWindow: vi.fn(),
    minimizeWindow: vi.fn(),
    maximizeWindow: vi.fn(),
  }),
}));
// Re-mock getState for the activeWindowId check inside Window.tsx
vi.mock('../../store', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    useOS: Object.assign(() => ({
      closeWindow: vi.fn(),
      focusWindow: vi.fn(),
      moveWindow: vi.fn(),
      resizeWindow: vi.fn(),
      minimizeWindow: vi.fn(),
      maximizeWindow: vi.fn(),
    }), {
      getState: () => ({ activeWindowId: 'test-window-1' })
    })
  };
});


describe('Window Component', () => {
  const mockData: WindowState = {
    id: 'test-window-1',
    appId: 'terminal',
    title: 'Test Terminal',
    x: 100,
    y: 100,
    width: 600,
    height: 400,
    zIndex: 1,
    isMinimized: false,
    isMaximized: false,
    desktopIndex: 0
  };

  it('renders the window with the correct title', () => {
    render(
      <Window data={mockData}>
        <div>Mock Window Content</div>
      </Window>
    );
    expect(screen.getByText('Test Terminal')).toBeInTheDocument();
    expect(screen.getByText('Mock Window Content')).toBeInTheDocument();
  });

  it('does not render when minimized', () => {
    render(
      <Window data={{ ...mockData, isMinimized: true }}>
        <div>Hidden Content</div>
      </Window>
    );
    expect(screen.queryByText('Hidden Content')).not.toBeInTheDocument();
  });

  // A maximized window used to hardcode top: 0 — fine in an ordinary tab,
  // but that puts its own title bar (with its own close/minimize/maximize
  // controls) directly underneath Taskbar.tsx's WCO title-bar strip once
  // window-controls-overlay is active. See lib/windowControlsOverlay.ts.
  describe('maximized window offset for Window Controls Overlay', () => {
    afterEach(() => {
      delete (navigator as any).windowControlsOverlay;
    });

    function findAbsolutePositionedDiv(container: HTMLElement): HTMLElement {
      const el = [...container.querySelectorAll('div')].find(d => d.style.position === 'absolute');
      if (!el) throw new Error('expected an absolutely-positioned window element');
      return el;
    }

    it('stays at top: 0 when WCO is not active (today\'s behavior, unchanged)', () => {
      const { container } = render(
        <Window data={{ ...mockData, isMaximized: true }}>
          <div>Content</div>
        </Window>
      );
      expect(findAbsolutePositionedDiv(container).style.top).toBe('0px');
    });

    it('offsets below the WCO title bar height when WCO is active', () => {
      (navigator as any).windowControlsOverlay = {
        visible: true,
        getTitlebarAreaRect: () => ({ height: 33 }),
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      const { container } = render(
        <Window data={{ ...mockData, isMaximized: true }}>
          <div>Content</div>
        </Window>
      );
      const el = findAbsolutePositionedDiv(container);
      expect(el.style.top).toBe('33px');
      // jsdom's CSSOM normalizes the calc() expression (52 + 33 = 85) —
      // asserting the resulting value rather than the literal source string.
      expect(el.style.height).toBe('calc(100% - 85px)');
    });
  });
});
