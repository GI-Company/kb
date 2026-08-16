import { describe, it, expect } from 'vitest';
import { parseLabeledExamples, describeDataset } from './datasetGen';

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
