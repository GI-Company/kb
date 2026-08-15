import React, { useEffect, useRef, useState, useCallback } from 'react';
import { kernel } from '../services/kernel';
import { Envelope } from '../types';

interface Line {
  id: string;
  type: 'input' | 'output' | 'error' | 'intent';
  content: string;
  time: string;
  imageDataUrl?: string; // set for `render <url> --screenshot` results — see the vm.render:image topic below
}

export const TerminalApp: React.FC = () => {
  const [lines, setLines] = useState<Line[]>([
    { id: 'init', type: 'output', content: 'Kernos OS [Version 1.0.0]\n(c) 2025 Kernos Foundation. All rights reserved.\n\nType "help" for commands.\nPrefix with "?" for natural language (e.g. ? show large files)\nSigned-in accounts also get curl/dig/ping/render — sign in from Settings for network access.\n', time: new Date().toLocaleTimeString() }
  ]);
  const [input, setInput] = useState('');
  const [ghostPrediction, setGhostPrediction] = useState('');
  const [pendingCmd, setPendingCmd] = useState<{ cmd: string, args: string[], reqId: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  // Ghost Command: debounce typing and request predictions
  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    setGhostPrediction(''); // Clear while typing

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (value.length >= 3 && !value.startsWith('?')) {
      debounceRef.current = setTimeout(() => {
        kernel.publish('terminal.typing', { input: value });
      }, 300);
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Tab accepts ghost prediction
    if (e.key === 'Tab' && ghostPrediction) {
      e.preventDefault();
      setInput(ghostPrediction);
      setGhostPrediction('');
      return;
    }

    if (e.key === 'Enter') {
      const cmd = input.trim();
      if (!cmd) return;

      setGhostPrediction('');

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

      if (command === 'clear') {
        setLines([]);
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
          kernel.publish('vm.render', { _request_id: reqId, url, mode });
        }
      } else {
        // Suspend standard execution and check the Speculative Execution shadow engine
        setPendingCmd({ cmd: command, args, reqId });
        kernel.publish('terminal.check_shadow', { command: cmd });
        if (kernel.isLive && (kernel as any).socket) {
          (kernel as any).socket.send(JSON.stringify({
            topic: 'terminal.check_shadow',
            from: kernel.getClientId(),
            payload: { command: cmd },
            time: new Date().toISOString()
          }));
        }
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

      // Ghost Command prediction received
      if (env.topic === 'terminal.predict') {
        const prediction = (env.payload as any).prediction;
        if (prediction) {
          setGhostPrediction(prediction);
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
          kernel.publish('vm.spawn', {
            _request_id: reqId,
            cmd,
            args,
            cwd: 'home'
          });
        }
      }

      // Shadow Engine Zero-Latency Hit
      if (env.topic === 'terminal.shadow:hit') {
        setPendingCmd(null);
        const payload = env.payload as any;
        setLines(prev => [...prev,
        {
          id: Math.random().toString(),
          type: 'output',
          content: `\x1b[35m[Kernos Pred-Exec] 0ms Latency Hit (Pre-computed in ${payload.exitMs}ms)\x1b[0m\n${payload.stdout || ''}`,
          time: new Date().toLocaleTimeString()
        },
        ...(payload.stderr ? [{
          id: Math.random().toString(),
          type: 'error' as const,
          content: payload.stderr,
          time: new Date().toLocaleTimeString()
        }] : [])
        ]);
      }

      // Shadow Engine Miss - Proceed with normal execution
      if (env.topic === 'terminal.shadow:miss') {
        if (pendingCmd && pendingCmd.cmd === (env.payload as any).command.split(' ')[0]) {
          kernel.publish('vm.spawn', {
            _request_id: pendingCmd.reqId,
            cmd: pendingCmd.cmd,
            args: pendingCmd.args,
            cwd: 'home'
          });
          setPendingCmd(null);
        }
      }
    });
    return unsubscribe;
  }, [pendingCmd]);

  // Compute the ghost text suffix to display after the cursor
  const ghostSuffix = ghostPrediction && ghostPrediction.startsWith(input) 
    ? ghostPrediction.slice(input.length) 
    : ghostPrediction && input.length > 0 ? ` → ${ghostPrediction}` : '';

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
          {line.type === 'input' && <span className="text-cyan-500 mr-2">➜ ~</span>}
          {line.type === 'intent' && <span className="text-purple-500 mr-2">⚡</span>}
          {line.imageDataUrl ? (
            <img src={line.imageDataUrl} alt="rendered page" className="max-w-full rounded border border-white/10 my-1" />
          ) : (
            <span className="whitespace-pre-wrap">{line.content}</span>
          )}
        </div>
      ))}
      <div className="flex items-center mt-2 relative">
        <span className="text-cyan-500 mr-2">➜ ~</span>
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
          {/* Ghost prediction overlay */}
          {ghostSuffix && (
            <div className="absolute top-0 left-0 pointer-events-none whitespace-pre z-0">
              <span className="invisible">{input}</span>
              <span className="text-gray-600 italic">{ghostSuffix}</span>
              <span className="text-gray-700 text-xs ml-2">[Tab]</span>
            </div>
          )}
        </div>
      </div>
      <div ref={bottomRef} />
    </div>
  );
};