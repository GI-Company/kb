import React, { useState, useEffect, useCallback } from 'react';
import { useOS } from '../../store';
import { X, ArrowRight, ArrowLeft, Sparkles } from 'lucide-react';

interface Step {
  selector: string;
  title: string;
  description: string;
}

// Targets the default-pinned taskbar icons by their aria-label — all of
// these are in Taskbar.tsx's DEFAULT_PINNED, so they're visible for any
// first-time user. If someone's unpinned one before ever seeing the tour
// (unlikely, but possible via right-click), that step just falls back to
// a centered, un-highlighted card rather than erroring.
const STEPS: Step[] = [
  {
    selector: '[aria-label="AI Chat"]',
    title: 'AI Chat',
    description: 'Six Groq-backed agent personas, each routed to a model matched to its job. Ask any of them to train or query your local model too.',
  },
  {
    selector: '[aria-label="Local Model (BNLM)"]',
    title: 'Local Model',
    description: 'A real language model that trains and runs entirely in this browser tab — no server, no GPU cluster. Save it, reuse it, or let an agent drive it as a tool.',
  },
  {
    selector: '[aria-label="Terminal"]',
    title: 'Terminal',
    description: 'Real, sandboxed command execution — allowlisted and ephemeral, safe to experiment in.',
  },
  {
    selector: '[aria-label="CDE"]',
    title: 'CDE',
    description: 'A lightweight in-browser IDE with a file explorer and its own terminal panel.',
  },
  {
    selector: '[aria-label="File System"]',
    title: 'File System',
    description: 'Your files live in this browser — nothing leaves unless you send it somewhere yourself.',
  },
  {
    selector: '[aria-label="All Apps"]',
    title: 'All Apps',
    description: 'Everything else — Task Engine, Settings, System Monitor — lives behind this menu.',
  },
];

export const WALKTHROUGH_SEEN_KEY = 'kernos_walkthrough_seen';

export const Walkthrough: React.FC = () => {
  const { walkthroughOpen, closeWalkthrough } = useOS();
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const updateRect = useCallback(() => {
    const step = STEPS[stepIndex];
    if (!step) return;
    const el = document.querySelector(step.selector);
    setRect(el ? el.getBoundingClientRect() : null);
  }, [stepIndex]);

  useEffect(() => {
    if (!walkthroughOpen) return;
    updateRect();
    window.addEventListener('resize', updateRect);
    return () => window.removeEventListener('resize', updateRect);
  }, [walkthroughOpen, updateRect]);

  useEffect(() => {
    if (walkthroughOpen) setStepIndex(0);
  }, [walkthroughOpen]);

  if (!walkthroughOpen) return null;

  const step = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;

  const finish = () => {
    try { localStorage.setItem(WALKTHROUGH_SEEN_KEY, 'true'); } catch { /* best-effort */ }
    closeWalkthrough();
  };

  // Taskbar targets sit at the bottom of the screen, so the tooltip goes
  // above them by default, clamped to stay fully on-screen either way.
  const tooltipStyle: React.CSSProperties = rect
    ? {
        left: Math.min(Math.max(rect.left + rect.width / 2 - 160, 16), window.innerWidth - 336),
        top: Math.max(rect.top - 190, 16),
      }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  return (
    <div className="fixed inset-0 z-[10000]">
      {/* Spotlight: a bordered box exactly over the target with an oversized
          box-shadow creates the "hole" effect without an SVG mask. */}
      {rect ? (
        <div
          className="fixed pointer-events-none rounded-xl transition-all duration-300"
          style={{
            left: rect.left - 8,
            top: rect.top - 8,
            width: rect.width + 16,
            height: rect.height + 16,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.75)',
            border: '2px solid rgba(34,211,238,0.6)',
          }}
        />
      ) : (
        <div className="fixed inset-0 bg-black/75" />
      )}

      <div
        className="fixed w-80 bg-[#12121a] border border-white/10 rounded-xl shadow-2xl p-4"
        style={tooltipStyle}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 text-cyan-400 text-[10px] font-mono uppercase tracking-wider">
            <Sparkles size={12} /> Step {stepIndex + 1} of {STEPS.length}
          </div>
          <button onClick={finish} className="text-gray-500 hover:text-white transition-colors" title="Skip tour">
            <X size={14} />
          </button>
        </div>
        <h3 className="text-sm font-bold text-white mb-1">{step.title}</h3>
        <p className="text-xs text-gray-400 leading-relaxed mb-4">{step.description}</p>
        <div className="flex items-center justify-between">
          <button
            onClick={() => setStepIndex(i => Math.max(0, i - 1))}
            disabled={stepIndex === 0}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition-colors"
          >
            <ArrowLeft size={12} /> Back
          </button>
          {isLast ? (
            <button onClick={finish} className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium transition-colors">
              Done
            </button>
          ) : (
            <button
              onClick={() => setStepIndex(i => Math.min(STEPS.length - 1, i + 1))}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium transition-colors"
            >
              Next <ArrowRight size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
