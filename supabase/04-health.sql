-- Lobby Directory: daily health history for each Pi, for monitoring and service reports.
-- Run once in Supabase after 03-agent.sql: SQL Editor -> New query -> paste -> Run.
--
-- One row per Pi per day (Central time), updated on every check-in (about once a minute):
--   checkins        how many times it checked in; about 1,440 in a full day online
--   power_dips      check-ins that reported under-voltage at that moment
--   browser_down    check-ins where the screen's browser wasn't running
--   max_temp_c      hottest reading of the day
-- Kept for 400 days, so a year-over-year report is possible. Like the device tables, it has row-level
-- security switched on and no policies: only the site's server functions can read or write it.

create table public.device_daily (
  id            bigint generated always as identity primary key,
  device_id     uuid not null references public.devices (id) on delete cascade,
  day           date not null,
  checkins      integer not null default 0,
  power_dips    integer not null default 0,
  browser_down  integer not null default 0,
  max_temp_c    real,
  first_at      timestamptz,
  last_at       timestamptz,
  unique (device_id, day)
);
create index device_daily_day on public.device_daily (day);

alter table public.device_daily enable row level security;
