// Chat history persistence — routes to Supabase Postgres for real accounts,
// localStorage for guests. The discriminator is the user id's shape:
// lib/auth.ts's createGuestUser() always produces "guest-xxxx" ids, real
// Supabase auth user ids are UUIDs and never take that form, so callers
// don't need to separately track/pass which backend to use.
//
// The interface stays async either way (Supabase calls are inherently
// async; localStorage isn't, but the shared shape means every caller —
// just services/kernel.ts's handleChatHistory today — doesn't need two
// code paths).

import { supabase, isSupabaseConfigured } from './supabaseClient';

export interface StoredConversation {
  id: string;
  user_id: string;
  title: string;
  agent_id: string;
  messages: unknown[];
  updated_at: string;
}

export interface ConversationMeta {
  id: string;
  title: string;
  agent_id: string;
  updated_at: string;
}

/** Aggregate counts for apps/SystemMetrics.tsx — avoids load()ing every conversation just to total its messages. */
export interface ChatStats {
  conversationCount: number;
  messageCount: number;
}

interface ChatMessageLike {
  id?: string;
  role: 'user' | 'agent';
  content: string;
  thinking?: string;
  agentId?: string;
  time?: string;
}

function isGuestId(userId: string): boolean {
  return !isSupabaseConfigured || userId.startsWith('guest-') || userId === 'guest';
}

// ── localStorage backend (guests) ──────────────────────────────────────

const STORAGE_KEY = 'kernos_chats_v1';

function readAllLocal(): Record<string, StoredConversation> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeAllLocal(data: Record<string, StoredConversation>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage full or unavailable — conversation just won't persist this time.
  }
}

const localBackend = {
  async list(userId: string): Promise<ConversationMeta[]> {
    const all = readAllLocal();
    return Object.values(all)
      .filter(c => c.user_id === userId)
      .map(({ id, title, agent_id, updated_at }) => ({ id, title, agent_id, updated_at }))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  },

  async save(conv: Omit<StoredConversation, 'updated_at'>): Promise<void> {
    const all = readAllLocal();
    all[conv.id] = { ...conv, updated_at: new Date().toISOString() };
    writeAllLocal(all);
  },

  async load(id: string): Promise<StoredConversation | undefined> {
    return readAllLocal()[id];
  },

  async delete(id: string): Promise<void> {
    const all = readAllLocal();
    delete all[id];
    writeAllLocal(all);
  },

  async stat(userId: string): Promise<ChatStats> {
    const mine = Object.values(readAllLocal()).filter(c => c.user_id === userId);
    return {
      conversationCount: mine.length,
      messageCount: mine.reduce((sum, c) => sum + (c.messages?.length ?? 0), 0),
    };
  },
};

// ── Supabase backend (real accounts) ───────────────────────────────────
// See supabase/schema.sql's conversations/messages tables. Messages are
// replaced wholesale on every save (delete + reinsert) rather than
// diffed — matches the localStorage version's own "save the whole array"
// simplicity; AIChat.tsx already debounces saves rather than writing per
// keystroke, so this isn't a hot path. ChatMessage.time is a
// toLocaleTimeString() *display* string, not a real timestamp, so
// created_at is synthesized (base time + index ms) purely to preserve
// message order — it's never read back as wall-clock time, only used to
// ORDER BY correctly, and load() reconstructs a fresh display string from it.

const supabaseBackend = {
  async list(userId: string): Promise<ConversationMeta[]> {
    const { data, error } = await supabase!
      .from('conversations')
      .select('id,title,agent_id,updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
  },

  async save(conv: Omit<StoredConversation, 'updated_at'>): Promise<void> {
    const updated_at = new Date().toISOString();
    const { error: convErr } = await supabase!
      .from('conversations')
      .upsert({ id: conv.id, user_id: conv.user_id, title: conv.title, agent_id: conv.agent_id, updated_at });
    if (convErr) throw convErr;

    const { error: delErr } = await supabase!.from('messages').delete().eq('conversation_id', conv.id);
    if (delErr) throw delErr;

    const messages = conv.messages as ChatMessageLike[];
    if (messages.length > 0) {
      const base = Date.now();
      const rows = messages.map((m, i) => ({
        conversation_id: conv.id,
        role: m.role,
        content: m.content,
        thinking: m.thinking ?? null,
        agent_id: m.agentId ?? null,
        created_at: new Date(base + i).toISOString(),
      }));
      const { error: insErr } = await supabase!.from('messages').insert(rows);
      if (insErr) throw insErr;
    }
  },

  async load(id: string): Promise<StoredConversation | undefined> {
    const { data: conv, error: convErr } = await supabase!
      .from('conversations')
      .select('id,user_id,title,agent_id,updated_at')
      .eq('id', id)
      .maybeSingle();
    if (convErr) throw convErr;
    if (!conv) return undefined;

    const { data: msgRows, error: msgErr } = await supabase!
      .from('messages')
      .select('role,content,thinking,agent_id,created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true });
    if (msgErr) throw msgErr;

    const messages: ChatMessageLike[] = (msgRows ?? []).map((r, i) => ({
      id: `${id}-${i}`,
      role: r.role,
      content: r.content,
      thinking: r.thinking ?? undefined,
      agentId: r.agent_id ?? undefined,
      time: new Date(r.created_at).toLocaleTimeString(),
    }));

    return { ...conv, messages };
  },

  async delete(id: string): Promise<void> {
    // messages cascade via the FK's `on delete cascade` in supabase/schema.sql
    const { error } = await supabase!.from('conversations').delete().eq('id', id);
    if (error) throw error;
  },

  // Two count-only queries (head: true fetches no rows) rather than
  // load()ing every conversation with its full message array.
  async stat(userId: string): Promise<ChatStats> {
    const { data: convIds, error: convErr } = await supabase!
      .from('conversations')
      .select('id')
      .eq('user_id', userId);
    if (convErr) throw convErr;

    const ids = (convIds ?? []).map(c => c.id);
    if (ids.length === 0) return { conversationCount: 0, messageCount: 0 };

    const { count, error: msgErr } = await supabase!
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .in('conversation_id', ids);
    if (msgErr) throw msgErr;

    return { conversationCount: ids.length, messageCount: count ?? 0 };
  },
};

export const chatStore = {
  list(userId: string): Promise<ConversationMeta[]> {
    return (isGuestId(userId) ? localBackend : supabaseBackend).list(userId);
  },
  save(conv: Omit<StoredConversation, 'updated_at'>): Promise<void> {
    return (isGuestId(conv.user_id) ? localBackend : supabaseBackend).save(conv);
  },
  load(id: string, userId: string): Promise<StoredConversation | undefined> {
    return (isGuestId(userId) ? localBackend : supabaseBackend).load(id);
  },
  delete(id: string, userId: string): Promise<void> {
    return (isGuestId(userId) ? localBackend : supabaseBackend).delete(id);
  },
  stat(userId: string): Promise<ChatStats> {
    return (isGuestId(userId) ? localBackend : supabaseBackend).stat(userId);
  },
};
