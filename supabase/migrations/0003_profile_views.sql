-- Private daily view counter for the owner's GitHub profile (github.com/emwil23), read in the table editor.
create table if not exists public.profile_views (
  day date primary key,
  views integer not null default 0
);

-- RLS on with no policies: only the API's service role can touch it.
alter table public.profile_views enable row level security;

-- Adds one view to today's row (UTC) and returns the new total.
create or replace function public.count_profile_view()
returns integer
language sql
security definer
set search_path = ''
as $$
  insert into public.profile_views (day, views)
  values ((now() at time zone 'utc')::date, 1)
  on conflict (day) do update set views = public.profile_views.views + 1
  returning views;
$$;

revoke all on function public.count_profile_view() from public, anon, authenticated;
grant execute on function public.count_profile_view() to service_role;
