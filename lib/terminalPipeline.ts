// Pipes and redirection, parsed and executed entirely in the browser.
//
// THE SECURITY POINT: `|` and `>` remain in api/exec.ts's DANGEROUS_CHARS
// rejection and must stay there. They are never sent to the server. The
// client parses the pipeline and composes the stages itself, so enabling
// this feature *removes* reasons to relax the server's sanitizer rather
// than creating them. More capability, same server surface.
//
// THE HONEST LIMIT: /api/exec has no stdin — each invocation is a fresh
// execFile in a throwaway jail. So a server command can only ever be the
// FIRST stage of a pipeline, never downstream of one. Rather than silently
// dropping the input, a server command in a later stage is refused with an
// explanation. The text filters below exist so the common pipelines
// (`cat x | grep y | wc -l`) are fully client-side anyway.

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface Stage {
  command: string;
  args: string[];
}

export interface ParsedLine {
  stages: Stage[];
  redirect?: { mode: 'overwrite' | 'append'; target: string };
}

/**
 * Splits a line into tokens, respecting single and double quotes so
 * `grep "hello world"` is one argument. Quotes are consumed, not kept.
 */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;

  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === ' ' || ch === '\t') {
      if (current || has) { tokens.push(current); current = ''; has = false; }
      continue;
    }
    current += ch;
  }
  if (current || has) tokens.push(current);
  return tokens;
}

/** Parses a line into pipeline stages plus an optional redirect. Returns a message on failure. */
export function parseLine(line: string): ParsedLine | string {
  const tokens = tokenize(line);
  if (tokens.length === 0) return 'empty command';

  let redirect: ParsedLine['redirect'];
  const body: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '>' || t === '>>') {
      const target = tokens[i + 1];
      if (!target) return `syntax error: ${t} needs a filename`;
      if (target === '|' || target === '>' || target === '>>') return `syntax error: ${t} needs a filename`;
      if (i + 2 < tokens.length) return 'syntax error: redirection must come last';
      redirect = { mode: t === '>>' ? 'append' : 'overwrite', target };
      break;
    }
    body.push(t);
  }

  const stages: Stage[] = [];
  let currentTokens: string[] = [];
  for (const t of body) {
    if (t === '|') {
      if (currentTokens.length === 0) return 'syntax error: empty command around |';
      stages.push({ command: currentTokens[0], args: currentTokens.slice(1) });
      currentTokens = [];
      continue;
    }
    currentTokens.push(t);
  }
  if (currentTokens.length === 0) return 'syntax error: empty command around |';
  stages.push({ command: currentTokens[0], args: currentTokens.slice(1) });

  return { stages, redirect };
}

// ── Text filters: read stdin, write stdout ──────────────────────────────
// These exist so a pipeline never needs the server. Each is a deliberate
// subset of the real tool, not a claim of full compatibility.

type Filter = (stdin: string, args: string[]) => CommandResult;

const lines = (s: string) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));
const join = (ls: string[]) => (ls.length ? ls.join('\n') + '\n' : '');
const ok = (stdout: string): CommandResult => ({ stdout, stderr: '', code: 0 });
const bad = (cmd: string, msg: string): CommandResult => ({ stdout: '', stderr: `${cmd}: ${msg}\n`, code: 1 });

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export const TEXT_FILTERS: Record<string, Filter> = {
  grep: (stdin, args) => {
    const flags = args.filter(a => a.startsWith('-'));
    const pattern = args.find(a => !a.startsWith('-'));
    if (pattern === undefined) return bad('grep', 'missing pattern\nUsage: grep [-i] [-v] <pattern>');
    const insensitive = flags.some(f => f.includes('i'));
    const invert = flags.some(f => f.includes('v'));
    const needle = insensitive ? pattern.toLowerCase() : pattern;
    const matched = lines(stdin).filter(l => {
      const hit = (insensitive ? l.toLowerCase() : l).includes(needle);
      return invert ? !hit : hit;
    });
    // grep exits 1 when nothing matched — scripts rely on that.
    return { stdout: join(matched), stderr: '', code: matched.length ? 0 : 1 };
  },

  wc: (stdin, args) => {
    const ls = lines(stdin);
    if (args.some(a => a.includes('l'))) return ok(`${ls.length}\n`);
    if (args.some(a => a.includes('w'))) return ok(`${stdin.split(/\s+/).filter(Boolean).length}\n`);
    if (args.some(a => a.includes('c'))) return ok(`${stdin.length}\n`);
    return ok(`${ls.length} ${stdin.split(/\s+/).filter(Boolean).length} ${stdin.length}\n`);
  },

  head: (stdin, args) => {
    const n = Number(flagValue(args, '-n') ?? 10);
    if (!Number.isFinite(n) || n < 0) return bad('head', 'invalid line count');
    return ok(join(lines(stdin).slice(0, n)));
  },

  tail: (stdin, args) => {
    const n = Number(flagValue(args, '-n') ?? 10);
    if (!Number.isFinite(n) || n < 0) return bad('tail', 'invalid line count');
    return ok(join(n === 0 ? [] : lines(stdin).slice(-n)));
  },

  sort: (stdin, args) => {
    let ls = [...lines(stdin)].sort((a, b) => a.localeCompare(b));
    if (args.some(a => a.includes('r'))) ls.reverse();
    if (args.some(a => a.includes('u'))) ls = ls.filter((l, i) => i === 0 || l !== ls[i - 1]);
    return ok(join(ls));
  },

  uniq: (stdin, args) => {
    const ls = lines(stdin);
    const counted = args.some(a => a.includes('c'));
    const out: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      if (i > 0 && ls[i] === ls[i - 1]) continue;
      if (counted) {
        let n = 1;
        while (i + n < ls.length && ls[i + n] === ls[i]) n++;
        out.push(`${String(n).padStart(4)} ${ls[i]}`);
      } else {
        out.push(ls[i]);
      }
    }
    return ok(join(out));
  },

  // Reads its arguments, not stdin — the one source stage that needs no file.
  echo: (_stdin, args) => ok(args.join(' ') + '\n'),
};

export const PIPE_AWARE_COMMANDS = new Set(Object.keys(TEXT_FILTERS));

/** True when a line uses any pipeline syntax, so callers can skip this path entirely. */
export function hasPipelineSyntax(line: string): boolean {
  const tokens = tokenize(line);
  return tokens.includes('|') || tokens.includes('>') || tokens.includes('>>');
}

export interface PipelineHandlers {
  /** Runs a VFS-backed command (ls, cat, ...). Returns null if not one. */
  runVfs: (stage: Stage, stdin: string) => Promise<CommandResult | null>;
  /** Writes the final output. Used for `>` and `>>`. */
  writeFile: (path: string, content: string, append: boolean) => Promise<CommandResult>;
  /** True if the command would otherwise go to /api/exec. */
  isServerCommand: (command: string) => boolean;
}

/**
 * Executes a parsed pipeline. Each stage's stdout becomes the next stage's
 * stdin. stderr is collected from every stage rather than only the last, so
 * a failure in the middle isn't swallowed.
 */
export async function runPipeline(
  parsed: ParsedLine,
  handlers: PipelineHandlers
): Promise<CommandResult> {
  let stdin = '';
  let stderr = '';
  let code = 0;

  for (let i = 0; i < parsed.stages.length; i++) {
    const stage = parsed.stages[i];
    const filter = TEXT_FILTERS[stage.command];

    if (filter) {
      const result = filter(stdin, stage.args);
      stdin = result.stdout;
      stderr += result.stderr;
      code = result.code;
      continue;
    }

    const vfsResult = await handlers.runVfs(stage, stdin);
    if (vfsResult) {
      stdin = vfsResult.stdout;
      stderr += vfsResult.stderr;
      code = vfsResult.code;
      continue;
    }

    if (handlers.isServerCommand(stage.command)) {
      return {
        stdout: '',
        stderr:
          stderr +
          `${stage.command}: cannot be used in a pipeline — it runs on the server, which has no stdin.\n` +
          `Commands that work in pipes: ${[...PIPE_AWARE_COMMANDS].sort().join(', ')}, plus cat and ls.\n`,
        code: 1,
      };
    }

    return { stdout: '', stderr: stderr + `${stage.command}: command not found\n`, code: 127 };
  }

  if (parsed.redirect) {
    const written = await handlers.writeFile(parsed.redirect.target, stdin, parsed.redirect.mode === 'append');
    if (written.code !== 0) return { stdout: '', stderr: stderr + written.stderr, code: written.code };
    // Output went to the file, so nothing is echoed back to the terminal.
    return { stdout: '', stderr, code };
  }

  return { stdout: stdin, stderr, code };
}
