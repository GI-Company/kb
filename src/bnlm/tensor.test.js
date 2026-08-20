// Nothing in src/bnlm/ has direct test coverage today — everything else is
// exercised indirectly through the lib/*.test.ts service-wrapper mocks. This
// file is scoped to l2Normalize alone: a new primitive with a hand-derived
// backward pass is exactly the kind of thing that can silently corrupt
// training (the model still sort of learns, just worse) without a test that
// checks the analytic gradient against a numerical one directly.
import { describe, it, expect } from 'vitest';
import { Tensor, l2Normalize } from './tensor.js';

function forwardLoss(xData, shape, upstream) {
  const x = new Tensor(new Float32Array(xData), shape, false);
  const y = l2Normalize(x);
  let loss = 0;
  for (let i = 0; i < y.data.length; i++) loss += y.data[i] * upstream[i];
  return loss;
}

describe('l2Normalize', () => {
  it('gives every row unit L2 norm', () => {
    const x = new Tensor(new Float32Array([3, 4, 0, 0, 5, 12]), [2, 3], false);
    const y = l2Normalize(x);
    for (let r = 0; r < 2; r++) {
      let sumSq = 0;
      for (let c = 0; c < 3; c++) sumSq += y.data[r * 3 + c] ** 2;
      expect(Math.sqrt(sumSq)).toBeCloseTo(1, 5);
    }
  });

  // This is the property the embedding model's contrastive loss actually
  // relies on: once both vectors are L2-normalized, matmul(y, y, false,
  // true) IS the cosine similarity matrix, no separate division needed.
  it('makes matmul(y, y^T) equal cosine similarity', () => {
    const a = [1, 2, 2]; // norm 3
    const b = [2, 0, -1]; // norm sqrt(5)
    const x = new Tensor(new Float32Array([...a, ...b]), [2, 3], false);
    const y = l2Normalize(x);
    const dot = y.data[0] * y.data[3] + y.data[1] * y.data[4] + y.data[2] * y.data[5];
    const rawDot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cosine = rawDot / (Math.sqrt(a[0] ** 2 + a[1] ** 2 + a[2] ** 2) * Math.sqrt(b[0] ** 2 + b[1] ** 2 + b[2] ** 2));
    expect(dot).toBeCloseTo(cosine, 5);
  });

  it('backward matches a numerical gradient (central differences)', async () => {
    const shape = [2, 3];
    const xData = [1, 2, 3, -1, 0.5, 2];
    const upstream = [0.3, -0.7, 0.1, 0.2, -0.4, 0.9];

    const x = new Tensor(new Float32Array(xData), shape, true);
    const y = l2Normalize(x);
    y.grad.set(upstream);
    await y._backward();

    const eps = 1e-3;
    for (let i = 0; i < xData.length; i++) {
      const plus = [...xData];
      plus[i] += eps;
      const minus = [...xData];
      minus[i] -= eps;
      const numGrad = (forwardLoss(plus, shape, upstream) - forwardLoss(minus, shape, upstream)) / (2 * eps);
      expect(x.grad[i]).toBeCloseTo(numGrad, 2);
    }
  });

  it('does not blow up on a near-zero row (eps guards the division)', () => {
    const x = new Tensor(new Float32Array([0, 0, 0]), [1, 3], false);
    const y = l2Normalize(x);
    for (const v of y.data) expect(Number.isFinite(v)).toBe(true);
  });
});
