// kernos.exec — the agent-callable execution tool. Runs agent-generated
// TypeScript through the exact same kind of sandbox
// components/apps/DynamicApplet.tsx already runs human-authored applet
// code in (an AsyncFunction body, no real eval, no DOM, no raw imports —
// see lib/appletCompiler.ts), just with a different contract: the code
// `export default`s a value OR a function; if it's a function, it's
// called (and awaited) and its return value becomes the tool result.
// Nothing here opens a window — this is for computing and returning a
// result, not UI. (Editor/CDE's "Launch Applet" is the UI path.)
//
// Capabilities injected into the sandbox are curated, not the raw
// modules: `vfs`/`bnlm` are scoped to the calling user, `agent.ask` goes
// through the same /api/chat path as everything else (so it's subject to
// the same server-side rate limiting), and `kernel` is the same
// restricted publish/subscribe proxy DynamicApplet.tsx already uses
// (blocks vm.spawn/task.run/sys.consolidate).
//
// Safety model, and its real limit: the wall-clock timeout below
// (Promise.race) catches slow/hung *async* work — a stuck fetch, an
// agent.ask that never resolves — but it cannot preempt genuinely
// synchronous code (a real `while (true) {}`), because JS is single-
// threaded and nothing here runs off-thread. True hard-kill of runaway
// code needs a Web Worker (killable via terminate() from outside its own
// thread) — not built for v1, since agent-generated code comes from the
// same trusted model already calling bnlm.train/exec/etc., not arbitrary
// untrusted input. The per-call budget guard below is the actual backstop
// for a runaway *loop* around real calls (agent.ask in particular costs
// real Groq API budget even after the tool call times out and returns an
// error to the caller) — capping how many such calls one execution can
// make bounds worst-case cost even though the timeout alone can't.

import { compileExecBody } from './appletCompiler';
import { kernel } from '../services/kernel';
import { vfs } from './vfs';
import { localModel } from './localModel';
import { fetchGroqText } from './groqFetch';
import * as LucideIcons from 'lucide-react';
import React from 'react';
import { Envelope } from '../types';

export interface KernosExecResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 20000;

// Worst-case call budget per single kernos.exec invocation — deliberately
// small; this is a tool call inside a chat turn or DAG step, not a batch
// job. Exceeding any of these throws, same as any other runtime error.
const CALL_BUDGET = { agentAsk: 5, bnlm: 5, vfs: 50, kernelPublish: 20 };

type AsyncFn = (...args: unknown[]) => Promise<unknown>;

export async function runKernosExec(code: string, userId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<KernosExecResult> {
  let compiled: string;
  try {
    compiled = compileExecBody(code);
  } catch (err: any) {
    return { ok: false, error: `Compile error: ${err?.message || err}` };
  }

  const clampedTimeout = Math.min(Math.max(timeoutMs, 1000), MAX_TIMEOUT_MS);
  const remaining = { ...CALL_BUDGET };
  const guard = (kind: keyof typeof CALL_BUDGET) => {
    if (remaining[kind]-- <= 0) {
      throw new Error(`kernos.exec: exceeded the ${kind} call budget (${CALL_BUDGET[kind]} per execution) — this usually means a loop around a real call, not a one-off.`);
    }
  };

  // Same restricted proxy DynamicApplet.tsx's AppletAPI already uses —
  // publish/subscribe only, hard-blocked from destructive OS topics.
  const kernelProxy = {
    publish: (topic: string, payload: unknown) => {
      guard('kernelPublish');
      const blocked = ['vm.spawn', 'task.run', 'sys.consolidate'];
      if (blocked.some(t => topic.startsWith(t))) {
        console.error(`[KernosExecSecurity] blocked restricted topic: ${topic}`);
        return;
      }
      kernel.publish(topic, payload);
    },
    subscribe: (cb: (env: Envelope) => void) => kernel.subscribe(cb),
  };

  const vfsApi = {
    read: (id: string) => { guard('vfs'); return vfs.read(id, userId); },
    write: (id: string, content: string) => { guard('vfs'); return vfs.write(id, content, userId); },
    list: (parentId: string) => { guard('vfs'); return vfs.list(parentId, userId); },
    create: (parentId: string, name: string, type: 'file' | 'directory', content?: string) => {
      guard('vfs');
      return vfs.create(parentId, name, type, userId, content);
    },
  };

  const bnlmApi = {
    train: (corpus: string, steps?: number) => { guard('bnlm'); return localModel.ensureInitAndTrain(corpus, steps ?? 200); },
    generate: (prompt: string, maxTokens?: number) => { guard('bnlm'); return localModel.generate(prompt, maxTokens ?? 60); },
    score: (text: string) => { guard('bnlm'); return localModel.score(text); },
  };

  const agentApi = {
    ask: (personaId: string, prompt: string) => { guard('agentAsk'); return fetchGroqText(personaId, prompt); },
  };

  try {
    // AsyncFunction isn't a global — construct it the same way any
    // async-function-from-a-string trick does, via the constructor of a
    // throwaway async function's prototype chain.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => AsyncFn;
    const sandboxFn = new AsyncFunction(
      'React', 'Lucide', 'kernel', 'vfs', 'bnlm', 'agent', 'console',
      `
        ${compiled}
        if (typeof __kernosExecExport === 'function') {
          return await __kernosExecExport();
        }
        if (typeof __kernosExecExport !== 'undefined') {
          return __kernosExecExport;
        }
        // No \`export default\` at all — compileExecBody allows that (unlike
        // applets, which need a real component reference). The code's own
        // top-level \`return\`, if it has one, already exited above this
        // point; if it doesn't, this implicitly returns undefined, not a
        // ReferenceError — __kernosExecExport is never referenced directly
        // here, only through the ReferenceError-safe \`typeof\` checks above.
      `
    );

    const execPromise = sandboxFn(React, LucideIcons, kernelProxy, vfsApi, bnlmApi, agentApi, console);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`kernos.exec timed out after ${clampedTimeout}ms`)), clampedTimeout)
    );
    const value = await Promise.race([execPromise, timeoutPromise]);
    return { ok: true, value };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
