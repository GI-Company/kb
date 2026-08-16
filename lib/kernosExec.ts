// kernos.exec — the agent-callable execution tool.
//
// Agent-written TypeScript is compiled by lib/appletCompiler.ts (the same
// Sucrase pass Editor/CDE's "Launch Applet" uses) and then run on a Web
// Worker, not on the main thread.
//
// WHY THE WORKER MATTERS: the previous version raced execution against a
// timeout Promise. That is enough for slow *async* work, but it cannot
// preempt synchronous code — `while (true) {}` pins the main thread and the
// timeout never gets a chance to fire, so the whole tab hangs. A worker runs
// on its own thread, so a timeout here ends with terminate(), which actually
// kills a spinning loop. That is the difference between a documented
// limitation and a real one being closed.
//
// The capability model is unchanged in what it grants and stronger in how it
// grants it. The worker holds no reference to the VFS, the local models, the
// kernel bus, or the network. It can only ask this file to act on its
// behalf, and every request is checked here against the same per-execution
// budgets as before. Terminating the thread therefore cannot strand a
// half-applied capability; the worst an aborted run leaves behind is an
// unanswered message.
//
// Deliberate capability changes from the main-thread version:
//   - React / Lucide are gone. They cannot cross a structured-clone
//     boundary, and the contract already said this tool does not open a
//     window — returning JSX from it was never useful.
//   - kernel.subscribe is gone. A callback cannot survive terminate(), so
//     it would leak a listener bound to a dead thread.
//   - bnlm.classify is new, reflecting the classifier being a real tool now.

import { compileExecBody } from './appletCompiler';
import { kernel } from '../services/kernel';
import { vfs } from './vfs';
import { localModel } from './localModel';
import { localClassifier } from './localClassifier';
import { fetchGroqText } from './groqFetch';

export interface KernosExecResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 20000;

// Worst-case call budget per single invocation — deliberately small; this is
// a tool call inside a chat turn or DAG step, not a batch job. A timeout
// alone doesn't bound cost, because in-flight calls keep spending after the
// caller has been handed an error.
const CALL_BUDGET = { agentAsk: 5, bnlm: 5, vfs: 50, kernelPublish: 20 };

const BLOCKED_TOPICS = ['vm.spawn', 'task.run', 'sys.consolidate'];

export async function runKernosExec(
  code: string,
  userId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<KernosExecResult> {
  let compiled: string;
  try {
    compiled = compileExecBody(code);
  } catch (err: any) {
    return { ok: false, error: `Compile error: ${err?.message || err}` };
  }

  const clampedTimeout = Math.min(Math.max(timeoutMs, 1000), MAX_TIMEOUT_MS);
  const remaining = { ...CALL_BUDGET };
  const spend = (kind: keyof typeof CALL_BUDGET) => {
    if (remaining[kind]-- <= 0) {
      throw new Error(
        `kernos.exec: exceeded the ${kind} call budget (${CALL_BUDGET[kind]} per execution) — ` +
        `this usually means a loop around a real call, not a one-off.`
      );
    }
  };

  // The capability table. This is the entire attack surface the sandbox has,
  // and it lives here rather than in the worker precisely so the worker can
  // be killed without consequence.
  const handlers: Record<string, Record<string, (...args: any[]) => unknown>> = {
    vfs: {
      read: (id: string) => { spend('vfs'); return vfs.read(id, userId); },
      write: (id: string, content: string) => { spend('vfs'); return vfs.write(id, content, userId); },
      list: (parentId: string) => { spend('vfs'); return vfs.list(parentId, userId); },
      create: (parentId: string, name: string, type: 'file' | 'directory', content?: string) => {
        spend('vfs');
        return vfs.create(parentId, name, type, userId, content);
      },
    },
    bnlm: {
      train: (corpus: string, steps?: number) => { spend('bnlm'); return localModel.ensureInitAndTrain(corpus, steps ?? 200); },
      generate: (prompt: string, maxTokens?: number) => { spend('bnlm'); return localModel.generate(prompt, maxTokens ?? 60); },
      score: (text: string) => { spend('bnlm'); return localModel.score(text); },
      classify: (text: string) => { spend('bnlm'); return localClassifier.predict(text); },
    },
    agent: {
      ask: (personaId: string, prompt: string) => { spend('agentAsk'); return fetchGroqText(personaId, prompt); },
    },
    kernel: {
      publish: (topic: string, payload: unknown) => {
        spend('kernelPublish');
        if (BLOCKED_TOPICS.some(t => String(topic).startsWith(t))) {
          throw new Error(`kernos.exec is not allowed to publish "${topic}".`);
        }
        kernel.publish(topic, payload);
        return true;
      },
    },
    console: {
      log: (...a: unknown[]) => { console.log('[kernos.exec]', ...a); return true; },
      warn: (...a: unknown[]) => { console.warn('[kernos.exec]', ...a); return true; },
      error: (...a: unknown[]) => { console.error('[kernos.exec]', ...a); return true; },
    },
  };

  let worker: Worker;
  try {
    worker = new Worker(new URL('./kernosExec.worker.ts', import.meta.url), { type: 'module' });
  } catch (err: any) {
    return { ok: false, error: `Could not start the sandbox worker: ${err?.message || err}` };
  }

  return new Promise<KernosExecResult>(resolve => {
    let settled = false;
    const finish = (result: KernosExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };

    // The actual kill. Unlike a Promise.race this ends the thread, so a
    // synchronous infinite loop stops rather than merely being ignored.
    const timer = setTimeout(() => {
      finish({
        ok: false,
        error:
          `kernos.exec timed out after ${clampedTimeout}ms and the sandbox was terminated. ` +
          `If this was an infinite loop, it has been stopped.`,
      });
    }, clampedTimeout);

    worker.onerror = event => {
      finish({ ok: false, error: event.message || 'The sandbox worker failed to start or crashed.' });
    };

    worker.onmessage = async (event: MessageEvent) => {
      const msg = event.data;

      if (msg?.type === 'done') {
        finish(msg.ok ? { ok: true, value: msg.value } : { ok: false, error: msg.error });
        return;
      }

      if (msg?.type !== 'rpc') return;

      // An unknown namespace/method is a bug or a probe; either way it is
      // reported to the sandbox as a failed call rather than ignored, so the
      // agent gets a usable error instead of hanging.
      const fn = handlers[msg.ns]?.[msg.method];
      if (!fn) {
        worker.postMessage({ type: 'rpc:result', id: msg.id, ok: false, error: `No such capability: ${msg.ns}.${msg.method}` });
        return;
      }

      try {
        const value = await fn(...(msg.args || []));
        // Results cross by structured clone; anything unclonable would throw
        // inside postMessage and hang the sandbox waiting for a reply that
        // never comes. Reported as an error instead.
        try {
          worker.postMessage({ type: 'rpc:result', id: msg.id, ok: true, value });
        } catch {
          worker.postMessage({
            type: 'rpc:result',
            id: msg.id,
            ok: false,
            error: `${msg.ns}.${msg.method} returned a value that cannot cross the sandbox boundary.`,
          });
        }
      } catch (err: any) {
        // Budget overruns land here too, which is what stops a runaway loop
        // from spending real API credit even before the timeout fires.
        worker.postMessage({ type: 'rpc:result', id: msg.id, ok: false, error: err?.message || String(err) });
      }
    };

    worker.postMessage({ type: 'run', code: compiled });
  });
}
