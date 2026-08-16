// Client-side DAG task engine — ports the essential subset of the original
// Go backend's task_engine.go (node/dependency walk, the hardcoded
// "build-pipeline" demo) to run entirely in the browser, driven by
// services/kernel.ts's `task.run` handling. Not ported: the self-healing
// parallel-recovery-branch mutation (needs a long-lived process; see
// ARCHITECTURE.md's cuts list) — a failed node just fails here.
//
// The part that's new relative to the original design: a node's `command`
// can be a bnlm.* tool name, or "kernos.exec", instead of a shell command,
// so a workflow can mix regular exec steps with "train a local model" /
// "generate from it" / "run this TypeScript" steps — the Dispatcher
// persona (lib/agents.ts) is instructed to emit these when planning a
// goal that calls for one. This is what makes local models and
// arbitrary agent-written logic composable into automated workflows
// rather than only reachable from an ad hoc chat message.

import { fetchGroqText } from './groqFetch';
import { runTool } from './kernosTools';

export interface TaskNode {
  id: string;
  command: string;
  args?: Record<string, any>;
  dependencies: string[];
}

export interface TaskEvent {
  runId: string;
  step: string;
  status: 'running' | 'completed' | 'failed';
  progress: number;
  output?: string;
}

// Mirrors the original Go backend's hardcoded MVP pipeline (main.go's
// handleTaskRun fallback for graphId === "build-pipeline"), minus shell
// quoting since api/exec.ts passes args straight to execFile, never
// through a shell.
const DEMO_PIPELINE: TaskNode[] = [
  { id: 'lint', command: 'echo linting-all-good', dependencies: [] },
  { id: 'test', command: 'whoami', dependencies: ['lint'] },
  { id: 'build', command: 'ls -la', dependencies: ['test'] },
  { id: 'deploy', command: 'date', dependencies: ['build'] },
];

export function getDemoPipeline(): TaskNode[] {
  return DEMO_PIPELINE;
}

/** Asks the Dispatcher persona to turn a natural-language goal into a TaskNode DAG (including, where appropriate, bnlm.train/bnlm.generate nodes). */
export async function planGoal(goal: string): Promise<TaskNode[]> {
  const text = await fetchGroqText(
    'agent-dispatcher',
    `Turn this goal into a task DAG: ${goal}\n\nRespond with ONLY a JSON array, no prose, no markdown fences.`
  );
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Dispatcher did not return a task list.');
  let parsed: any;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new Error('Dispatcher returned malformed JSON.');
  }
  if (!Array.isArray(parsed)) throw new Error('Dispatcher response was not a JSON array.');
  return parsed.map((n: any) => ({
    id: String(n.id ?? Math.random().toString(36).slice(2, 8)),
    command: String(n.command ?? ''),
    args: n.args && typeof n.args === 'object' ? n.args : undefined,
    dependencies: Array.isArray(n.dependencies) ? n.dependencies.map(String) : [],
  }));
}

async function executeNode(node: TaskNode): Promise<string> {
  if (node.command.startsWith('bnlm.') || node.command === 'kernos.exec') {
    // DAG nodes only consume the prose result; the structured glass-box
    // detail is for interactive surfaces.
    return (await runTool({ tool: node.command, args: node.args })).text;
  }
  const [cmd, ...args] = node.command.split(' ').filter(Boolean);
  if (!cmd) throw new Error('Empty command');
  const res = await fetch('/api/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, args }),
  });
  const data = await res.json();
  if (data.code && data.code !== 0) throw new Error(data.stderr || `exited with code ${data.code}`);
  return data.stdout || '';
}

/** Walks the DAG in dependency order, running each wave of ready nodes in parallel, emitting a TaskEvent per node transition. */
export async function runTaskGraph(runId: string, nodes: TaskNode[], onEvent: (event: TaskEvent) => void): Promise<void> {
  const completed = new Set<string>();
  const remaining = new Map(nodes.map(n => [n.id, n]));

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter(n => n.dependencies.every(d => completed.has(d)));
    if (ready.length === 0) {
      for (const n of remaining.values()) {
        onEvent({ runId, step: n.id, status: 'failed', progress: 100, output: 'Unresolvable dependency (cycle or missing node)' });
      }
      return;
    }

    await Promise.all(ready.map(async node => {
      onEvent({ runId, step: node.id, status: 'running', progress: 50 });
      try {
        const output = await executeNode(node);
        completed.add(node.id);
        remaining.delete(node.id);
        onEvent({ runId, step: node.id, status: 'completed', progress: 100, output });
      } catch (err: any) {
        remaining.delete(node.id);
        onEvent({ runId, step: node.id, status: 'failed', progress: 100, output: err?.message || String(err) });
      }
    }));
  }
}
