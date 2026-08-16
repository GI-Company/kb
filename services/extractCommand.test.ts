import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/supabaseClient', () => ({ supabase: null }));
vi.mock('../lib/appletCompiler', () => ({ compileApplet: vi.fn() }));

const { extractCommand } = await import('./kernel');

describe('extractCommand', () => {
  it('takes a bare command line', () => {
    expect(extractCommand('ls -la')).toBe('ls -la');
  });

  it('unwraps inline backticks', () => {
    expect(extractCommand('`cat notes.md`')).toBe('cat notes.md');
  });

  // The reported failure. The Dispatcher answered in its tool-call format;
  // the parser stripped the backticks off the opening fence and ran the
  // fence language, so `? what can we do here` became `tool` and came back
  // as "Command 'tool' is not in the kernel allowlist."
  it('does not mistake a fence language for the command', () => {
    const reply = '```tool\n{"tool":"kernos.exec","args":{}}\n```';
    expect(extractCommand(reply)).toBeNull();
  });

  it('reads the command from inside a fenced block', () => {
    expect(extractCommand('```bash\nwc -l notes.md\n```')).toBe('wc -l notes.md');
  });

  it('drops a prose answer that is not a command', () => {
    expect(extractCommand('You can list files or read them.')).toBeNull();
  });

  // Better a clear "no command does that" than a 127 from a command the
  // serverless image does not actually have.
  it('rejects commands this shell does not have', () => {
    expect(extractCommand('find . -size +1M')).toBeNull();
    expect(extractCommand('jq .name package.json')).toBeNull();
    expect(extractCommand('node -v')).toBeNull();
  });

  it('honours the explicit UNSUPPORTED reply', () => {
    expect(extractCommand('UNSUPPORTED')).toBeNull();
  });

  it('keeps pipes and redirects intact', () => {
    expect(extractCommand('cat log.txt | grep error > errs.txt')).toBe('cat log.txt | grep error > errs.txt');
  });

  it('allows the browser-side commands, not just the server ones', () => {
    expect(extractCommand('python -c "print(2+2)"')).toBe('python -c "print(2+2)"');
  });
});
