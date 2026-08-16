import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the subscriber callback
let subscriberCallback: ((env: any) => void) | null = null;
vi.mock('../../services/kernel', () => ({
  kernel: {
    subscribe: (cb: any) => {
      subscriberCallback = cb;
      return vi.fn(); // unsubscribe
    }
  }
}));

import { ToastSystem } from './ToastSystem';

describe('ToastSystem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriberCallback = null;
  });

  it('renders no toasts before anything is published', () => {
    const { container } = render(<ToastSystem />);
    // The positioning wrapper is always mounted (it's fixed and
    // pointer-events-none, so an empty one is inert); what matters is that
    // it holds no toasts.
    expect(container.querySelector('.pointer-events-auto')).toBeNull();
  });

  it('renders a toast for sys.kernel_panic', () => {
    render(<ToastSystem />);

    act(() => {
      subscriberCallback?.({
        topic: 'sys.kernel_panic',
        payload: { subsystem: 'VFS', error: 'Disk corruption detected' },
        from: 'kernel',
        time: new Date().toISOString(),
      });
    });

    expect(screen.getByText('Kernel Panic')).toBeInTheDocument();
    expect(screen.getByText(/VFS: Disk corruption detected/)).toBeInTheDocument();
  });

  it('renders a toast for sys.notify:toast with info urgency', () => {
    render(<ToastSystem />);

    act(() => {
      subscriberCallback?.({
        topic: 'sys.notify:toast',
        payload: { title: 'Config Updated', message: 'Font size changed to 16', urgency: 'info' },
        from: 'system',
        time: new Date().toISOString(),
      });
    });

    expect(screen.getByText('Config Updated')).toBeInTheDocument();
    expect(screen.getByText('Font size changed to 16')).toBeInTheDocument();
  });

  it('renders a success toast', () => {
    render(<ToastSystem />);

    act(() => {
      subscriberCallback?.({
        topic: 'sys.notify:toast',
        payload: { title: 'Build Complete', message: 'All checks passed', urgency: 'success' },
        from: 'system',
        time: new Date().toISOString(),
      });
    });

    expect(screen.getByText('Build Complete')).toBeInTheDocument();
  });

  it('renders multiple concurrent toasts', () => {
    render(<ToastSystem />);

    act(() => {
      subscriberCallback?.({
        topic: 'sys.notify:toast',
        payload: { title: 'Toast 1', message: 'First', urgency: 'info' },
        from: 'system', time: new Date().toISOString(),
      });
      subscriberCallback?.({
        topic: 'sys.notify:toast',
        payload: { title: 'Toast 2', message: 'Second', urgency: 'warning' },
        from: 'system', time: new Date().toISOString(),
      });
    });

    expect(screen.getByText('Toast 1')).toBeInTheDocument();
    expect(screen.getByText('Toast 2')).toBeInTheDocument();
  });
});
