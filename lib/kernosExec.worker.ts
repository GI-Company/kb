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

/**
 * Forwards any method call on this namespace to the host as an RPC. Not
 * built from a fixed method list — the host's own handler table
 * (lib/kernosExec.ts) is the single source of truth for which
 * namespace.method combinations actually exist, not a second list
 * duplicated here that could drift from it.
 *
 * That drift was a real bug, not a hypothetical one: the old version built
 * each namespace from Object.fromEntries(methods.map(...)) with an
 * explicit array (`makeNamespace('vfs', ['read','write','list','create'])`).
 * Calling vfs.delete() then threw a plain "vfs.delete is not a function"
 * from inside the sandbox — the worker rejected it before any RPC went
 * out, so the host's own "No such capability" handling (and the trace
 * entry it produces) never ran for a method this list hadn't heard of.
 * Every method the agent's script calls now reaches the host; the host
 * decides what exists, once, in one place.
 */
const makeNamespace = (ns: string) =>
  new Proxy({}, { get: (_target, method: string) => (...args: unknown[]) => rpc(ns, method, args) });

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
    const vfs = makeNamespace('vfs');
    const bnlm = makeNamespace('bnlm');
    const agent = makeNamespace('agent');
    const net = makeNamespace('net');
    // publish is fire-and-forget from here; subscribe is deliberately absent
    // from the HOST's handler table (not this list, which no longer
    // exists) — a callback can't survive a terminate() and would leak a
    // listener on the host for a thread that no longer exists. Calling
    // kernel.subscribe() now reaches the host and gets a real "No such
    // capability" error, rather than failing silently here beforehand.
    const kernel = makeNamespace('kernel');

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
      'kernel', 'vfs', 'bnlm', 'agent', 'net', 'console',
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

    const value = await fn(kernel, vfs, bnlm, agent, net, sandboxConsole);

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
