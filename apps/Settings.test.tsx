import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/settings is deliberately NOT mocked — these exercise the real store
// (write, read back, apply document effects) rather than a stand-in.
//
// This environment has no localStorage, which is fine and worth stating:
// lib/settings wraps every storage access in try/catch precisely so an
// unavailable or full quota degrades to in-memory rather than throwing.
// So the assertions below cover the in-memory path and the DOM effects;
// durability across reloads is not what's being tested here.

const mockPublish = vi.fn();
vi.mock('../services/kernel', () => ({
  kernel: { publish: (...a: any[]) => mockPublish(...a), subscribe: () => vi.fn() },
}));

const setLiteMode = vi.fn();
vi.mock('../store', () => ({
  useOS: () => ({ liteMode: false, setLiteMode, openWalkthrough: vi.fn() }),
}));

vi.mock('../lib/auth', () => ({
  getSession: vi.fn(async () => null),
  signOut: vi.fn(async () => {}),
}));

const setAnalyticsOptOut = vi.fn();
vi.mock('../lib/analytics', () => ({
  resetAnalyticsIdentity: vi.fn(),
  setAnalyticsOptOut: (v: boolean) => setAnalyticsOptOut(v),
}));

vi.mock('../lib/donate', () => ({ DONATE_URL: '', isDonateConfigured: false }));

import { SettingsApp } from './Settings';
import { getSetting, resetSettings } from '../lib/settings';

// Row renders <div>[ <div><div>{label}</div><div>{hint}</div></div> <div>{control}</div> ]</div>,
// so the label's grandparent is the row that also holds the control.
const rowOf = (label: string) => screen.getByText(label).parentElement!.parentElement!;

describe('SettingsApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSettings();
  });

  it('renders the settings header', () => {
    render(<SettingsApp />);
    expect(screen.getByText('System Preferences')).toBeInTheDocument();
  });

  // The panel used to publish sys.config:get and wait for a sys.config:ack
  // that nothing ever sent, so it sat on "Connecting to kernel..." forever.
  it('does not round-trip preferences through the kernel bus', () => {
    render(<SettingsApp />);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(screen.queryByText(/Connecting to kernel/)).not.toBeInTheDocument();
  });

  it('renders controls immediately, with no loading state', () => {
    render(<SettingsApp />);
    for (const label of ['Theme', 'Reduce Motion', 'Default Agent', 'Font Size', 'Opt Out of Analytics']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('persists the theme choice', () => {
    render(<SettingsApp />);
    expect(getSetting('theme')).toBe('dark');
    fireEvent.click(screen.getByText('Light'));
    expect(getSetting('theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('persists reduce-motion and applies the document class', () => {
    render(<SettingsApp />);
    fireEvent.click(rowOf('Reduce Motion').querySelector('button')!);
    expect(getSetting('reduceMotion')).toBe(true);
    expect(document.documentElement.classList.contains('kernos-reduce-motion')).toBe(true);
  });

  it('persists the default agent from the real roster', () => {
    render(<SettingsApp />);
    fireEvent.change(screen.getByDisplayValue('Auto'), { target: { value: 'agent-security' } });
    expect(getSetting('defaultPersona')).toBe('agent-security');
  });

  it('persists terminal font size as a CSS variable', () => {
    render(<SettingsApp />);
    fireEvent.change(rowOf('Font Size').querySelector('input[type="range"]')!, { target: { value: '18' } });
    expect(getSetting('terminalFontSize')).toBe(18);
    expect(document.documentElement.style.getPropertyValue('--kernos-terminal-font-size')).toBe('18px');
  });

  it('flips PostHog capture immediately when opting out', () => {
    render(<SettingsApp />);
    fireEvent.click(rowOf('Opt Out of Analytics').querySelector('button')!);
    expect(getSetting('analyticsOptOut')).toBe(true);
    expect(setAnalyticsOptOut).toHaveBeenCalledWith(true);
  });

  it('restores defaults', () => {
    render(<SettingsApp />);
    fireEvent.click(screen.getByText('Light'));
    expect(getSetting('theme')).toBe('light');
    fireEvent.click(screen.getByText('Reset'));
    expect(getSetting('theme')).toBe('dark');
  });
});
