// webgpu.js
// Thin WebGPU backend: a single generic matmul compute shader (WGSL) that
// implements C = op(A) @ op(B), where op() optionally transposes its operand.
// Used for both the forward linear layers AND their backward gradients
// (dA = dC @ B^T, dB = A^T @ dC are just two more calls to this same kernel
// with different transpose flags -- see tensor.js).
//
// Falls back gracefully: if navigator.gpu doesn't exist (older browser, or
// Node.js during testing), initWebGPU() resolves to null and callers should
// use the CPU path (cpuMatmul below) instead.

const MATMUL_SHADER = /* wgsl */ `
struct Dims {
  M: u32,
  K: u32,
  N: u32,
  transposeA: u32,
  transposeB: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> A: array<f32>;
@group(0) @binding(2) var<storage, read> B: array<f32>;
@group(0) @binding(3) var<storage, read_write> C: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let row = gid.y;
  let col = gid.x;
  if (row >= dims.M || col >= dims.N) {
    return;
  }
  var sum: f32 = 0.0;
  for (var k: u32 = 0u; k < dims.K; k = k + 1u) {
    var aVal: f32;
    if (dims.transposeA == 1u) {
      // A is stored as (K, M): element (k, row)
      aVal = A[k * dims.M + row];
    } else {
      // A is stored as (M, K): element (row, k)
      aVal = A[row * dims.K + k];
    }
    var bVal: f32;
    if (dims.transposeB == 1u) {
      // B is stored as (N, K): element (col, k)
      bVal = B[col * dims.K + k];
    } else {
      // B is stored as (K, N): element (k, col)
      bVal = B[k * dims.N + col];
    }
    sum = sum + aVal * bVal;
  }
  C[row * dims.N + col] = sum;
}
`;

let backendPromise = null;

// Set once initWebGPU() resolves (to a backend object, or null if
// unavailable). `getBackendSync` lets the hot path (matmulRaw, called once
// or more per op, many times per training step) skip the await + microtask
// hop of `await getBackend()` once we already know the answer, since that
// answer never changes for the lifetime of the page.
let cachedBackend; // undefined until initWebGPU() resolves for the first time

// ---------------------------------------------------------------------------
// BufferPool: reuse GPUBuffers of the same size+usage across training steps.
// Each training step calls gpuMatmul many times, and each call previously
// created 5 fresh GPUBuffer objects and destroyed them afterward -- fine for
// a demo, but expensive at larger model sizes (significant GC pressure).
// The pool keeps a freelist per (size, usage) key; callers acquire before
// use and release after unmap/readback. JS is single-threaded within a
// Worker so no locking is needed.
// ---------------------------------------------------------------------------

class BufferPool {
  constructor() {
    this._free = new Map(); // key: `${size}:${usage}` -> GPUBuffer[]
  }

  /** Acquire a buffer of the given size+usage from the pool, or create one. */
  acquire(device, size, usage) {
    const key = `${size}:${usage}`;
    const list = this._free.get(key);
    if (list && list.length > 0) return list.pop();
    return device.createBuffer({ size, usage });
  }

  /** Return a buffer to the pool for reuse. */
  release(buf, size, usage) {
    const key = `${size}:${usage}`;
    let list = this._free.get(key);
    if (!list) { list = []; this._free.set(key, list); }
    list.push(buf);
  }

  /** Destroy all pooled buffers and clear the pool (call on model reinit). */
  destroy() {
    for (const list of this._free.values()) {
      for (const buf of list) buf.destroy();
    }
    this._free.clear();
  }
}

/**
 * Lazily initializes a single shared WebGPU backend (device + compiled
 * matmul pipeline + buffer pool). Returns null if WebGPU is unavailable.
 */
export function getBackend() {
  if (!backendPromise) {
    backendPromise = initWebGPU().then((backend) => {
      cachedBackend = backend;
      return backend;
    });
  }
  return backendPromise;
}

/** Synchronous peek at the resolved backend: `undefined` if getBackend() hasn't resolved yet, otherwise the backend (or null). */
export function getBackendSync() {
  return cachedBackend;
}

/**
 * Destroy all pooled GPU buffers. Call when reinitializing the model to
 * avoid leaking buffers from the previous session.
 */
export function destroyPool() {
  if (cachedBackend) cachedBackend.pool.destroy();
}

async function initWebGPU() {
  if (typeof navigator === "undefined" || !navigator.gpu) {
    return null;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    const module = device.createShaderModule({ code: MATMUL_SHADER });
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    return { device, pipeline, pool: new BufferPool() };
  } catch (err) {
    console.warn("[browser-lm] WebGPU init failed, falling back to CPU:", err);
    return null;
  }
}

/**
 * Runs C = op(A) @ op(B) on the GPU. aData/bData are Float32Array in their
 * *stored* (possibly-to-be-transposed) layout. Returns a Float32Array of
 * length M*N.
 */
export async function gpuMatmul(backend, aData, bData, M, K, N, transposeA, transposeB) {
  const { device, pipeline, pool } = backend;

  const aSize = alignSize(aData.byteLength);
  const bSize = alignSize(bData.byteLength);
  const cSize = alignSize(M * N * 4);
  const dimsData = new Uint32Array([M, K, N, transposeA ? 1 : 0, transposeB ? 1 : 0, 0, 0, 0]);
  const dimsSize = dimsData.byteLength;

  const aBuf = pool.acquire(device, aSize, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  device.queue.writeBuffer(aBuf, 0, aData);

  const bBuf = pool.acquire(device, bSize, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  device.queue.writeBuffer(bBuf, 0, bData);

  const cBuf = pool.acquire(device, cSize, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);

  const dimsBuf = pool.acquire(device, dimsSize, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  device.queue.writeBuffer(dimsBuf, 0, dimsData);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: dimsBuf } },
      { binding: 1, resource: { buffer: aBuf } },
      { binding: 2, resource: { buffer: bBuf } },
      { binding: 3, resource: { buffer: cBuf } },
    ],
  });

  const readBuf = pool.acquire(device, cSize, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(N / 8), Math.ceil(M / 8), 1);
  pass.end();
  encoder.copyBufferToBuffer(cBuf, 0, readBuf, 0, cSize);
  device.queue.submit([encoder.finish()]);

  await readBuf.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(readBuf.getMappedRange().slice(0, M * N * 4));
  readBuf.unmap();

  // Return all buffers to the pool for reuse next step instead of destroying.
  pool.release(aBuf, aSize, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  pool.release(bBuf, bSize, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  pool.release(cBuf, cSize, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  pool.release(dimsBuf, dimsSize, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  pool.release(readBuf, cSize, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);

  return result;
}

function alignSize(bytes) {
  // WebGPU buffer sizes must be multiples of 4; keep it simple and safe.
  return Math.max(4, Math.ceil(bytes / 4) * 4);
}

/**
 * CPU reference implementation of the exact same operation as the WGSL
 * kernel above. Used as the fallback backend, and as the ground truth that
 * the GPU kernel is checked against in tests.
 */
export function cpuMatmul(aData, bData, M, K, N, transposeA, transposeB) {
  const out = new Float32Array(M * N);
  for (let row = 0; row < M; row++) {
    for (let col = 0; col < N; col++) {
      let sum = 0;
      for (let k = 0; k < K; k++) {
        const aVal = transposeA ? aData[k * M + row] : aData[row * K + k];
        const bVal = transposeB ? bData[col * K + k] : bData[k * N + col];
        sum += aVal * bVal;
      }
      out[row * N + col] = sum;
    }
  }
  return out;
}
