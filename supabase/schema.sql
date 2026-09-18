-- Run this once in the Supabase project's SQL editor (Dashboard → SQL Editor)
-- to support the "Account" sign-in feature added in src/supabaseAuth.js.
--
-- One row per signed-in user, holding that user's entire Bill Tracker export
-- as JSON. Row Level Security means a user's access token (issued at sign-in)
-- can only ever read or write their own row — the anon key alone grants
-- nothing here.
create table if not exists public.account_blobs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.account_blobs enable row level security;

create policy "Users manage their own blob"
  on public.account_blobs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Optional cleanup: the old anonymous-sync-key table this replaces. Only
-- drop it once you've confirmed nothing still depends on it.
-- drop table if exists public.sync_blobs;

-- For the "Email code" sign-in option to work, the Magic Link email template
-- (Dashboard → Authentication → Email Templates) must include {{ .Token }} —
-- by default it only shows a clickable {{ .ConfirmationURL }} link, which
-- this app doesn't use (see the comment in src/supabaseAuth.js for why).
