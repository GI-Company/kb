// Chat history persistence — localStorage-backed for v1 (single-user, no
// account system). Swap point: this is the one file that would change to
// route through Supabase Postgres once real accounts exist; nothing that
// calls chatStore needs to know which backend it is.

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

const STORAGE_KEY = 'kernos_chats_v1';

function readAll(): Record<string, StoredConversation> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, StoredConversation>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage full or unavailable — conversation just won't persist this time.
  }
}

export const chatStore = {
  list(userId: string): ConversationMeta[] {
    const all = readAll();
    return Object.values(all)
      .filter(c => c.user_id === userId)
      .map(({ id, title, agent_id, updated_at }) => ({ id, title, agent_id, updated_at }))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  },

  save(conv: Omit<StoredConversation, 'updated_at'>): void {
    const all = readAll();
    all[conv.id] = { ...conv, updated_at: new Date().toISOString() };
    writeAll(all);
  },

  load(id: string): StoredConversation | undefined {
    return readAll()[id];
  },

  delete(id: string): void {
    const all = readAll();
    delete all[id];
    writeAll(all);
  },
};
