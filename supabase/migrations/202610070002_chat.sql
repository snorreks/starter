create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_owner_updated_idx on public.conversations(owner_id, updated_at desc, id desc);
create trigger conversations_touch_updated_at before update on public.conversations
for each row execute function public.touch_updated_at();

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (length(content) <= 8000),
  client_id text not null check (length(client_id) between 1 and 128),
  created_at timestamptz not null default now(),
  unique (conversation_id, client_id)
);
create index messages_conversation_created_idx on public.messages(conversation_id, created_at, id);

create schema private;
revoke all on schema private from public, anon, authenticated;
create table private.chat_generations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  client_id text not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  assistant_message_id uuid not null unique default gen_random_uuid(),
  user_message_id uuid not null unique,
  state text not null check (state in ('admitted', 'completed', 'failed', 'cancelled')) default 'admitted',
  attempt integer not null default 1 check (attempt > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, client_id)
);
create table private.admission_counters (
  owner_id uuid not null references auth.users(id) on delete cascade,
  bucket_start timestamptz not null,
  admitted integer not null default 0 check (admitted between 0 and 5),
  primary key (owner_id, bucket_start)
);
create table private.job_hourly_admissions (
  owner_id uuid not null references auth.users(id) on delete cascade,
  bucket_start timestamptz not null,
  admitted integer not null default 0 check (admitted between 0 and 5),
  primary key(owner_id,bucket_start)
);
create table private.job_daily_admissions (
  bucket_start date primary key,
  admitted integer not null default 0 check (admitted between 0 and 50)
);

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
create policy conversations_select_owner on public.conversations for select to authenticated using (owner_id = (select auth.uid()));
create policy conversations_insert_owner on public.conversations for insert to authenticated with check (owner_id = (select auth.uid()));
create policy conversations_update_owner on public.conversations for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy conversations_delete_owner on public.conversations for delete to authenticated using (owner_id = (select auth.uid()));
create policy messages_select_owner on public.messages for select to authenticated using (
  exists (select 1 from public.conversations c where c.id = conversation_id and c.owner_id = (select auth.uid()))
);
revoke all on public.conversations, public.messages from anon, authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
grant select on public.messages to authenticated;
