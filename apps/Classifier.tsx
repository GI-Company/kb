// The Classifier app — trains a local intent router and lets you interrogate
// it. This is the surface that makes the capability reachable by a person
// rather than only by an agent tool call.
//
// The layout is opinionated in one way that matters: it refuses to show a
// training accuracy without a held-out accuracy next to it. The first
// classifier built here reported 100% training accuracy while scoring at
// chance on unseen input, so a UI that displays only the flattering number
// would actively mislead. Every train run here splits the data first.

import React, { useCallback, useEffect, useState } from 'react';
import { localClassifier, LabeledExample, PredictResult, Attribution, splitHeldOut } from '../lib/localClassifier';
import { generateLabeledExamples, describeDataset } from '../lib/datasetGen';
import { SavedClassifierMeta } from '../lib/classifierRegistry';
import { trackEvent } from '../lib/analytics';
import {
  Tags, Sparkles, Loader2, Play, Save, Trash2, AlertTriangle, Search, Download,
} from 'lucide-react';

type Status = 'idle' | 'generating' | 'training' | 'ready';

export const ClassifierApp: React.FC = () => {
  const [labelsText, setLabelsText] = useState('files, network, model');
  const [domain, setDomain] = useState('short commands a user types into a desktop OS terminal or chat');
  const [perLabel, setPerLabel] = useState(100);
  const [steps, setSteps] = useState(300);

  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [dataWarnings, setDataWarnings] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<{
    examples: number; params: number; trainAcc: number; heldOut: number; seconds: number;
  } | null>(null);

  const [probe, setProbe] = useState('');
  const [prediction, setPrediction] = useState<PredictResult | null>(null);
  const [attribution, setAttribution] = useState<Attribution | null>(null);
  const [probing, setProbing] = useState(false);

  const [saveName, setSaveName] = useState('');
  const [saved, setSaved] = useState<SavedClassifierMeta[]>([]);

  const addLog = (line: string) => setLog(prev => [...prev.slice(-40), line]);

  const refreshSaved = useCallback(() => {
    localClassifier.listSaved().then(setSaved).catch(() => { /* registry unavailable — list stays empty */ });
  }, []);
  useEffect(() => { refreshSaved(); }, [refreshSaved]);

  const labels = labelsText.split(',').map(l => l.trim()).filter(Boolean);

  const buildAndTrain = async () => {
    if (labels.length < 2) { addLog('Need at least 2 labels — a classifier has to choose between things.'); return; }
    setMetrics(null); setPrediction(null); setAttribution(null); setDataWarnings([]);
    try {
      setStatus('generating');
      setProgress(`Asking Groq for ${perLabel} examples per label…`);
      const examples = await generateLabeledExamples(labels, perLabel, domain);
      const stats = describeDataset(examples);
      setDataWarnings(stats.warnings);
      addLog(`Generated ${stats.total} examples (${Object.entries(stats.perLabel).map(([l, n]) => `${l}: ${n}`).join(', ')}).`);

      // Split BEFORE training so the reported accuracy means something.
      const { train, test } = splitHeldOut(examples);
      setStatus('training');
      const init = localClassifier.init(train);
      addLog(`Initialized ${init.paramCount.toLocaleString()} params, vocab ${init.vocabSize}.`);

      const started = performance.now();
      const result = await localClassifier.train(steps, s => {
        if (s % 25 === 0) setProgress(`Training… step ${s} / ${steps}`);
      });
      setProgress('Evaluating on held-out examples…');
      const heldOut = await localClassifier.evaluate(test);
      const seconds = (performance.now() - started) / 1000;

      setMetrics({
        examples: train.length, params: init.paramCount,
        trainAcc: result.trainAccuracy, heldOut, seconds,
      });
      addLog(`Train ${(result.trainAccuracy * 100).toFixed(1)}% · held-out ${(heldOut * 100).toFixed(1)}%.`);
      trackEvent('classifier_trained', { labels: labels.length, examples: train.length, held_out: heldOut });
      setStatus('ready');
      setProgress('');
    } catch (err: any) {
      addLog(`ERROR: ${err?.message || err}`);
      setStatus('idle'); setProgress('');
    }
  };

  const runProbe = async () => {
    if (!probe.trim()) return;
    setProbing(true);
    try {
      const p = await localClassifier.predict(probe);
      setPrediction(p);
      // Attribution is a second pass per word; only run it on demand like this.
      setAttribution(await localClassifier.explain(probe).catch(() => null));
    } catch (err: any) {
      addLog(`ERROR: ${err?.message || err}`);
      setPrediction(null); setAttribution(null);
    } finally {
      setProbing(false);
    }
  };

  const doSave = async () => {
    try {
      await localClassifier.saveAs(saveName, metrics?.heldOut);
      addLog(`Saved "${saveName}".`);
      setSaveName('');
      refreshSaved();
    } catch (err: any) { addLog(`ERROR: ${err?.message || err}`); }
  };

  const doLoad = async (name: string) => {
    try {
      const r = await localClassifier.loadSaved(name);
      addLog(`Loaded "${name}" — ${r.labels.join(', ')} (${r.paramCount.toLocaleString()} params).`);
      const meta = saved.find(s => s.name === name);
      setMetrics(meta?.heldOutAccuracy !== undefined
        ? { examples: meta.exampleCount, params: meta.paramCount, trainAcc: NaN, heldOut: meta.heldOutAccuracy, seconds: 0 }
        : null);
      setStatus('ready');
    } catch (err: any) { addLog(`ERROR: ${err?.message || err}`); }
  };

  const busy = status === 'generating' || status === 'training';
  const maxContribution = Math.max(0.001, ...(attribution?.contributions || []).map(c => Math.abs(c.score)));

  return (
    <div className="h-full bg-[#0a0a0f] text-white flex flex-col overflow-hidden text-sm">
      <div className="px-5 pt-4 pb-3 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <Tags className="text-emerald-400" size={18} />
          <h2 className="text-sm font-bold uppercase tracking-widest text-gray-300">Intent Classifier</h2>
        </div>
        <p className="text-[11px] text-gray-600">
          Trains a small router in this tab. Groq writes the training data once; after that every
          decision is local, offline, and sub-millisecond.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* ── Build ── */}
        <div className="rounded-lg bg-white/5 border border-white/5 p-3 space-y-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-widest">Build</div>
          <label className="block">
            <span className="text-[10px] text-gray-600">Labels (comma separated)</span>
            <input
              value={labelsText} onChange={e => setLabelsText(e.target.value)} disabled={busy}
              className="w-full mt-0.5 bg-black/40 border border-white/10 rounded px-2 py-1.5 font-mono text-xs outline-none focus:border-emerald-500/50 disabled:opacity-50"
            />
          </label>
          <label className="block">
            <span className="text-[10px] text-gray-600">What is being classified</span>
            <input
              value={domain} onChange={e => setDomain(e.target.value)} disabled={busy}
              className="w-full mt-0.5 bg-black/40 border border-white/10 rounded px-2 py-1.5 font-mono text-xs outline-none focus:border-emerald-500/50 disabled:opacity-50"
            />
          </label>
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="text-[10px] text-gray-600">Examples per label</span>
              <input
                type="number" min={20} max={150} value={perLabel} disabled={busy}
                onChange={e => setPerLabel(Number(e.target.value))}
                className="w-full mt-0.5 bg-black/40 border border-white/10 rounded px-2 py-1.5 font-mono text-xs outline-none disabled:opacity-50"
              />
            </label>
            <label className="flex-1">
              <span className="text-[10px] text-gray-600">Training steps</span>
              <input
                type="number" min={50} max={600} value={steps} disabled={busy}
                onChange={e => setSteps(Number(e.target.value))}
                className="w-full mt-0.5 bg-black/40 border border-white/10 rounded px-2 py-1.5 font-mono text-xs outline-none disabled:opacity-50"
              />
            </label>
          </div>
          <button
            onClick={buildAndTrain} disabled={busy || labels.length < 2}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded bg-emerald-600/20 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-600/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-xs font-medium"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {busy ? (progress || 'Working…') : 'Generate data & train'}
          </button>
          {labels.length < 2 && (
            <div className="text-[10px] text-amber-400">A classifier needs at least 2 labels.</div>
          )}
        </div>

        {/* ── Results: never a training number without a held-out number ── */}
        {metrics && (
          <div className="rounded-lg bg-white/5 border border-white/5 p-3">
            <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2">Results</div>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div className="bg-black/30 rounded p-2">
                <div className="text-[9px] text-gray-600 uppercase">Held-out accuracy</div>
                <div className="text-lg font-mono text-emerald-400">{(metrics.heldOut * 100).toFixed(1)}%</div>
                <div className="text-[9px] text-gray-600">on examples never trained on</div>
              </div>
              <div className="bg-black/30 rounded p-2">
                <div className="text-[9px] text-gray-600 uppercase">Training accuracy</div>
                <div className="text-lg font-mono text-gray-400">
                  {Number.isNaN(metrics.trainAcc) ? '—' : `${(metrics.trainAcc * 100).toFixed(1)}%`}
                </div>
                <div className="text-[9px] text-gray-600">not a measure of generalization</div>
              </div>
            </div>
            <div className="text-[10px] text-gray-500 font-mono">
              {metrics.params.toLocaleString()} params · {metrics.examples} training examples
              {metrics.seconds > 0 && ` · ${metrics.seconds.toFixed(1)}s`}
            </div>
            {!Number.isNaN(metrics.trainAcc) && metrics.trainAcc - metrics.heldOut > 0.15 && (
              <div className="mt-2 text-[10px] text-amber-400 flex items-start gap-1.5">
                <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                Training accuracy is far above held-out — it is memorizing. Add more examples,
                or shrink the model.
              </div>
            )}
          </div>
        )}

        {dataWarnings.length > 0 && (
          <div className="rounded-lg bg-amber-500/5 border border-amber-500/20 p-3">
            <div className="text-[10px] text-amber-400 uppercase tracking-widest mb-1 flex items-center gap-1.5">
              <AlertTriangle size={11} /> Data quality
            </div>
            {dataWarnings.map((w, i) => <div key={i} className="text-[11px] text-amber-300/80">{w}</div>)}
          </div>
        )}

        {/* ── Probe ── */}
        {status === 'ready' && (
          <div className="rounded-lg bg-white/5 border border-white/5 p-3 space-y-2">
            <div className="text-[10px] text-gray-500 uppercase tracking-widest">Try it</div>
            <div className="flex gap-2">
              <input
                value={probe} onChange={e => setProbe(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && runProbe()}
                placeholder="Type something to classify…"
                className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1.5 font-mono text-xs outline-none focus:border-emerald-500/50"
              />
              <button
                onClick={runProbe} disabled={probing || !probe.trim()}
                className="px-3 rounded bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-40 transition-colors"
              >
                {probing ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              </button>
            </div>

            {prediction && (
              <div className="space-y-2 pt-1">
                <div className="text-[11px] text-gray-400">{prediction.explanation}</div>
                {prediction.ranked.map(r => (
                  <div key={r.label} className="flex items-center gap-2">
                    <span className={`text-[10px] font-mono w-24 truncate ${r.label === prediction.label ? 'text-emerald-300' : 'text-gray-500'}`}>
                      {r.label}
                    </span>
                    <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
                      <div
                        className={r.label === prediction.label ? 'h-full bg-emerald-400' : 'h-full bg-gray-600'}
                        style={{ width: `${Math.max(r.probability * 100, 1)}%` }}
                      />
                    </div>
                    <span className="text-[10px] font-mono text-gray-500 w-11 text-right">
                      {(r.probability * 100).toFixed(1)}%
                    </span>
                  </div>
                ))}

                {attribution && attribution.contributions.length > 0 && (
                  <div className="pt-1">
                    <div className="text-[9px] text-gray-600 uppercase tracking-wider mb-1 flex items-center gap-1">
                      <Search size={9} /> What drove it — drop in confidence if removed
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {attribution.contributions.map((c, i) => (
                        <span
                          key={i}
                          title={`Removing "${c.token}" changes confidence by ${(c.score * 100).toFixed(1)} points`}
                          className="px-1.5 py-0.5 rounded text-[10px] font-mono border"
                          style={{
                            backgroundColor: `rgba(52, 211, 153, ${Math.max(0, c.score / maxContribution) * 0.35})`,
                            borderColor: `rgba(52, 211, 153, ${Math.max(0, c.score / maxContribution) * 0.5})`,
                          }}
                        >
                          {c.token}
                        </span>
                      ))}
                    </div>
                    {attribution.contributions.every(c => Math.abs(c.score) < 0.01) && (
                      <div className="text-[10px] text-gray-600 mt-1 italic">
                        No single word was decisive — the evidence is redundant.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Saved ── */}
        <div className="rounded-lg bg-white/5 border border-white/5 p-3 space-y-2">
          <div className="text-[10px] text-gray-500 uppercase tracking-widest">Saved classifiers</div>
          {status === 'ready' && (
            <div className="flex gap-2">
              <input
                value={saveName} onChange={e => setSaveName(e.target.value)}
                placeholder="name this classifier"
                className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1.5 font-mono text-xs outline-none focus:border-emerald-500/50"
              />
              <button
                onClick={doSave} disabled={!saveName.trim()}
                className="px-3 rounded bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-40 transition-colors"
                title="Save so it survives a reload"
              >
                <Save size={13} />
              </button>
            </div>
          )}
          {saved.length === 0 ? (
            <div className="text-[11px] text-gray-600 italic">Nothing saved yet.</div>
          ) : saved.map(m => (
            <div key={m.name} className="flex items-center gap-2 bg-black/30 rounded px-2 py-1.5">
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-gray-300 font-mono truncate">{m.name}</div>
                <div className="text-[9px] text-gray-600">
                  {m.labels.join(' · ')} — {m.paramCount.toLocaleString()} params, {m.exampleCount} examples
                  {m.heldOutAccuracy !== undefined && ` · held-out ${(m.heldOutAccuracy * 100).toFixed(1)}%`}
                </div>
              </div>
              <button onClick={() => doLoad(m.name)} className="p-1.5 rounded hover:bg-white/10 text-gray-500 hover:text-emerald-400 transition-colors" title="Load">
                <Download size={12} />
              </button>
              <button
                onClick={() => localClassifier.deleteSaved(m.name).then(refreshSaved)}
                className="p-1.5 rounded hover:bg-white/10 text-gray-600 hover:text-red-400 transition-colors" title="Delete"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>

        {log.length > 0 && (
          <div className="rounded-lg bg-black/30 border border-white/5 p-3">
            <div className="text-[10px] text-gray-600 uppercase tracking-widest mb-1">Log</div>
            <div className="font-mono text-[10px] text-gray-500 space-y-0.5 max-h-32 overflow-y-auto">
              {log.map((l, i) => (
                <div key={i} className={l.startsWith('ERROR') ? 'text-red-400' : ''}>{l}</div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
