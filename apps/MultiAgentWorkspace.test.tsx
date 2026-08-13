import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPublish = vi.fn();
vi.mock('../services/kernel', () => ({
  kernel: {
    publish: (...args: any[]) => mockPublish(...args),
    subscribe: () => vi.fn(),
    sendToAgent: vi.fn(),
  }
}));

import { MultiAgentWorkspace } from './MultiAgentWorkspace';

describe('MultiAgentWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the workspace header', () => {
    render(<MultiAgentWorkspace />);
    expect(screen.getByText('Multi-Agent Workspace')).toBeInTheDocument();
  });

  it('renders all 4 agent cards', () => {
    render(<MultiAgentWorkspace />);
    expect(screen.getByText('Security Auditor')).toBeInTheDocument();
    expect(screen.getByText('Code Reviewer')).toBeInTheDocument();
    expect(screen.getByText('DevOps Bot')).toBeInTheDocument();
    expect(screen.getByText('Architect')).toBeInTheDocument();
  });

  it('renders the goal input field', () => {
    render(<MultiAgentWorkspace />);
    const input = screen.getByPlaceholderText(/Shared goal/);
    expect(input).toBeInTheDocument();
  });

  it('dispatch button is disabled when goal is empty', () => {
    render(<MultiAgentWorkspace />);
    const button = screen.getByText('Dispatch');
    expect(button).toBeDisabled();
  });

  it('enables dispatch button when goal is typed', () => {
    render(<MultiAgentWorkspace />);
    const input = screen.getByPlaceholderText(/Shared goal/);
    fireEvent.change(input, { target: { value: 'Audit the codebase' } });
    const button = screen.getByText('Dispatch');
    expect(button).not.toBeDisabled();
  });

  it('shows agent specialties', () => {
    render(<MultiAgentWorkspace />);
    expect(screen.getByText(/vulnerabilities/i)).toBeInTheDocument();
    expect(screen.getByText(/code quality/i)).toBeInTheDocument();
    expect(screen.getByText(/builds, deployments/i)).toBeInTheDocument();
    expect(screen.getByText(/system structure/i)).toBeInTheDocument();
  });

  it('shows the communication log section', () => {
    render(<MultiAgentWorkspace />);
    expect(screen.getByText(/Agent Communication Log/)).toBeInTheDocument();
  });
});
