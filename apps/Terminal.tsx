import React, { useEffect, useRef, useState, useCallback } from 'react';
import { kernel } from '../services/kernel';
import { Envelope } from '../types';
import { VFS_COMMANDS, runFsCommand, cwdPath, ROOT_CWD, Cwd, completePath, commonPrefix } from '../lib/terminalFs';
import { hasPipelineSyntax, parseLine, runPipeline, PIPE_AWARE_COMMANDS, tokenize } from '../lib/terminalPipeline';
import { getCurrentUserId } from '../lib/auth';

interface Line {
  id: string;
  type: 'input' | 'output' | 'error' | 'intent';
  content: string;
  time: string;
  imageDataUrl?: string; // set for `render <url> --screenshot` results — see the vm.render:image topic below
}

export const TerminalApp: React.FC = () => {
  const [lines, setLines] = useState<Line[]>([
    { id: 'init', type: 'output', content: 'Kernos OS [Version 1.0.0]\n(c) 2025 Kernos Foundation. All rights reserved.\n\nType "help" for commands.\nFilesystem commands (ls, cd, cat, mkdir, write...) act on your real files and persist.\nPrefix with "?" for natural language (e.g. ? show large files)\nSigned-in accounts also get curl/dig/ping/render — sign in from Settings for network access.\n', time: new Date().toLocaleTimeString() }
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
  const [running, setRunning] = useState<{ label: string; startedAt: number } | null>(null);
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
      const known = [...VFS_COMMANDS, ...PIPE_AWARE_COMMANDS, 'clear', 'help', 'render', 'curl', 'dig', 'ping'];
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
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

      const [command, ...args] = cmd.split(' ');
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
            isServerCommand: (c) => !VFS_COMMANDS.has(c),
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
          setRunning({ label: cmd, startedAt: Date.now() });
          kernel.publish('vm.render', { _request_id: reqId, url, mode });
        }
      } else {
        // Straight to the sandbox. The speculative "shadow jail" this used
        // to consult was cut along with the Go backend and always answered
        // "miss", so it only ever added a round trip before every command.
        setRunning({ label: cmd, startedAt: Date.now() });
        kernel.publish('vm.spawn', { _request_id: reqId, cmd: command, args, cwd: 'home' });
      }

      setInput('');
    }
  };

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
        const command = (env.payload as any).command;
        if (command) {
          setLines(prev => [...prev, {
            id: Math.random().toString(),
            type: 'intent',
            content: `✨ Translated → ${command}`,
            time: new Date().toLocaleTimeString()
          }]);

          // Auto-execute the translated command
          const [cmd, ...args] = command.split(' ');
          const reqId = Math.random().toString(36).substring(7);
          setRunning({ label: command, startedAt: Date.now() });
          kernel.publish('vm.spawn', {
            _request_id: reqId,
            cmd,
            args,
            cwd: 'home'
          });
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