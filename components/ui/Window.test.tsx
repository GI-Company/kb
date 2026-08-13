import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
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
});
