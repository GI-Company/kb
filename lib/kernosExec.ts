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
import { localModel } from './localModel';
import { localClassifier } from './localClassifier';
import { fetchGroqText } from './groqFetch';
import { VfsOverlay } from './vfsOverlay';
import type { Capability } from './terminalCapabilities';

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
//
// Keys reuse lib/terminalCapabilities.ts's Capability vocabulary wherever
// kernos.exec actually exercises that capability — 'vfs' and 'model:local'/
// 'model:cloud' below are the SAME strings `can`/`policy` show a terminal
// user, not a second naming scheme for the same three ideas. Previously
// these were agentAsk/bnlm/vfs — accurate, but their own vocabulary,
// invisible from the terminal side; `can classify` and "how much can an
// agent's kernos.exec call spend on model:local" had no way to agree they
// were talking about the same budget. kernelPublish has no Capability
// equivalent and keeps its own name: publishing to the bus isn't a
// capability exposed to terminal commands at all, so there's nothing to
// unify it with.
// This array exists only so TypeScript checks each string against the
// real Capability union below — an `as` cast on CALL_BUDGET itself would
// have suppressed exactly the typo it's meant to catch: a misspelled key
// creates a budget that silently never triggers (remaining[undefinedKey]--
// is NaN, and NaN <= 0 is false), not a compile error.
const _capabilityBudgetKeys: Capability[] = ['model:cloud', 'model:local', 'vfs'];
void _capabilityBudgetKeys;

const CALL_BUDGET = {
  'model:cloud': 5,
  'model:local': 5,
  vfs: 50,
  kernelPublish: 20,
} as const;

const BLOCKED_TOPICS = ['vm.spawn', 'task.run', 'sys.consolidate'];

/**
 * One line describing an RPC call, for `trace` — enough to know what ran
 * without dumping full payloads. A vfs.write carrying a megabyte of
 * content has no business in a log meant to be skimmed; its length does.
 */
function summarizeCall(ns: string, method: string, args: unknown[]): string {
  const s = (v: unknown, max = 40) => { const t = String(v); return t.length > max ? t.slice(0, max) + '…' : t; };
  switch (`${ns}.${method}`) {
    case 'vfs.read': return `read(${s(args[0])})`;
    case 'vfs.write': return `write(${s(args[0])}, ${String(args[1] ?? '').length} chars)`;
    case 'vfs.list': return `list(${s(args[0])})`;
    case 'vfs.create': return `create(${s(args[0])}, "${s(args[1])}")`;
    case 'bnlm.train': return `train(${String(args[0] ?? '').length} chars corpus)`;
    case 'bnlm.generate': return `generate("${s(args[0])}")`;
    case 'bnlm.score': return `score(${String(args[0] ?? '').length} chars)`;
    case 'bnlm.classify': return `classify("${s(args[0])}")`;
    case 'agent.ask': return `ask(${s(args[0])}, "${s(args[1])}")`;
    case 'kernel.publish': return `publish(${s(args[0])})`;
    default: return `${ns}.${method}(…)`;
  }
}

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
  // VFS mutations land here, not in the real filesystem, until this
  // invocation finishes with ok:true — see lib/vfsOverlay.ts for why.
  const overlay = new VfsOverlay(userId);
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
      read: (id: string) => { spend('vfs'); return overlay.read(id); },
      write: (id: string, content: string) => { spend('vfs'); return overlay.write(id, content); },
      list: (parentId: string) => { spend('vfs'); return overlay.list(parentId); },
      create: (parentId: string, name: string, type: 'file' | 'directory', content?: string) => {
        spend('vfs');
        return overlay.create(parentId, name, type, content);
      },
    },
    bnlm: {
      train: (corpus: string, steps?: number) => { spend('model:local'); return localModel.ensureInitAndTrain(corpus, steps ?? 200); },
      generate: (prompt: string, maxTokens?: number) => { spend('model:local'); return localModel.generate(prompt, maxTokens ?? 60); },
      score: (text: string) => { spend('model:local'); return localModel.score(text); },
      classify: (text: string) => { spend('model:local'); return localClassifier.predict(text); },
    },
    agent: {
      ask: (personaId: string, prompt: string) => { spend('model:cloud'); return fetchGroqText(personaId, prompt); },
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
      // The commit/discard decision. ok:true is the only path a staged
      // write ever reaches durable storage — a timeout, a worker crash, or
      // the script itself throwing all fall through to discard(), and
      // nothing the sandbox wrote survives. Commit failures (a stale id
      // that no longer exists, say) are swallowed rather than flipping a
      // result the caller already trusted to be ok:true — the call
      // budget already bounded how much a run could stage, so a partial
      // commit here is a smaller, already-a-no-op-style failure, not a
      // new one.
      if (result.ok && overlay.hasPendingWrites) {
        overlay.commit()
          .catch(err => console.error('[kernos.exec] overlay commit failed:', err))
          .finally(() => resolve(result));
        return;
      }
      overlay.discard();
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

      const summary = summarizeCall(msg.ns, msg.method, msg.args || []);
      // Every RPC call traces here, in one place, rather than inside each
      // handler — a new capability added to the table below is automatically
      // visible to `trace` without anyone having to remember to wire it up.
      // This is what makes an agent's use of vfs/bnlm/agent stop being
      // invisible to the glass box: previously only an EXPLICIT
      // kernel.publish call from the agent's own code reached the bus at
      // all, so a classify or a file write via kernos.exec left no trace
      // unless the agent happened to also announce it itself.
      const trace = (ok: boolean, error?: string) =>
        kernel.publish('kernos.exec:call', { ns: msg.ns, method: msg.method, ok, summary, error });

      // An unknown namespace/method is a bug or a probe; either way it is
      // reported to the sandbox as a failed call rather than ignored, so the
      // agent gets a usable error instead of hanging.
      const fn = handlers[msg.ns]?.[msg.method];
      if (!fn) {
        const error = `No such capability: ${msg.ns}.${msg.method}`;
        trace(false, error);
        worker.postMessage({ type: 'rpc:result', id: msg.id, ok: false, error });
        return;
      }

      try {
        const value = await fn(...(msg.args || []));
        trace(true);
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
        // from spending real API credit even before the timeout fires — and
        // now that denial is traced too, not just silently thrown back to
        // the agent's own script.
        const error = err?.message || String(err);
        trace(false, error);
        worker.postMessage({ type: 'rpc:result', id: msg.id, ok: false, error });
      }
    };

    worker.postMessage({ type: 'run', code: compiled });
  });
}
