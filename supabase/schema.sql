-- Kernos + BNLM — Supabase schema for the planned auth/persistence migration.
--
-- NOT WIRED UP YET. Nothing in the app reads or writes this today — every
-- piece of state currently lives in the browser (localStorage/IndexedDB),
-- scoped to a single "guest" identity (see App.tsx's enterDesktop()). This
-- file is the concrete target for when that changes: each table below maps
-- 1:1 to an existing browser-storage module, so the migration is "swap the
-- implementation behind an existing interface," not a redesign.
--
--   auth.users (built into Supabase)  -> replaces the guest-identity stub
--   profiles                          -> minimal per-user metadata
--   conversations + messages          -> lib/chatStore.ts (localStorage)
--   vfs_nodes                         -> lib/vfs.ts (localStorage)
--   local_models                      -> lib/modelRegistry.ts (IndexedDB)
--   embeddings                        -> revives the GraphRAG/vector-memory
--                                        cut from the original design (see
--                                        ARCHITECTURE.md) — optional, only
--                                        needed if that comes back
--
-- Run this in the Supabase SQL editor on a fresh project. Every table has
-- Row Level Security enabled with a policy scoping it to auth.uid() —
-- required before you ever query these with the anon key from the browser,
-- since Supabase's client-side SDK talks to Postgres directly through
-- PostgREST rather than through your own API layer.

-- ─── profiles ────────────────────────────────────────────────────────────
-- One row per auth.users row. Supabase Auth owns email/password/OAuth;
-- this just holds the app-facing display fields (avatar_url mirrors the
-- dicebear-generated one App.tsx currently makes up for guests).

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "profiles: read own" on profiles
  for select using (auth.uid() = id);
create policy "profiles: update own" on profiles
  for update using (auth.uid() = id);

-- Auto-create a profile row whenever a new auth.users row appears.
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username, avatar_url)
  values (new.id, coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)), null);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();


-- ─── conversations + messages ───────────────────────────────────────────
-- Replaces lib/chatStore.ts's StoredConversation. Normalized into two
-- tables (rather than one JSONB blob column) so message history is
-- queryable/paginatable/searchable later — chatStore.ts's flat array was
-- fine for localStorage, not for a growing multi-conversation history.

create table if not exists conversations (
  id text primary key,               -- matches the client-generated "chat-<ts>-<rand>" id scheme
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New Chat',
  agent_id text not null default 'agent-chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_user_id_idx on conversations(user_id);

alter table conversations enable row level security;

create policy "conversations: crud own" on conversations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id text not null references conversations(id) on delete cascade,
  role text not null check (role in ('user', 'agent')),
  content text not null,
  thinking text,                     -- extracted <think> block, if any (see apps/AIChat.tsx's extractThinking)
  agent_id text,                     -- which persona replied (or 'bnlm-local' for a tool-call result)
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_id_idx on messages(conversation_id, created_at);

alter table messages enable row level security;

create policy "messages: crud via owned conversation" on messages
  for all using (
    exists (select 1 from conversations c where c.id = messages.conversation_id and c.user_id = auth.uid())
  ) with check (
    exists (select 1 from conversations c where c.id = messages.conversation_id and c.user_id = auth.uid())
  );


-- ─── vfs_nodes ───────────────────────────────────────────────────────────
-- Replaces lib/vfs.ts's FileNode tree. `children` isn't stored directly
-- (unlike the localStorage version) — it's derived by querying
-- `parent_id`, which is the actually-normalized way to represent a tree
-- in a relational table.

create table if not exists vfs_nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  parent_id uuid references vfs_nodes(id) on delete cascade,
  name text not null,
  type text not null check (type in ('file', 'directory')),
  content text,                      -- null for directories
  mount_source text,                 -- reserved: matches types.ts's FileNode.mountSource, unused today
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vfs_nodes_user_parent_idx on vfs_nodes(user_id, parent_id);

alter table vfs_nodes enable row level security;

create policy "vfs_nodes: crud own" on vfs_nodes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ─── local_models ────────────────────────────────────────────────────────
-- Replaces lib/modelRegistry.ts (currently IndexedDB). Weight buffers are
-- binary and can run past what's comfortable in a Postgres row even as
-- bytea — store them in Supabase Storage instead (bucket: "model-weights",
-- path convention below) and keep only the pointer + metadata here.
-- param_shapes is required to split the single concatenated weights blob
-- back into per-tensor Float32Arrays on load (mirrors what
-- lib/localModel.ts's loadSaved() does today, param-by-param).

create table if not exists local_models (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  config jsonb not null,             -- LocalModelConfig: dModel/numLayers/numHeads/contextLen/mixerType/lr/batchSize/numWorkers
  vocab_chars text not null,         -- itos.join('') — rebuilds an identical CharTokenizer
  corpus_text text not null,         -- retained so training can resume after load
  vocab_size int not null,
  param_count int not null,
  param_shapes jsonb not null,       -- number[][], one shape per model.parameters() entry, in order
  weights_storage_path text not null, -- Storage object path, e.g. "{user_id}/{id}.bin" in the "model-weights" bucket
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table local_models enable row level security;

create policy "local_models: crud own" on local_models
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Storage bucket + policy for the actual weight blobs. Run separately if
-- your project's SQL editor doesn't have storage.* access — otherwise this
-- works inline.
insert into storage.buckets (id, name, public)
values ('model-weights', 'model-weights', false)
on conflict (id) do nothing;

create policy "model-weights: crud own folder" on storage.objects
  for all using (bucket_id = 'model-weights' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'model-weights' and (storage.foldername(name))[1] = auth.uid()::text);


-- ─── embeddings (optional, future) ──────────────────────────────────────
-- Only needed if the GraphRAG/vector-memory cut (see ARCHITECTURE.md) ever
-- comes back. Requires the pgvector extension, which Supabase ships with —
-- just needs enabling once per project.

create extension if not exists vector;

create table if not exists embeddings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null,         -- e.g. 'vfs_node', 'message'
  source_id text not null,
  content text not null,
  embedding vector(1536),            -- dimension depends on whatever embedding model you pick
  created_at timestamptz not null default now()
);

create index if not exists embeddings_user_id_idx on embeddings(user_id);
-- IVFFlat index for approximate nearest-neighbor search — build only once
-- you have a meaningful number of rows (it needs data to train on):
-- create index embeddings_vector_idx on embeddings using ivfflat (embedding vector_cosine_ops);

alter table embeddings enable row level security;

create policy "embeddings: crud own" on embeddings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
