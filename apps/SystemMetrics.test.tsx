import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The panel reads from every real store the app has rather than from a
// `sys.metrics` bus topic (which nothing publishes on this architecture —
// that was the Go microkernel's). So the mocks here are the data sources,
// not the bus.

const fakeState = {
  windows: [
    { id: 'a', isMinimized: false },
    { id: 'b', isMinimized: true },
  ],
  currentDesktop: 0,
  guestRemainingSeconds: null as number | null,
};

vi.mock('../store', () => ({
  useOS: (selector: (s: typeof fakeState) => unknown) => selector(fakeState),
}));

vi.mock('../services/kernel', () => ({
  kernel: {
    subscribe: () => vi.fn(),
    getTrafficLog: () => [{ topic: 'agent.chat' }, { topic: 'ai.done' }],
  },
}));

vi.mock('../lib/vfs', () => ({
  vfs: { stat: vi.fn(async () => ({ fileCount: 7, dirCount: 2, totalBytes: 2048 })) },
}));

vi.mock('../lib/chatStore', () => ({
  chatStore: { stat: vi.fn(async () => ({ conversationCount: 4, messageCount: 19 })) },
}));

vi.mock('../lib/modelRegistry', () => ({
  modelRegistry: { list: vi.fn(async () => [{ name: 'm1', paramCount: 1234 }]) },
}));

vi.mock('../lib/localModel', () => ({
  localModel: {
    isReady: true,
    currentConfig: { mixerType: 'attention', dModel: 48 },
  },
}));

vi.mock('../lib/localModelHistory', () => ({
  runHistoryStore: { list: () => [{}, {}, {}] },
  genHistoryStore: { list: () => [{}] },
}));

vi.mock('../lib/auth', () => ({
  getCurrentUserId: vi.fn(async () => 'guest-abcd'),
  getSession: vi.fn(async () => null), // guest
  isSupabaseConfigured: true,
}));

vi.mock('../lib/analytics', () => ({ isAnalyticsConfigured: true }));

vi.mock('../lib/settings', () => ({
  getSetting: () => false,
  subscribeSettings: () => vi.fn(),
}));

vi.mock('../lib/guestUsage', () => ({ formatRemaining: (s: number) => `${s}s` }));

import { SystemMetricsApp } from './SystemMetrics';

describe('SystemMetricsApp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the panel title', () => {
    render(<SystemMetricsApp />);
    expect(screen.getByText('System Metrics')).toBeInTheDocument();
  });

  it('reports window counts from the OS store', () => {
    render(<SystemMetricsApp />);
    // One of the two fake windows is minimized, so open (1) and total (2) differ.
    expect(screen.getByText('Open Windows').parentElement).toHaveTextContent('1');
    expect(screen.getByText('Total Windows').parentElement).toHaveTextContent('2');
  });

  it('reports real VFS counts once they resolve', async () => {
    render(<SystemMetricsApp />);
    expect(await screen.findByText('7')).toBeInTheDocument();     // files
    expect(await screen.findByText('2.0 KB')).toBeInTheDocument(); // 2048 bytes
  });

  it('reports chat counts once they resolve', async () => {
    render(<SystemMetricsApp />);
    expect(await screen.findByText('4')).toBeInTheDocument();  // conversations
    expect(await screen.findByText('19')).toBeInTheDocument(); // messages
  });

  it('shows the in-session local model config when one is initialized', () => {
    render(<SystemMetricsApp />);
    expect(screen.getByText('attention · d48')).toBeInTheDocument();
  });

  it('shows guest session state and gates network commands', () => {
    render(<SystemMetricsApp />);
    expect(screen.getByText('Guest')).toBeInTheDocument();
    expect(screen.getByText('sign in to use')).toBeInTheDocument();
  });

  it('does not reference the removed Go runtime metrics', () => {
    render(<SystemMetricsApp />);
    expect(screen.queryByText(/Goroutines/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/heapAlloc_mb/)).not.toBeInTheDocument();
    expect(screen.queryByText(/WebSocket Clients/i)).not.toBeInTheDocument();
  });
});
