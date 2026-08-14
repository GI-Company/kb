import React, { useState, useEffect, useCallback } from 'react';
import { useOS } from '../../store';
import { FEATURE_TOURS } from '../../lib/featureTours';
import { X, ArrowRight, ArrowLeft, Compass } from 'lucide-react';

// Same spotlight/tooltip mechanic as Walkthrough.tsx (the one-time desktop
// intro), generalized to tour a single app's own controls instead of the
// taskbar. Window.tsx's per-window "?" button opens this with that
// window's appId; steps are keyed by appId in lib/featureTours.ts.
export const FeatureTour: React.FC = () => {
  const { activeTourAppId, closeFeatureTour } = useOS();
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const steps = activeTourAppId ? FEATURE_TOURS[activeTourAppId] || [] : [];

  const updateRect = useCallback(() => {
    const step = steps[stepIndex];
    if (!step) return;
    const el = document.querySelector(step.selector);
    setRect(el ? el.getBoundingClientRect() : null);
  }, [stepIndex, activeTourAppId]);

  useEffect(() => {
    if (!activeTourAppId) return;
    updateRect();
    window.addEventListener('resize', updateRect);
    return () => window.removeEventListener('resize', updateRect);
  }, [activeTourAppId, updateRect]);

  useEffect(() => {
    if (activeTourAppId) setStepIndex(0);
  }, [activeTourAppId]);

  if (!activeTourAppId || steps.length === 0) return null;

  const step = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;

  const tooltipStyle: React.CSSProperties = rect
    ? {
        left: Math.min(Math.max(rect.left + rect.width / 2 - 160, 16), window.innerWidth - 336),
        top: rect.top - 190 < 16 ? Math.min(rect.bottom + 12, window.innerHeight - 220) : rect.top - 190,
      }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  return (
    <div className="fixed inset-0 z-[10001]">
      {rect ? (
        <div
          className="fixed pointer-events-none rounded-xl transition-all duration-300"
          style={{
            left: rect.left - 8,
            top: rect.top - 8,
            width: rect.width + 16,
            height: rect.height + 16,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.75)',
            border: '2px solid rgba(168,85,247,0.6)',
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
          <div className="flex items-center gap-1.5 text-purple-400 text-[10px] font-mono uppercase tracking-wider">
            <Compass size={12} /> Step {stepIndex + 1} of {steps.length}
          </div>
          <button onClick={closeFeatureTour} className="text-gray-500 hover:text-white transition-colors" title="Close tour">
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
            <button onClick={closeFeatureTour} className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium transition-colors">
              Done
            </button>
          ) : (
            <button
              onClick={() => setStepIndex(i => Math.min(steps.length - 1, i + 1))}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium transition-colors"
            >
              Next <ArrowRight size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
