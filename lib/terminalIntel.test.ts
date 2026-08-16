import { describe, it, expect, vi, beforeEach } from 'vitest';

const trafficLog: any[] = [];
vi.mock('../services/kernel', () => ({
  kernel: { getTrafficLog: () => trafficLog },
}));

const predict = vi.fn();
const explain = vi.fn();
const loadSaved = vi.fn();
vi.mock('./localClassifier', () => ({
  localClassifier: {
    predict: (...a: any[]) => predict(...a),
    explain: (...a: any[]) => explain(...a),
    loadSaved: (...a: any[]) => loadSaved(...a),
  },
}));

const catResult = { stdout: '', stderr: '', code: 0 };
vi.mock('./terminalFs', () => ({
  runFsCommand: vi.fn(async () => ({ result: catResult, cwd: [] })),
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
