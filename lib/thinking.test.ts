import { describe, it, expect } from 'vitest';
import { extractThinking } from './thinking';

describe('extractThinking', () => {
  it('leaves a plain reply untouched', () => {
    const { thinking, response } = extractThinking('Just the answer.');
    expect(thinking).toBe('');
    expect(response).toBe('Just the answer.');
  });

  it('splits <think> blocks emitted natively by reasoning models', () => {
    const { thinking, response } = extractThinking('<think>weighing it up</think>The answer.');
    expect(thinking).toBe('weighing it up');
    expect(response).toBe('The answer.');
  });

  // GLASS_BOX_CONTRACT in lib/agents.ts asks for <reasoning> specifically.
  // If this tag weren't handled, the block would render as clutter in the
  // reply rather than collapsing into the "why" panel.
  it('splits <reasoning> blocks requested by the glass-box contract', () => {
    const { thinking, response } = extractThinking(
      '<reasoning>Routing to files: classifier gave 0.92 vs 0.05 runner-up.</reasoning>Listing your files.'
    );
    expect(thinking).toBe('Routing to files: classifier gave 0.92 vs 0.05 runner-up.');
    expect(response).toBe('Listing your files.');
  });

  it('handles both tag styles in one reply', () => {
    const { thinking, response } = extractThinking('<think>a</think>mid<reasoning>b</reasoning>end');
    expect(thinking).toBe('a\n\nb');
    expect(response).toBe('midend');
  });

  it('keeps partial content while a block is still streaming', () => {
    const { thinking, response } = extractThinking('Working on it.<reasoning>still deciding');
    expect(thinking).toBe('still deciding');
    expect(response).toBe('Working on it.');
  });

  it('does not treat a mismatched pair as a closed block', () => {
    // <think>...</reasoning> must not match: the closing tag has to be the
    // same tag that opened. It falls through to the unclosed path instead.
    const { thinking, response } = extractThinking('<think>x</reasoning>y');
    expect(response).toBe('');
    expect(thinking).toContain('x');
  });
});
