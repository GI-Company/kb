/// <reference lib="webworker" />
import { loadPyodide } from 'pyodide';

// Pyodide (CPython compiled to WASM) on its own thread.
//
// WHY A WORKER, for the same reason kernos.exec uses one: Python running on
// the main thread would freeze the tab, and `while True: pass` would be
// unkillable. Off-thread, the host can terminate() a runaway script and the
// UI stays responsive. It also keeps a 13MB wasm instantiation off the
// thread that paints.
//
// Loaded from our own origin (public/pyodide, copied by
// scripts/copy-pyodide.mjs) rather than a CDN — the CSP has no CDN in
// script-src and COEP require-corp would refuse a cross-origin resource
// without CORP anyway.

/**
 * Must match the `pyodide` dependency in package.json. The lockfile we serve
 * from public/pyodide is the one from this version, and a wheel built for a
 * different ABI will not load — so a version bump has to move both.
 */
const PYODIDE_VERSION = '314.0.3';

let pyodide: any = null;
let loading: Promise<any> | null = null;

/** Captured so print() reaches the terminal instead of the worker's console. */
let stdoutBuffer = '';
let stderrBuffer = '';

async function ensurePyodide(): Promise<any> {
  if (pyodide) return pyodide;
  if (loading) return loading;

  loading = (async () => {
    // The 18KB loader is bundled from node_modules; everything heavy
    // (pyodide.asm.mjs, the 9.2MB wasm, python_stdlib.zip) is fetched at
    // runtime from indexURL below, same-origin.
    //
    // NOT `await import('/pyodide/pyodide.mjs')`. Vite rewrites a dynamic
    // import with a non-literal specifier to `__vite__injectQuery(url,
    // 'import')` — @vite-ignore does not suppress that — and the resulting
    // `/pyodide/pyodide.mjs?import` 500s because dev-server module
    // resolution does not cover public/. Verified live, not assumed.
    const instance = await loadPyodide({
      indexURL: '/pyodide/',
      // Package wheels are NOT in the npm package — only the interpreter is
      // — so they have to come from the CDN. Pinned to this exact version
      // and paired with our own bundled pyodide-lock.json, which carries a
      // sha256 for all 354 packages; loadPackage verifies against it. See
      // the `pip` handler below for why that is the whole install path.
      packageBaseUrl: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
      stdout: (line: string) => { stdoutBuffer += line + '\n'; },
      stderr: (line: string) => { stderrBuffer += line + '\n'; },
    });
    pyodide = instance;
    return instance;
  })();

  return loading;
}

// Mirrors readDirFiles' read-side cap in lib/terminalFs.ts — the write
// bridge shouldn't be more permissive than the one that seeds it.
const WRITE_BACK_MAX_BYTES = 2_000_000;

/**
 * Every regular file in Pyodide's CWD after a run, for the host to diff
 * against what it seeded in. Scoped to exactly this one flat directory —
 * matching readDirFiles' own scope — so a script that calls os.mkdir() and
 * writes inside it gets that work silently dropped, not durably written
 * somewhere the read bridge never showed it.
 */
function collectWorkspaceFiles(py: any): { files: Record<string, string>; skipped: string[] } {
  const entries: string[] = py.FS.readdir('.');
  const files: Record<string, string> = {};
  const skipped: string[] = [];
  let total = 0;

  for (const name of entries) {
    if (name === '.' || name === '..') continue;
    const stat = py.FS.stat(name);
    // Emscripten FS mode bits: S_IFDIR is octal 040000.
    const isDir = (stat.mode & 0o170000) === 0o040000;
    if (isDir) { skipped.push(`${name} (directory — only the flat workspace round-trips)`); continue; }

    let content: string;
    try {
      content = py.FS.readFile(name, { encoding: 'utf8' });
    } catch {
      skipped.push(`${name} (not valid text)`);
      continue;
    }
    total += content.length;
    if (total > WRITE_BACK_MAX_BYTES) { skipped.push(`${name} (over the 2MB write-back cap)`); continue; }
    files[name] = content;
  }
  return { files, skipped };
}

function drain() {
  const out = stdoutBuffer;
  const err = stderrBuffer;
  stdoutBuffer = '';
  stderrBuffer = '';
  return { out, err };
}

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;

  try {
    if (msg?.type === 'init') {
      post({ type: 'status', text: 'Downloading Python runtime (~13 MB, first run only)…' });
      await ensurePyodide();
      const version = pyodide.runPython('import sys; sys.version.split()[0]');
      post({ type: 'ready', version });
      return;
    }

    if (msg?.type === 'run') {
      const py = await ensurePyodide();
      drain(); // discard anything buffered before this run

      // Files the script should see, mapped in before execution. Writing
      // them into Pyodide's in-memory FS is what makes open("notes.md")
      // work against the user's real VFS content.
      if (msg.files) {
        for (const [name, content] of Object.entries(msg.files as Record<string, string>)) {
          try { py.FS.writeFile(name, content as string, { encoding: 'utf8' }); } catch { /* skip unwritable names */ }
        }
      }

      // Piped input replaces sys.stdin wholesale. StringIO is what makes
      // input() and sys.stdin.read() work without a real console attached.
      if (typeof msg.stdin === 'string') {
        py.globals.set('__kernos_stdin', msg.stdin);
        py.runPython('import sys, io; sys.stdin = io.StringIO(__kernos_stdin)');
      }

      let value: unknown;
      try {
        value = await py.runPythonAsync(msg.code);
      } catch (err: any) {
        const { out, err: errOut } = drain();
        // Python tracebacks are the useful part of a failure, so they are
        // passed through rather than replaced with a generic message.
        post({ type: 'done', ok: false, stdout: out, stderr: errOut + String(err?.message || err) + '\n' });
        return;
      }

      const { out, err: errOut } = drain();
      // A bare expression's value is echoed like a REPL would; None is not,
      // since almost every statement evaluates to it.
      const repr = value === undefined || value === null ? '' : String(value) + '\n';

      // Only collected on the success path — a script that raised gets no
      // write-back at all, computed or otherwise. The host stages these
      // into a VfsOverlay (lib/vfsOverlay.ts, the same primitive
      // kernos.exec's VFS writes use) and only commits because this
      // message says ok:true; nothing here is durable yet.
      const { files: workspaceFiles, skipped } = collectWorkspaceFiles(py);
      const skipNote = skipped.length ? `\n${skipped.map(s => `(not written back: ${s})`).join('\n')}\n` : '';

      post({ type: 'done', ok: true, stdout: out + repr, stderr: errOut + skipNote, files: workspaceFiles });
      return;
    }

    if (msg?.type === 'pip') {
      const py = await ensurePyodide();
      post({ type: 'status', text: `Installing ${msg.packages.join(', ')}…` });
      // loadPackage, NOT micropip. micropip installs whatever PyPI serves,
      // which would mean allowing arbitrary hosts in connect-src and running
      // unverified code. loadPackage resolves names against the lockfile we
      // ship and checks each wheel's sha256, so the install set is the 354
      // curated Pyodide packages and nothing else. Narrower than real pip on
      // purpose — and the interesting ones (numpy, pandas, scipy,
      // scikit-learn, matplotlib, sympy, pillow) are all in it.
      try {
        await py.loadPackage(msg.packages);
      } catch (err: any) {
        post({
          type: 'done',
          ok: false,
          stdout: '',
          stderr:
            `pip: ${err?.message || err}\n` +
            `Installable packages are the ones in Pyodide's verified distribution; ` +
            `arbitrary PyPI packages are not fetched here.\n` +
            `Run \`pip list\` to see what is available.\n`,
        });
        return;
      }
      const { out, err: errOut } = drain();
      post({ type: 'done', ok: true, stdout: out + `Installed ${msg.packages.join(', ')}\n`, stderr: errOut });
      return;
    }
  } catch (err: any) {
    post({ type: 'done', ok: false, stdout: '', stderr: `python: ${err?.message || err}\n` });
  }
};
