// src/quantize.js
// Post-training int8 symmetric quantization for inference.

import { BNLM } from "./model.js";

// Symmetric per-row quantization
function quantizeTensor(tensor) {
  const [rows, cols] = tensor.shape.length === 2 ? tensor.shape : [1, tensor.data.length];
  const qdata = new Int8Array(rows * cols);
  const scales = new Float32Array(rows);
  
  for (let r = 0; r < rows; r++) {
    let maxAbs = 0;
    const rowStart = r * cols;
    for (let c = 0; c < cols; c++) {
      const val = Math.abs(tensor.data[rowStart + c]);
      if (val > maxAbs) maxAbs = val;
    }
    const scale = maxAbs / 127;
    scales[r] = scale;
    if (scale === 0) continue; // all zeros
    
    for (let c = 0; c < cols; c++) {
      qdata[rowStart + c] = Math.round(tensor.data[rowStart + c] / scale);
    }
  }
  return { qdata, scales, shape: tensor.shape };
}

function dequantizeTensor(qtensor, outBuffer) {
  const [rows, cols] = qtensor.shape.length === 2 ? qtensor.shape : [1, qtensor.qdata.length];
  for (let r = 0; r < rows; r++) {
    const scale = qtensor.scales[r];
    const rowStart = r * cols;
    for (let c = 0; c < cols; c++) {
      outBuffer[rowStart + c] = qtensor.qdata[rowStart + c] * scale;
    }
  }
}

// Just copy non-quantized weights (like layerNorm params, small biases)
function copyTensor(tensor) {
  return { data: new Float32Array(tensor.data), shape: tensor.shape };
}

export function quantizeModel(model) {
  const qlayers = model.layers.map(layer => {
    const qlayer = {};
    for (const [k, v] of Object.entries(layer)) {
      if (k === 'Wq' || k === 'Wk' || k === 'Wv' || k === 'Wo' || k === 'Wr' || k === 'w' || k === 'u' || k === 'W1' || k === 'W2') {
        qlayer[k] = quantizeTensor(v);
      } else {
        qlayer[k] = copyTensor(v);
      }
    }
    return qlayer;
  });
  
  const qdict = {
    vocabSize: model.vocabSize,
    config: {
      dModel: model.dModel,
      numLayers: model.layers.length,
      numHeads: model.numHeads,
      mlpRatio: (model.layers[0].W1.shape[0] / model.dModel) || 4,
      mixerType: model.mixerType,
      contextLen: model.contextLen
    },
    tokEmb: quantizeTensor(model.tokEmb),
    posEmb: model.posEmb ? quantizeTensor(model.posEmb) : null,
    lnfg: copyTensor(model.lnfg),
    lnfb: copyTensor(model.lnfb),
    layers: qlayers,
  };
  return new QuantizedModel(qdict);
}

export class QuantizedModel {
  constructor(qdict) {
    this.qdict = qdict;
    this.vocabSize = qdict.vocabSize;
    this.config = qdict.config;
    this.dModel = qdict.config.dModel;
    this.numLayers = qdict.config.numLayers;
    this.numHeads = qdict.config.numHeads;
    this.headDim = this.dModel / this.numHeads;
    const dHidden = this.dModel * (this.config.mlpRatio || 4);
    
    // Allocate workspace per layer for dequantizing weights without reallocating
    this.layerWorkspaces = Array.from({ length: this.numLayers }, () => ({
      Wq: new Float32Array(this.dModel * this.dModel),
      Wk: new Float32Array(this.dModel * this.dModel),
      Wv: new Float32Array(this.dModel * this.dModel),
      Wo: new Float32Array(this.dModel * this.dModel),
      Wr: new Float32Array(this.dModel * this.dModel),
      w: new Float32Array(this.dModel),
      u: new Float32Array(this.dModel),
      W1: new Float32Array(this.dModel * dHidden),
      W2: new Float32Array(this.dModel * dHidden),
    }));
  }
  
  // Expose same inference methods. We only support recurrent inference.
  createEmptyState() {
    if (this.config.mixerType === "attention") {
      throw new Error("Quantized attention generation not supported.");
    } else if (this.config.mixerType === "linear") {
      return this.qdict.layers.map(() => 
        Array.from({ length: this.numHeads }, () => ({
          S: new Float32Array(this.headDim * this.headDim),
          z: new Float32Array(this.headDim),
        }))
      );
    } else if (this.config.mixerType === "rwkv") {
      return this.qdict.layers.map(() => ({
        x_prev: new Float32Array(this.dModel),
        num: new Float32Array(this.dModel),
        den: new Float32Array(this.dModel),
        max: new Float32Array(this.dModel).fill(-Infinity),
      }));
    }
  }

  getRecurrentState() {
    if (!this._currentState) {
      this._currentState = this.createEmptyState();
    }
    return this._currentState;
  }

  setRecurrentState(state) {
    this._currentState = state;
  }

  generate(promptIds, maxNewTokens = 50, opts = {}) {
    if (this.config.mixerType === "linear") {
      return BNLM.prototype.generateRecurrent.call(this, promptIds, maxNewTokens, opts);
    } else if (this.config.mixerType === "rwkv") {
      return BNLM.prototype.generateRecurrentRWKV.call(this, promptIds, maxNewTokens, opts);
    } else {
      throw new Error("Quantized attention generation not supported.");
    }
  }
  
  stepRecurrentToken(tokenId, state) {
    return this.stepToken(tokenId, state);
  }

  stepToken(tokenId, state) {
    const x = new Float32Array(this.dModel);
    const scale = this.qdict.tokEmb.scales[tokenId];
    const rowStart = tokenId * this.dModel;
    for (let d = 0; d < this.dModel; d++) {
      x[d] = this.qdict.tokEmb.qdata[rowStart + d] * scale;
    }
    
    const mockModel = {
      dModel: this.dModel,
      numLayers: this.numLayers,
      numHeads: this.numHeads,
      headDim: this.headDim,
      vocabSize: this.vocabSize,
      tokEmb: { data: new Float32Array(this.vocabSize * this.dModel) },
      layers: this.qdict.layers.map((qlayer, l) => {
        const layer = {};
        const ws = this.layerWorkspaces[l];
        for (const [k, v] of Object.entries(qlayer)) {
          if (v.qdata) {
            if (ws[k]) {
              dequantizeTensor(v, ws[k]);
              layer[k] = { data: ws[k], shape: v.shape };
            } else {
              const tmp = new Float32Array(v.qdata.length);
              dequantizeTensor(v, tmp);
              layer[k] = { data: tmp, shape: v.shape };
            }
          } else {
            layer[k] = v;
          }
        }
        return layer;
      }),
      lnfg: this.qdict.lnfg,
      lnfb: this.qdict.lnfb,
      linearMixerStep: BNLM.prototype.linearMixerStep,
      rwkvMixerStep: BNLM.prototype.rwkvMixerStep,
      stepToken: BNLM.prototype.stepToken,
      stepTokenRWKV: BNLM.prototype.stepTokenRWKV,
    };
    
    dequantizeTensor(this.qdict.tokEmb, mockModel.tokEmb.data);
    
    if (this.config.mixerType === "linear") {
      return mockModel.stepToken(tokenId, state);
    } else if (this.config.mixerType === "rwkv") {
      return mockModel.stepTokenRWKV(tokenId, state);
    }
  }
}

export function serializeQuantized(qmodel) {
  const buffers = [];
  let totalLen = 0;
  
  const meta = { version: 1, vocabSize: qmodel.vocabSize, config: qmodel.config, tensors: {} };
  
  function addTensor(name, obj) {
    if (!obj) return;
    if (obj.qdata) {
      meta.tensors[name] = { type: 'q8', shape: obj.shape, qdataLen: obj.qdata.length, scalesLen: obj.scales.length };
      buffers.push(obj.qdata.buffer);
      buffers.push(obj.scales.buffer);
      totalLen += obj.qdata.byteLength + obj.scales.byteLength;
    } else {
      meta.tensors[name] = { type: 'f32', shape: obj.shape, dataLen: obj.data.length };
      buffers.push(obj.data.buffer);
      totalLen += obj.data.byteLength;
    }
  }
  
  addTensor('tokEmb', qmodel.qdict.tokEmb);
  addTensor('posEmb', qmodel.qdict.posEmb);
  addTensor('lnfg', qmodel.qdict.lnfg);
  addTensor('lnfb', qmodel.qdict.lnfb);
  for (let l = 0; l < qmodel.numLayers; l++) {
    for (const [k, v] of Object.entries(qmodel.qdict.layers[l])) {
      addTensor(`layer_${l}_${k}`, v);
    }
  }
  
  const metaStr = JSON.stringify(meta);
  const metaBytes = new TextEncoder().encode(metaStr);
  const header = new Int32Array([0x514C4D31, metaBytes.length]); // QLM1
  totalLen += header.byteLength + metaBytes.byteLength;
  
  const out = new Uint8Array(totalLen);
  out.set(new Uint8Array(header.buffer), 0);
  out.set(metaBytes, header.byteLength);
  
  let offset = header.byteLength + metaBytes.byteLength;
  for (const b of buffers) {
    const u8 = new Uint8Array(b);
    out.set(u8, offset);
    offset += u8.byteLength;
  }
  
  return out.buffer;
}

export function deserializeQuantized(buffer) {
  const i32 = new Int32Array(buffer, 0, 2);
  if (i32[0] !== 0x514C4D31) throw new Error("Invalid magic number");
  const metaLen = i32[1];
  
  const metaBytes = new Uint8Array(buffer, 8, metaLen);
  const metaStr = new TextDecoder().decode(metaBytes);
  const meta = JSON.parse(metaStr);
  
  let offset = 8 + metaLen;
  
  function readTensor(info) {
    if (info.type === 'q8') {
      const qdata = new Int8Array(buffer, offset, info.qdataLen);
      offset += info.qdataLen;
      const scales = new Float32Array(buffer.slice(offset, offset + info.scalesLen * 4));
      offset += info.scalesLen * 4;
      return { qdata, scales, shape: info.shape };
    } else {
      const data = new Float32Array(buffer.slice(offset, offset + info.dataLen * 4));
      offset += info.dataLen * 4;
      return { data, shape: info.shape };
    }
  }
  
  const qdict = {
    vocabSize: meta.vocabSize,
    config: meta.config,
    layers: Array(meta.config.numLayers).fill(0).map(() => ({})),
    posEmb: null,
  };
  
  for (const [name, info] of Object.entries(meta.tensors)) {
    const tensor = readTensor(info);
    if (name.startsWith('layer_')) {
      const parts = name.split('_');
      const l = parseInt(parts[1]);
      const k = parts.slice(2).join('_');
      qdict.layers[l][k] = tensor;
    } else {
      qdict[name] = tensor;
    }
  }
  
  return new QuantizedModel(qdict);
}
