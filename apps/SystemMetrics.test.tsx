import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let subscriberCallback: ((env: any) => void) | null = null;
vi.mock('../services/kernel', () => ({
  kernel: {
    subscribe: (cb: any) => {
      subscriberCallback = cb;
      return vi.fn();
    },
    publish: vi.fn()
  }
}));

import { SystemMetricsApp } from './SystemMetrics';

describe('SystemMetricsApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriberCallback = null;
  });

  it('renders the dashboard title', () => {
    render(<SystemMetricsApp />);
    expect(screen.getByText('Live System Metrics')).toBeInTheDocument();
  });

  it('starts with zero values', () => {
    render(<SystemMetricsApp />);
    // Both Heap and System memory start at 0
    const zeroMBs = screen.getAllByText('0 MB');
    expect(zeroMBs.length).toBe(2);
  });

  it('updates metrics when sys.metrics is received', () => {
    render(<SystemMetricsApp />);

    act(() => {
      subscriberCallback?.({
        topic: 'sys.metrics',
        payload: {
          heapAlloc_mb: 42,
          sysAlloc_mb: 128,
          numGoroutine: 15,
          numClients: 3,
          activeProcs: 2,
        },
        from: 'cron',
        time: new Date().toISOString(),
      });
    });

    expect(screen.getByText('42 MB')).toBeInTheDocument();
    expect(screen.getByText('128 MB')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows raw telemetry JSON', () => {
    render(<SystemMetricsApp />);
    expect(screen.getByText('Raw Telemetry')).toBeInTheDocument();
    expect(screen.getByText(/heapAlloc_mb/)).toBeInTheDocument();
  });

  it('shows live indicator dot', () => {
    const { container } = render(<SystemMetricsApp />);
    const pulsingDot = container.querySelector('.animate-pulse');
    expect(pulsingDot).toBeInTheDocument();
  });
});
