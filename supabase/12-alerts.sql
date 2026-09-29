-- Lobby Directory: who gets alert emails, set in the console (DP-02 round 8).
-- Run in Supabase BEFORE uploading the round 8 code: SQL Editor -> New query -> paste -> Run.
-- (The old code doesn't know this table; until recipients are added, ALERT_EMAIL_TO in Netlify still gets every
-- alert.) Safe to run more than once.
--
-- Each recipient chooses which alerts they get. The mail server's sign-in stays in Netlify (never in the database).
-- Like the device tables: row-level security on and no policies, so only the site's server functions reach it.

create table if not exists public.alert_recipients (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name        text not null default '',
  offline     boolean not null default true,    -- a Pi went offline / is back
  power       boolean not null default true,    -- under-voltage / power normal again
  hot         boolean not null default true,    -- 80°C or hotter / cooled down
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) on delete set null
);

alter table public.alert_recipients enable row level security;
revoke all on public.alert_recipients from anon, authenticated;

notify pgrst, 'reload schema';
