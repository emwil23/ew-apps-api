-- One row per account, shared by every EW app. Written only by the API (service role), never by users,
-- unlike auth user_metadata, which a signed-in user can change themselves.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  adult_confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;

-- Carry over anyone who already confirmed 18+ under the old user_metadata flag.
insert into public.profiles (id, adult_confirmed_at)
select id, now() from auth.users where raw_user_meta_data ->> 'adult' = 'true'
on conflict (id) do nothing;
