import React, { useState, useCallback, useRef, useEffect } from 'react';
import { localModel, DEFAULT_LOCAL_MODEL_CONFIG, MixerType } from '../lib/localModel';
import { runHistoryStore, genHistoryStore, RunHistoryEntry, GenHistoryEntry } from '../lib/localModelHistory';
import { SavedModelMeta } from '../lib/modelStore';
import { generateProseCorpus } from '../lib/datasetGen';
import { trackEvent } from '../lib/analytics';
import { getCurrentUserId } from '../lib/auth';
import { Cpu, Play, Sparkles, Download, RotateCcw, Loader2, Save, FolderOpen, Trash2, Wand2, Gauge } from 'lucide-react';

const SAMPLE_CORPUS = `Once upon a time, there was a small robot named Kip. Kip lived in a workshop full of gears and wires.

One day, Kip found a tiny bird with a broken wing. Kip built a little cart to carry the bird around until it could fly again.

The bird and Kip became best friends. Every morning, the bird would sing, and Kip would hum along in beeps and clicks.

When the bird's wing healed, it flew to the top of the workshop and looked back at Kip. Then it flew down, landed on Kip's shoulder, and stayed.`;

interface LogLine { id: string; text: string; kind: 'info' | 'error' | 'success' }
type BottomTab = 'log' | 'runs' | 'generations';

export const LocalModelApp: React.FC = () => {
  const [corpus, setCorpus] = useState(SAMPLE_CORPUS);
  const [dModel, setDModel] = useState(DEFAULT_LOCAL_MODEL_CONFIG.dModel);
  const [numLayers, setNumLayers] = useState(DEFAULT_LOCAL_MODEL_CONFIG.numLayers);
  const [numHeads, setNumHeads] = useState(DEFAULT_LOCAL_MODEL_CONFIG.numHeads);
  const [contextLen, setContextLen] = useState(DEFAULT_LOCAL_MODEL_CONFIG.contextLen);
  const [numWorkers, setNumWorkers] = useState(DEFAULT_LOCAL_MODEL_CONFIG.numWorkers);
  const [mixerType, setMixerType] = useState<MixerType>(DEFAULT_LOCAL_MODEL_CONFIG.mixerType);
  const [steps, setSteps] = useState(200);
  const [prompt, setPrompt] = useState('Once upon a time');
  const [maxTokens, setMaxTokens] = useState(80);

  const [isReady, setIsReady] = useState(localModel.isReady);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isTraining, setIsTraining] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [modelInfo, setModelInfo] = useState<{ vocabSize: number; paramCount: number; documents: number } | null>(null);
  const [lastLoss, setLastLoss] = useState<number | null>(null);
  const [lossHistory, setLossHistory] = useState<number[]>([]);
  const [generated, setGenerated] = useState('');
  const [scoreText, setScoreText] = useState('');
  const [scoreResult, setScoreResult] = useState<{ loss: number; perplexity: number; tokensScored: number } | null>(null);
  const [isScoring, setIsScoring] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const [bottomTab, setBottomTab] = useState<BottomTab>('log');
  const [runHistory, setRunHistory] = useState<RunHistoryEntry[]>([]);
  const [genHistory, setGenHistory] = useState<GenHistoryEntry[]>([]);

  const [datasetTopic, setDatasetTopic] = useState('a small robot who makes a new friend');
  const [datasetCount, setDatasetCount] = useState(6);
  const [isGeneratingDataset, setIsGeneratingDataset] = useState(false);

  const [savedModels, setSavedModels] = useState<SavedModelMeta[]>([]);
  const [saveName, setSaveName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingModel, setIsLoadingModel] = useState(false);
  const [userId, setUserId] = useState('guest');

  useEffect(() => {
    getCurrentUserId().then(setUserId);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const log = useCallback((text: string, kind: LogLine['kind'] = 'info') => {
    setLogs(prev => [...prev.slice(-199), { id: Math.random().toString(36), text, kind }]);
  }, []);

  const refreshHistory = useCallback(() => {
    setRunHistory(runHistoryStore.list());
    setGenHistory(genHistoryStore.list());
  }, []);

  const refreshSavedModels = useCallback(() => {
    localModel.listSaved(userId).then(setSavedModels).catch(() => {});
  }, [userId]);

  useEffect(() => {
    refreshHistory();
    refreshSavedModels();
  }, [refreshHistory, refreshSavedModels]);

  const handleInit = async () => {
    setIsInitializing(true);
    try {
      const result = await localModel.init(corpus, { dModel, numLayers, numHeads, contextLen, mixerType, numWorkers });
      setModelInfo(result);
      setIsReady(true);
      setLossHistory([]);
      setLastLoss(null);
      setGenerated('');
      log(`Model initialized: mixer=${mixerType}, d_model=${dModel}, layers=${numLayers}, heads=${numHeads}, context=${contextLen}, workers=${numWorkers}, params=${result.paramCount.toLocaleString()}, vocab=${result.vocabSize}, stories=${result.documents}`, 'success');
    } catch (err: any) {
      log(`ERROR: ${err?.message || err}`, 'error');
    } finally {
      setIsInitializing(false);
    }
  };

  const handleTrain = async () => {
    if (!isReady) { log('Initialize the model first.', 'error'); return; }
    setIsTraining(true);
    log(`Training ${steps} steps${numWorkers > 1 ? ` across ${numWorkers} workers` : ''}...`);
    try {
      const result = await localModel.train(steps, (step, loss) => {
        if (step % 10 === 0 || step === steps) {
          setLastLoss(loss);
          setLossHistory(prev => [...prev.slice(-199), loss]);
        }
      });
      setLastLoss(result.finalLoss);
      log(`Finished ${result.steps} steps. Final loss: ${result.finalLoss.toFixed(4)}`, 'success');
      trackEvent('local_model_trained', { mixer_type: mixerType, steps: result.steps, workers: numWorkers, final_loss: result.finalLoss });
      refreshHistory();
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
      if (result.cappedBy) {
        // The engine only console.warn'd this, which made a request for
        // e.g. 200 tokens silently return contextLen-minus-prompt instead
        // and read as a fixed generation limit.
        log(
          `Generated ${result.tokensGenerated} tokens — capped at ${result.cappedBy.limit} of the ` +
          `${result.requestedTokens} requested. The attention mixer can't exceed its context window ` +
          `(${result.cappedBy.contextLen}), and the prompt used ${result.cappedBy.promptTokens} of it. ` +
          `Raise Context Length, shorten the prompt, or switch the mixer to linear/rwkv for unbounded generation.`,
          'error'
        );
      } else {
        log(`Generated ${result.tokensGenerated} tokens.`, 'success');
      }
      trackEvent('local_model_generated', { mixer_type: mixerType, tokens: result.tokensGenerated });
      refreshHistory();
    } catch (err: any) {
      log(`ERROR: ${err?.message || err}`, 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleScore = async () => {
    if (!isReady) { log('Initialize the model first.', 'error'); return; }
    if (!scoreText.trim()) { log('Enter some text to score.', 'error'); return; }
    setIsScoring(true);
    try {
      const result = await localModel.score(scoreText);
      setScoreResult(result);
      log(`Scored ${result.tokensScored} tokens: loss ${result.loss.toFixed(3)}, perplexity ${result.perplexity.toFixed(2)}.`, 'success');
    } catch (err: any) {
      log(`ERROR: ${err?.message || err}`, 'error');
    } finally {
      setIsScoring(false);
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

  const handleGenerateDataset = async () => {
    setIsGeneratingDataset(true);
    log(`Asking Groq to generate ${datasetCount} training stories about "${datasetTopic}"...`);
    try {
      const text = await generateProseCorpus(datasetTopic, datasetCount);
      if (!text) throw new Error('Groq returned an empty response.');
      setCorpus(text);
      log(`Groq generated a new training corpus (${text.length} chars). Review it below, then Initialize.`, 'success');
    } catch (err: any) {
      log(`ERROR generating dataset: ${err?.message || err}`, 'error');
    } finally {
      setIsGeneratingDataset(false);
    }
  };

  const handleSaveModel = async () => {
    const name = saveName.trim();
    if (!name) { log('Enter a name to save this model as.', 'error'); return; }
    setIsSaving(true);
    try {
      await localModel.saveAs(userId, name);
      log(`Saved model as "${name}".`, 'success');
      setSaveName('');
      refreshSavedModels();
    } catch (err: any) {
      log(`ERROR saving model: ${err?.message || err}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleLoadModel = async (name: string) => {
    setIsLoadingModel(true);
    try {
      const result = await localModel.loadSaved(userId, name);
      const cfg = localModel.currentConfig;
      setCorpus(localModel.currentCorpusText);
      setDModel(cfg.dModel);
      setNumLayers(cfg.numLayers);
      setNumHeads(cfg.numHeads);
      setContextLen(cfg.contextLen);
      setNumWorkers(cfg.numWorkers);
      setMixerType(cfg.mixerType);
      setModelInfo(result);
      setIsReady(true);
      setLossHistory([]);
      setLastLoss(null);
      setGenerated('');
      log(`Loaded model "${name}": ${result.paramCount.toLocaleString()} params, vocab ${result.vocabSize}.`, 'success');
    } catch (err: any) {
      log(`ERROR loading model: ${err?.message || err}`, 'error');
    } finally {
      setIsLoadingModel(false);
    }
  };

  const handleDeleteModel = async (name: string) => {
    try {
      await localModel.deleteSaved(userId, name);
      log(`Deleted saved model "${name}".`);
      refreshSavedModels();
    } catch (err: any) {
      log(`ERROR deleting model: ${err?.message || err}`, 'error');
    }
  };

  const sparkline = lossHistory.length > 1 ? buildSparklinePath(lossHistory) : null;

  return (
    <div className="h-full flex bg-[#0a0a0f] text-gray-200 text-sm">
      {/* ── Left: config + corpus + saved models ── */}
      <div className="w-80 border-r border-white/5 flex flex-col shrink-0 overflow-y-auto">
        <div className="p-3 border-b border-white/5 flex items-center gap-2">
          <Cpu size={14} className="text-cyan-300" />
          <span className="text-xs font-bold text-gray-300 uppercase tracking-wider">Local Model (BNLM)</span>
        </div>

        <div className="p-3 flex flex-col gap-3">
          <div data-tour="lm-dataset" className="border border-purple-500/20 bg-purple-500/5 rounded-lg p-2 flex flex-col gap-2">
            <label className="text-[10px] text-purple-300 uppercase tracking-wide flex items-center gap-1"><Wand2 size={10} /> Generate dataset with Groq</label>
            <input
              type="text"
              value={datasetTopic}
              onChange={e => setDatasetTopic(e.target.value)}
              placeholder="Topic..."
              className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-gray-300 outline-none focus:border-purple-500/50"
            />
            <div className="flex gap-2">
              <NumberField label="stories" value={datasetCount} onChange={setDatasetCount} compact />
              <button
                onClick={handleGenerateDataset}
                disabled={isGeneratingDataset}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 bg-purple-600/20 border border-purple-500/30 hover:bg-purple-600/30 disabled:opacity-40 rounded text-xs font-medium text-purple-300 transition-colors"
              >
                {isGeneratingDataset ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                Generate
              </button>
            </div>
          </div>

          <div data-tour="lm-corpus">
            <label className="text-[10px] text-gray-500 uppercase tracking-wide">Training text</label>
            <textarea
              value={corpus}
              onChange={e => setCorpus(e.target.value)}
              rows={8}
              className="mt-1 w-full bg-white/5 border border-white/10 rounded-lg p-2 text-xs text-gray-300 outline-none focus:border-cyan-500/50 resize-none font-mono"
            />
          </div>

          <div data-tour="lm-config" className="grid grid-cols-2 gap-2">
            <NumberField label="d_model" value={dModel} onChange={setDModel} />
            <NumberField label="layers" value={numLayers} onChange={setNumLayers} />
            <NumberField label="heads" value={numHeads} onChange={setNumHeads} />
            <NumberField label="context" value={contextLen} onChange={setContextLen} />
          </div>

          <div className="grid grid-cols-2 gap-2 items-end">
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
            <NumberField label="workers" value={numWorkers} onChange={setNumWorkers} />
          </div>

          <button
            data-tour="lm-init"
            onClick={handleInit}
            disabled={isInitializing}
            className="flex items-center justify-center gap-2 px-3 py-2 bg-cyan-600/20 border border-cyan-500/30 hover:bg-cyan-600/30 disabled:opacity-40 rounded-lg text-xs font-medium text-cyan-300 transition-colors"
          >
            {isInitializing ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
            Initialize / Reset Model
          </button>

          <div data-tour="lm-saved" className="border-t border-white/5 pt-3 flex flex-col gap-2">
            <label className="text-[10px] text-gray-500 uppercase tracking-wide">Saved models</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                placeholder="Name this model..."
                className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-gray-300 outline-none focus:border-cyan-500/50"
              />
              <button
                onClick={handleSaveModel}
                disabled={!isReady || isSaving}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-40 rounded text-xs text-gray-300 transition-colors"
              >
                {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              </button>
            </div>
            {savedModels.length === 0 ? (
              <div className="text-[10px] text-gray-600">No saved models yet.</div>
            ) : (
              <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
                {savedModels.map(m => (
                  <div key={m.name} className="flex items-center gap-1 text-[11px] bg-white/[0.03] border border-white/5 rounded px-2 py-1">
                    <span className="flex-1 truncate text-gray-300" title={m.name}>{m.name}</span>
                    <span className="text-[9px] text-gray-600 shrink-0">{m.paramCount.toLocaleString()}p</span>
                    <button onClick={() => handleLoadModel(m.name)} disabled={isLoadingModel} className="p-1 text-gray-500 hover:text-cyan-400 transition-colors" title="Load">
                      <FolderOpen size={11} />
                    </button>
                    <button onClick={() => handleDeleteModel(m.name)} className="p-1 text-gray-500 hover:text-red-400 transition-colors" title="Delete">
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Right: train / generate / logs ── */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="p-3 border-b border-white/5 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <NumberField label="steps" value={steps} onChange={setSteps} compact />
            <button
              data-tour="lm-train"
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

        <div data-tour="lm-generate" className="p-3 border-b border-white/5 flex items-center gap-2 flex-wrap">
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

        {/* Score: the "more than generation" use of a trained model — how
            well does this text match what it learned, without sampling anything new. */}
        <div data-tour="lm-score" className="p-3 border-b border-white/5 flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={scoreText}
            onChange={e => setScoreText(e.target.value)}
            placeholder="Score text against the trained model..."
            className="flex-1 min-w-[160px] bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 outline-none focus:border-purple-500/50"
          />
          <button
            onClick={handleScore}
            disabled={!isReady || isScoring}
            className="flex items-center gap-1.5 px-3 py-2 bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-40 rounded-lg text-xs text-gray-300 transition-colors"
          >
            {isScoring ? <Loader2 size={12} className="animate-spin" /> : <Gauge size={12} />}
            Score
          </button>
          {scoreResult && (
            <span className="text-[10px] text-gray-500 font-mono">
              loss {scoreResult.loss.toFixed(3)} · perplexity {scoreResult.perplexity.toFixed(2)} · {scoreResult.tokensScored} tokens
            </span>
          )}
        </div>

        {/* Bottom tabs: Log / Run History / Generation Log */}
        <div className="px-3 pt-2 flex items-center gap-1 border-b border-white/5">
          {(['log', 'runs', 'generations'] as BottomTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setBottomTab(tab)}
              className={`px-3 py-1.5 text-[10px] uppercase tracking-wide rounded-t transition-colors ${bottomTab === tab ? 'bg-white/5 text-cyan-300 border-b-2 border-cyan-400' : 'text-gray-500 hover:text-gray-300'}`}
            >
              {tab === 'log' ? 'Log' : tab === 'runs' ? `Run History (${runHistory.length})` : `Generations (${genHistory.length})`}
            </button>
          ))}
          {bottomTab === 'runs' && runHistory.length > 0 && (
            <button onClick={() => { runHistoryStore.clear(); refreshHistory(); }} className="ml-auto text-[10px] text-gray-600 hover:text-red-400">Clear</button>
          )}
          {bottomTab === 'generations' && genHistory.length > 0 && (
            <button onClick={() => { genHistoryStore.clear(); refreshHistory(); }} className="ml-auto text-[10px] text-gray-600 hover:text-red-400">Clear</button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px]">
          {bottomTab === 'log' && (
            <div className="space-y-1">
              {logs.length === 0 && (
                <div className="text-gray-600">Paste in some text (or generate one with Groq above), initialize a model, then train and generate — all in this tab, no server involved.</div>
              )}
              {logs.map(l => (
                <div key={l.id} className={l.kind === 'error' ? 'text-red-400' : l.kind === 'success' ? 'text-green-400' : 'text-gray-500'}>
                  {l.text}
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          )}

          {bottomTab === 'runs' && (
            runHistory.length === 0 ? (
              <div className="text-gray-600">No training runs logged yet — results appear here each time a training run finishes.</div>
            ) : (
              <table className="w-full text-left">
                <thead>
                  <tr className="text-gray-500 text-[10px] uppercase">
                    <th className="pb-1 pr-3">Time</th>
                    <th className="pb-1 pr-3">Mixer</th>
                    <th className="pb-1 pr-3">Config</th>
                    <th className="pb-1 pr-3">Params</th>
                    <th className="pb-1 pr-3">Steps</th>
                    <th className="pb-1 pr-3">Loss</th>
                    <th className="pb-1">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {runHistory.map((r, i) => (
                    <tr key={i} className="border-t border-white/5 text-gray-400">
                      <td className="py-1 pr-3">{r.time}</td>
                      <td className="py-1 pr-3">{r.mixer}</td>
                      <td className="py-1 pr-3">d={r.dModel} L={r.numLayers} H={r.numHeads} ctx={r.contextLen}</td>
                      <td className="py-1 pr-3">{r.params.toLocaleString()}</td>
                      <td className="py-1 pr-3">{r.totalSteps}</td>
                      <td className="py-1 pr-3">{r.finalLoss.toFixed(4)}</td>
                      <td className="py-1">{r.durationSec.toFixed(1)}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {bottomTab === 'generations' && (
            genHistory.length === 0 ? (
              <div className="text-gray-600">No generations logged yet.</div>
            ) : (
              <table className="w-full text-left">
                <thead>
                  <tr className="text-gray-500 text-[10px] uppercase">
                    <th className="pb-1 pr-3">Time</th>
                    <th className="pb-1 pr-3">Mixer</th>
                    <th className="pb-1 pr-3">Prompt</th>
                    <th className="pb-1">Output</th>
                  </tr>
                </thead>
                <tbody>
                  {genHistory.map((r, i) => (
                    <tr key={i} className="border-t border-white/5 text-gray-400 align-top">
                      <td className="py-1 pr-3 whitespace-nowrap">{r.time}</td>
                      <td className="py-1 pr-3 whitespace-nowrap">{r.mixer}</td>
                      <td className="py-1 pr-3 max-w-[160px] truncate" title={r.prompt}>{r.prompt}</td>
                      <td className="py-1 max-w-[320px] truncate" title={r.output}>{r.output}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
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
