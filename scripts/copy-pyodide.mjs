// Copies Pyodide's runtime out of node_modules into public/ so it is served
// from our own origin.
//
// It cannot come from a CDN here, for two independent reasons:
//   - CSP: script-src is 'self' (plus 'unsafe-eval' and blob:), with no CDN
//     origin allowed. A jsdelivr script tag would be blocked outright.
//   - COEP: require-corp is set for SharedArrayBuffer, so any cross-origin
//     resource without a matching CORP header is refused as well.
// Self-hosting satisfies both without loosening either.
//
// ~13MB, so public/pyodide is gitignored and regenerated on install/build
// rather than committed.

import { cp, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pyodide');
const dest = join(root, 'public', 'pyodide');

// Only what the runtime actually loads. Copying the whole package would drag
// in source maps and docs for no benefit.
const FILES = [
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
];

if (!existsSync(src)) {
  console.error('[pyodide] node_modules/pyodide missing — run npm install first.');
  process.exit(0); // not fatal: a build without Python still works, python just reports unavailable
}

await mkdir(dest, { recursive: true });
let total = 0;
for (const file of FILES) {
  const from = join(src, file);
  if (!existsSync(from)) {
    console.warn(`[pyodide] expected ${file} but it is not in the package — skipping.`);
    continue;
  }
  await cp(from, join(dest, file));
  total += (await stat(from)).size;
}
console.log(`[pyodide] copied ${FILES.length} files (${(total / 1024 / 1024).toFixed(1)} MB) to public/pyodide`);
