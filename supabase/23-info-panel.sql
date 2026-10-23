-- Lobby Directory: the shared information panel: a live traffic map, travel times and nearby amenities (DP-08 round 11).
-- Run in Supabase BEFORE uploading the round 11 code: SQL Editor -> New query -> paste -> Run.
-- (The old code ignores the new columns and never calls the new function, so this order has no gap; the new editor
-- saves the new columns, so it needs them first.) Safe to run more than once.
-- Then run check-info-panel.sql; it should end with ALL 9 CHECKS PASSED (red on purpose).
--
-- Per directory (each screen has its own directory, so effectively per screen; like news), all OFF by default,
-- so no screen changes until someone ticks them in the editor:
--   directories.map_enabled        a live traffic map (Google Maps with its traffic layer) in the panel's rotation
--   directories.times_enabled      live travel times to the building's destinations (Google Routes, traffic-aware)
--   directories.amenities_enabled  the building's nearby amenities
-- Per building (shared by its directories, edited in the editor's Building panel):
--   properties.destinations   up to 3: [{label, address}], e.g. {"label": "Birmingham Airport", "address": "BHM ..."}
--   properties.amenities      up to 20: [{name, distance, line}], distance a free text like "0.3 mi" or "5 min walk"
-- Server-only:
--   screens.traffic_at        when this screen last asked Google for travel times (not granted to signed-in users)
--   traffic_claim(key, device) one call: may this screen ask Google now? Google's terms allow no shared cache, so each
--                             screen asks for itself, at most every 25 minutes (the display asks every 30), on
--                             weekdays from 6 a.m. to 7 p.m. building time. That keeps three screens with three
--                             destinations inside Google's free monthly amount. Nothing Google returns is stored.

alter table public.directories add column if not exists map_enabled       boolean not null default false;
alter table public.directories add column if not exists times_enabled     boolean not null default false;
alter table public.directories add column if not exists amenities_enabled boolean not null default false;

alter table public.properties add column if not exists destinations jsonb not null default '[]'::jsonb;
alter table public.properties add column if not exists amenities    jsonb not null default '[]'::jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'properties_destinations_shape') then
    alter table public.properties add constraint properties_destinations_shape
      check (jsonb_typeof(destinations) = 'array' and jsonb_array_length(destinations) <= 3);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'properties_amenities_shape') then
    alter table public.properties add constraint properties_amenities_shape
      check (jsonb_typeof(amenities) = 'array' and jsonb_array_length(amenities) <= 20);
  end if;
end $$;

alter table public.screens add column if not exists traffic_at timestamptz;   -- server-only (not in 06's column grant)

create or replace function public.traffic_claim(p_key text, p_device text)
returns jsonb
language plpgsql set search_path = public as $$
declare
  s     public.screens%rowtype;
  d     public.directories%rowtype;
  p     public.properties%rowtype;
  v_now timestamp;
begin
  if coalesce(p_device, '') <> '' then
    select sc.* into s from public.devices dv join public.screens sc on sc.id = dv.screen_id where dv.serial = p_device;
  else
    select * into s from public.screens where key = p_key;
  end if;
  if not found then return jsonb_build_object('off', 'no such screen'); end if;
  select * into d from public.directories where id = s.directory_id;
  if not found or not d.times_enabled then return jsonb_build_object('off', 'switched off'); end if;
  select * into p from public.properties where id = d.property_id;
  if jsonb_array_length(p.destinations) = 0 then return jsonb_build_object('off', 'no destinations'); end if;
  if p.lat is null and coalesce(trim(p.address), '') = '' then return jsonb_build_object('off', 'no building location'); end if;

  -- Weekdays, 6 a.m. to 7 p.m. at the building
  v_now := now() at time zone coalesce(nullif(p.timezone, ''), 'America/Chicago');
  if extract(isodow from v_now) > 5 or extract(hour from v_now) < 6 or extract(hour from v_now) >= 19 then
    return jsonb_build_object('off', 'hours');
  end if;

  -- At most every 25 minutes per screen
  if s.traffic_at is not null and s.traffic_at > now() - interval '25 minutes' then
    return jsonb_build_object('wait', ceil(extract(epoch from (s.traffic_at + interval '25 minutes' - now())))::int);
  end if;
  update public.screens set traffic_at = now() where id = s.id;

  return jsonb_build_object(
    'origin', jsonb_build_object('lat', p.lat, 'lon', p.lon, 'address', p.address),
    'destinations', p.destinations);
end $$;

revoke all on function public.traffic_claim(text, text) from public, anon, authenticated;
grant execute on function public.traffic_claim(text, text) to service_role;

notify pgrst, 'reload schema';
