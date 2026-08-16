// Python in the terminal, via Pyodide on a Web Worker.
//
// TWO DELIBERATE GATES:
//
//  1. Signed-in only. The runtime is ~13MB before a single package, which
//     is a real cost to push onto someone who typed `python` out of
//     curiosity on a guest session. Guests get a clear explanation instead
//     of a silent 13MB download.
//
//  2. Lazy. Nothing is fetched until the first `python` or `pip` command.
//     Importing this module costs nothing; the worker isn't even created.
//
// The worker gives the same property kernos.exec has: `while True: pass` is
// terminable, and the UI keeps painting while Python runs.

import { getSession } from './auth';

export interface PythonResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Progress messages during the first load, which is slow enough to need them. */
export type StatusHandler = (text: string) => void;

const MAX_RUNTIME_MS = 30_000;

/**
 * `pip install` is off, and this is the whole switch.
 *
 * The interpreter is self-hosted, but package wheels are NOT in the npm
 * package — only the 5 runtime files are. Wheels can only come from
 * jsDelivr, and `connect-src` in vercel.json does not list it. That is a
 * deliberate ordering choice, not an oversight: shipping Python first and
 * package installs second keeps the CSP unchanged for this slice.
 *
 * TO ENABLE, two changes, both small:
 *   1. vercel.json → append ` https://cdn.jsdelivr.net` to connect-src.
 *   2. Flip this to true.
 *
 * The install path is already written and deliberately uses Pyodide's
 * `loadPackage`, not micropip: names resolve against the pyodide-lock.json
 * we serve ourselves, and every wheel's sha256 is verified against it. So
 * enabling this allows 354 pinned, checksummed packages — not arbitrary
 * code from PyPI, which is what micropip would have meant.
 */
const PACKAGE_INSTALL_ENABLED = false;

class PythonRuntime {
  private worker: Worker | null = null;
  private ready = false;
  private booting: Promise<void> | null = null;

  get isLoaded(): boolean {
    return this.ready;
  }

  /** True when a real account is signed in. Guests are refused before any download starts. */
  async isAvailable(): Promise<boolean> {
    return (await getSession()) !== null;
  }

  private spawnWorker(): Worker {
    return new Worker(new URL('./python.worker.ts', import.meta.url), { type: 'module' });
  }

  /**
   * Boots the runtime if it isn't already. Concurrent callers share one boot
   * rather than each starting a 13MB download.
   */
  private async boot(onStatus?: StatusHandler): Promise<void> {
    if (this.ready) return;
    if (this.booting) return this.booting;

    this.booting = new Promise<void>((resolve, reject) => {
      const worker = this.spawnWorker();
      this.worker = worker;

      const timer = setTimeout(() => {
        worker.terminate();
        this.worker = null;
        this.booting = null;
        reject(new Error('Timed out downloading the Python runtime. Check your connection and try again.'));
      }, 120_000);

      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        if (msg?.type === 'status') { onStatus?.(msg.text); return; }
        if (msg?.type === 'ready') {
          clearTimeout(timer);
          this.ready = true;
          onStatus?.(`Python ${msg.version} ready.`);
          resolve();
          return;
        }
        if (msg?.type === 'done' && !msg.ok) {
          clearTimeout(timer);
          this.booting = null;
          reject(new Error(msg.stderr || 'Python runtime failed to start.'));
        }
      };

      worker.onerror = (event) => {
        clearTimeout(timer);
        this.worker = null;
        this.booting = null;
        reject(new Error(event.message || 'Python worker failed to start.'));
      };

      worker.postMessage({ type: 'init' });
    });

    return this.booting;
  }

  /**
   * The current run's watchdog and its unresolved promise.
   *
   * Held on the instance so terminate() can cancel them. Ctrl+C kills the
   * worker while a run is outstanding, and without this its timer stayed
   * armed and fired 30s later — terminating whatever interpreter had been
   * booted since and reporting a timeout for a command that had already
   * finished. Caught by running Ctrl+C and then another command.
   */
  private pending: { timer: ReturnType<typeof setTimeout>; settle: (r: PythonResult) => void } | null = null;

  /** Kills the runtime. The next command pays the load cost again, which is the point of a hard stop. */
  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.booting = null;
    if (this.pending) {
      const { timer, settle } = this.pending;
      this.pending = null;
      clearTimeout(timer);
      // 130 is the conventional shell code for "killed by SIGINT".
      settle({ stdout: '', stderr: '', code: 130 });
    }
  }

  private async send(message: Record<string, unknown>, onStatus?: StatusHandler): Promise<PythonResult> {
    await this.boot(onStatus);
    const worker = this.worker;
    if (!worker) return { stdout: '', stderr: 'python: runtime is not running.\n', code: 1 };

    return new Promise<PythonResult>(resolve => {
      const finish = (result: PythonResult) => {
        if (this.pending?.timer === timer) this.pending = null;
        clearTimeout(timer);
        worker.onmessage = null;
        resolve(result);
      };

      // A real kill, not a race — this is why Python runs off-thread.
      const timer = setTimeout(() => {
        // Detach first: otherwise terminate() would settle this promise with
        // 130 and the timeout message below would be swallowed.
        this.pending = null;
        this.terminate();
        finish({
          stdout: '',
          stderr: `python: timed out after ${MAX_RUNTIME_MS / 1000}s and the interpreter was terminated.\n`,
          code: 124,
        });
      }, MAX_RUNTIME_MS);

      this.pending = { timer, settle: finish };

      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        if (msg?.type === 'status') { onStatus?.(msg.text); return; }
        if (msg?.type === 'done') {
          finish({ stdout: msg.stdout || '', stderr: msg.stderr || '', code: msg.ok ? 0 : 1 });
        }
      };

      worker.postMessage(message);
    });
  }

  /**
   * Runs Python source. `files` is written into the interpreter's filesystem
   * first, so a script can `open()` the user's real VFS files by name, and
   * `stdin` is fed to sys.stdin so the script can sit in a pipeline.
   */
  async run(
    code: string,
    files: Record<string, string> = {},
    onStatus?: StatusHandler,
    stdin?: string
  ): Promise<PythonResult> {
    return this.send({ type: 'run', code, files, stdin }, onStatus);
  }

  /**
   * What `pip install` will accept, straight from the bundled lockfile.
   * Deliberately not routed through the worker: asking what is installable
   * should not trigger the 13MB interpreter download.
   */
  async pipList(): Promise<PythonResult> {
    try {
      const res = await fetch('/pyodide/pyodide-lock.json');
      if (!res.ok) throw new Error(`lockfile unavailable (${res.status})`);
      const lock = await res.json();
      const names = Object.keys(lock.packages || {}).sort();
      return {
        stdout:
          `${names.length} packages in Pyodide's verified distribution for Python ` +
          `${lock.info?.python || '?'}. Each wheel's sha256 is checked against the ` +
          `lockfile this list came from.\n` +
          (PACKAGE_INSTALL_ENABLED
            ? ''
            : 'Installation is not enabled in this deployment — the standard library is available, these are not.\n') +
          '\n' +
          names.join('  ') + '\n',
        stderr: '',
        code: 0,
      };
    } catch (err: any) {
      return { stdout: '', stderr: `pip: ${err?.message || err}\n`, code: 1 };
    }
  }

  async pipInstall(packages: string[], onStatus?: StatusHandler): Promise<PythonResult> {
    if (!PACKAGE_INSTALL_ENABLED) {
      return {
        stdout: '',
        stderr:
          'pip: package installation is not enabled in this deployment.\n' +
          "Python's full standard library is available — json, re, math, csv, " +
          'datetime, itertools, collections, statistics, hashlib, sqlite3 and the rest ' +
          'all work with no install step.\n' +
          'Run `pip list` to see what installing would make available.\n',
        code: 1,
      };
    }
    return this.send({ type: 'pip', packages }, onStatus);
  }
}

export const pythonRuntime = new PythonRuntime();

export const PYTHON_USAGE: Record<string, string> = {
  python: 'Usage: python -c "<code>"  |  python <file.py>',
  pip: 'Usage: pip install <package> [package...]  |  pip list',
};

export const GUEST_MESSAGE =
  'python: available to signed-in accounts only.\n' +
  'The runtime is a ~13 MB download, so it is not pushed onto guest sessions.\n' +
  'Sign in from Settings to use it.\n';
