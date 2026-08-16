import { describe, it, expect, vi, beforeEach } from 'vitest';

const trafficLog: any[] = [];
vi.mock('../services/kernel', () => ({
  kernel: { getTrafficLog: () => trafficLog },
}));

const predict = vi.fn();
const explain = vi.fn();
const loadSaved = vi.fn();
const initFn = vi.fn();
const trainFn = vi.fn();
const evaluateFn = vi.fn();
const saveAsFn = vi.fn();
const currentExamplesFn = vi.fn(() => [] as any[]);
const currentConfigFn = vi.fn(() => ({} as any));
vi.mock('./localClassifier', () => ({
  localClassifier: {
    predict: (...a: any[]) => predict(...a),
    explain: (...a: any[]) => explain(...a),
    loadSaved: (...a: any[]) => loadSaved(...a),
    init: (...a: any[]) => initFn(...a),
    train: (...a: any[]) => trainFn(...a),
    evaluate: (...a: any[]) => evaluateFn(...a),
    saveAs: (...a: any[]) => saveAsFn(...a),
    get currentExamples() { return currentExamplesFn(); },
    get currentConfig() { return currentConfigFn(); },
  },
  // A trivial, deterministic split — what's tested here is that train/evaluate
  // are called with the merged set and its complement, not the split's exact
  // ratio (that's covered where splitHeldOut itself is defined).
  // Math.floor, matching the real splitHeldOut, so the length this test
  // asserts on isn't testing this mock's own arithmetic instead of the code
  // under test.
  splitHeldOut: (examples: any[]) => {
    const cut = Math.floor(examples.length * 0.8);
    return { train: examples.slice(0, cut), test: examples.slice(cut) };
  },
}));

const registryLoad = vi.fn();
vi.mock('./classifierRegistry', () => ({
  classifierRegistry: { load: (...a: any[]) => registryLoad(...a) },
}));

// A small in-memory VFS double, real enough that `correct` writing a
// correction and `train` reading it back actually round-trips — the
// interaction between the two commands is exactly what needs covering.
const catResult = { stdout: '', stderr: '', code: 0 };
const files = new Map<string, string>();
const runFsCommandMock = vi.fn(async (command: string, args: string[]) => {
  if (command === 'write') {
    const append = args[0] === '-a';
    const rest = append ? args.slice(1) : args;
    const [path, text] = rest;
    const prev = files.get(path) ?? '';
    files.set(path, append ? prev + text : text);
    return { result: { stdout: '', stderr: '', code: 0 }, cwd: [] };
  }
  if (command === 'cat') {
    const [path] = args;
    if (files.has(path)) return { result: { stdout: files.get(path)!, stderr: '', code: 0 }, cwd: [] };
    return { result: catResult, cwd: [] };
  }
  return { result: catResult, cwd: [] };
});
vi.mock('./terminalFs', () => ({
  runFsCommand: runFsCommandMock,
}));

const { runIntelCommand, _resetIntelSession } = await import('./terminalIntel');

const ctx = { cwd: [], userId: 'u1' };
const ev = (topic: string, payload: any, from = 'client', to?: string) =>
  ({ topic, from, to, payload, time: '2026-08-16T12:04:31.000Z' });

beforeEach(() => {
  vi.clearAllMocks();
  trafficLog.length = 0;
  _resetIntelSession();
  catResult.stdout = '';
  catResult.code = 0;
  files.clear();
  currentExamplesFn.mockReturnValue([]);
  currentConfigFn.mockReturnValue({});
});

describe('trace', () => {
  it('says so plainly when the bus has been quiet', async () => {
    const r = await runIntelCommand('trace', [], ctx);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/No bus activity yet/);
  });

  // getTrafficLog() is newest-first; a log that reads newest-first is not a
  // log. The command reverses so it reads like one.
  it('prints oldest first, whatever order the bus keeps', async () => {
    trafficLog.push(ev('vm.exit', { code: 0 }), ev('vm.spawn', { cmd: 'whoami', args: [] }));
    const r = await runIntelCommand('trace', [], ctx);
    expect(r.stdout.indexOf('vm.spawn')).toBeLessThan(r.stdout.indexOf('vm.exit'));
  });

  it('summarises payloads per topic rather than dumping JSON', async () => {
    trafficLog.push(ev('vm.spawn', { cmd: 'ls', args: ['-la'] }));
    const r = await runIntelCommand('trace', [], ctx);
    expect(r.stdout).toContain('ls -la');
    expect(r.stdout).not.toContain('{');
  });

  it('filters by topic and limits with --last', async () => {
    trafficLog.push(ev('agent.chat', { msg: 'hi' }), ev('vm.spawn', { cmd: 'a', args: [] }));
    expect((await runIntelCommand('trace', ['--topic', 'vm.'], ctx)).stdout).not.toContain('agent.chat');
    const limited = await runIntelCommand('trace', ['--last', '1'], ctx);
    expect(limited.stdout.split('\n').filter(l => l.includes(':'))).toHaveLength(1);
  });

  it('rejects a bad --last instead of silently defaulting', async () => {
    const r = await runIntelCommand('trace', ['--last', 'x'], ctx);
    expect(r.code).toBe(2);
  });

  it('emits one record per line with --json', async () => {
    trafficLog.push(ev('vm.spawn', { cmd: 'ls', args: [] }));
    const r = await runIntelCommand('trace', ['--json'], ctx);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ topic: 'vm.spawn', summary: 'ls' });
  });
});

describe('classify', () => {
  const prediction = {
    label: 'billing',
    confidence: 0.942,
    margin: 0.711,
    ranked: [{ label: 'billing', probability: 0.942 }, { label: 'support', probability: 0.231 }],
    logits: [], pooledNorm: 1, explanation: '',
  };

  it('states the runner-up and the margin, not just the winner', async () => {
    predict.mockResolvedValue(prediction);
    const r = await runIntelCommand('classify', ['refund', 'my', 'order'], ctx);
    expect(r.stdout).toContain('billing (94.2%)');
    expect(r.stdout).toContain('support (23.1%)');
    expect(r.stdout).toMatch(/Clear separation/);
  });

  // A router that reports 94% while the runner-up is at 88% is the failure
  // mode that matters, so a narrow margin has to be said out loud.
  it('calls a narrow margin uncertain', async () => {
    predict.mockResolvedValue({ ...prediction, margin: 0.06, ranked: [
      { label: 'billing', probability: 0.51 }, { label: 'support', probability: 0.45 },
    ] });
    expect((await runIntelCommand('classify', ['x'], ctx)).stdout).toMatch(/Narrow margin/);
  });

  // "No classifier" is the normal state of a fresh tab. The message has to
  // name the fix rather than read like a crash.
  it('explains how to get a classifier instead of just failing', async () => {
    predict.mockRejectedValue(new Error('No classifier has been trained yet in this tab.'));
    const r = await runIntelCommand('classify', ['x'], ctx);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--model/);
    expect(r.stderr).toMatch(/not a failure/);
  });

  it('emits an NDJSON record per input with --json', async () => {
    predict.mockResolvedValue(prediction);
    const r = await runIntelCommand('classify', ['--json'], { ...ctx, stdin: 'one\ntwo\n' });
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ text: 'one', label: 'billing' });
  });

  // The one rule that makes records composable: a JSON line contributes its
  // `text` field, anything else contributes itself.
  it('reads the text field out of piped records', async () => {
    predict.mockResolvedValue(prediction);
    await runIntelCommand('classify', [], { ...ctx, stdin: '{"text":"from a record"}\nplain line\n' });
    expect(predict).toHaveBeenNthCalledWith(1, 'from a record');
    expect(predict).toHaveBeenNthCalledWith(2, 'plain line');
  });

  it('falls back to the raw line when a record has no text field', async () => {
    predict.mockResolvedValue(prediction);
    await runIntelCommand('classify', [], { ...ctx, stdin: '{"other":1}\n' });
    expect(predict).toHaveBeenCalledWith('{"other":1}');
  });

  it('needs something to classify', async () => {
    expect((await runIntelCommand('classify', [], ctx)).code).toBe(2);
  });
});

describe('explain', () => {
  const attribution = {
    label: 'billing',
    baseline: 0.942,
    contributions: [
      { token: 'refund', index: 0, score: 0.42 },
      { token: 'my', index: 1, score: 0.03 },
      { token: 'order', index: 2, score: -0.16 },
    ],
  };

  it('ranks by magnitude and states the sign convention', async () => {
    explain.mockResolvedValue(attribution);
    const r = await runIntelCommand('explain', ['refund my order'], ctx);
    expect(r.stdout.indexOf('refund')).toBeLessThan(r.stdout.indexOf('order'));
    expect(r.stdout.indexOf('order')).toBeLessThan(r.stdout.indexOf('my'));
    // score = baseline - p(without); positive means it held the answer up.
    expect(r.stdout).toMatch(/Positive means removing it dropped the answer/);
    expect(r.stdout).toContain('+0.420');
    expect(r.stdout).toContain('−0.160');
  });

  it('explains the last classify with no arguments', async () => {
    predict.mockResolvedValue({
      label: 'billing', confidence: 0.9, margin: 0.5,
      ranked: [{ label: 'billing', probability: 0.9 }], logits: [], pooledNorm: 1, explanation: '',
    });
    explain.mockResolvedValue(attribution);
    await runIntelCommand('classify', ['refund', 'my', 'order'], ctx);
    await runIntelCommand('explain', [], ctx);
    expect(explain).toHaveBeenCalledWith('refund my order', expect.anything());
  });

  // Session state is per-tab. Explaining a decision the user can't see is
  // worse than admitting there isn't one.
  it('refuses rather than guessing when there is no last classify', async () => {
    const r = await runIntelCommand('explain', [], ctx);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cleared by a reload/);
  });

  it('warns that char granularity measures near nothing', async () => {
    explain.mockResolvedValue(attribution);
    const r = await runIntelCommand('explain', ['x', '--granularity', 'char'], ctx);
    expect(r.stdout).toMatch(/near zero/);
  });

  it('rejects an unknown granularity', async () => {
    expect((await runIntelCommand('explain', ['x', '--granularity', 'token'], ctx)).code).toBe(2);
  });

  it('passes --for through to the attribution target', async () => {
    explain.mockResolvedValue(attribution);
    await runIntelCommand('explain', ['x', '--for', 'support'], ctx);
    expect(explain).toHaveBeenCalledWith('x', expect.objectContaining({ forLabel: 'support' }));
  });
});

describe('correct', () => {
  const prediction = {
    label: 'files',
    confidence: 0.94,
    margin: 0.7,
    ranked: [{ label: 'files', probability: 0.94 }, { label: 'network', probability: 0.06 }],
    logits: [], pooledNorm: 1, explanation: '',
  };

  it('refuses when there is nothing to correct', async () => {
    const r = await runIntelCommand('correct', ['network'], ctx);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/nothing to correct/);
  });

  // A correction has to know which saved model it belongs to, or a later
  // retrain has nothing to attribute it to. Guessing would be worse than
  // refusing.
  it('refuses when the last classify was not attributed to a saved model', async () => {
    predict.mockResolvedValue(prediction);
    await runIntelCommand('classify', ['list', 'my', 'files'], ctx); // no --model
    const r = await runIntelCommand('correct', ['network'], ctx);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/wasn't run against a saved model/);
  });

  it('needs a label', async () => {
    predict.mockResolvedValue(prediction);
    await runIntelCommand('classify', ['x', '--model', 'router'], ctx);
    expect((await runIntelCommand('correct', [], ctx)).code).toBe(2);
  });

  // Validated against the label set the PREDICTION carried, not whatever
  // localClassifier has loaded at the moment `correct` runs — the service
  // is a singleton shared with the Classifier app UI, so "loaded right now"
  // can silently be a different model than the one that made this call.
  it('rejects an unknown label without --new-label', async () => {
    predict.mockResolvedValue(prediction);
    await runIntelCommand('classify', ['x', '--model', 'router'], ctx);
    const r = await runIntelCommand('correct', ['billing'], ctx);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not one of this classifier's labels/);
    expect(r.stderr).toMatch(/--new-label/);
  });

  it('accepts an unknown label with --new-label', async () => {
    predict.mockResolvedValue(prediction);
    await runIntelCommand('classify', ['x', '--model', 'router'], ctx);
    const r = await runIntelCommand('correct', ['billing', '--new-label'], ctx);
    expect(r.code).toBe(0);
  });

  it('writes the correction to a file named after the classifier', async () => {
    predict.mockResolvedValue(prediction);
    await runIntelCommand('classify', ['ping', 'the', 'host', '--model', 'router-test'], ctx);
    const r = await runIntelCommand('correct', ['network'], ctx);

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Recorded:.*network/);
    expect(r.stdout).toMatch(/predicted files at 94\.0%/);

    const written = files.get('corrections.router-test.jsonl');
    expect(written).toBeTruthy();
    const record = JSON.parse(written!.trim());
    expect(record).toMatchObject({ text: 'ping the host', label: 'network', predictedLabel: 'files' });
  });

  it('counts corrections across calls rather than always reporting one', async () => {
    predict.mockResolvedValue(prediction);
    await runIntelCommand('classify', ['a', '--model', 'router'], ctx);
    const first = await runIntelCommand('correct', ['network'], ctx);
    expect(first.stdout).toMatch(/1 correction saved/);

    await runIntelCommand('classify', ['b', '--model', 'router'], ctx);
    const second = await runIntelCommand('correct', ['network'], ctx);
    expect(second.stdout).toMatch(/2 corrections saved/);
  });

  it('emits a record with --json', async () => {
    predict.mockResolvedValue(prediction);
    await runIntelCommand('classify', ['a', '--model', 'router'], ctx);
    const r = await runIntelCommand('correct', ['network', '--json'], ctx);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({
      label: 'network', classifier: 'router', totalCorrections: 1,
    });
  });
});

describe('train --from-corrections', () => {
  it('has no bare mode', async () => {
    expect((await runIntelCommand('train', [], ctx)).code).toBe(2);
  });

  it('rejects a bad --steps value', async () => {
    const r = await runIntelCommand('train', ['--from-corrections', 'router', '--steps', 'lots'], ctx);
    expect(r.code).toBe(2);
  });

  it('refuses an unknown saved classifier', async () => {
    registryLoad.mockResolvedValue(undefined);
    const r = await runIntelCommand('train', ['--from-corrections', 'ghost'], ctx);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no saved classifier named "ghost"/);
    expect(loadSaved).not.toHaveBeenCalled();
  });

  it('refuses when there are no corrections recorded yet', async () => {
    registryLoad.mockResolvedValue({ heldOutAccuracy: 0.9 });
    catResult.code = 1; // no corrections.router.jsonl in the fake VFS at all
    const r = await runIntelCommand('train', ['--from-corrections', 'router'], ctx);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no corrections recorded/);
    expect(r.stderr).toMatch(/correct <label>/);
  });

  it('trains only on human-confirmed corrections, merged with the seed set', async () => {
    registryLoad.mockResolvedValue({ heldOutAccuracy: 0.85 });
    currentExamplesFn.mockReturnValue([{ text: 'seed one', label: 'files' }, { text: 'seed two', label: 'network' }]);
    currentConfigFn.mockReturnValue({ dModel: 24, mixerType: 'linear' });
    files.set('corrections.router.jsonl',
      JSON.stringify({ text: 'new one', label: 'files' }) + '\n' +
      'not json at all\n' +
      JSON.stringify({ text: 'new two', label: 'network' }) + '\n'
    );
    evaluateFn.mockResolvedValue(0.93);

    const r = await runIntelCommand('train', ['--from-corrections', 'router'], ctx);

    expect(loadSaved).toHaveBeenCalledWith('router');
    // 2 seed + 2 valid corrections = 4; the garbage line is skipped, not merged.
    expect(initFn).toHaveBeenCalledWith(
      expect.arrayContaining([{ text: 'seed one', label: 'files' }, { text: 'new one', label: 'files' }]),
      { dModel: 24, mixerType: 'linear' }
    );
    expect(initFn.mock.calls[0][0]).toHaveLength(3); // 80% cut of 4 examples via the mocked split
    expect(trainFn).toHaveBeenCalledWith(200); // default steps
    expect(evaluateFn).toHaveBeenCalled();
    expect(saveAsFn).toHaveBeenCalledWith('router', 0.93);

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Found 2 corrections \(1 line skipped/);
    expect(r.stdout).toMatch(/held-out 85\.0%/);
    expect(r.stdout).toMatch(/Held-out 93\.0% \(was 85\.0%\)/);
  });

  it('honours --steps and --save-as', async () => {
    registryLoad.mockResolvedValue({ heldOutAccuracy: 0.5 });
    currentExamplesFn.mockReturnValue([{ text: 's', label: 'a' }]);
    files.set('corrections.router.jsonl', JSON.stringify({ text: 'x', label: 'b' }) + '\n');
    evaluateFn.mockResolvedValue(0.6);

    await runIntelCommand('train', ['--from-corrections', 'router', '--steps', '50', '--save-as', 'router-v2'], ctx);

    expect(trainFn).toHaveBeenCalledWith(50);
    expect(saveAsFn).toHaveBeenCalledWith('router-v2', 0.6);
  });

  it('emits a summary record with --json', async () => {
    registryLoad.mockResolvedValue({ heldOutAccuracy: 0.5 });
    currentExamplesFn.mockReturnValue([{ text: 's', label: 'a' }]);
    files.set('corrections.router.jsonl', JSON.stringify({ text: 'x', label: 'b' }) + '\n');
    evaluateFn.mockResolvedValue(0.6);

    const r = await runIntelCommand('train', ['--from-corrections', 'router', '--json'], ctx);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({
      name: 'router', savedAs: 'router', seedExamples: 1, corrections: 1,
      heldOutBefore: 0.5, heldOutAfter: 0.6,
    });
  });
});
