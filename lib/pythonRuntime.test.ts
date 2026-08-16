import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The runtime's only dependency is the session check, and these tests are
// about scheduling, not auth — so it's stubbed to "signed in".
vi.mock('./auth', () => ({ getSession: vi.fn(async () => ({ user: { id: 'u1' } })) }));

/**
 * A Worker that never answers unless told to. Real Pyodide can't run in
 * jsdom, and the bugs under test are host-side scheduling bugs, so the
 * useful fake is one whose replies we control precisely.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  terminated = false;
  posted: any[] = [];

  constructor() { FakeWorker.instances.push(this); }

  postMessage(msg: any) {
    this.posted.push(msg);
    // Booting is answered immediately; `run`/`pip` are left hanging so a
    // test can decide when (or whether) they finish.
    if (msg?.type === 'init') queueMicrotask(() => this.reply({ type: 'ready', version: '3.14.2' }));
  }

  reply(data: any) { this.onmessage?.({ data } as MessageEvent); }
  terminate() { this.terminated = true; }
}

vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
vi.stubGlobal('URL', globalThis.URL);

const { pythonRuntime } = await import('./pythonRuntime');

describe('pythonRuntime', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    pythonRuntime.terminate();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

  it('boots once and reuses the interpreter across runs', async () => {
    const first = pythonRuntime.run('print(1)');
    await flush();
    FakeWorker.instances[0].reply({ type: 'done', ok: true, stdout: '1\n', stderr: '' });
    expect((await first).stdout).toBe('1\n');

    const second = pythonRuntime.run('print(2)');
    await flush();
    expect(FakeWorker.instances).toHaveLength(1); // no second 13MB download
    FakeWorker.instances[0].reply({ type: 'done', ok: true, stdout: '2\n', stderr: '' });
    expect((await second).stdout).toBe('2\n');
  });

  // The bug: Ctrl+C killed the worker but left that run's 30s watchdog
  // armed. It fired later and terminated whatever interpreter had been
  // booted since, reporting a timeout for a command that had already
  // finished. Only reproducible by interrupting and then continuing to work.
  it('terminate() disarms the interrupted run\'s watchdog', async () => {
    const interrupted = pythonRuntime.run('while True: pass');
    await flush();
    expect(FakeWorker.instances).toHaveLength(1);

    pythonRuntime.terminate();
    expect((await interrupted).code).toBe(130); // SIGINT, and it does resolve

    // The two watchdogs have to be separated in time or the assertion can't
    // tell them apart: the stale one is due at t=30s, so starting the next
    // run at t=20s puts its own deadline at t=50s.
    await vi.advanceTimersByTimeAsync(20_000);
    const next = pythonRuntime.run('print(1)');
    await flush();
    const worker = FakeWorker.instances[1];
    expect(worker.terminated).toBe(false);

    // t=35s: past the stale deadline, well short of this run's own.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(worker.terminated).toBe(false);

    worker.reply({ type: 'done', ok: true, stdout: 'ok\n', stderr: '' });
    expect((await next).stdout).toBe('ok\n');
  });

  it('kills a run that overruns the limit and says so', async () => {
    const hung = pythonRuntime.run('while True: pass');
    await flush();
    const worker = FakeWorker.instances[0];

    await vi.advanceTimersByTimeAsync(31_000);
    const result = await hung;
    expect(worker.terminated).toBe(true);
    expect(result.code).toBe(124);
    expect(result.stderr).toMatch(/timed out/);
  });

  // Package installs are off by default; the message has to explain that
  // rather than leaving someone to guess why numpy won't install.
  it('refuses pip install without booting the interpreter', async () => {
    const result = await pythonRuntime.pipInstall(['numpy']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not enabled/);
    expect(FakeWorker.instances).toHaveLength(0);
  });
});
