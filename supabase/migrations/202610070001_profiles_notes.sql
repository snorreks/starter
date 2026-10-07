create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function public.create_profile_for_auth_user()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger auth_user_profile after insert on auth.users
for each row execute function public.create_profile_for_auth_user();

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(title) between 1 and 120),
  body text not null default '' check (length(body) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create function public.touch_updated_at()
returns trigger language plpgsql
set search_path = pg_catalog
as $$ begin new.updated_at := pg_catalog.now(); return new; end $$;
create trigger notes_touch_updated_at before update on public.notes
for each row execute function public.touch_updated_at();
create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function public.touch_updated_at();
create index notes_owner_updated_idx on public.notes(owner_id, updated_at desc, id desc);
alter table public.profiles enable row level security;
alter table public.notes enable row level security;
create policy profiles_select_self on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy profiles_update_self on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy notes_select_owner on public.notes for select to authenticated using (owner_id = (select auth.uid()));
create policy notes_insert_owner on public.notes for insert to authenticated with check (owner_id = (select auth.uid()));
create policy notes_update_owner on public.notes for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy notes_delete_owner on public.notes for delete to authenticated using (owner_id = (select auth.uid()));
revoke all on public.profiles, public.notes from anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.notes to authenticated;
