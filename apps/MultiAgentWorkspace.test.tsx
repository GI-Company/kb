import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSendToAgent = vi.fn();
let subscriber: ((env: any) => void) | null = null;

vi.mock('../services/kernel', () => ({
  kernel: {
    publish: vi.fn(),
    sendToAgent: (...args: any[]) => mockSendToAgent(...args),
    subscribe: (cb: any) => { subscriber = cb; return vi.fn(); },
  },
}));

import { MultiAgentWorkspace } from './MultiAgentWorkspace';

/** Dispatches a goal and returns the [agentId, requestId] pairs the app sent. */
function dispatchGoal(goal = 'Review the login flow') {
  fireEvent.change(screen.getByPlaceholderText(/Ask all four agents/), { target: { value: goal } });
  fireEvent.click(screen.getByText('Ask All'));
  return mockSendToAgent.mock.calls.map(([agentId, , payload]) => [agentId, payload._request_id] as const);
}

describe('MultiAgentWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriber = null;
  });

  it('renders the workspace header', () => {
    render(<MultiAgentWorkspace />);
    expect(screen.getByText('Multi-Agent Workspace')).toBeInTheDocument();
  });

  it('renders a pane per persona, named from the real roster', () => {
    render(<MultiAgentWorkspace />);
    for (const name of ['Security Auditor', 'Code Review', 'DevOps Engineer', 'Architect']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it('shows each persona’s actual model', () => {
    render(<MultiAgentWorkspace />);
    expect(screen.getByText('openai/gpt-oss-safeguard-20b')).toBeInTheDocument();
    expect(screen.getByText('qwen/qwen3.6-27b')).toBeInTheDocument();
  });

  it('disables the button until a goal is typed', () => {
    render(<MultiAgentWorkspace />);
    expect(screen.getByText('Ask All')).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/Ask all four agents/), { target: { value: 'Audit this' } });
    expect(screen.getByText('Ask All')).not.toBeDisabled();
  });

  // The core regression: handleDirectChat used to ignore `to` and always use
  // the agent-chat persona, so all four panes got the same answer.
  it('addresses each request to a distinct persona', () => {
    render(<MultiAgentWorkspace />);
    const sent = dispatchGoal();
    expect(sent.map(([agentId]) => agentId)).toEqual([
      'agent-security', 'agent-coder', 'agent-devops', 'agent-architect',
    ]);
    expect(mockSendToAgent).toHaveBeenCalledTimes(4);
  });

  // The other half: replies were filtered on _request_id, but the kernel never
  // echoed it, so nothing ever matched and panes hung forever.
  it('routes a streamed reply to the pane that asked for it', () => {
    render(<MultiAgentWorkspace />);
    const sent = dispatchGoal();
    const [devopsAgentId, devopsRequestId] = sent.find(([id]) => id === 'agent-devops')!;

    act(() => {
      subscriber?.({
        topic: 'ai.stream',
        from: devopsAgentId,
        payload: { _request_id: devopsRequestId, chunk: 'Pin your base images.' },
        time: new Date().toISOString(),
      });
    });

    expect(screen.getByText(/Pin your base images/)).toBeInTheDocument();
  });

  it('ignores stream chunks belonging to another window’s request', () => {
    render(<MultiAgentWorkspace />);
    dispatchGoal();

    act(() => {
      subscriber?.({
        topic: 'ai.stream',
        from: 'agent-devops',
        payload: { _request_id: 'someone-elses-request', chunk: 'Leaked text.' },
        time: new Date().toISOString(),
      });
    });

    expect(screen.queryByText(/Leaked text/)).not.toBeInTheDocument();
  });

  it('surfaces an error reported by the kernel', () => {
    render(<MultiAgentWorkspace />);
    const sent = dispatchGoal();
    const [, requestId] = sent[0];

    act(() => {
      subscriber?.({
        topic: 'ai.stream',
        from: 'agent-security',
        payload: { _request_id: requestId, chunk: '⚠️ Rate limited', error: 'Rate limited' },
        time: new Date().toISOString(),
      });
    });

    expect(screen.getByText('Rate limited')).toBeInTheDocument();
  });

  it('strips <think> blocks from a reasoning model’s output', () => {
    render(<MultiAgentWorkspace />);
    const sent = dispatchGoal();
    const [, requestId] = sent.find(([id]) => id === 'agent-devops')!;

    act(() => {
      subscriber?.({
        topic: 'ai.stream',
        from: 'agent-devops',
        payload: {
          _request_id: requestId,
          chunk: '<think>weighing the options</think>Use short-lived tokens.',
        },
        time: new Date().toISOString(),
      });
    });

    expect(screen.getByText(/Use short-lived tokens/)).toBeInTheDocument();
    expect(screen.queryByText(/weighing the options/)).not.toBeInTheDocument();
  });
});
