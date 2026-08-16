import { describe, it, expect } from 'vitest';
import {
  tokenize, parseLine, runPipeline, hasPipelineSyntax, TEXT_FILTERS, PipelineHandlers,
} from './terminalPipeline';

/** Handlers backed by a tiny in-memory file map. */
function makeHandlers(files: Record<string, string> = {}): PipelineHandlers & { files: Record<string, string> } {
  return {
    files,
    runVfs: async (stage) => {
      if (stage.command === 'cat') {
        const name = stage.args[0];
        if (!(name in files)) return { stdout: '', stderr: `cat: ${name}: No such file or directory\n`, code: 1 };
        return { stdout: files[name], stderr: '', code: 0 };
      }
      if (stage.command === 'ls') return { stdout: Object.keys(files).sort().join('\n') + '\n', stderr: '', code: 0 };
      return null;
    },
    writeFile: async (path, content, append) => {
      files[path] = append ? (files[path] ?? '') + content : content;
      return { stdout: '', stderr: '', code: 0 };
    },
    isServerCommand: (c) => ['whoami', 'date', 'node'].includes(c),
  };
}

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('grep foo bar')).toEqual(['grep', 'foo', 'bar']);
  });

  it('keeps quoted strings together', () => {
    expect(tokenize('grep "hello world" file')).toEqual(['grep', 'hello world', 'file']);
    expect(tokenize("grep 'a b'")).toEqual(['grep', 'a b']);
  });

  it('preserves an intentionally empty quoted argument', () => {
    expect(tokenize('echo ""')).toEqual(['echo', '']);
  });
});

describe('parseLine', () => {
  it('parses a single command', () => {
    expect(parseLine('ls -l')).toEqual({ stages: [{ command: 'ls', args: ['-l'] }], redirect: undefined });
  });

  it('parses a pipeline', () => {
    const p = parseLine('cat a | grep b | wc -l');
    expect(typeof p).not.toBe('string');
    if (typeof p === 'string') return;
    expect(p.stages.map(s => s.command)).toEqual(['cat', 'grep', 'wc']);
  });

  it('parses both redirect modes', () => {
    const over = parseLine('echo hi > out.txt');
    const app = parseLine('echo hi >> out.txt');
    if (typeof over === 'string' || typeof app === 'string') throw new Error('should parse');
    expect(over.redirect).toEqual({ mode: 'overwrite', target: 'out.txt' });
    expect(app.redirect).toEqual({ mode: 'append', target: 'out.txt' });
  });

  it('rejects a redirect with no filename', () => {
    expect(parseLine('echo hi >')).toContain('needs a filename');
  });

  it('rejects an empty stage around a pipe', () => {
    expect(parseLine('cat a | | wc')).toContain('empty command');
    expect(parseLine('| wc')).toContain('empty command');
  });

  it('rejects anything after a redirect target', () => {
    expect(parseLine('echo hi > out.txt extra')).toContain('must come last');
  });
});

describe('hasPipelineSyntax', () => {
  it('detects pipes and redirects, and ignores them inside quotes', () => {
    expect(hasPipelineSyntax('cat a | grep b')).toBe(true);
    expect(hasPipelineSyntax('echo x > f')).toBe(true);
    expect(hasPipelineSyntax('ls -l')).toBe(false);
    // A pipe inside quotes is data, not syntax.
    expect(hasPipelineSyntax('grep "a | b"')).toBe(false);
  });
});

describe('text filters', () => {
  const s = 'alpha\nbeta\ngamma\nbeta\n';

  it('grep filters, and exits 1 when nothing matched', () => {
    expect(TEXT_FILTERS.grep(s, ['beta']).stdout).toBe('beta\nbeta\n');
    expect(TEXT_FILTERS.grep(s, ['zzz']).code).toBe(1);
  });

  it('grep -i and -v', () => {
    expect(TEXT_FILTERS.grep('Alpha\n', ['-i', 'alpha']).stdout).toBe('Alpha\n');
    expect(TEXT_FILTERS.grep(s, ['-v', 'beta']).stdout).toBe('alpha\ngamma\n');
  });

  it('wc counts lines, words, chars', () => {
    expect(TEXT_FILTERS.wc(s, ['-l']).stdout).toBe('4\n');
    expect(TEXT_FILTERS.wc(s, ['-w']).stdout).toBe('4\n');
  });

  it('head and tail', () => {
    expect(TEXT_FILTERS.head(s, ['-n', '2']).stdout).toBe('alpha\nbeta\n');
    expect(TEXT_FILTERS.tail(s, ['-n', '1']).stdout).toBe('beta\n');
  });

  it('sort, sort -r, sort -u', () => {
    expect(TEXT_FILTERS.sort(s, []).stdout).toBe('alpha\nbeta\nbeta\ngamma\n');
    expect(TEXT_FILTERS.sort(s, ['-u']).stdout).toBe('alpha\nbeta\ngamma\n');
    expect(TEXT_FILTERS.sort(s, ['-r']).stdout).toBe('gamma\nbeta\nbeta\nalpha\n');
  });

  it('uniq collapses only adjacent duplicates, like the real thing', () => {
    expect(TEXT_FILTERS.uniq('a\na\nb\na\n', []).stdout).toBe('a\nb\na\n');
    expect(TEXT_FILTERS.uniq('a\na\nb\n', ['-c']).stdout).toContain('2 a');
  });

  it('handles empty stdin without inventing a line', () => {
    expect(TEXT_FILTERS.wc('', ['-l']).stdout).toBe('0\n');
    expect(TEXT_FILTERS.sort('', []).stdout).toBe('');
  });
});

describe('runPipeline', () => {
  const run = async (line: string, h: PipelineHandlers) => {
    const parsed = parseLine(line);
    if (typeof parsed === 'string') throw new Error(parsed);
    return runPipeline(parsed, h);
  };

  it('threads stdout into the next stage', async () => {
    const h = makeHandlers({ 'notes.md': 'alpha\nbeta\ngamma\n' });
    const r = await run('cat notes.md | grep a | wc -l', h);
    // alpha, beta, gamma all contain "a"
    expect(r.stdout).toBe('3\n');
    expect(r.code).toBe(0);
  });

  it('writes to a file with > and returns nothing to the terminal', async () => {
    const h = makeHandlers({ 'in.txt': 'b\na\n' });
    const r = await run('cat in.txt | sort > out.txt', h);
    expect(r.stdout).toBe('');
    expect(h.files['out.txt']).toBe('a\nb\n');
  });

  it('appends with >>', async () => {
    const h = makeHandlers();
    await run('echo one > log.txt', h);
    await run('echo two >> log.txt', h);
    expect(h.files['log.txt']).toBe('one\ntwo\n');
  });

  it('overwrites with >', async () => {
    const h = makeHandlers({ 'log.txt': 'old\n' });
    await run('echo new > log.txt', h);
    expect(h.files['log.txt']).toBe('new\n');
  });

  // /api/exec has no stdin, so this can't work — saying so beats silently
  // dropping the piped input on the floor.
  it('refuses a server command downstream of a pipe, and explains', async () => {
    const h = makeHandlers({ 'a.txt': 'x\n' });
    const r = await run('cat a.txt | whoami', h);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('no stdin');
    expect(r.stderr).toContain('Commands that work in pipes');
  });

  it('reports an unknown command as not found', async () => {
    const r = await run('nosuchthing', makeHandlers());
    expect(r.code).toBe(127);
    expect(r.stderr).toContain('command not found');
  });

  it('surfaces stderr from a middle stage rather than swallowing it', async () => {
    const h = makeHandlers();
    const r = await run('cat missing.txt | wc -l', h);
    expect(r.stderr).toContain('No such file or directory');
  });
});

describe('head/tail line counts', () => {
  // `head -2` used to fall through to the default of 10 and quietly return
  // the wrong number of lines — no error, just a wrong answer.
  it('accepts the -N shorthand, not just -n N', () => {
    const input = 'a\nb\nc\nd\n';
    expect(TEXT_FILTERS.head(input, ['-2']).stdout).toBe('a\nb\n');
    expect(TEXT_FILTERS.head(input, ['-n', '2']).stdout).toBe('a\nb\n');
    expect(TEXT_FILTERS.tail(input, ['-1']).stdout).toBe('d\n');
  });

  it('still defaults to 10 with no flag', () => {
    const input = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    expect(TEXT_FILTERS.head(input, []).stdout.trim().split('\n')).toHaveLength(10);
  });
});
