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

/**
 * Shared compile step: strip imports, rebind a default export to
 * `bindingName` if one exists, transform JSX/TS. Throws with a message
 * safe to surface to whoever wrote the source (human or agent).
 *
 * `requireDefaultExport` distinguishes the two callers' actual needs:
 * compileApplet truly needs a component reference to render, so a missing
 * export is a real error there. compileExecBody doesn't — agent-generated
 * code frequently skips `export default` even when told to use it
 * (confirmed live: a smaller model asked for a computed result wrote a
 * bare `const result = ...` with no export at all), and that's a
 * completely reasonable, working script — it just returns via its own
 * `return` statement instead of an exported value. Rejecting that outright
 * fought the model instead of accepting what it actually produced.
 */
function compileSource(source: string, bindingName: string, requireDefaultExport: boolean): string {
  if (!source || !source.trim()) {
    throw new Error('Nothing to compile — the source is empty.');
  }

  const withoutImports = source.replace(IMPORT_STATEMENT_RE, '');
  const hasDefaultExport = EXPORT_DEFAULT_RE.test(withoutImports);

  if (!hasDefaultExport && requireDefaultExport) {
    throw new Error('No default export found. Add `export default ...`.');
  }
  const rebound = hasDefaultExport
    ? withoutImports.replace(EXPORT_DEFAULT_RE, `const ${bindingName} = `)
    : withoutImports;

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
  // the starter applet template in apps/Editor.tsx is written.
  const preamble =
    'const { useState, useEffect, useRef, useCallback, useMemo, useContext, useReducer, useLayoutEffect } = React;\n';

  return preamble + transformed;
}

export function compileApplet(source: string): CompileResult {
  return { code: compileSource(source, 'KernosDynamicApplet', true) };
}

/**
 * For lib/kernosExec.ts — same compile step, bound to a differently-named
 * export since this isn't a React-component contract, and tolerant of
 * code with no `export default` at all (see compileSource's doc comment).
 * Callers must check for the binding's existence with `typeof` before
 * referencing it directly — referencing a genuinely undeclared identifier
 * any other way throws a ReferenceError, and this binding may not exist
 * in the no-default-export case.
 */
export function compileExecBody(source: string): string {
  return compileSource(source, '__kernosExecExport', false);
}
