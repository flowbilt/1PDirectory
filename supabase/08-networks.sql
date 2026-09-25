-- Lobby Directory: saved Wi-Fi networks and prepare codes, for generic prepared cards (DP-02).
-- Run in Supabase BEFORE uploading the code that uses it: SQL Editor -> New query -> paste -> Run.
-- (The old code doesn't know these tables exist, so this order has no gap.) Safe to run more than once.
--
--   wifi_networks  every network a prepared card should know. Every card carries all of them, and a Pi joins
--                  whichever is in range (a network cable always wins). Entered in the console's Pi setup tab
--                  (1Point only); a password can be replaced there but never read back.
--   prepare_codes  one-hour, single-use codes for `setup-kiosk.sh --prepare --code ...` on the bench Pi,
--                  which downloads the networks. Only a hash of each code is kept.
--
-- Like the device tables: row-level security on and no policies, so nothing here is readable or writable
-- except through the site's server functions.

create table if not exists public.wifi_networks (
  id          uuid primary key default gen_random_uuid(),
  label       text not null default '',          -- where it's used, e.g. "Perimeter Park One" or "1Point office"
  ssid        text not null check (length(ssid) between 1 and 32),
  psk         text not null default '' check (psk = '' or length(psk) between 8 and 63),   -- '' = open network
  hidden      boolean not null default false,
  sort        integer not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) on delete set null
);

create table if not exists public.prepare_codes (
  id          bigint generated always as identity primary key,
  code_hash   text not null unique,              -- sha-256 of the code
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

alter table public.wifi_networks enable row level security;
alter table public.prepare_codes enable row level security;
revoke all on public.wifi_networks, public.prepare_codes from anon, authenticated;

notify pgrst, 'reload schema';
