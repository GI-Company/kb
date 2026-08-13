import React, { useState, useCallback, useRef, useEffect } from 'react';
import { localModel, DEFAULT_LOCAL_MODEL_CONFIG, MixerType } from '../lib/localModel';
import { Cpu, Play, Sparkles, Download, RotateCcw, Loader2 } from 'lucide-react';

const SAMPLE_CORPUS = `Once upon a time, there was a small robot named Kip. Kip lived in a workshop full of gears and wires.

One day, Kip found a tiny bird with a broken wing. Kip built a little cart to carry the bird around until it could fly again.

The bird and Kip became best friends. Every morning, the bird would sing, and Kip would hum along in beeps and clicks.

When the bird's wing healed, it flew to the top of the workshop and looked back at Kip. Then it flew down, landed on Kip's shoulder, and stayed.`;

interface LogLine { id: string; text: string; kind: 'info' | 'error' | 'success' }

export const LocalModelApp: React.FC = () => {
  const [corpus, setCorpus] = useState(SAMPLE_CORPUS);
  const [dModel, setDModel] = useState(DEFAULT_LOCAL_MODEL_CONFIG.dModel);
  const [numLayers, setNumLayers] = useState(DEFAULT_LOCAL_MODEL_CONFIG.numLayers);
  const [numHeads, setNumHeads] = useState(DEFAULT_LOCAL_MODEL_CONFIG.numHeads);
  const [contextLen, setContextLen] = useState(DEFAULT_LOCAL_MODEL_CONFIG.contextLen);
  const [mixerType, setMixerType] = useState<MixerType>(DEFAULT_LOCAL_MODEL_CONFIG.mixerType);
  const [steps, setSteps] = useState(200);
  const [prompt, setPrompt] = useState('Once upon a time');
  const [maxTokens, setMaxTokens] = useState(80);

  const [isReady, setIsReady] = useState(localModel.isReady);
  const [isTraining, setIsTraining] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [modelInfo, setModelInfo] = useState<{ vocabSize: number; paramCount: number; documents: number } | null>(null);
  const [lastLoss, setLastLoss] = useState<number | null>(null);
  const [lossHistory, setLossHistory] = useState<number[]>([]);
  const [generated, setGenerated] = useState('');
  const [logs, setLogs] = useState<LogLine[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const log = useCallback((text: string, kind: LogLine['kind'] = 'info') => {
    setLogs(prev => [...prev.slice(-199), { id: Math.random().toString(36), text, kind }]);
  }, []);

  const handleInit = () => {
    try {
      const result = localModel.init(corpus, { dModel, numLayers, numHeads, contextLen, mixerType });
      setModelInfo(result);
      setIsReady(true);
      setLossHistory([]);
      setLastLoss(null);
      setGenerated('');
      log(`Model initialized: mixer=${mixerType}, d_model=${dModel}, layers=${numLayers}, heads=${numHeads}, context=${contextLen}, params=${result.paramCount.toLocaleString()}, vocab=${result.vocabSize}, stories=${result.documents}`, 'success');
    } catch (err: any) {
      log(`ERROR: ${err?.message || err}`, 'error');
    }
  };

  const handleTrain = async () => {
    if (!isReady) { log('Initialize the model first.', 'error'); return; }
    setIsTraining(true);
    log(`Training ${steps} steps...`);
    try {
      const result = await localModel.train(steps, (step, loss) => {
        if (step % 10 === 0 || step === steps) {
          setLastLoss(loss);
          setLossHistory(prev => [...prev.slice(-199), loss]);
        }
      });
      setLastLoss(result.finalLoss);
      log(`Finished ${result.steps} steps. Final loss: ${result.finalLoss.toFixed(4)}`, 'success');
    } catch (err: any) {
      log(`ERROR: ${err?.message || err}`, 'error');
    } finally {
      setIsTraining(false);
    }
  };

  const handleGenerate = async () => {
    if (!isReady) { log('Initialize the model first.', 'error'); return; }
    setIsGenerating(true);
    try {
      const result = await localModel.generate(prompt, maxTokens);
      setGenerated(result.text);
      log(`Generated ${result.tokensGenerated} tokens.`, 'success');
    } catch (err: any) {
      log(`ERROR: ${err?.message || err}`, 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleExport = () => {
    try {
      const { blob, filename } = localModel.exportInt8();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      log(`Exported ${filename} (${(blob.size / 1024).toFixed(1)} KB)`, 'success');
    } catch (err: any) {
      log(`ERROR: ${err?.message || err}`, 'error');
    }
  };

  const sparkline = lossHistory.length > 1 ? buildSparklinePath(lossHistory) : null;

  return (
    <div className="h-full flex bg-[#0a0a0f] text-gray-200 text-sm">
      {/* ── Left: config + corpus ── */}
      <div className="w-72 border-r border-white/5 flex flex-col shrink-0 overflow-y-auto">
        <div className="p-3 border-b border-white/5 flex items-center gap-2">
          <Cpu size={14} className="text-cyan-300" />
          <span className="text-xs font-bold text-gray-300 uppercase tracking-wider">Local Model (BNLM)</span>
        </div>

        <div className="p-3 flex flex-col gap-3">
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-wide">Training text</label>
            <textarea
              value={corpus}
              onChange={e => setCorpus(e.target.value)}
              rows={8}
              className="mt-1 w-full bg-white/5 border border-white/10 rounded-lg p-2 text-xs text-gray-300 outline-none focus:border-cyan-500/50 resize-none font-mono"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <NumberField label="d_model" value={dModel} onChange={setDModel} />
            <NumberField label="layers" value={numLayers} onChange={setNumLayers} />
            <NumberField label="heads" value={numHeads} onChange={setNumHeads} />
            <NumberField label="context" value={contextLen} onChange={setContextLen} />
          </div>

          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-wide">Mixer</label>
            <select
              value={mixerType}
              onChange={e => setMixerType(e.target.value as MixerType)}
              className="mt-1 w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none focus:border-cyan-500/50"
            >
              <option value="attention">attention</option>
              <option value="linear">linear</option>
              <option value="rwkv">rwkv</option>
            </select>
          </div>

          <button
            onClick={handleInit}
            className="flex items-center justify-center gap-2 px-3 py-2 bg-cyan-600/20 border border-cyan-500/30 hover:bg-cyan-600/30 rounded-lg text-xs font-medium text-cyan-300 transition-colors"
          >
            <RotateCcw size={12} /> Initialize / Reset Model
          </button>
        </div>
      </div>

      {/* ── Right: train / generate / logs ── */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="p-3 border-b border-white/5 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <NumberField label="steps" value={steps} onChange={setSteps} compact />
            <button
              onClick={handleTrain}
              disabled={!isReady || isTraining}
              className="flex items-center gap-1.5 px-3 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-600 rounded-lg text-xs font-medium transition-colors"
            >
              {isTraining ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              Train
            </button>
          </div>
          <div className="w-px h-6 bg-white/10" />
          <button
            onClick={handleExport}
            disabled={!isReady}
            className="flex items-center gap-1.5 px-3 py-2 bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-40 rounded-lg text-xs text-gray-300 transition-colors"
          >
            <Download size={12} /> Export Int8
          </button>
          <div className="ml-auto text-[10px] text-gray-500 font-mono">
            {modelInfo ? `${modelInfo.paramCount.toLocaleString()} params · vocab ${modelInfo.vocabSize}` : 'not initialized'}
            {lastLoss !== null && ` · loss ${lastLoss.toFixed(4)}`}
          </div>
        </div>

        {sparkline && (
          <div className="px-3 pt-2">
            <svg viewBox="0 0 200 40" className="w-full h-10">
              <path d={sparkline} fill="none" stroke="#22d3ee" strokeWidth="1.5" />
            </svg>
          </div>
        )}

        <div className="p-3 border-b border-white/5 flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="Prompt..."
            className="flex-1 min-w-[160px] bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 outline-none focus:border-purple-500/50"
          />
          <NumberField label="max tokens" value={maxTokens} onChange={setMaxTokens} compact />
          <button
            onClick={handleGenerate}
            disabled={!isReady || isGenerating}
            className="flex items-center gap-1.5 px-3 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-800 disabled:text-gray-600 rounded-lg text-xs font-medium transition-colors"
          >
            {isGenerating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            Generate
          </button>
        </div>

        {generated && (
          <div className="px-3 py-2 border-b border-white/5 bg-white/[0.02]">
            <div className="text-[10px] text-cyan-400 mb-1 font-mono uppercase tracking-wide">Output</div>
            <div className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed max-h-32 overflow-y-auto">{generated}</div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] space-y-1">
          {logs.length === 0 && (
            <div className="text-gray-600">Paste in some text, initialize a model, then train and generate — all in this tab, no server involved.</div>
          )}
          {logs.map(l => (
            <div key={l.id} className={l.kind === 'error' ? 'text-red-400' : l.kind === 'success' ? 'text-green-400' : 'text-gray-500'}>
              {l.text}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
};

const NumberField: React.FC<{ label: string; value: number; onChange: (v: number) => void; compact?: boolean }> = ({ label, value, onChange, compact }) => (
  <div className={compact ? 'w-24' : ''}>
    <label className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</label>
    <input
      type="number"
      value={value}
      onChange={e => onChange(parseInt(e.target.value, 10) || 0)}
      className="mt-1 w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none focus:border-cyan-500/50"
    />
  </div>
);

function buildSparklinePath(values: number[]): string {
  const w = 200, h = 40, pad = 2;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const step = (w - pad * 2) / Math.max(values.length - 1, 1);
  return values
    .map((v, i) => {
      const x = pad + i * step;
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
