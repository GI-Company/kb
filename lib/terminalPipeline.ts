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

/**
 * Line count for head/tail, accepting both `-n 5` and the `-5` shorthand.
 *
 * Only `-n 5` used to parse. `head -2` fell through to the default of 10
 * and silently returned the wrong number of lines — no error, just a quiet
 * lie, which is the worst way for this to fail. The shorthand is also the
 * form the natural-language translator reaches for.
 */
/**
 * Short flags as individual letters: `['-rn']` → `{'r','n'}`.
 *
 * Numeric shorthand (`-5`) is skipped — that's head/tail's line count, not
 * a flag, and lineCount below reads it.
 */
function shortFlags(args: string[]): Set<string> {
  const out = new Set<string>();
  for (const a of args) {
    if (!a.startsWith('-') || a === '-' || /^-\d+$/.test(a)) continue;
    if (a.startsWith('--')) { out.add(a.slice(2)); continue; }
    for (const ch of a.slice(1)) out.add(ch);
  }
  return out;
}

/**
 * Fails on a flag this implementation doesn't have, instead of ignoring it.
 *
 * WHY THIS IS THE POINT OF THE FILE: `sort` used to test flags with
 * `args.some(a => a.includes('r'))`. `sort -n` therefore matched nothing,
 * sorted lexically, and returned 10 before 9 with no error — a wrong answer
 * wearing a success exit code. `head -2` failed the same way for the same
 * reason. These filters are deliberate subsets of the real tools, and a
 * subset is only honest if it says so when you step outside it.
 */
function unknownFlag(command: string, args: string[], known: string): CommandResult | null {
  const supported = new Set(known.split(''));
  for (const flag of shortFlags(args)) {
    if (!supported.has(flag)) {
      return bad(
        command,
        `unsupported option -${flag}\n` +
        `This is a subset of ${command}; it supports ${[...supported].map(f => '-' + f).join(' ')}.`
      );
    }
  }
  return null;
}

/** Bytes from a human-readable size like `4.5K` or `2M`, for `sort -h`. */
function humanSize(text: string): number {
  const m = text.trim().match(/^(-?[\d.]+)\s*([KMGTP])?i?B?/i);
  if (!m) return Number.NEGATIVE_INFINITY;
  const scale = { k: 1e3, m: 1e6, g: 1e9, t: 1e12, p: 1e15 }[(m[2] || '').toLowerCase()] ?? 1;
  return Number(m[1]) * scale;
}

/** Splits on a delimiter, honouring backslash escapes — for sed's s/a\/b/c/. */
function splitUnescaped(text: string, delim: string): string[] {
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === delim) { current += delim; i++; continue; }
    if (text[i] === delim) { out.push(current); current = ''; continue; }
    current += text[i];
  }
  out.push(current);
  return out;
}

/** cut's -f list: "1", "1,3", "2-4", or a mix. 1-indexed, null if malformed. */
function parseFieldList(spec: string): number[] | null {
  const fields: number[] = [];
  for (const part of spec.split(',')) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (from < 1 || to < from) return null;
      for (let n = from; n <= to; n++) fields.push(n);
      continue;
    }
    if (!/^\d+$/.test(part) || Number(part) < 1) return null;
    fields.push(Number(part));
  }
  return fields.length ? [...new Set(fields)].sort((a, b) => a - b) : null;
}

/** tr's character sets, expanding a-z ranges. */
function expandSet(spec: string | undefined): string | null {
  if (!spec) return null;
  let out = '';
  for (let i = 0; i < spec.length; i++) {
    if (spec[i + 1] === '-' && spec[i + 2] !== undefined) {
      for (let c = spec.charCodeAt(i); c <= spec.charCodeAt(i + 2); c++) out += String.fromCharCode(c);
      i += 2;
      continue;
    }
    out += spec[i];
  }
  return out;
}

function lineCount(args: string[], fallback = 10): number | null {
  const shorthand = args.find(a => /^-\d+$/.test(a));
  const raw = shorthand ? shorthand.slice(1) : flagValue(args, '-n');
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export const TEXT_FILTERS: Record<string, Filter> = {
  grep: (stdin, args) => {
    const err = unknownFlag('grep', args, 'iv');
    if (err) return err;
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
    const err = unknownFlag('wc', args, 'lwc');
    if (err) return err;
    const ls = lines(stdin);
    if (args.some(a => a.includes('l'))) return ok(`${ls.length}\n`);
    if (args.some(a => a.includes('w'))) return ok(`${stdin.split(/\s+/).filter(Boolean).length}\n`);
    if (args.some(a => a.includes('c'))) return ok(`${stdin.length}\n`);
    return ok(`${ls.length} ${stdin.split(/\s+/).filter(Boolean).length} ${stdin.length}\n`);
  },

  head: (stdin, args) => {
    const err = unknownFlag('head', args, 'n');
    if (err) return err;
    const n = lineCount(args);
    if (n === null) return bad('head', 'invalid line count');
    return ok(join(lines(stdin).slice(0, n)));
  },

  tail: (stdin, args) => {
    const err = unknownFlag('tail', args, 'n');
    if (err) return err;
    const n = lineCount(args);
    if (n === null) return bad('tail', 'invalid line count');
    return ok(join(n === 0 ? [] : lines(stdin).slice(-n)));
  },

  sort: (stdin, args) => {
    const err = unknownFlag('sort', args, 'nhru');
    if (err) return err;
    const flags = shortFlags(args);

    // -n and -h are real comparators now. Previously neither existed and
    // both were silently accepted, so `sort -n` returned 10 before 9.
    const key = flags.has('h') ? humanSize
      : flags.has('n') ? (l: string) => { const v = parseFloat(l); return Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY; }
      : null;

    let ls = [...lines(stdin)].sort(
      key ? (a, b) => key(a) - key(b) || a.localeCompare(b) : (a, b) => a.localeCompare(b)
    );
    if (flags.has('r')) ls.reverse();
    if (flags.has('u')) ls = ls.filter((l, i) => i === 0 || l !== ls[i - 1]);
    return ok(join(ls));
  },

  // A single s/// substitution, which is what sed is actually used for in a
  // one-liner. Not GNU sed: no -e, no addresses, no d/p/y commands. The
  // pattern IS a real regex, unlike grep's substring match in this same
  // file — an inconsistency worth closing, but not by making sed worse.
  sed: (stdin, args) => {
    const err = unknownFlag('sed', args, '');
    if (err) return err;
    const script = args.find(a => !a.startsWith('-'));
    if (!script) return bad('sed', 'missing script\nUsage: sed s/pattern/replacement/[g]');

    // Any delimiter, so s|a|b| and s#a#b# work like the real thing.
    const delim = script[1];
    if (script[0] !== 's' || !delim) return bad('sed', `only s/// substitution is supported, got "${script}"`);
    const parts = splitUnescaped(script.slice(2), delim);
    if (parts.length < 2) return bad('sed', `malformed substitution "${script}"`);
    const [pattern, replacement, modifiers = ''] = parts;
    if (/[^g]/.test(modifiers)) return bad('sed', `unsupported modifier "${modifiers}" (only g)`);

    let re: RegExp;
    try {
      re = new RegExp(pattern, modifiers.includes('g') ? 'g' : '');
    } catch (e: any) {
      return bad('sed', `bad regex: ${e.message}`);
    }
    return ok(join(lines(stdin).map(l => l.replace(re, replacement))));
  },

  cut: (stdin, args) => {
    const err = unknownFlag('cut', args, 'df');
    if (err) return err;
    const delim = flagValue(args, '-d') ?? '\t';
    const spec = flagValue(args, '-f');
    if (!spec) return bad('cut', 'missing field list\nUsage: cut -d <delim> -f <n[,n][n-m]>');

    const wanted = parseFieldList(spec);
    if (!wanted) return bad('cut', `bad field list "${spec}"`);

    return ok(join(lines(stdin).map(line => {
      const fields = line.split(delim);
      // cut is 1-indexed and drops out-of-range fields silently, as the
      // real one does — that part is not a subset, it's the behaviour.
      return wanted.filter(n => n <= fields.length).map(n => fields[n - 1]).join(delim);
    })));
  },

  tr: (stdin, args) => {
    const err = unknownFlag('tr', args, 'd');
    if (err) return err;
    const positional = args.filter(a => !a.startsWith('-'));
    const deleting = shortFlags(args).has('d');
    const from = expandSet(positional[0]);
    if (!from) return bad('tr', 'missing character set\nUsage: tr <set1> <set2>   |   tr -d <set>');

    if (deleting) {
      return ok(lines(stdin).map(l => [...l].filter(c => !from.includes(c)).join('')).join('\n') + (stdin ? '\n' : ''));
    }
    const to = expandSet(positional[1]);
    if (!to) return bad('tr', 'missing replacement set\nUsage: tr <set1> <set2>   |   tr -d <set>');
    // Short replacement sets pad with their last character, like real tr.
    const mapped = [...stdin].map(c => {
      const i = from.indexOf(c);
      return i === -1 ? c : (to[i] ?? to[to.length - 1]);
    }).join('');
    return ok(mapped);
  },

  uniq: (stdin, args) => {
    const err = unknownFlag('uniq', args, 'c');
    if (err) return err;
    const ls = lines(stdin);
    const counted = shortFlags(args).has('c');
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
