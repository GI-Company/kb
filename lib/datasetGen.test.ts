import { describe, it, expect } from 'vitest';
import { parseLabeledExamples, describeDataset, parseParaphrasePairs, parseTaggedText } from './datasetGen';

const LABELS = ['files', 'network'];

describe('parseLabeledExamples', () => {
  it('parses the clean format', () => {
    const out = parseLabeledExamples('files | open the readme\nnetwork | ping the host', LABELS);
    expect(out).toEqual([
      { label: 'files', text: 'open the readme' },
      { label: 'network', text: 'ping the host' },
    ]);
  });

  // Real model output routinely arrives with numbering, bullets, markdown,
  // a chatty preamble and blank lines. Losing a few lines is acceptable;
  // losing the batch is not.
  it('survives the mess models actually emit', () => {
    const messy = [
      'Here is your training data:',
      '',
      '1. files | list my documents',
      '- **network** | curl that endpoint',
      '   files   |   delete the old logs   ',
      '',
      'network | resolve the domain',
      'Hope this helps!',
    ].join('\n');
    const out = parseLabeledExamples(messy, LABELS);
    expect(out).toEqual([
      { label: 'files', text: 'list my documents' },
      { label: 'network', text: 'curl that endpoint' },
      { label: 'files', text: 'delete the old logs' },
      { label: 'network', text: 'resolve the domain' },
    ]);
  });

  it('matches labels case-insensitively but keeps the canonical casing', () => {
    const out = parseLabeledExamples('FILES | a\nNetwork | b', LABELS);
    expect(out.map(e => e.label)).toEqual(['files', 'network']);
  });

  // Relabeling an unrecognized label to a "close" match would inject wrong
  // labels — worse than a smaller dataset.
  it('drops unknown labels rather than guessing', () => {
    const out = parseLabeledExamples('files | keep\ndatabase | drop this\nfilesystem | and this', LABELS);
    expect(out).toEqual([{ label: 'files', text: 'keep' }]);
  });

  it('keeps pipes that appear inside the example text', () => {
    const out = parseLabeledExamples('network | curl a | grep b', LABELS);
    expect(out).toEqual([{ label: 'network', text: 'curl a | grep b' }]);
  });

  it('drops duplicates, which inflate size without adding signal', () => {
    const out = parseLabeledExamples('files | open it\nfiles | open it\nfiles | Open It', LABELS);
    expect(out).toHaveLength(1);
  });

  it('returns nothing when no line has a separator', () => {
    expect(parseLabeledExamples('files: open it\nnetwork: ping it', LABELS)).toEqual([]);
  });
});

describe('parseParaphrasePairs', () => {
  it('parses the clean format', () => {
    const out = parseParaphrasePairs('the cat sat on the mat | a cat was sitting on a mat\nshe ran fast | she moved quickly');
    expect(out).toEqual([
      { a: 'the cat sat on the mat', b: 'a cat was sitting on a mat' },
      { a: 'she ran fast', b: 'she moved quickly' },
    ]);
  });

  it('survives the mess models actually emit', () => {
    const messy = [
      'Here are your pairs:',
      '',
      '1. the dog barked | the dog made noise',
      '- **it rained hard** | there was heavy rain',
      '   he left early   |   he departed sooner   ',
      '',
      'Hope this helps!',
    ].join('\n');
    const out = parseParaphrasePairs(messy);
    expect(out).toEqual([
      { a: 'the dog barked', b: 'the dog made noise' },
      { a: 'it rained hard', b: 'there was heavy rain' },
      { a: 'he left early', b: 'he departed sooner' },
    ]);
  });

  it('drops lines with no separator or an empty side', () => {
    const out = parseParaphrasePairs('no separator here\n| missing a side\nmissing b side |');
    expect(out).toEqual([]);
  });

  it('keeps pipes that appear inside the text', () => {
    const out = parseParaphrasePairs('run a | grep b | cmd | run "a" then "grep b"');
    expect(out).toEqual([{ a: 'run a', b: 'grep b | cmd | run "a" then "grep b"' }]);
  });

  it('drops duplicate pairs, case-insensitively', () => {
    const out = parseParaphrasePairs('a | b\nA | B\na | b');
    expect(out).toHaveLength(1);
  });
});

describe('parseTaggedText', () => {
  const TAGS = ['risky'];
  const DEFAULT = 'safe';

  it('strips markup and tags the marked span, leaving the rest as the default tag', () => {
    const [ex] = parseTaggedText('delete [risky]rm -rf /[/risky] now', TAGS, DEFAULT);
    expect(ex.text).toBe('delete rm -rf / now');
    expect(ex.tags).toHaveLength(ex.text.length);
    expect(ex.tags.slice(0, 7)).toEqual(Array(7).fill('safe')); // "delete "
    expect(ex.tags.slice(7, 15)).toEqual(Array(8).fill('risky')); // "rm -rf /"
    expect(ex.tags.slice(15)).toEqual(Array(4).fill('safe')); // " now"
  });

  it('tags an unmarked line entirely with the default tag', () => {
    const [ex] = parseTaggedText('just a normal sentence', TAGS, DEFAULT);
    expect(ex.text).toBe('just a normal sentence');
    expect(ex.tags.every(t => t === 'safe')).toBe(true);
  });

  it('handles multiple spans of different tags on one line', () => {
    const [ex] = parseTaggedText(
      '[urgent]call now[/urgent] about the [risky]expired cert[/risky] please',
      ['urgent', 'risky'],
      'normal'
    );
    expect(ex.text).toBe('call now about the expired cert please');
    expect(ex.tags.slice(0, 8)).toEqual(Array(8).fill('urgent')); // "call now"
    expect(ex.tags.slice(8, 19)).toEqual(Array(11).fill('normal')); // " about the "
    expect(ex.tags.slice(19, 31)).toEqual(Array(12).fill('risky')); // "expired cert"
    expect(ex.tags.slice(31)).toEqual(Array(7).fill('normal')); // " please"
  });

  it('folds an unrecognized tag name into the default tag rather than dropping the line', () => {
    const [ex] = parseTaggedText('[bogus]some text[/bogus] and more', TAGS, DEFAULT);
    expect(ex.text).toBe('some text and more');
    expect(ex.tags.every(t => t === 'safe')).toBe(true);
  });

  it('matches tag names case-insensitively', () => {
    const [ex] = parseTaggedText('[RISKY]bad stuff[/RISKY]', TAGS, DEFAULT);
    expect(ex.tags.every(t => t === 'risky')).toBe(true);
  });

  it('strips numbered-list and bullet artifacts from the start of a line', () => {
    const out = parseTaggedText('1. [risky]drop table[/risky] users\n- another [risky]bad[/risky] one', TAGS, DEFAULT);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe('drop table users');
    expect(out[1].text).toBe('another bad one');
  });

  it('skips blank lines', () => {
    const out = parseTaggedText('one line\n\n\nanother line', TAGS, DEFAULT);
    expect(out).toHaveLength(2);
  });

  it('keeps every tags array the same length as its text, across a mixed batch', () => {
    const raw = [
      'no markup here',
      '[risky]all of this[/risky]',
      'mixed [risky]middle[/risky] parts',
    ].join('\n');
    for (const ex of parseTaggedText(raw, TAGS, DEFAULT)) {
      expect(ex.tags).toHaveLength(Array.from(ex.text).length);
    }
  });
});

describe('describeDataset', () => {
  const many = (label: string, n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({ label, text: `${prefix} thing number ${i}` }));

  it('counts per label', () => {
    const d = describeDataset([...many('files', 60, 'open'), ...many('network', 60, 'ping')]);
    expect(d.total).toBe(120);
    expect(d.perLabel).toEqual({ files: 60, network: 60 });
  });

  it('warns on imbalance', () => {
    const d = describeDataset([...many('files', 100, 'open'), ...many('network', 10, 'ping')]);
    expect(d.warnings.some(w => /imbalanced/i.test(w))).toBe(true);
  });

  it('warns when the set is too small to generalize', () => {
    const d = describeDataset([...many('files', 12, 'open'), ...many('network', 12, 'ping')]);
    expect(d.warnings.some(w => /memorization/i.test(w))).toBe(true);
  });

  // The failure that actually happened: every example built from the same
  // frame, so the model keyed on the frame.
  it('warns when examples nearly all start the same way', () => {
    const d = describeDataset([...many('files', 60, 'open'), ...many('network', 60, 'open')]);
    expect(d.topOpenerShare).toBeGreaterThan(0.4);
    expect(d.warnings.some(w => /shared frame/i.test(w))).toBe(true);
  });

  // Scale-invariance: 20 distinct openers is healthy whether the set has
  // 240 examples or 24. A distinct/total ratio would have flagged this.
  it('stays quiet on a large, balanced, varied set', () => {
    const verbs = ['open', 'list', 'delete', 'rename', 'move', 'copy', 'find', 'show', 'purge', 'archive'];
    const examples = verbs.flatMap((v, i) => [
      ...Array.from({ length: 12 }, (_, j) => ({ label: 'files', text: `${v} item ${i}${j}` })),
      ...Array.from({ length: 12 }, (_, j) => ({ label: 'network', text: `${v}ing host ${i}${j}` })),
    ]);
    expect(describeDataset(examples).warnings).toEqual([]);
  });
});
