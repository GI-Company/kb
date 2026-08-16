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

  // Ghost predictions were removed: Terminal subscribed to terminal.predict,
  // which nothing in the app has ever published, so the overlay could never
  // appear. `terminal.typing` is no longer sent either.
  it('does not publish typing events for a dead prediction feature', () => {
    render(<TerminalApp />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'git sta' } });
    act(() => { vi.advanceTimersByTime(500); });
    expect(mockPublish).not.toHaveBeenCalledWith('terminal.typing', expect.anything());
  });

  // The speculative shadow engine always answered "miss", so it was a
  // guaranteed extra round trip. Commands now go straight to the sandbox.
  it('dispatches straight to vm.spawn with no shadow check', () => {
    render(<TerminalApp />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'whoami' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockPublish).not.toHaveBeenCalledWith('terminal.check_shadow', expect.anything());
    expect(mockPublish).toHaveBeenCalledWith('vm.spawn', expect.objectContaining({ cmd: 'whoami' }));
  });

  // The command line was split on spaces, so a quoted argument arrived as
  // two tokens with the quote characters still attached. `write notes.md
  // "hello world"` stored the literal string `"hello` — quoting silently
  // corrupted the file it wrote. Found by running it, not by reading it.
  it('parses quoted arguments as one token, without the quotes', () => {
    render(<TerminalApp />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'whoami "hello world"' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockPublish).toHaveBeenCalledWith(
      'vm.spawn',
      expect.objectContaining({ cmd: 'whoami', args: ['hello world'] })
    );
  });

  // Python is handled by the in-browser Pyodide worker. If it ever reached
  // vm.spawn it would be sent to /api/exec, where there is no interpreter.
  it('never sends python or pip to the server', () => {
    render(<TerminalApp />);
    const input = screen.getByRole('textbox');
    for (const cmd of ['python -c "print(1)"', 'python3 x.py', 'pip list']) {
      fireEvent.change(input, { target: { value: cmd } });
      fireEvent.keyDown(input, { key: 'Enter' });
    }
    expect(mockPublish).not.toHaveBeenCalledWith('vm.spawn', expect.anything());
  });

  // Ctrl+C must abort the real request, not just hide the indicator — an
  // uncancelled fetch keeps consuming budget and can still emit output.
  it('Ctrl+C publishes vm.cancel for the in-flight request', () => {
    render(<TerminalApp />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'whoami' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const spawn = mockPublish.mock.calls.find(c => c[0] === 'vm.spawn');
    expect(spawn).toBeTruthy();
    const reqId = spawn![1]._request_id;

    fireEvent.keyDown(input, { key: 'c', ctrlKey: true });
    expect(mockPublish).toHaveBeenCalledWith('vm.cancel', { _request_id: reqId });
  });

  it('Ctrl+C with nothing running just discards the line', () => {
    render(<TerminalApp />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'half typed' } });
    fireEvent.keyDown(input, { key: 'c', ctrlKey: true });
    expect(input.value).toBe('');
    expect(mockPublish).not.toHaveBeenCalledWith('vm.cancel', expect.anything());
  });

  it('recalls the previous command with ArrowUp', () => {
    render(<TerminalApp />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'whoami' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('whoami');
  });

  // ArrowUp must not destroy a half-typed line.
  it('ArrowDown restores the draft that ArrowUp stashed', () => {
    render(<TerminalApp />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'date' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'half-typed' } });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('date');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.value).toBe('half-typed');
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
// Uses `whoami`, not `ls`: filesystem commands are handled client-side
// against the VFS now and complete instantly, so they deliberately do NOT
// raise the running indicator. Only commands that actually leave the
// browser should.
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
    run('whoami');
    expect(screen.getByText(/running/)).toBeInTheDocument();
    // Appears twice on purpose — once as the echoed prompt line, once named
    // inside the indicator so it's clear WHAT is still running.
    expect(screen.getAllByText('whoami').length).toBeGreaterThan(1);
  });

  it('counts elapsed time up', () => {
    render(<TerminalApp />);
    run('whoami');
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.getByText(/1\.\d+s/)).toBeInTheDocument();
  });

  // vm.exit is emitted on success AND failure, which is why it's the signal
  // used to stop the indicator — an error path must not leave it spinning.
  it('clears on vm.exit', () => {
    render(<TerminalApp />);
    run('whoami');
    expect(screen.queryByText(/running/)).toBeInTheDocument();

    act(() => {
      subscriber?.({ topic: 'vm.exit', payload: { code: 0 }, from: 'kernel', time: new Date().toISOString() });
    });
    expect(screen.queryByText(/running/)).not.toBeInTheDocument();
  });

  it('clears even when the command failed', () => {
    render(<TerminalApp />);
    run('whoami');
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
    run('whoami');
    act(() => { vi.advanceTimersByTime(121_000); });
    expect(screen.queryByText(/running/)).not.toBeInTheDocument();
  });
});
