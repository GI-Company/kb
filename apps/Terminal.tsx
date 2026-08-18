import React, { useEffect, useRef, useState, useCallback } from 'react';
import { kernel } from '../services/kernel';
import { Envelope } from '../types';
import { VFS_COMMANDS, runFsCommand, cwdPath, ROOT_CWD, Cwd, CommandResult, completePath, commonPrefix, readDirFiles, writeBackFiles, saveDownload } from '../lib/terminalFs';
import { hasPipelineSyntax, parseLine, runPipeline, PIPE_AWARE_COMMANDS, TEXT_FILTERS, tokenize } from '../lib/terminalPipeline';
import { getCurrentUserId } from '../lib/auth';
// Imported for its types and the small gate/usage constants only — the
// 13MB Pyodide runtime is behind a dynamic import inside pythonRuntime and
// is not fetched until someone actually types `python`.
import { pythonRuntime, PYTHON_USAGE, GUEST_MESSAGE, PYTHON_COMMANDS } from '../lib/pythonRuntime';
import { INTEL_COMMANDS, TRAINING_COMMANDS, runIntelCommand } from '../lib/terminalIntel';
import { META_COMMANDS, runMetaCommand } from '../lib/terminalMeta';

/**
 * Commands that write or delete. A natural-language translation of one of
 * these is staged for confirmation rather than executed — see the
 * sys.terminal.intent:ack handler.
 */
const MUTATING_COMMANDS = new Set(['rm', 'mv', 'cp', 'write', 'mkdir', 'touch', 'curl', 'wget']);

interface Line {
  id: string;
  type: 'input' | 'output' | 'error' | 'intent';
  content: string;
  time: string;
  imageDataUrl?: string; // set for `render <url> --screenshot` results — see the vm.render:image topic below
}

export const TerminalApp: React.FC = () => {
  const [lines, setLines] = useState<Line[]>([
    { id: 'init', type: 'output', content: 'Kernos OS [Version 1.0.0]\n(c) 2025 Kernos Foundation. All rights reserved.\n\nType "help" for commands.\nFilesystem commands (ls, cd, cat, mkdir, write...) act on your real files and persist.\nPrefix with "?" for natural language (e.g. ? show large files)\nSigned-in accounts also get python/pip and curl/dig/ping/wget/render — sign in from Settings.\n', time: new Date().toLocaleTimeString() }
  ]);
  const [input, setInput] = useState('');
  // Persisted so history survives a reload, like a real shell's.
  // historyIndex === null means "typing a fresh line".
  const [history, setHistory] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('kernos_terminal_history') || '[]'); } catch { return []; }
  });
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  // What's currently in flight, so the prompt can show progress instead of
  // going silent. `render` in particular is a real headless-browser page
  // load and can take many seconds — with no feedback that reads as a hang.
  // `reqId` means a server request that Ctrl+C cancels through the kernel;
  // `local` means an in-browser worker that Ctrl+C kills directly.
  const [running, setRunning] = useState<
    { label: string; startedAt: number; reqId?: string; local?: 'python' } | null
  >(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  // Filesystem commands run against the real VFS instead of the server's
  // throwaway jail, so a working directory finally means something and
  // files survive between commands.
  const [cwd, setCwd] = useState<Cwd>(ROOT_CWD);
  const [userId, setUserId] = useState('guest');
  useEffect(() => { getCurrentUserId().then(setUserId); }, []);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The kernel.subscribe effect below mounts once ([] deps) so its closure
  // over cwd/userId would otherwise go stale the moment the user `cd`s
  // anywhere — a curl -O/wget response arriving after that would land in
  // whatever directory was current at page load, not where the command was
  // actually run. Refs mirror the latest values in without re-subscribing.
  const cwdRef = useRef(cwd);
  const userIdRef = useRef(userId);
  useEffect(() => { cwdRef.current = cwd; }, [cwd]);
  useEffect(() => { userIdRef.current = userId; }, [userId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    // Editing abandons history navigation, so the next ArrowUp starts from
    // the newest entry rather than wherever you had scrolled to.
    setHistoryIndex(null);
  }, []);

  const remember = useCallback((command: string) => {
    setHistory(prev => {
      // Skip an immediate repeat, like a shell's HISTCONTROL=ignoredups.
      const next = prev[prev.length - 1] === command ? prev : [...prev, command];
      const capped = next.slice(-200);
      try { localStorage.setItem('kernos_terminal_history', JSON.stringify(capped)); } catch { /* best-effort */ }
      return capped;
    });
  }, []);

  // Completes a command name in the first position, a VFS path anywhere
  // else — only possible now that the terminal has a real cwd and real
  // files to complete against.
  const completeInput = useCallback(async () => {
    if (!input || input.startsWith('?')) return;
    const endsWithSpace = /\s$/.test(input);
    const tokens = tokenize(input);
    const isCommandPosition = tokens.length <= 1 && !endsWithSpace;
    const partial = endsWithSpace ? '' : (tokens[tokens.length - 1] ?? '');

    let matches: string[] = [];
    let dirPrefix = '';
    if (isCommandPosition) {
      const known = [...VFS_COMMANDS, ...PIPE_AWARE_COMMANDS, ...PYTHON_COMMANDS, ...INTEL_COMMANDS, ...TRAINING_COMMANDS, ...META_COMMANDS, 'clear', 'help', 'render', 'curl', 'dig', 'ping', 'wget'];
      matches = [...new Set(known)].filter(c => c.startsWith(partial)).sort();
    } else {
      const found = await completePath(cwd, partial, userId);
      matches = found.matches;
      dirPrefix = found.prefix;
    }
    if (matches.length === 0) return;

    // One match completes outright; several advance to the longest shared
    // prefix and list the options, the way a shell does.
    const shared = matches.length === 1 ? matches[0] : commonPrefix(matches);
    const head = input.slice(0, input.length - partial.length);
    const completion = isCommandPosition ? shared : dirPrefix + shared;
    setInput(head + completion + (matches.length === 1 && isCommandPosition ? ' ' : ''));

    if (matches.length > 1) {
      setLines(prev => [...prev, {
        id: Math.random().toString(),
        type: 'output',
        content: matches.join('  ') + '\n',
        time: new Date().toLocaleTimeString()
      }]);
    }
  }, [input, cwd, userId]);

  const append = useCallback((content: string, type: Line['type'] = 'output') => {
    if (!content) return;
    setLines(prev => [...prev, {
      id: Math.random().toString(),
      type,
      content,
      time: new Date().toLocaleTimeString()
    }]);
  }, []);

  /**
   * Real CPython, in the tab. Off-thread on a worker, so a runaway loop is
   * killable and the UI keeps painting.
   *
   * Two gates before anything is downloaded (see lib/pythonRuntime.ts):
   * signed-in only, and lazy — a guest gets an explanation, not 13MB.
   */
  const execPython = useCallback(async (command: string, args: string[], stdin?: string): Promise<CommandResult> => {
    if (!(await pythonRuntime.isAvailable())) {
      return { stdout: '', stderr: GUEST_MESSAGE, code: 1 };
    }

    if (command === 'pip') {
      if (args[0] === 'list') return pythonRuntime.pipList();
      if (args[0] !== 'install' || args.length < 2) {
        return { stdout: '', stderr: PYTHON_USAGE.pip + '\n', code: 2 };
      }
      return pythonRuntime.pipInstall(args.slice(1), text => append(text + '\n'));
    }

    let code: string | null = null;
    if (args[0] === '-c') {
      code = args.slice(1).join(' ');
    } else if (args.length > 0 && !args[0].startsWith('-')) {
      // A script name is resolved against the VFS, not a disk that doesn't
      // exist — `cat` already knows how to walk a path from the cwd.
      const { result } = await runFsCommand('cat', [args[0]], { cwd, userId });
      if (result.code !== 0) return result;
      code = result.stdout;
    }

    if (!code) {
      return { stdout: '', stderr: PYTHON_USAGE.python + '\n', code: 2 };
    }

    // Files in the cwd are mapped into the interpreter first, which is what
    // makes open("notes.md") read the user's actual file. Piped input lands
    // on sys.stdin so `cat log.txt | python -c "..."` behaves as expected.
    const files = await readDirFiles(cwd, userId);
    const result = await pythonRuntime.run(code, files, text => append(text + '\n'), stdin);

    // Write-back only on a real success (code 0, and files present — a
    // Ctrl+C/timeout result has neither). Anything the script wrote is
    // already gone if it got here any other way: the worker only computes
    // and sends the post-run file state on its own ok:true path, so a
    // failed or killed run has nothing for this to stage in the first
    // place — not a check this function performs so much as a fact
    // already true about what result.files contains.
    if (result.code === 0 && result.files) {
      const { written, failed } = await writeBackFiles(cwd, userId, files, result.files);
      if (written.length) {
        result.stdout += `${written.length} file${written.length === 1 ? '' : 's'} written: ${written.join(', ')}\n`;
      }
      if (failed.length) {
        result.stderr += `${failed.length} file${failed.length === 1 ? '' : 's'} failed to write: ${failed.join(', ')}\n`;
      }
    }
    return result;
  }, [append, cwd, userId]);

  const runPython = useCallback(async (command: string, args: string[], rawLine: string) => {
    setRunning({ label: rawLine, startedAt: Date.now(), local: 'python' });
    try {
      const result = await execPython(command, args);
      append(result.stderr, 'error');
      append(result.stdout);
    } finally {
      setRunning(null);
    }
  }, [append, execPython]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl+C. Aborts an in-flight request through the kernel; with nothing
    // running it just discards the current line, like a real shell.
    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      if (running?.reqId) {
        kernel.publish('vm.cancel', { _request_id: running.reqId });
      } else if (running?.local === 'python') {
        // A real kill: the interpreter is on a worker, so terminate() stops
        // `while True: pass` dead. Nothing else can interrupt WASM.
        pythonRuntime.terminate();
        setRunning(null);
        setLines(prev => [...prev, {
          id: Math.random().toString(),
          type: 'error',
          content: '^C\npython: interpreter terminated.\n',
          time: new Date().toLocaleTimeString()
        }]);
      } else {
        setLines(prev => [...prev, {
          id: Math.random().toString(),
          type: 'output',
          content: (input ? input : '') + '^C\n',
          time: new Date().toLocaleTimeString()
        }]);
      }
      setInput('');
      setHistoryIndex(null);
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      void completeInput();
      return;
    }

    // ArrowUp from a fresh line stashes the draft so ArrowDown restores it
    // rather than losing what was typed.
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      if (historyIndex === null) setDraft(input);
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setInput(history[next]);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex === null) return;
      const next = historyIndex + 1;
      if (next >= history.length) { setHistoryIndex(null); setInput(draft); return; }
      setHistoryIndex(next);
      setInput(history[next]);
      return;
    }

    if (e.key === 'Enter') {
      const cmd = input.trim();
      if (!cmd) return;

      remember(cmd);
      setHistoryIndex(null);
      setDraft('');

      setLines(prev => [...prev, {
        id: Math.random().toString(),
        type: 'input',
        content: cmd,
        time: new Date().toLocaleTimeString()
      }]);

      // Natural Language Shell: "? find large files" → sys.terminal.intent
      if (cmd.startsWith('?')) {
        const intent = cmd.slice(1).trim();
        if (intent) {
          kernel.publish('sys.terminal.intent', { intent });
          setLines(prev => [...prev, {
            id: Math.random().toString(),
            type: 'intent',
            content: `🧠 Translating: "${intent}"...`,
            time: new Date().toLocaleTimeString()
          }]);
        }
        setInput('');
        return;
      }

      runCommandLine(cmd);
      setInput('');
      return;
    }
  };

  /**
   * Runs one command line, whatever produced it.
   *
   * Extracted so the natural-language translator goes through exactly this
   * path. It used to publish vm.spawn directly, which meant a translated
   * `ls` ran against the server's throwaway jail instead of the user's real
   * files, and translated `python`/pipes/redirects could not work at all.
   */
  const runCommandLine = useCallback((cmd: string) => {
      // tokenize, not split(' '): a naive split kept the quotes as part of
      // the argument, so `write notes.md "hello world"` stored the literal
      // string `"hello` — quoting silently corrupted the file it wrote.
      const [command, ...args] = tokenize(cmd);
      const reqId = Math.random().toString(36).substring(7);

      const emit = (text: string, isError: boolean) => {
        if (!text) return;
        setLines(prev => [...prev, {
          id: Math.random().toString(),
          type: isError ? 'error' : 'output',
          content: text,
          time: new Date().toLocaleTimeString()
        }]);
      };

      if (command === 'clear') {
        setLines([]);
      } else if (hasPipelineSyntax(cmd)) {
        // Pipes and redirects are composed here and never sent to the
        // server — `|` and `>` stay rejected by api/exec.ts's sanitizer.
        const parsed = parseLine(cmd);
        if (typeof parsed === 'string') {
          emit(`${parsed}\n`, true);
        } else {
          let workingCwd = cwd;
          runPipeline(parsed, {
            runVfs: async (stage, stdin) => {
              // Python is browser-side too, so it belongs in a pipeline like
              // the VFS commands do — not in the "runs on the server, has no
              // stdin" rejection below.
              if (PYTHON_COMMANDS.has(stage.command)) {
                return execPython(stage.command, stage.args, stdin);
              }
              if (INTEL_COMMANDS.has(stage.command)) {
                return runIntelCommand(stage.command, stage.args, { cwd: workingCwd, userId, stdin });
              }
              if (!VFS_COMMANDS.has(stage.command)) return null;
              // `write` is how a redirect target gets its content, so a
              // piped stage passes stdin through as the text to write.
              const args = stage.command === 'write' && stdin ? [stage.args[0], stdin] : stage.args;
              const { result, cwd: next } = await runFsCommand(stage.command, args, { cwd: workingCwd, userId });
              workingCwd = next;
              return result;
            },
            writeFile: async (path, content, append) => {
              const args = append ? ['-a', path, content] : [path, content];
              const { result } = await runFsCommand('write', args, { cwd: workingCwd, userId });
              return result;
            },
            isServerCommand: (c) => !VFS_COMMANDS.has(c) && !PYTHON_COMMANDS.has(c) && !INTEL_COMMANDS.has(c),
          }).then(result => {
            setCwd(workingCwd);
            emit(result.stderr, true);
            emit(result.stdout, false);
          });
        }
      } else if (VFS_COMMANDS.has(command)) {
        // Handled entirely in the browser: persistent, instant, and these
        // never reach execFile at all — less server surface, not more.
        runFsCommand(command, args, { cwd, userId }).then(({ result, cwd: nextCwd }) => {
          setCwd(nextCwd);
          const text = result.stderr || result.stdout;
          if (text) {
            setLines(prev => [...prev, {
              id: Math.random().toString(),
              type: result.code === 0 ? 'output' : 'error',
              content: text,
              time: new Date().toLocaleTimeString()
            }]);
          }
        });
      } else if (PIPE_AWARE_COMMANDS.has(command) && command !== 'echo') {
        // `wc -l notes.md` with no pipe. These filters read stdin, so
        // without this they fell through to the server — whose jail is a
        // fresh empty temp dir, so the answer was always "No such file".
        // A real shell reads the file; so does this now, from the VFS.
        //
        // The last non-flag argument is treated as the filename, matching
        // how `grep pattern file` and `wc -l file` are actually written.
        // With no filename they still go to the server, where `date`-style
        // argument-free use keeps working.
        const positional = args.filter(a => !a.startsWith('-'));
        const file = positional[positional.length - 1];
        if (!file) {
          setRunning({ label: cmd, startedAt: Date.now(), reqId });
          kernel.publish('vm.spawn', { _request_id: reqId, cmd: command, args, cwd: 'home' });
        } else {
          runFsCommand('cat', [file], { cwd, userId }).then(({ result }) => {
            // Reattribute cat's error to the command the user actually
            // typed — `wc -l missing.txt` reporting "cat: ..." is confusing.
            if (result.code !== 0) { emit(result.stderr.replace(/^cat:/, `${command}:`), true); return; }
            const rest = args.filter(a => a !== file);
            const out = TEXT_FILTERS[command](result.stdout, rest);
            emit(out.stderr, true);
            emit(out.stdout, false);
          });
        }
      } else if (INTEL_COMMANDS.has(command)) {
        // classify/explain/trace — local model and bus, no network. See
        // BUILTINS.md for the contract these implement.
        runIntelCommand(command, args, { cwd, userId }).then(result => {
          emit(result.stderr, true);
          emit(result.stdout, false);
        });
      } else if (META_COMMANDS.has(command)) {
        // can/policy answer instantly from static data plus one session
        // check — no running indicator needed.
        runMetaCommand(command, args).then(result => {
          emit(result.stderr, true);
          emit(result.stdout, false);
        });
      } else if (TRAINING_COMMANDS.has(command)) {
        // correct/train — the teach loop. `train` retrains from scratch on
        // seed + corrections and can take real seconds, so it gets the same
        // running indicator python does; `correct` is one file append and
        // doesn't need one. Neither is cancellable mid-flight yet: Ctrl+C
        // during `train` prints ^C but the retrain keeps running to
        // completion, same as pressing it with nothing in flight — it does
        // not falsely claim to have stopped anything.
        if (command === 'train') setRunning({ label: cmd, startedAt: Date.now() });
        runIntelCommand(command, args, { cwd, userId }).then(result => {
          if (command === 'train') setRunning(null);
          emit(result.stderr, true);
          emit(result.stdout, false);
        });
      } else if (PYTHON_COMMANDS.has(command)) {
        void runPython(command, args, cmd);
      } else if (command === 'render') {
        // Headless-browser page render — a real navigated page, not just a
        // fetch, and a separate endpoint/budget from every other command
        // here (see api/browser-render.ts). Signed-in accounts only; a
        // guest gets that exact error back as a normal vm.stderr line.
        const url = args.find(a => !a.startsWith('--'));
        const mode = args.includes('--screenshot') ? 'screenshot' : 'text';
        if (!url) {
          setLines(prev => [...prev, {
            id: Math.random().toString(),
            type: 'error',
            content: 'render: missing URL. Usage: render <url> [--screenshot]\n',
            time: new Date().toLocaleTimeString()
          }]);
        } else {
          setRunning({ label: cmd, startedAt: Date.now(), reqId });
          kernel.publish('vm.render', { _request_id: reqId, url, mode });
        }
      } else {
        // Straight to the sandbox. The speculative "shadow jail" this used
        // to consult was cut along with the Go backend and always answered
        // "miss", so it only ever added a round trip before every command.
        setRunning({ label: cmd, startedAt: Date.now(), reqId });
        kernel.publish('vm.spawn', { _request_id: reqId, cmd: command, args, cwd: 'home' });
      }
  }, [cwd, userId, runPython, append]);

  useEffect(() => {
    // Subscribe to VM streams, Shadow Engine, Ghost Commands, and NL Shell
    const unsubscribe = kernel.subscribe((env: Envelope) => {
      if (env.topic === 'vm.stdout' || env.topic === 'vm.stderr') {
        setLines(prev => [...prev, {
          id: Math.random().toString(),
          type: env.topic === 'vm.stderr' ? 'error' : 'output',
          content: env.payload.text,
          time: new Date().toLocaleTimeString()
        }]);
      }

      // Every command path ends in vm.exit, success or failure, which makes
      // it the one reliable place to stop the progress indicator.
      if (env.topic === 'vm.exit') {
        setRunning(null);
      }

      // curl -O/-o or wget's downloaded bytes — the server that fetched
      // them has no VFS to write into (see networkCommands.ts's
      // CommandResult.download doc comment), so this is where the actual
      // write happens, against the terminal's real current directory.
      if (env.topic === 'vm.exec:download') {
        const { name, contentBase64 } = env.payload as { name: string; contentBase64: string; encoding: 'base64' };
        saveDownload(cwdRef.current, userIdRef.current, name, contentBase64).then(result => {
          setLines(prev => [...prev, {
            id: Math.random().toString(),
            type: result.code === 0 ? 'output' : 'error',
            content: result.code === 0 ? result.stdout : result.stderr,
            time: new Date().toLocaleTimeString()
          }]);
        });
      }

      // `render <url> --screenshot` result — displayed as an image, not text.
      if (env.topic === 'vm.render:image') {
        const dataUrl = (env.payload as any).dataUrl;
        if (dataUrl) {
          setLines(prev => [...prev, {
            id: Math.random().toString(),
            type: 'output',
            content: '',
            imageDataUrl: dataUrl,
            time: new Date().toLocaleTimeString()
          }]);
        }
      }

      // Natural Language Shell translation received
      if (env.topic === 'sys.terminal.intent:ack') {
        const { command, error } = env.payload as { command?: string; error?: string };
        if (error) {
          setLines(prev => [...prev, {
            id: Math.random().toString(),
            type: 'error',
            content: error + '\n',
            time: new Date().toLocaleTimeString()
          }]);
        } else if (command) {
          setLines(prev => [...prev, {
            id: Math.random().toString(),
            type: 'intent',
            content: `✨ Translated → ${command}`,
            time: new Date().toLocaleTimeString()
          }]);

          // Through the same dispatch as a typed line, so a translated
          // `ls` reads the user's real files and translated pipes/python
          // work — publishing vm.spawn directly bypassed all of that.
          //
          // But NOT auto-run when it would modify something. Before the
          // filesystem commands became real, a translated `rm` hit a temp
          // jail that was discarded anyway; now it would delete the user's
          // actual files, on one model's reading of one ambiguous sentence.
          // Mutating translations are staged in the input instead, so the
          // destructive step is a human pressing Enter.
          if (MUTATING_COMMANDS.has(tokenize(command)[0])) {
            setInput(command);
            setLines(prev => [...prev, {
              id: Math.random().toString(),
              type: 'intent',
              content: 'This one changes files, so it is not run automatically — press Enter to confirm, or edit it first.\n',
              time: new Date().toLocaleTimeString()
            }]);
          } else {
            runCommandLine(command);
          }
        }
      }

    });
    return unsubscribe;
  }, []);

  // Drives the elapsed counter, and clears a spinner that never got its
  // vm.exit. The kernel emits vm.exit even on failure, so this only fires if
  // something is genuinely wrong — better a stale indicator disappears than
  // spins forever.
  useEffect(() => {
    if (!running) { setElapsedMs(0); return; }
    const started = running.startedAt;
    const timer = setInterval(() => {
      const ms = Date.now() - started;
      setElapsedMs(ms);
      if (ms > 120_000) setRunning(null);
    }, 100);
    return () => clearInterval(timer);
  }, [running]);

  return (
    <div
      className="h-full bg-[#0c0c0c] text-gray-300 font-mono p-4 overflow-y-auto"
      style={{ fontSize: 'var(--kernos-terminal-font-size, 13px)' }}
      onClick={() => inputRef.current?.focus()}
    >
      {lines.map(line => (
        <div key={line.id} className={`mb-1 break-words ${
          line.type === 'error' ? 'text-red-400' : 
          line.type === 'input' ? 'text-white' : 
          line.type === 'intent' ? 'text-purple-400' :
          'text-gray-400'
        }`}>
          {line.type === 'input' && <span className="text-cyan-500 mr-2">➜</span>}
          {line.type === 'intent' && <span className="text-purple-500 mr-2">⚡</span>}
          {line.imageDataUrl ? (
            <img src={line.imageDataUrl} alt="rendered page" className="max-w-full rounded border border-white/10 my-1" />
          ) : (
            <span className="whitespace-pre-wrap">{line.content}</span>
          )}
        </div>
      ))}
      {running && (
        <div className="flex items-center gap-2 mt-2 text-cyan-400/80" aria-live="polite">
          <span className="inline-block w-3 animate-pulse">▊</span>
          <span className="truncate">running <span className="text-white">{running.label}</span></span>
          <span className="text-gray-500 tabular-nums">{(elapsedMs / 1000).toFixed(1)}s</span>
          {/* Chromium cold start dominates the first render; saying so beats
              leaving someone wondering whether it has hung. */}
          {running.label.startsWith('render') && elapsedMs > 3000 && (
            <span className="text-gray-600 text-xs">headless browser — first run is slower</span>
          )}
          {elapsedMs > 30000 && (
            <span className="text-amber-500/70 text-xs">still going…</span>
          )}
          {running.reqId && <span className="text-gray-600 text-xs">ctrl-c to cancel</span>}
        </div>
      )}
      <div className="flex items-center mt-2 relative">
        <span className="text-cyan-500 mr-2">➜ {cwdPath(cwd)}</span>
        <div className="relative flex-1">
          <input
            data-tour="terminal-input"
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className="bg-transparent border-none outline-none w-full text-white relative z-10"
            autoFocus
            spellCheck={false}
          />
        </div>
      </div>
      <div ref={bottomRef} />
    </div>
  );
};