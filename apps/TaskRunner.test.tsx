import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPublish = vi.fn();
vi.mock('../services/kernel', () => ({
  kernel: {
    publish: (...args: any[]) => mockPublish(...args),
    subscribe: () => vi.fn(),
  }
}));

import { TaskRunnerApp } from './TaskRunner';

describe('TaskRunnerApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the task engine header', () => {
    render(<TaskRunnerApp />);
    expect(screen.getByText('Task Engine')).toBeInTheDocument();
    expect(screen.getByText(/DAG Execution/)).toBeInTheDocument();
  });

  it('defaults to Goal Mode', () => {
    render(<TaskRunnerApp />);
    const goalInput = screen.getByPlaceholderText(/Set up a Node/);
    expect(goalInput).toBeInTheDocument();
  });

  it('shows both mode toggle buttons', () => {
    render(<TaskRunnerApp />);
    expect(screen.getByText(/Goal Mode/)).toBeInTheDocument();
    expect(screen.getByText(/Pipeline/)).toBeInTheDocument();
  });

  it('switches to Pipeline mode', () => {
    render(<TaskRunnerApp />);
    const pipelineBtn = screen.getByText(/Pipeline/);
    fireEvent.click(pipelineBtn);
    expect(screen.getByText('Start Workflow')).toBeInTheDocument();
  });

  it('disables execute button when goal is empty', () => {
    render(<TaskRunnerApp />);
    const executeBtn = screen.getByText(/Execute Goal/);
    expect(executeBtn).toBeDisabled();
  });

  it('enables execute button when goal is typed', () => {
    render(<TaskRunnerApp />);
    const input = screen.getByPlaceholderText(/Set up a Node/);
    fireEvent.change(input, { target: { value: 'Build a REST API' } });
    const executeBtn = screen.getByText(/Execute Goal/);
    expect(executeBtn).not.toBeDisabled();
  });

  it('publishes task.run with goal on submit', () => {
    render(<TaskRunnerApp />);
    const input = screen.getByPlaceholderText(/Set up a Node/);
    fireEvent.change(input, { target: { value: 'Deploy to production' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockPublish).toHaveBeenCalledWith(
      'task.run',
      expect.objectContaining({ goal: 'Deploy to production' })
    );
  });

  it('publishes task.run with graphId for pipeline mode', () => {
    render(<TaskRunnerApp />);
    const pipelineBtn = screen.getByText(/Pipeline/);
    fireEvent.click(pipelineBtn);
    const startBtn = screen.getByText('Start Workflow');
    fireEvent.click(startBtn);

    expect(mockPublish).toHaveBeenCalledWith(
      'task.run',
      expect.objectContaining({ graphId: 'build-pipeline' })
    );
  });
});
