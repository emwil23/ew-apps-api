-- Shared by every EW app: one row per user, app and day.
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  app text not null,
  day date not null default current_date,
  count integer not null default 0,
  primary key (user_id, app, day)
);

-- RLS on with no policies: only the API's service role can touch it.
alter table public.ai_usage enable row level security;

-- Adds one call and returns today's total in a single atomic statement.
create or replace function public.use_ai_quota(p_user uuid, p_app text)
returns integer
language sql
security definer
set search_path = ''
as $$
  insert into public.ai_usage (user_id, app, day, count)
  values (p_user, p_app, current_date, 1)
  on conflict (user_id, app, day) do update set count = public.ai_usage.count + 1
  returning count;
$$;

-- The daily keep-awake ping from the API.
create or replace function public.ping()
returns integer
language sql
as $$ select 1 $$;

revoke all on function public.use_ai_quota(uuid, text) from public, anon, authenticated;
revoke all on function public.ping() from public, anon, authenticated;
grant execute on function public.use_ai_quota(uuid, text) to service_role;
grant execute on function public.ping() to service_role;
