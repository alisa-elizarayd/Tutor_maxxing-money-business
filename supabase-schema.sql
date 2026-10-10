-- Tutor Maxxing Money Business: Supabase schema
create table if not exists public.user_data (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (id in ('calendar', 'finance')),
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.user_data enable row level security;

drop policy if exists "Users can read own tutor data" on public.user_data;
create policy "Users can read own tutor data"
  on public.user_data for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own tutor data" on public.user_data;
create policy "Users can insert own tutor data"
  on public.user_data for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own tutor data" on public.user_data;
create policy "Users can update own tutor data"
  on public.user_data for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete own tutor data" on public.user_data;
create policy "Users can delete own tutor data"
  on public.user_data for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.user_data to authenticated;

-- Required for browser Realtime updates.
alter table public.user_data replica identity full;
do $$
begin
  alter publication supabase_realtime add table public.user_data;
exception
  when duplicate_object then null;
end $$;
