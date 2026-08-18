-- Kernos + BNLM — Supabase schema backing the auth/persistence layer.
--
-- Wired up: every table below is live. Real (non-guest) accounts read and
-- write through it; guests keep using the original browser-only storage
-- (localStorage/IndexedDB) so the app still works with zero Supabase config.
-- The dispatcher for each concern picks a backend by the user id's shape
-- (see e.g. lib/chatStore.ts's isGuestId) — guest ids always look like
-- "guest-xxxx", real ones are auth.users UUIDs.
--
--   auth.users (built into Supabase)  -> real account identity
--   profiles                          -> minimal per-user metadata
--   conversations + messages          -> lib/chatStore.ts
--   vfs_nodes                         -> lib/vfs.ts
--   local_models (+ Storage bucket)   -> lib/modelStore.ts
--   guest_usage                       -> api/guest-usage.ts's 15-min/day/IP
--                                        quota — server-only, no RLS policy,
--                                        never queried from the browser
--   embeddings                        -> revives the GraphRAG/vector-memory
--                                        cut from the original design (see
--                                        ARCHITECTURE.md) — optional, only
--                                        needed if that comes back; nothing
--                                        reads/writes it yet
--
-- Run this in the Supabase SQL editor — safe to re-run any time (tables use
-- if-not-exists, functions/triggers use or-replace, and every policy is
-- dropped-if-exists immediately before being recreated, since Postgres has
-- no CREATE POLICY IF NOT EXISTS). Every table except guest_usage has Row Level
-- Security enabled with a policy scoping it to auth.uid() — required before
-- you ever query these with the anon key from the browser, since Supabase's
-- client-side SDK talks to Postgres directly through PostgREST rather than
-- through your own API layer. guest_usage deliberately has RLS on with NO
-- policy (zero access via the anon/authenticated roles) since it's only
-- ever touched server-side with the service-role key — see
-- lib/supabaseAdmin.ts and its required SUPABASE_SERVICE_ROLE_KEY env var.

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

drop policy if exists "profiles: read own" on profiles;
create policy "profiles: read own" on profiles
  for select using (auth.uid() = id);
drop policy if exists "profiles: update own" on profiles;
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

drop trigger if exists on_auth_user_created on auth.users;
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

drop policy if exists "conversations: crud own" on conversations;
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

drop policy if exists "messages: crud via owned conversation" on messages;
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
  encoding text,                     -- 'base64' for binary content (curl -O/wget downloads); null = plain text
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- `create table if not exists` above doesn't add columns to an
-- already-deployed table, so a column added after the first deploy (this
-- one) needs its own idempotent statement to keep the file's "safe to
-- re-run any time" promise true for databases that already have vfs_nodes.
alter table vfs_nodes add column if not exists encoding text;

create index if not exists vfs_nodes_user_parent_idx on vfs_nodes(user_id, parent_id);

alter table vfs_nodes enable row level security;

drop policy if exists "vfs_nodes: crud own" on vfs_nodes;
create policy "vfs_nodes: crud own" on vfs_nodes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ─── local_models ────────────────────────────────────────────────────────
-- Real-account backend for lib/modelStore.ts (guests still use
-- lib/modelRegistry.ts's IndexedDB directly). Weight buffers are binary and
-- can run past what's comfortable in a Postgres row even as bytea — stored
-- in Supabase Storage instead (bucket: "model-weights", path convention
-- below), keeping only the pointer + metadata here. param_shapes is what
-- lib/modelStore.ts uses to split the single concatenated weights blob
-- back into per-tensor Float32Arrays on load.

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

drop policy if exists "local_models: crud own" on local_models;
create policy "local_models: crud own" on local_models
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Storage bucket + policy for the actual weight blobs. Run separately if
-- your project's SQL editor doesn't have storage.* access — otherwise this
-- works inline.
insert into storage.buckets (id, name, public)
values ('model-weights', 'model-weights', false)
on conflict (id) do nothing;

drop policy if exists "model-weights: crud own folder" on storage.objects;
create policy "model-weights: crud own folder" on storage.objects
  for all using (bucket_id = 'model-weights' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'model-weights' and (storage.foldername(name))[1] = auth.uid()::text);


-- ─── guest_usage ─────────────────────────────────────────────────────────
-- Backs the 15-min/day/IP guest quota (api/guest-usage.ts, lib/guestUsage.ts).
-- Guests are never authenticated, so there's no auth.uid() to scope a
-- normal RLS policy to here — deliberately NO policies are defined, which
-- with RLS enabled means the anon/authenticated roles get zero access.
-- Only the service-role client (lib/supabaseAdmin.ts, server-side only)
-- can read/write this table, since the service role bypasses RLS entirely.
-- IPs are stored as a SHA-256 hash, never raw.

create table if not exists guest_usage (
  ip_hash text not null,
  usage_date date not null,
  seconds_used int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (ip_hash, usage_date)
);

alter table guest_usage enable row level security;

-- Atomic upsert-and-increment, called via supabaseAdmin.rpc() from
-- api/guest-usage.ts. security definer so it can write to guest_usage even
-- though no policy grants the calling role direct access — the function
-- itself is the only sanctioned way in, and it's only ever invoked with the
-- service-role key from server-side code, never from the browser.
create or replace function increment_guest_usage(p_ip_hash text, p_usage_date date, p_seconds int)
returns int as $$
declare
  new_total int;
begin
  insert into guest_usage (ip_hash, usage_date, seconds_used, updated_at)
  values (p_ip_hash, p_usage_date, greatest(p_seconds, 0), now())
  on conflict (ip_hash, usage_date)
  do update set seconds_used = guest_usage.seconds_used + greatest(p_seconds, 0), updated_at = now()
  returning seconds_used into new_total;
  return new_total;
end;
$$ language plpgsql security definer;


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

drop policy if exists "embeddings: crud own" on embeddings;
create policy "embeddings: crud own" on embeddings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
