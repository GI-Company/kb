// Client-side TSX/JSX -> runnable-code compiler, shared by two callers:
//  - Editor/CDE's "Launch Applet" (components/apps/DynamicApplet.tsx runs
//    the result as a React component)
//  - lib/kernosExec.ts's agent-callable `kernos.exec` tool (runs the
//    result as a plain value/function, no component contract)
// No server round-trip — Sucrase transforms JSX/TypeScript syntax
// entirely in the browser (a syntax transformer, not a real module
// bundler, and needs no runtime helper library — the output is
// self-contained).
//
// Deliberately scoped to `import ... from 'react'` and
// `import * as X from 'lucide-react'` (both stripped — React/Lucide are
// supplied as sandbox globals already) plus a single default export.
// Anything else imported (relative paths to real project files) is
// stripped along with everything else and will simply be undefined at
// runtime — this is a single-file compiler, not a bundler, and that's a
// known, deliberate v1 limit rather than an oversight.

import { transform } from 'sucrase';

export interface CompileResult {
  code: string; // ready to run inside DynamicApplet.tsx's sandbox
}

// Matches whole `import ... from '...';` statements, including multi-line
// (e.g. destructured) import lists.
const IMPORT_STATEMENT_RE = /^[ \t]*import\s+[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm;

// `export default function Foo(){}` / `export default class Foo{}` /
// `export default () => {}` / `export default SomeIdentifier;` all become
// valid expressions once `export default ` is replaced with `const
// <bindingName> = ` — a named function/class declaration is legal JS in
// expression position (and keeps its name for stack traces/DevTools).
const EXPORT_DEFAULT_RE = /export\s+default\s+/;

/** Shared compile step: strip imports, rebind the default export to `bindingName`, transform JSX/TS. Throws with a message safe to surface to whoever wrote the source (human or agent). */
function compileSource(source: string, bindingName: string): string {
  if (!source || !source.trim()) {
    throw new Error('Nothing to compile — the source is empty.');
  }

  const withoutImports = source.replace(IMPORT_STATEMENT_RE, '');

  if (!EXPORT_DEFAULT_RE.test(withoutImports)) {
    throw new Error('No default export found. Add `export default ...`.');
  }
  const rebound = withoutImports.replace(EXPORT_DEFAULT_RE, `const ${bindingName} = `);

  let transformed: string;
  try {
    const result = transform(rebound, {
      transforms: ['typescript', 'jsx'],
      jsxRuntime: 'classic', // React.createElement(...) calls, referencing the sandbox's injected `React` param
      production: true,
    });
    transformed = result.code;
  } catch (err: any) {
    throw new Error(`Syntax error: ${err?.message || err}`);
  }

  // Common hooks available bare (not just React.useState) — matches how
  // this project's own example applets are written (see MyTestApplet.tsx).
  const preamble =
    'const { useState, useEffect, useRef, useCallback, useMemo, useContext, useReducer, useLayoutEffect } = React;\n';

  return preamble + transformed;
}

export function compileApplet(source: string): CompileResult {
  return { code: compileSource(source, 'KernosDynamicApplet') };
}

/** For lib/kernosExec.ts — same compile step, bound to a differently-named export since this isn't a React-component contract. */
export function compileExecBody(source: string): string {
  return compileSource(source, '__kernosExecExport');
}
