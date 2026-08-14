// Named local-model persistence dispatcher — same guest/real split as
// lib/chatStore.ts and lib/vfs.ts. Guests keep the existing IndexedDB
// registry (lib/modelRegistry.ts, unchanged); real accounts get
// supabase/schema.sql's local_models table for metadata plus the
// "model-weights" Storage bucket for the actual weight bytes (Postgres
// rows aren't a great fit for multi-MB binary blobs even as bytea).
//
// All param tensors are Float32Array (see src/bnlm/tensor.js's Tensor
// class) — the Supabase backend concatenates every param's raw bytes into
// one blob on save and re-splits it using param_shapes (4 bytes/element)
// on load, exactly mirroring what lib/localModel.ts's loadSaved() already
// does param-by-param against the IndexedDB version.

import { supabase, isSupabaseConfigured } from './supabaseClient';
import { modelRegistry, SavedModelMeta, SavedModelRecord } from './modelRegistry';

export type { SavedModelMeta, SavedModelRecord };

const WEIGHTS_BUCKET = 'model-weights';

function isGuestId(userId: string): boolean {
  return !isSupabaseConfigured || userId.startsWith('guest-') || userId === 'guest';
}

function weightsPath(userId: string, name: string): string {
  return `${userId}/${name}.bin`;
}

function concatBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const total = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const buf of buffers) {
    combined.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return combined.buffer;
}

function splitBuffer(combined: ArrayBuffer, paramShapes: number[][]): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  let offset = 0;
  for (const shape of paramShapes) {
    const count = shape.reduce((a, b) => a * b, 1);
    const byteLength = count * Float32Array.BYTES_PER_ELEMENT;
    buffers.push(combined.slice(offset, offset + byteLength));
    offset += byteLength;
  }
  return buffers;
}

const supabaseBackend = {
  async list(userId: string): Promise<SavedModelMeta[]> {
    const { data, error } = await supabase!
      .from('local_models')
      .select('name,created_at,config,vocab_size,param_count')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(r => ({
      name: r.name,
      savedAt: r.created_at,
      config: r.config,
      vocabSize: r.vocab_size,
      paramCount: r.param_count,
    }));
  },

  async save(userId: string, record: SavedModelRecord): Promise<void> {
    const path = weightsPath(userId, record.name);
    const { error: uploadErr } = await supabase!.storage
      .from(WEIGHTS_BUCKET)
      .upload(path, concatBuffers(record.paramBuffers), { contentType: 'application/octet-stream', upsert: true });
    if (uploadErr) throw uploadErr;

    const { error: dbErr } = await supabase!.from('local_models').upsert(
      {
        user_id: userId,
        name: record.name,
        config: record.config,
        vocab_chars: record.vocabChars,
        corpus_text: record.corpusText,
        vocab_size: record.vocabSize,
        param_count: record.paramCount,
        param_shapes: record.paramShapes,
        weights_storage_path: path,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,name' }
    );
    if (dbErr) throw dbErr;
  },

  async load(userId: string, name: string): Promise<SavedModelRecord | undefined> {
    const { data: row, error } = await supabase!
      .from('local_models')
      .select('name,created_at,config,vocab_size,param_count,vocab_chars,corpus_text,param_shapes,weights_storage_path')
      .eq('user_id', userId)
      .eq('name', name)
      .maybeSingle();
    if (error) throw error;
    if (!row) return undefined;

    const { data: blob, error: downloadErr } = await supabase!.storage.from(WEIGHTS_BUCKET).download(row.weights_storage_path);
    if (downloadErr) throw downloadErr;
    const combined = await blob.arrayBuffer();

    return {
      name: row.name,
      savedAt: row.created_at,
      config: row.config,
      vocabSize: row.vocab_size,
      paramCount: row.param_count,
      vocabChars: row.vocab_chars,
      corpusText: row.corpus_text,
      paramShapes: row.param_shapes,
      paramBuffers: splitBuffer(combined, row.param_shapes),
    };
  },

  async remove(userId: string, name: string): Promise<void> {
    await supabase!.storage.from(WEIGHTS_BUCKET).remove([weightsPath(userId, name)]);
    const { error } = await supabase!.from('local_models').delete().eq('user_id', userId).eq('name', name);
    if (error) throw error;
  },
};

export const modelStore = {
  list(userId: string): Promise<SavedModelMeta[]> {
    return isGuestId(userId) ? modelRegistry.list() : supabaseBackend.list(userId);
  },
  save(userId: string, record: SavedModelRecord): Promise<void> {
    return isGuestId(userId) ? modelRegistry.save(record) : supabaseBackend.save(userId, record);
  },
  load(userId: string, name: string): Promise<SavedModelRecord | undefined> {
    return isGuestId(userId) ? modelRegistry.load(name) : supabaseBackend.load(userId, name);
  },
  remove(userId: string, name: string): Promise<void> {
    return isGuestId(userId) ? modelRegistry.remove(name) : supabaseBackend.remove(userId, name);
  },
};
