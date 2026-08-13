import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPublish = vi.fn();
let subscriberCallback: ((env: any) => void) | null = null;
vi.mock('../services/kernel', () => ({
  kernel: {
    publish: (...args: any[]) => mockPublish(...args),
    subscribe: (cb: any) => {
      subscriberCallback = cb;
      return vi.fn();
    }
  }
}));

import { SettingsApp } from './Settings';

describe('SettingsApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriberCallback = null;
  });

  it('renders the settings header', () => {
    render(<SettingsApp />);
    expect(screen.getByText('System Preferences')).toBeInTheDocument();
  });

  it('requests all default config keys on mount', () => {
    render(<SettingsApp />);
    expect(mockPublish).toHaveBeenCalledWith('sys.config:get', { key: 'theme' });
    expect(mockPublish).toHaveBeenCalledWith('sys.config:get', { key: 'font_size' });
    expect(mockPublish).toHaveBeenCalledWith('sys.config:get', { key: 'lm_endpoint' });
    expect(mockPublish).toHaveBeenCalledWith('sys.config:get', { key: 'ai_model' });
  });

  it('shows connecting message when no configs loaded', () => {
    render(<SettingsApp />);
    expect(screen.getByText('Connecting to kernel...')).toBeInTheDocument();
  });
});
