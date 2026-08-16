import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

// Mock kernel
let subscriber: ((env: any) => void) | null = null;
const mockPublish = vi.fn();
// The implementation's parameter is declared even though it's unused: with
// a bare `() => vi.fn()`, TypeScript infers a zero-argument call signature
// and the `mockSubscribe(cb)` call below fails to type-check.
const mockSubscribe = vi.fn((cb: any) => { subscriber = cb; return vi.fn(); });
vi.mock('../services/kernel', () => ({
  kernel: {
    publish: (...args: any[]) => mockPublish(...args),
    subscribe: (cb: any) => mockSubscribe(cb),
    isLive: false,
    getClientId: () => 'test-client',
  }
}));

import { TerminalApp } from './Terminal';

describe('TerminalApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriber = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the welcome message', () => {
    render(<TerminalApp />);
    expect(screen.getByText(/Kernos OS/)).toBeInTheDocument();
    expect(screen.getByText(/Type "help"/)).toBeInTheDocument();
  });

  it('renders the input field', () => {
    render(<TerminalApp />);
    const input = screen.getByRole('textbox');
    expect(input).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it('sends terminal.typing for ghost commands after debounce', () => {
    render(<TerminalApp />);
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: 'git sta' } });
    expect(mockPublish).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(300); });
    expect(mockPublish).toHaveBeenCalledWith('terminal.typing', { input: 'git sta' });
  });

  it('does not send terminal.typing for short input', () => {
    render(<TerminalApp />);
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: 'ab' } });
    act(() => { vi.advanceTimersByTime(300); });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does not send terminal.typing for ? prefix (NL shell)', () => {
    render(<TerminalApp />);
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: '? find large' } });
    act(() => { vi.advanceTimersByTime(300); });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('routes ? prefix to sys.terminal.intent on Enter', () => {
    render(<TerminalApp />);
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: '? show big files' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockPublish).toHaveBeenCalledWith('sys.terminal.intent', { intent: 'show big files' });
    expect(screen.getByText(/Translating/)).toBeInTheDocument();
  });

  it('handles clear command locally', () => {
    render(<TerminalApp />);
    const input = screen.getByRole('textbox');

    // First verify welcome message is there
    expect(screen.getByText(/Kernos OS/)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'clear' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Welcome message should be gone
    expect(screen.queryByText(/Kernos OS/)).not.toBeInTheDocument();
  });
});

// Progress feedback. `render` is a real headless-browser page load and can
// take many seconds; with no indicator that is indistinguishable from a hang.
describe('TerminalApp running indicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriber = null;
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  const run = (command: string) => {
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: command } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };

  it('shows the command while it is in flight', () => {
    render(<TerminalApp />);
    run('ls -la');
    expect(screen.getByText(/running/)).toBeInTheDocument();
    // Appears twice on purpose — once as the echoed prompt line, once named
    // inside the indicator so it's clear WHAT is still running.
    expect(screen.getAllByText('ls -la').length).toBeGreaterThan(1);
  });

  it('counts elapsed time up', () => {
    render(<TerminalApp />);
    run('ls -la');
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.getByText(/1\.\d+s/)).toBeInTheDocument();
  });

  // vm.exit is emitted on success AND failure, which is why it's the signal
  // used to stop the indicator — an error path must not leave it spinning.
  it('clears on vm.exit', () => {
    render(<TerminalApp />);
    run('ls -la');
    expect(screen.queryByText(/running/)).toBeInTheDocument();

    act(() => {
      subscriber?.({ topic: 'vm.exit', payload: { code: 0 }, from: 'kernel', time: new Date().toISOString() });
    });
    expect(screen.queryByText(/running/)).not.toBeInTheDocument();
  });

  it('clears even when the command failed', () => {
    render(<TerminalApp />);
    run('ls -la');
    act(() => {
      subscriber?.({ topic: 'vm.exit', payload: { code: 1 }, from: 'kernel', time: new Date().toISOString() });
    });
    expect(screen.queryByText(/running/)).not.toBeInTheDocument();
  });

  it('shows the headless-browser hint only for a slow render', () => {
    render(<TerminalApp />);
    run('render https://example.com');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText(/headless browser/)).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText(/headless browser/)).toBeInTheDocument();
  });

  it('gives up on a spinner that never got its vm.exit', () => {
    render(<TerminalApp />);
    run('ls -la');
    act(() => { vi.advanceTimersByTime(121_000); });
    expect(screen.queryByText(/running/)).not.toBeInTheDocument();
  });
});
