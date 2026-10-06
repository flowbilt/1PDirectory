-- Lobby Directory: the alert mail server's sign-in, set in the console (DP-04 round 5).
-- Run in Supabase BEFORE uploading the round 5 code: SQL Editor -> New query -> paste -> Run.
-- (The old code doesn't know this table, so this order has no gap.) Safe to run more than once.
-- Then run check-mail.sql; every column should read true.
--
-- One row (or none). While there's no row, alerts keep using Netlify's SMTP_* variables, as before.
-- The password is never stored as typed: the site encrypts it with SETTINGS_KEY, a key kept only in Netlify
-- (netlify/lib/secret.mjs), so a copy of the database alone can't send mail as 1Point.
-- Like the device tables: row-level security on and no policies, so only the site's server functions reach it.

create table if not exists public.mail_settings (
  id            boolean primary key default true check (id),   -- at most one row
  host          text not null check (host ~ '^[A-Za-z0-9.-]{1,253}$'),
  port          integer not null check (port between 1 and 65535),
  secure        boolean not null default true,    -- true: encrypted from the start (SSL/TLS, usually 465); false: STARTTLS (usually 587)
  username      text not null check (length(username) between 1 and 254),
  password_enc  text not null check (password_enc like 'v1:%'),
  from_address  text not null check (from_address ~* '^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$'),
  from_name     text not null default '',
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users (id) on delete set null
);

alter table public.mail_settings enable row level security;
revoke all on public.mail_settings from anon, authenticated;

notify pgrst, 'reload schema';
