-- Lobby Directory: touch screens, first step (DP-08 round 13).
-- Run in Supabase BEFORE uploading the round 13 code: SQL Editor -> New query -> paste -> Run.
-- (The old code ignores the new columns; the new console saves them, so they must exist first.) Safe to run more
-- than once. Then run check-touch.sql; it should end with ALL 5 CHECKS PASSED (red on purpose).
--
--   screens.touch           1Point's per-screen switch (console, Screen settings): this screen is a touch screen.
--                           Off by default; the current fleet stays display-only. The touch directory (round 15)
--                           only appears on screens with it on.
--   screens.screen_inches   the display's size, measured corner to corner (7 to 100; blank = not given), so touch
--                           buttons can be sized for fingers at any size (13" bench to 55" kiosks)
--   screen_state            sends both to the screen, and counts them in its version
-- Nothing here for the Pi's health: busy, firmware and remote support (agent 1.9.0) arrive inside the health report
-- the database already keeps whole (devices.last_health).

alter table public.screens add column if not exists touch boolean not null default false;
alter table public.screens add column if not exists screen_inches numeric(4,1);
do $$ begin
  alter table public.screens add constraint screens_screen_inches_range check (screen_inches is null or screen_inches between 7 and 100);
exception when duplicate_object then null;
end $$;
grant select (touch, screen_inches) on public.screens to authenticated;

-- ── screen_state (from 24-directory-to-go.sql), with touch and screen_inches in the screen's details and its version ──
create or replace function public.screen_state(
  p_key     text,    -- screen address, or null when p_device is given
  p_device  text,    -- Pi serial for /?device= screens
  p_etag    text,    -- the version the screen already has, or null
  p_report  jsonb    -- {w, h, version, agent} from the screen, or null for no check-in
) returns jsonb
language plpgsql set search_path = public as $$
declare
  s      public.screens%rowtype;
  d      public.directories%rowtype;
  p      public.properties%rowtype;
  v_etag text;
begin
  if coalesce(p_device, '') <> '' then
    select sc.* into s from public.devices dv join public.screens sc on sc.id = dv.screen_id where dv.serial = p_device;
    if not found then return jsonb_build_object('new_device', true); end if;
  else
    select * into s from public.screens where key = p_key;
    if not found then return jsonb_build_object('missing', true); end if;
  end if;

  -- The check-in (this used to be a separate heartbeat call). Every 4 minutes is plenty for Online/Offline.
  if p_report is not null and (s.last_seen is null or s.last_seen < now() - interval '4 minutes') then
    update public.screens set last_seen = now(), last_report = p_report where id = s.id;
  end if;

  if s.directory_id is not null then
    select * into d from public.directories where id = s.directory_id;
    if found then select * into p from public.properties where id = d.property_id; end if;
  end if;

  -- The version: anything the screen shows. Tenant edits bump the directory's updated_at (trigger in 01),
  -- and building or directory edits bump their own. The screen's own sizes, its WayTuGo mark and its touch settings count too.
  v_etag := md5(concat_ws('|', s.key, s.name, s.orientation, coalesce(s.directory_id::text, '-'),
                          coalesce(s.identify_until::text, '-'), coalesce(d.updated_at::text, '-'), coalesce(p.updated_at::text, '-'),
                          coalesce(s.sizes::text, '{}'), s.hide_powered_by::text,
                          s.touch::text, coalesce(s.screen_inches::text, '-')));
  if v_etag = p_etag then
    return jsonb_build_object('etag', v_etag, 'not_modified', true);
  end if;

  return jsonb_build_object(
    'etag', v_etag,
    'screen', jsonb_build_object('key', s.key, 'name', s.name, 'orientation', s.orientation, 'identify_until', s.identify_until,
                                 'sizes', coalesce(s.sizes, '{}'::jsonb), 'hide_powered_by', s.hide_powered_by,
                                 'touch', s.touch, 'screen_inches', s.screen_inches),
    'dir',  case when d.id is not null then to_jsonb(d) end,
    'prop', case when p.id is not null then to_jsonb(p) end,
    'tenants', case when d.id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('name', t.name, 'suite', t.suite, 'arrow', t.arrow, 'note', t.note, 'sort', t.sort) order by t.sort, t.name)
      from public.tenants t where t.directory_id = d.id), '[]'::jsonb) end
  );
end $$;

revoke all on function public.screen_state(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.screen_state(text, text, text, jsonb) to service_role;

notify pgrst, 'reload schema';
