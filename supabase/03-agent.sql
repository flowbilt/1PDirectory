-- Lobby Directory: remote management of the Pis (the "agent").
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to run after 01 and 02.
--
--   devices          one row per physical Pi, identified by its hardware serial number
--   device_commands  actions queued from the console (reboot, reload, ...) and their results
--
-- Pis never sign in and never touch the database directly. They talk to the Netlify site with their own
-- per-device key, and the site uses the service key. So these tables have row-level security switched on
-- and no policies at all: nothing is readable or writable except through the site's server functions.

create table public.devices (
  id               uuid primary key default gen_random_uuid(),
  serial           text not null unique check (serial ~ '^[0-9a-fA-F]{8,32}$'),
  screen_id        uuid unique references public.screens (id) on delete set null,  -- which screen this Pi drives
  key_hash         text,                                   -- sha-256 of the device's own key; null = not enrolled yet
  status           text not null default 'active' check (status in ('active', 'revoked')),
  model            text not null default '',
  hostname         text not null default '',
  agent_version    text not null default '',
  last_seen        timestamptz,
  last_health      jsonb not null default '{}'::jsonb,     -- temperature, power, uptime, storage, IP...
  screenshot       text not null default '',               -- latest small JPEG as a data URL
  screenshot_at    timestamptz,
  alert_state      jsonb not null default '{}'::jsonb,     -- what we've already emailed about
  created_at       timestamptz not null default now()
);

create table public.device_commands (
  id           bigint generated always as identity primary key,
  device_id    uuid not null references public.devices (id) on delete cascade,
  command      text not null check (command in ('reboot', 'reload', 'screenshot', 'update_agent')),
  status       text not null default 'pending' check (status in ('pending', 'sent', 'done', 'failed', 'expired')),
  result       text not null default '',
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  done_at      timestamptz
);
create index device_commands_pending on public.device_commands (device_id) where status in ('pending', 'sent');

-- "Identify" flashes the screen's name on the TV; the display picks it up on its next check.
alter table public.screens add column if not exists identify_until timestamptz;

alter table public.devices enable row level security;
alter table public.device_commands enable row level security;

-- Connect the Pis already listed in the Yodeck report: their serials are in screens.hardware.
-- (Each creates an un-enrolled device record; the Pi claims it on its first check-in.)
insert into public.devices (serial, screen_id, model)
select lower(s.hardware->>'serial'), s.id, coalesce(s.hardware->>'model', '')
from public.screens s
where coalesce(s.hardware->>'serial', '') ~ '^[0-9a-fA-F]{8,32}$'
on conflict (serial) do nothing;
