// tensor.js
// A small reverse-mode autograd engine over 2D (and 1D) Float32Array tensors.
// Every op below builds a node in a dynamic computation graph (parents +
// an async _backward closure); Tensor.backward() topologically sorts the
// graph and runs each node's backward closure in reverse order, exactly
// like micrograd/PyTorch's autograd -- except ops may be `await`-ed because
// matmul can round-trip to the GPU (see webgpu.js).
//
// GPU/CPU dispatch is decided once, in matmulRaw(), by a FLOP-count
// threshold: small matmuls (attention scores, per-head projections) stay on
// CPU where GPU dispatch overhead isn't worth it; large ones (the MLP and
// the vocab-sized output projection) go to the GPU when available. Either
// path produces numerically identical results -- only speed differs.

import { getBackend, getBackendSync, gpuMatmul, cpuMatmul } from "./webgpu.js";

// Matmuls below this FLOP count run on CPU even if a GPU backend exists --
// GPU buffer setup + submit + mapAsync round-trip costs more than the CPU
// loop at this scale. Measured empirically: at the demo's default model
// scale (d_model ~32-128), per-dispatch overhead (buffer alloc + submit +
// mapAsync readback) dominates until matmuls get into the low millions of
// FLOPs, so the threshold is set well above the naive "GPU is always
// faster" assumption. Tune this down if you raise the model size enough
// that individual matmuls get large (e.g. vocab or d_model in the
// thousands) and GPU buffer reuse/pooling (see BLUEPRINT.md future work) would
// pay for itself.
const GPU_FLOP_THRESHOLD = 2_000_000;

export class Tensor {
  /**
   * @param {Float32Array|number[]} data
   * @param {number[]} shape - e.g. [rows, cols] or [n] for a 1D tensor
   * @param {boolean} requiresGrad
   */
  constructor(data, shape, requiresGrad = false) {
    this.data = data instanceof Float32Array ? data : Float32Array.from(data);
    this.shape = shape;
    this.requiresGrad = requiresGrad;
    this.grad = requiresGrad ? new Float32Array(this.data.length) : null;
    this._parents = [];
    this._backward = null; // async () => void
  }

  zeroGrad() {
    if (this.grad) this.grad.fill(0);
  }

  /**
   * Kick off backward from this (scalar-ish) tensor with an all-ones (or given) upstream gradient.
   *
   * IMPORTANT: this method *accumulates* into each parameter's `.grad` buffer
   * (matching PyTorch semantics). Call `model.zeroGrad()` / `param.zeroGrad()`
   * before each backward pass, otherwise gradients from previous steps will
   * be silently added to the current ones.
   */
  async backward(gradOutput) {
    if (!this.grad) throw new Error("backward() called on a tensor that does not require grad");
    const g = gradOutput || onesLike(this.data);
    for (let i = 0; i < this.grad.length; i++) this.grad[i] += g[i];

    const topo = [];
    const visited = new Set();
    (function build(t) {
      if (visited.has(t)) return;
      visited.add(t);
      for (const p of t._parents) build(p);
      topo.push(t);
    })(this);

    for (let i = topo.length - 1; i >= 0; i--) {
      if (topo[i]._backward) await topo[i]._backward();
    }
  }
}

function onesLike(data) {
  const o = new Float32Array(data.length);
  o.fill(1);
  return o;
}

function addInPlace(dst, src) {
  for (let i = 0; i < dst.length; i++) dst[i] += src[i];
}

export function zeros(shape, requiresGrad = false) {
  const n = shape.reduce((a, b) => a * b, 1);
  return new Tensor(new Float32Array(n), shape, requiresGrad);
}

/** Simple seeded PRNG (mulberry32) so runs are reproducible when desired. */
export function makeRng(seed = 1234567) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randNormal(rng) {
  // Box-Muller
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function randTensor(shape, std, requiresGrad, rng) {
  const n = shape.reduce((a, b) => a * b, 1);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = randNormal(rng) * std;
  return new Tensor(data, shape, requiresGrad);
}

// ---------------------------------------------------------------------------
// matmul: the one op that can hit the GPU. Forward computes C = op(A) @ op(B).
// Backward derivation (Aeff = transposeA ? A^T : A, similarly Beff; C = Aeff @ Beff):
//   dAeff = dC @ Beff^T  =  matmul(dC, B_stored, transposeB = !transposeB)
//   dBeff = Aeff^T @ dC  =  matmul(A_stored, dC, transposeA = !transposeA)
// then dA = transposeA ? transpose(dAeff) : dAeff  (and symmetrically for dB),
// because if A is stored transposed, dAeff has the *effective* (untransposed)
// shape and must be transposed back to match A's actual storage shape.
// ---------------------------------------------------------------------------

async function matmulRaw(aData, aRows, aCols, bData, bRows, bCols, transposeA, transposeB) {
  const M = transposeA ? aCols : aRows;
  const K = transposeA ? aRows : aCols;
  const K2 = transposeB ? bCols : bRows;
  const N = transposeB ? bRows : bCols;
  if (K !== K2) {
    throw new Error(`matmul shape mismatch: inner dims ${K} vs ${K2}`);
  }
  const flops = M * K * N;
  let backend = null;
  if (flops > GPU_FLOP_THRESHOLD) {
    // Skip the await (and its microtask hop) once we already know the answer --
    // this function runs many times per training step, so that adds up.
    const cached = getBackendSync();
    backend = cached !== undefined ? cached : await getBackend();
  }
  let data;
  if (backend) {
    data = await gpuMatmul(backend, aData, bData, M, K, N, transposeA, transposeB);
  } else {
    data = cpuMatmul(aData, bData, M, K, N, transposeA, transposeB);
  }
  return { data, M, K, N };
}

function transpose2D(data, rows, cols) {
  const out = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out[c * rows + r] = data[r * cols + c];
    }
  }
  return out;
}

export async function matmul(a, b, transposeA = false, transposeB = false) {
  const { data, M, K, N } = await matmulRaw(
    a.data, a.shape[0], a.shape[1],
    b.data, b.shape[0], b.shape[1],
    transposeA, transposeB
  );
  const out = new Tensor(data, [M, N], a.requiresGrad || b.requiresGrad);
  out._parents = [a, b];
  out._backward = async () => {
    if (a.requiresGrad) {
      const { data: dAeff } = await matmulRaw(out.grad, M, N, b.data, b.shape[0], b.shape[1], false, !transposeB);
      const dA = transposeA ? transpose2D(dAeff, M, K) : dAeff;
      addInPlace(a.grad, dA);
    }
    if (b.requiresGrad) {
      const { data: dBeff } = await matmulRaw(a.data, a.shape[0], a.shape[1], out.grad, M, N, !transposeA, false);
      const dB = transposeB ? transpose2D(dBeff, K, N) : dBeff;
      addInPlace(b.grad, dB);
    }
  };
  return out;
}

// Linear layer convention (PyTorch-style): weight shape (outFeatures, inFeatures),
// y = x @ W^T + b.  x: (rows, inFeatures) -> y: (rows, outFeatures)
export async function linear(x, weight, bias) {
  const y = await matmul(x, weight, false, true);
  return addBias(y, bias);
}

export function addBias(x, bias) {
  const [rows, cols] = x.shape;
  const out = new Tensor(new Float32Array(x.data.length), x.shape, x.requiresGrad || bias.requiresGrad);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.data[r * cols + c] = x.data[r * cols + c] + bias.data[c];
    }
  }
  out._parents = [x, bias];
  out._backward = async () => {
    if (x.requiresGrad) addInPlace(x.grad, out.grad);
    if (bias.requiresGrad) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          bias.grad[c] += out.grad[r * cols + c];
        }
      }
    }
  };
  return out;
}

export function addElem(a, b) {
  const out = new Tensor(new Float32Array(a.data.length), a.shape, a.requiresGrad || b.requiresGrad);
  for (let i = 0; i < a.data.length; i++) out.data[i] = a.data[i] + b.data[i];
  out._parents = [a, b];
  out._backward = async () => {
    if (a.requiresGrad) addInPlace(a.grad, out.grad);
    if (b.requiresGrad) addInPlace(b.grad, out.grad);
  };
  return out;
}

export function scaleConst(x, c) {
  const out = new Tensor(new Float32Array(x.data.length), x.shape, x.requiresGrad);
  for (let i = 0; i < x.data.length; i++) out.data[i] = x.data[i] * c;
  out._parents = [x];
  out._backward = async () => {
    if (x.requiresGrad) {
      for (let i = 0; i < x.grad.length; i++) x.grad[i] += out.grad[i] * c;
    }
  };
  return out;
}

/** Adds a fixed (non-differentiable) additive tensor, e.g. a causal mask. */
export function addConst(x, constData) {
  const out = new Tensor(new Float32Array(x.data.length), x.shape, x.requiresGrad);
  for (let i = 0; i < x.data.length; i++) out.data[i] = x.data[i] + constData[i];
  out._parents = [x];
  out._backward = async () => {
    if (x.requiresGrad) addInPlace(x.grad, out.grad);
  };
  return out;
}

// tanh-approximation GELU constants (shared with model.js's geluVec, the
// plain-numeric variant used by the recurrent generation path -- see its
// import of these two below).
export const GELU_C1 = Math.sqrt(2 / Math.PI);
export const GELU_C2 = 0.044715;

export function gelu(x) {
  const out = new Tensor(new Float32Array(x.data.length), x.shape, x.requiresGrad);
  for (let i = 0; i < x.data.length; i++) {
    const v = x.data[i];
    const inner = GELU_C1 * (v + GELU_C2 * v * v * v);
    out.data[i] = 0.5 * v * (1 + Math.tanh(inner));
  }
  out._parents = [x];
  out._backward = async () => {
    if (!x.requiresGrad) return;
    for (let i = 0; i < x.data.length; i++) {
      const v = x.data[i];
      const inner = GELU_C1 * (v + GELU_C2 * v * v * v);
      const t = Math.tanh(inner);
      const dInner = GELU_C1 * (1 + 3 * GELU_C2 * v * v);
      const dtanh = (1 - t * t) * dInner;
      const dgelu = 0.5 * (1 + t) + 0.5 * v * dtanh;
      x.grad[i] += out.grad[i] * dgelu;
    }
  };
  return out;
}

/** Standard LayerNorm over the last dimension. x: (rows, D), gamma/beta: (D,) */
export function layerNorm(x, gamma, beta, eps = 1e-5) {
  const [rows, D] = x.shape;
  const out = new Tensor(new Float32Array(x.data.length), x.shape, x.requiresGrad || gamma.requiresGrad || beta.requiresGrad);
  const normalized = new Float32Array(x.data.length);
  const invstd = new Float32Array(rows);

  for (let r = 0; r < rows; r++) {
    let mean = 0;
    for (let c = 0; c < D; c++) mean += x.data[r * D + c];
    mean /= D;
    let variance = 0;
    for (let c = 0; c < D; c++) {
      const d = x.data[r * D + c] - mean;
      variance += d * d;
    }
    variance /= D;
    const is = 1 / Math.sqrt(variance + eps);
    invstd[r] = is;
    for (let c = 0; c < D; c++) {
      const y = (x.data[r * D + c] - mean) * is;
      normalized[r * D + c] = y;
      out.data[r * D + c] = y * gamma.data[c] + beta.data[c];
    }
  }

  out._parents = [x, gamma, beta];
  out._backward = async () => {
    if (gamma.requiresGrad || beta.requiresGrad) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < D; c++) {
          const dout = out.grad[r * D + c];
          if (beta.requiresGrad) beta.grad[c] += dout;
          if (gamma.requiresGrad) gamma.grad[c] += dout * normalized[r * D + c];
        }
      }
    }
    if (x.requiresGrad) {
      for (let r = 0; r < rows; r++) {
        let sumDy = 0;
        let sumDyY = 0;
        for (let c = 0; c < D; c++) {
          const dy = out.grad[r * D + c] * gamma.data[c];
          sumDy += dy;
          sumDyY += dy * normalized[r * D + c];
        }
        for (let c = 0; c < D; c++) {
          const dy = out.grad[r * D + c] * gamma.data[c];
          const y = normalized[r * D + c];
          x.grad[r * D + c] += (invstd[r] / D) * (D * dy - sumDy - y * sumDyY);
        }
      }
    }
  };
  return out;
}

/**
 * Positive feature map elu(x)+1, used by the linear-attention mixer to keep
 * "attention weights" non-negative without an exponential (that's what
 * makes the causal cumulative-sum trick below valid and O(T) instead of
 * requiring a full O(T^2) softmax).
 */
export function featureMap(x) {
  const out = new Tensor(new Float32Array(x.data.length), x.shape, x.requiresGrad);
  for (let i = 0; i < x.data.length; i++) {
    const v = x.data[i];
    out.data[i] = v > 0 ? v + 1 : Math.exp(v);
  }
  out._parents = [x];
  out._backward = async () => {
    if (!x.requiresGrad) return;
    for (let i = 0; i < x.data.length; i++) {
      const v = x.data[i];
      const dv = v > 0 ? 1 : Math.exp(v);
      x.grad[i] += out.grad[i] * dv;
    }
  };
  return out;
}

/** Elementwise multiply by a fixed (non-differentiable) array, e.g. a 0/1 causal mask. */
export function mulConst(x, constData) {
  const out = new Tensor(new Float32Array(x.data.length), x.shape, x.requiresGrad);
  for (let i = 0; i < x.data.length; i++) out.data[i] = x.data[i] * constData[i];
  out._parents = [x];
  out._backward = async () => {
    if (!x.requiresGrad) return;
    for (let i = 0; i < x.data.length; i++) x.grad[i] += out.grad[i] * constData[i];
  };
  return out;
}

/**
 * Row-wise L1 normalization: y_i = x_i / (sum_j x_j + eps). Used by the
 * linear-attention mixer in place of softmax (its "scores" are already
 * non-negative via featureMap, so a plain sum is enough to turn them into a
 * weighted average -- no max-subtraction/exp needed).
 * Backward: dx_k = g_k/s - dot(g,x)/s^2, where s = rowSum + eps.
 */
export function rowNormalize(x, eps = 1e-6) {
  const [rows, cols] = x.shape;
  const out = new Tensor(new Float32Array(x.data.length), x.shape, x.requiresGrad);
  const rowSum = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    let s = eps;
    for (let c = 0; c < cols; c++) s += x.data[r * cols + c];
    rowSum[r] = s;
    for (let c = 0; c < cols; c++) out.data[r * cols + c] = x.data[r * cols + c] / s;
  }
  out._parents = [x];
  out._backward = async () => {
    if (!x.requiresGrad) return;
    for (let r = 0; r < rows; r++) {
      const s = rowSum[r];
      let dot = 0;
      for (let c = 0; c < cols; c++) dot += out.grad[r * cols + c] * x.data[r * cols + c];
      for (let c = 0; c < cols; c++) {
        x.grad[r * cols + c] += out.grad[r * cols + c] / s - dot / (s * s);
      }
    }
  };
  return out;
}

/**
 * Row-wise L2 normalization: y_i = x_i / sqrt(sum_j x_j^2 + eps). Unlike
 * rowNormalize (L1, for the linear-attention mixer's non-negative scores),
 * this is the one that makes a vector's self dot-product equal 1 -- i.e. it
 * turns matmul(y, y, false, true) into a cosine-similarity matrix. That's
 * what the embedding model's contrastive loss needs; nothing else in this
 * engine currently uses it.
 * Backward: dx_k = (g_k - y_k*dot(g,y)) / norm, where norm = sqrt(sumSq+eps)
 * -- same derivation shape as softmaxRows below (dot of grad against the
 * OUTPUT, not the input), since both are "normalize, then the Jacobian only
 * depends on the normalized result."
 */
export function l2Normalize(x, eps = 1e-8) {
  const [rows, cols] = x.shape;
  const out = new Tensor(new Float32Array(x.data.length), x.shape, x.requiresGrad);
  const norm = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    let sumSq = 0;
    for (let c = 0; c < cols; c++) {
      const v = x.data[r * cols + c];
      sumSq += v * v;
    }
    const n = Math.sqrt(sumSq + eps);
    norm[r] = n;
    for (let c = 0; c < cols; c++) out.data[r * cols + c] = x.data[r * cols + c] / n;
  }
  out._parents = [x];
  out._backward = async () => {
    if (!x.requiresGrad) return;
    for (let r = 0; r < rows; r++) {
      let dot = 0;
      for (let c = 0; c < cols; c++) dot += out.grad[r * cols + c] * out.data[r * cols + c];
      const n = norm[r];
      for (let c = 0; c < cols; c++) {
        const y = out.data[r * cols + c];
        x.grad[r * cols + c] += (out.grad[r * cols + c] - y * dot) / n;
      }
    }
  };
  return out;
}

/** Row-wise numerically-stable softmax. x: (rows, cols) */
export function softmaxRows(x) {
  const [rows, cols] = x.shape;
  const out = new Tensor(new Float32Array(x.data.length), x.shape, x.requiresGrad);
  for (let r = 0; r < rows; r++) {
    let max = -Infinity;
    for (let c = 0; c < cols; c++) max = Math.max(max, x.data[r * cols + c]);
    let sum = 0;
    for (let c = 0; c < cols; c++) {
      const e = Math.exp(x.data[r * cols + c] - max);
      out.data[r * cols + c] = e;
      sum += e;
    }
    for (let c = 0; c < cols; c++) out.data[r * cols + c] /= sum;
  }
  out._parents = [x];
  out._backward = async () => {
    if (!x.requiresGrad) return;
    for (let r = 0; r < rows; r++) {
      let dot = 0;
      for (let c = 0; c < cols; c++) dot += out.grad[r * cols + c] * out.data[r * cols + c];
      for (let c = 0; c < cols; c++) {
        const y = out.data[r * cols + c];
        x.grad[r * cols + c] += y * (out.grad[r * cols + c] - dot);
      }
    }
  };
  return out;
}

/** Extract a contiguous submatrix x[r0:r1, c0:c1]. Differentiable. */
export function slice2D(x, r0, r1, c0, c1) {
  const cols = x.shape[1];
  const outRows = r1 - r0;
  const outCols = c1 - c0;
  const out = new Tensor(new Float32Array(outRows * outCols), [outRows, outCols], x.requiresGrad);
  for (let r = 0; r < outRows; r++) {
    for (let c = 0; c < outCols; c++) {
      out.data[r * outCols + c] = x.data[(r + r0) * cols + (c + c0)];
    }
  }
  out._parents = [x];
  out._backward = async () => {
    if (!x.requiresGrad) return;
    for (let r = 0; r < outRows; r++) {
      for (let c = 0; c < outCols; c++) {
        x.grad[(r + r0) * cols + (c + c0)] += out.grad[r * outCols + c];
      }
    }
  };
  return out;
}

/**
 * Inverse of slice2D: scatter a list of {tensor, r0, c0} pieces into a
 * fresh (rows, cols) tensor. Used to reassemble per-head attention outputs
 * back into a single (T, D) tensor.
 */
export function scatterInto(rows, cols, pieces) {
  const requiresGrad = pieces.some((p) => p.tensor.requiresGrad);
  const out = new Tensor(new Float32Array(rows * cols), [rows, cols], requiresGrad);
  for (const { tensor, r0, c0 } of pieces) {
    const [pr, pc] = tensor.shape;
    for (let r = 0; r < pr; r++) {
      for (let c = 0; c < pc; c++) {
        out.data[(r + r0) * cols + (c + c0)] = tensor.data[r * pc + c];
      }
    }
  }
  out._parents = pieces.map((p) => p.tensor);
  out._backward = async () => {
    for (const { tensor, r0, c0 } of pieces) {
      if (!tensor.requiresGrad) continue;
      const [pr, pc] = tensor.shape;
      for (let r = 0; r < pr; r++) {
        for (let c = 0; c < pc; c++) {
          tensor.grad[r * pc + c] += out.grad[(r + r0) * cols + (c + c0)];
        }
      }
    }
  };
  return out;
}

/** Gather rows of an embedding table by integer index. table: (V, D), indices: array-like of length N -> (N, D) */
export function embeddingLookup(table, indices) {
  const D = table.shape[1];
  const N = indices.length;
  const out = new Tensor(new Float32Array(N * D), [N, D], table.requiresGrad);
  for (let i = 0; i < N; i++) {
    const row = indices[i];
    out.data.set(table.data.subarray(row * D, row * D + D), i * D);
  }
  out._parents = [table];
  out._backward = async () => {
    if (!table.requiresGrad) return;
    for (let i = 0; i < N; i++) {
      const row = indices[i];
      for (let d = 0; d < D; d++) {
        table.grad[row * D + d] += out.grad[i * D + d];
      }
    }
  };
  return out;
}

/**
 * Combined log-softmax + negative-log-likelihood, mean-reduced over rows.
 * logits: (N, V) Tensor, targets: Int32Array/array of length N of class indices.
 * Returns { loss: Tensor (scalar, shape [1]), value: number }.
 */
export function crossEntropyLoss(logits, targets) {
  const [N, V] = logits.shape;
  let total = 0;
  const probs = new Float32Array(logits.data.length);
  for (let i = 0; i < N; i++) {
    let max = -Infinity;
    for (let v = 0; v < V; v++) max = Math.max(max, logits.data[i * V + v]);
    let sum = 0;
    for (let v = 0; v < V; v++) {
      const e = Math.exp(logits.data[i * V + v] - max);
      probs[i * V + v] = e;
      sum += e;
    }
    for (let v = 0; v < V; v++) probs[i * V + v] /= sum;
    const t = targets[i];
    total += -Math.log(Math.max(probs[i * V + t], 1e-9));
  }
  const meanLoss = total / N;

  const out = new Tensor(new Float32Array([meanLoss]), [1], logits.requiresGrad);
  out._parents = [logits];
  out._backward = async () => {
    if (!logits.requiresGrad) return;
    const upstream = out.grad[0];
    for (let i = 0; i < N; i++) {
      const t = targets[i];
      for (let v = 0; v < V; v++) {
        const grad = (probs[i * V + v] - (v === t ? 1 : 0)) / N;
        logits.grad[i * V + v] += grad * upstream;
      }
    }
  };
  return { loss: out, value: meanLoss };
}

/**
 * Elementwise sigmoid: y = 1/(1+exp(-x)).
 * Backward: dx = y*(1-y) * dy
 */
export function sigmoid(x) {
  const out = new Tensor(new Float32Array(x.data.length), x.shape, x.requiresGrad);
  for (let i = 0; i < x.data.length; i++) {
    out.data[i] = 1 / (1 + Math.exp(-x.data[i]));
  }
  out._parents = [x];
  out._backward = async () => {
    if (!x.requiresGrad) return;
    for (let i = 0; i < x.data.length; i++) {
      const y = out.data[i];
      x.grad[i] += out.grad[i] * y * (1 - y);
    }
  };
  return out;
}

/**
 * Elementwise expNeg: y = exp(-exp(x)).
 * RWKV time-decay parameterization: w stored in unconstrained log-log space
 * so exp(w) stays in (0,1) (decay is always a fraction, no clamping needed).
 * Backward chain rule: dy/dx = -exp(x) * exp(-exp(x)) = -exp(x) * y.
 */
export function expNeg(x) {
  const out = new Tensor(new Float32Array(x.data.length), x.shape, x.requiresGrad);
  for (let i = 0; i < x.data.length; i++) {
    out.data[i] = Math.exp(-Math.exp(x.data[i]));
  }
  out._parents = [x];
  out._backward = async () => {
    if (!x.requiresGrad) return;
    for (let i = 0; i < x.data.length; i++) {
      x.grad[i] += out.grad[i] * (-Math.exp(x.data[i])) * out.data[i];
    }
  };
  return out;
}

/**
 * Elementwise multiply of two differentiable tensors: z = a * b.
 * Unlike mulConst, both operands may require gradients.
 * dA = dZ * B, dB = dZ * A. Tensors must have the same shape.
 */
export function hadamard(a, b) {
  if (a.data.length !== b.data.length) throw new Error("hadamard: shape mismatch");
  const requiresGrad = a.requiresGrad || b.requiresGrad;
  const out = new Tensor(new Float32Array(a.data.length), a.shape, requiresGrad);
  for (let i = 0; i < a.data.length; i++) out.data[i] = a.data[i] * b.data[i];
  out._parents = [a, b];
  out._backward = async () => {
    for (let i = 0; i < a.data.length; i++) {
      if (a.requiresGrad) a.grad[i] += out.grad[i] * b.data[i];
      if (b.requiresGrad) b.grad[i] += out.grad[i] * a.data[i];
    }
  };
  return out;
}
