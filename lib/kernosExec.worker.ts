/// <reference lib="webworker" />
// The sandbox thread for kernos.exec.
//
// WHY A WORKER: the previous design raced execution against a timeout
// Promise on the main thread. That catches slow *async* work, but it cannot
// preempt synchronous code — `while (true) {}` on the main thread hangs the
// entire tab, timeout or not, because nothing else gets to run. A worker is
// a separate thread with its own event loop, so the host can call
// terminate() and the loop actually dies.
//
// Nothing capability-bearing lives in here. The worker holds no reference to
// the VFS, the local model, the kernel bus, or the network — it only knows
// how to ask the host for those things over postMessage, and the host
// decides whether to answer. Killing this thread therefore cannot leave a
// half-applied capability behind; the worst an aborted run leaves is an
// unanswered request.

interface RpcResolvers {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

const pending = new Map<number, RpcResolvers>();
let rpcSeq = 0;

/** Asks the host to perform a capability call on our behalf. */
function rpc(ns: string, method: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    pending.set(id, { resolve, reject });
    (self as unknown as Worker).postMessage({ type: 'rpc', id, ns, method, args });
  });
}

const makeNamespace = (ns: string, methods: string[]) =>
  Object.fromEntries(methods.map(m => [m, (...args: unknown[]) => rpc(ns, m, args)]));

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;

  if (msg?.type === 'rpc:result') {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.value);
    else entry.reject(new Error(msg.error || 'Capability call failed'));
    return;
  }

  if (msg?.type !== 'run') return;

  try {
    const vfs = makeNamespace('vfs', ['read', 'write', 'list', 'create']);
    const bnlm = makeNamespace('bnlm', ['train', 'generate', 'score', 'classify']);
    const agent = makeNamespace('agent', ['ask']);
    // publish is fire-and-forget from here; subscribe is deliberately absent
    // because a callback can't survive a terminate() and would leak a
    // listener on the host for a thread that no longer exists.
    const kernel = makeNamespace('kernel', ['publish']);

    // console is proxied so output still reaches the host's devtools rather
    // than vanishing into a worker nobody is inspecting.
    const sandboxConsole = {
      log: (...a: unknown[]) => rpc('console', 'log', a),
      warn: (...a: unknown[]) => rpc('console', 'warn', a),
      error: (...a: unknown[]) => rpc('console', 'error', a),
    };

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;

    const fn = new AsyncFunction(
      'kernel', 'vfs', 'bnlm', 'agent', 'console',
      `
        ${msg.code}
        if (typeof __kernosExecExport === 'function') {
          return await __kernosExecExport();
        }
        if (typeof __kernosExecExport !== 'undefined') {
          return __kernosExecExport;
        }
      `
    );

    const value = await fn(kernel, vfs, bnlm, agent, sandboxConsole);

    // The result crosses by structured clone, so anything unclonable (a
    // function, a class instance, a DOM node) would throw on postMessage and
    // look like a sandbox failure. Check here and report it as what it is.
    try {
      structuredClone(value);
    } catch {
      (self as unknown as Worker).postMessage({
        type: 'done',
        ok: false,
        error:
          'kernos.exec returned a value that cannot cross the sandbox boundary ' +
          '(functions, class instances and DOM nodes cannot). Return plain data instead.',
      });
      return;
    }

    (self as unknown as Worker).postMessage({ type: 'done', ok: true, value });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    (self as unknown as Worker).postMessage({ type: 'done', ok: false, error: message });
  }
};
