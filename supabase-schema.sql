-- Tutor Maxxing Money Business: complete Supabase sync schema
alter table public.user_data drop constraint if exists user_data_id_check;
alter table public.user_data add constraint user_data_id_check check (id in ('app_state', 'calendar', 'finance'));
alter table public.user_data enable row level security;
grant select, insert, update, delete on public.user_data to authenticated;
alter table public.user_data replica identity full;
do $$
begin
  alter publication supabase_realtime add table public.user_data;
exception
  when duplicate_object then null;
end $$;