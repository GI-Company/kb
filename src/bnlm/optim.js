// optim.js
// Adam optimizer operating directly on the flat Float32Array param/grad
// buffers held by each Tensor. Optimizer-step cost is O(total param count),
// negligible next to a forward/backward pass, so this runs on the CPU only
// -- no reason to add GPU dispatch complexity here.

export class Adam {
  constructor(params, { lr = 3e-3, beta1 = 0.9, beta2 = 0.999, eps = 1e-8 } = {}) {
    this.params = params; // array of Tensor
    this.lr = lr;
    this.beta1 = beta1;
    this.beta2 = beta2;
    this.eps = eps;
    this.t = 0;
    this.m = params.map((p) => new Float32Array(p.data.length));
    this.v = params.map((p) => new Float32Array(p.data.length));
  }

  zeroGrad() {
    for (const p of this.params) p.zeroGrad();
  }

  step() {
    this.t += 1;
    const { beta1, beta2, eps, lr, t } = this;
    const biasCorrection1 = 1 - Math.pow(beta1, t);
    const biasCorrection2 = 1 - Math.pow(beta2, t);
    for (let pi = 0; pi < this.params.length; pi++) {
      const p = this.params[pi];
      const m = this.m[pi];
      const v = this.v[pi];
      for (let i = 0; i < p.data.length; i++) {
        const g = p.grad[i];
        m[i] = beta1 * m[i] + (1 - beta1) * g;
        v[i] = beta2 * v[i] + (1 - beta2) * g * g;
        const mHat = m[i] / biasCorrection1;
        const vHat = v[i] / biasCorrection2;
        p.data[i] -= (lr * mHat) / (Math.sqrt(vHat) + eps);
      }
    }
  }
}

/**
 * Global-norm gradient clipping, applied in place across every param's
 * .grad buffer (called after backward(), before optimizer.step()). Opt-in
 * and off by default everywhere it's wired up (trainStep, the parallel
 * training loop) -- this project's model/corpus scale hasn't needed it in
 * testing, and enabling it by default would change every existing test's
 * loss trajectory for no proven benefit. Exists for users who push the
 * learning rate higher and want the standard safety net.
 * Returns the pre-clip global norm (mostly useful for logging/debugging).
 */
export function clipGradNorm(params, maxNorm) {
  if (!maxNorm || maxNorm <= 0) return 0;
  let sumSq = 0;
  for (const p of params) {
    if (!p.grad) continue;
    for (let i = 0; i < p.grad.length; i++) sumSq += p.grad[i] * p.grad[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm > maxNorm) {
    const scale = maxNorm / (norm + 1e-6);
    for (const p of params) {
      if (!p.grad) continue;
      for (let i = 0; i < p.grad.length; i++) p.grad[i] *= scale;
    }
  }
  return norm;
}
