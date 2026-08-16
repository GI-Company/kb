// The intelligence builtins: trace, classify, explain.
//
// These are specified in BUILTINS.md; this file is the implementation, and
// the spec is the contract. The argument for them is that this machine is a
// tab with a persistent filesystem, a local model and a visible bus — so
// labelling, attribution and provenance belong next to `grep`, not in a
// separate app.
//
// Everything here runs in the browser against the user's own trained model.
// None of it touches the network, and `trace` is deliberately ungated: it
// is the glass box, and a glass box you need permission to look through is
// not one.

import { Envelope } from '../types';
import { kernel } from '../services/kernel';
import { localClassifier, PredictResult } from './localClassifier';
import { CommandResult, Cwd, runFsCommand } from './terminalFs';

export const INTEL_COMMANDS = new Set(['trace', 'classify', 'explain']);

export const INTEL_USAGE: Record<string, string> = {
  trace: 'Usage: trace [--last <n>] [--topic <substring>] [--json]',
  classify: 'Usage: classify <text> | classify -f <file> | ... | classify   [--json] [--model <name>] [--field <key>]',
  explain: 'Usage: explain [text] [--for <label>] [--granularity word|char] [--json]',
};

export interface IntelContext {
  cwd: Cwd;
  userId: string;
  /** Piped input, when the command is a pipeline stage. */
  stdin?: string;
}

const ok = (stdout: string): CommandResult => ({ stdout, stderr: '', code: 0 });
const bad = (cmd: string, msg: string, code = 1): CommandResult => ({ stdout: '', stderr: `${cmd}: ${msg}\n`, code });

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Positional args, with `--flag value` pairs removed. */
function positionals(args: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.includes(args[i])) { i++; continue; }
    if (args[i].startsWith('-')) continue;
    out.push(args[i]);
  }
  return out;
}

/**
 * Text from a stdin line, per BUILTINS.md's one rule for record input: a
 * line that parses as JSON with a `text` field contributes that field,
 * anything else contributes itself. That is what lets `ls | classify` and
 * `classify … --json | classify` both work without a type system.
 */
function textFromLine(line: string, field = 'text'): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return line;
  try {
    const record = JSON.parse(trimmed);
    const value = record?.[field];
    return typeof value === 'string' ? value : line;
  } catch {
    return line;
  }
}

// ── trace ────────────────────────────────────────────────────────────────

/**
 * A readable one-line summary of an envelope's payload.
 *
 * Topic-specific, because the useful part differs: for a spawn it is the
 * command, for output it is the size, for a chat it is the persona. A
 * generic JSON dump would be technically complete and unreadable, which
 * defeats the purpose of a trace command.
 */
function summarize(env: Envelope): string {
  const p: any = env.payload ?? {};
  switch (env.topic) {
    case 'vm.spawn': return [p.cmd, ...(p.args ?? [])].join(' ');
    case 'vm.cancel': return 'cancelled';
    case 'vm.stdout':
    case 'vm.stderr': return `${(p.text ?? '').length} bytes`;
    case 'vm.exit': return `exit ${p.code}`;
    case 'vm.render': return `${p.mode ?? 'text'} ${p.url ?? ''}`;
    case 'sys.terminal.intent': return `"${p.intent}"`;
    case 'sys.terminal.intent:ack': return p.command ?? p.error ?? '';
    case 'agent.chat':
    case 'ai.chat': return `"${String(p.msg ?? p.prompt ?? '').slice(0, 48)}"`;
    case 'agent.chat:stream':
    case 'ai.stream': return `${(p.chunk ?? '').length} chars`;
    case 'agent.chat:reply': return `${(p.reply ?? '').length} chars`;
    default: {
      const keys = Object.keys(p);
      return keys.length ? keys.slice(0, 3).join(', ') : '';
    }
  }
}

const clockTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toTimeString().slice(0, 8);
};

function runTrace(args: string[]): CommandResult {
  const last = Number(flagValue(args, '--last') ?? 20);
  if (!Number.isFinite(last) || last < 1) return bad('trace', `bad --last value\n${INTEL_USAGE.trace}`, 2);
  const topic = flagValue(args, '--topic');

  // getTrafficLog() is newest-first. Filter, take the most recent n, then
  // reverse — a log reads oldest to newest or it isn't a log.
  let log = kernel.getTrafficLog();
  if (topic) log = log.filter(e => e.topic.includes(topic));
  const recent = log.slice(0, last).reverse();

  if (recent.length === 0) {
    return ok(topic ? `No bus activity matching "${topic}".\n` : 'No bus activity yet.\n');
  }

  if (args.includes('--json')) {
    return ok(recent.map(e => JSON.stringify({
      time: e.time, topic: e.topic, from: e.from, to: e.to ?? null, summary: summarize(e),
    })).join('\n') + '\n');
  }

  const width = Math.max(...recent.map(e => e.topic.length));
  const body = recent.map(e => {
    const route = e.to ? `${e.from} → ${e.to}` : e.from;
    return `${clockTime(e.time)}  ${e.topic.padEnd(width)}  ${route}  ${summarize(e)}`.trimEnd();
  });
  // The cap is worth stating: an absent event may simply have aged out.
  const note = log.length > recent.length ? `\n(${recent.length} of ${log.length} retained; the bus keeps the last 200)\n` : '\n';
  return ok(body.join('\n') + note);
}

// ── classify ─────────────────────────────────────────────────────────────

/**
 * The last text classified in this tab, so `explain` can be called bare.
 *
 * Module state, not persisted. A reload clears it, and explain says so
 * rather than explaining a decision from a session the user has forgotten.
 */
let lastClassified: string | null = null;

/** Exported for tests; there is no reason for anything else to call it. */
export function _resetIntelSession() { lastClassified = null; }

const NO_CLASSIFIER =
  'no classifier is loaded in this tab.\n' +
  'Train one in the Classifier app, or load a saved one with --model <name>.\n' +
  'This is the normal state on a fresh tab, not a failure.';

function describe(result: PredictResult): string {
  const [top, second] = result.ranked;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  let line = `${top.label} (${pct(top.probability)})`;
  if (second) line += `, ahead of ${second.label} (${pct(second.probability)})`;
  // The margin is the number that matters for routing, so it is stated in
  // words rather than left for the reader to subtract.
  line += result.margin < 0.15 ? '. Narrow margin — treat as uncertain.'
    : result.margin > 0.4 ? '. Clear separation.'
    : '.';
  return line;
}

async function runClassify(args: string[], ctx: IntelContext): Promise<CommandResult> {
  const asJson = args.includes('--json');
  const field = flagValue(args, '--field') ?? 'text';
  const modelName = flagValue(args, '--model');

  if (modelName) {
    try {
      await localClassifier.loadSaved(modelName);
    } catch (err: any) {
      return bad('classify', `could not load model "${modelName}": ${err?.message || err}`);
    }
  }

  // Where the text comes from: -f a file, stdin when piped, else argv.
  const file = flagValue(args, '-f');
  let inputs: string[];
  if (file) {
    const { result } = await runFsCommand('cat', [file], { cwd: ctx.cwd, userId: ctx.userId });
    if (result.code !== 0) return { ...result, stderr: result.stderr.replace(/^cat:/, 'classify:') };
    inputs = [result.stdout.trim()];
  } else if (ctx.stdin !== undefined && ctx.stdin !== '') {
    inputs = ctx.stdin.split('\n').filter(l => l.trim() !== '').map(l => textFromLine(l, field));
  } else {
    const words = positionals(args, ['--model', '--field', '-f', '--last', '--topic']);
    if (words.length === 0) return bad('classify', `missing text\n${INTEL_USAGE.classify}`, 2);
    inputs = [words.join(' ')];
  }

  const out: string[] = [];
  for (const text of inputs) {
    let result;
    try {
      result = await localClassifier.predict(text);
    } catch (err: any) {
      const message = String(err?.message || err);
      return bad('classify', /no classifier|not been trained/i.test(message) ? NO_CLASSIFIER : message);
    }
    lastClassified = text;
    out.push(asJson
      ? JSON.stringify({
          text,
          label: result.label,
          confidence: Number(result.confidence.toFixed(4)),
          margin: Number(result.margin.toFixed(4)),
          ranked: result.ranked.map(r => ({ label: r.label, probability: Number(r.probability.toFixed(4)) })),
        })
      : describe(result));
  }
  return ok(out.join('\n') + '\n');
}

// ── explain ──────────────────────────────────────────────────────────────

const BAR_WIDTH = 10;

function bars(contributions: { token: string; score: number }[]): string {
  const peak = Math.max(...contributions.map(c => Math.abs(c.score)), 1e-9);
  const labelWidth = Math.max(...contributions.map(c => c.token.length));
  return contributions.map(c => {
    const filled = Math.max(1, Math.round((Math.abs(c.score) / peak) * BAR_WIDTH));
    const bar = (c.score >= 0 ? '▇' : '░').repeat(filled);
    const signed = `${c.score >= 0 ? '+' : '−'}${Math.abs(c.score).toFixed(3)}`;
    return `  ${c.token.padEnd(labelWidth)}  ${bar.padEnd(BAR_WIDTH)}  ${signed}`;
  }).join('\n');
}

async function runExplain(args: string[], ctx: IntelContext): Promise<CommandResult> {
  const asJson = args.includes('--json');
  const forLabel = flagValue(args, '--for');
  const granularity = (flagValue(args, '--granularity') ?? 'word') as 'word' | 'char';
  if (granularity !== 'word' && granularity !== 'char') {
    return bad('explain', `granularity must be "word" or "char"\n${INTEL_USAGE.explain}`, 2);
  }

  const words = positionals(args, ['--for', '--granularity', '--field', '--model']);
  const piped = ctx.stdin?.split('\n').find(l => l.trim() !== '');
  const text = words.length ? words.join(' ') : piped ? textFromLine(piped) : lastClassified;

  if (!text) {
    return bad('explain',
      'nothing to explain.\n' +
      'Run `classify <text>` first, or pass the text directly: explain "<text>".\n' +
      'The last classification is per-tab and is cleared by a reload.');
  }

  let attribution;
  try {
    attribution = await localClassifier.explain(text, { forLabel, granularity });
  } catch (err: any) {
    const message = String(err?.message || err);
    return bad('explain', /no classifier|not been trained/i.test(message) ? NO_CLASSIFIER : message);
  }

  if (asJson) {
    return ok(JSON.stringify({
      text,
      label: attribution.label,
      baseline: Number(attribution.baseline.toFixed(4)),
      granularity,
      contributions: attribution.contributions.map(c => ({ token: c.token, score: Number(c.score.toFixed(4)) })),
    }) + '\n');
  }

  if (attribution.contributions.length === 0) {
    return ok(`${attribution.label} (${(attribution.baseline * 100).toFixed(1)}%) — nothing left to remove.\n`);
  }

  const ranked = [...attribution.contributions].sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const header = `${attribution.label} (${(attribution.baseline * 100).toFixed(1)}%) — removing each ${granularity} and re-running:`;
  const footer =
    `\nBaseline ${attribution.baseline.toFixed(3)}. ` +
    `Positive means removing it dropped the answer, so it was holding the prediction up.` +
    // The measured reason word is the default, stated where someone is
    // most likely to be about to reach for --granularity char.
    (granularity === 'char'
      ? '\nCharacter occlusion usually measures near zero — a word survives losing one letter. Word granularity shows more.'
      : '');
  return ok(`${header}\n\n${bars(ranked)}\n${footer}\n`);
}

// ── dispatch ─────────────────────────────────────────────────────────────

export async function runIntelCommand(command: string, args: string[], ctx: IntelContext): Promise<CommandResult> {
  switch (command) {
    case 'trace': return runTrace(args);
    case 'classify': return runClassify(args, ctx);
    case 'explain': return runExplain(args, ctx);
    default: return bad(command, 'not an intelligence command');
  }
}
