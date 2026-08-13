import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

// Mock kernel
const mockPublish = vi.fn();
const mockSubscribe = vi.fn(() => vi.fn());
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
