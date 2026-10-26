-- Lobby Directory: the touch directory (DP-09 round 15).
-- Run in Supabase BEFORE uploading the round 15 code: SQL Editor -> New query -> paste -> Run.
-- (The new console and editor read and save the new columns, so they must exist first; the old code never asks for
-- them.) Safe to run more than once. Then run check-touch-directory.sql; it should end with ALL 6 CHECKS PASSED (red
-- on purpose).
--
-- Scot's decisions (2026-10-25):
--   * Tapping a company on a touch screen opens its card: name, suite and its people (round 14's rules decide who and
--     which details; with the owner's switch off the card shows no people and no note about them).
--   * An A-Z strip, only when the list is too long to fit.
--   * The time with no touch before the screen goes back to the whole directory is set per screen (45 s by default).
--   * An accessible on-screen keyboard, when the customer chooses: a per-directory switch, off by default; it searches
--     company names only (people are found only through their company).
--   * Places and promotions become tappable in a round of their own.
--
--   screens.touch_idle_s        seconds with no touch before the screen returns to the directory, 15 to 300 (45);
--                               readable by signed-in users, written by 1Point (Screen settings), like the round 13 two
--   directories.touch_keyboard  the customer's switch for the keyboard button (the editor; off by default); reaches the
--                               screen with the rest of the directory row and counts in its version already
--   screen_state                sends touch_idle_s, and counts it in the screen's version

alter table public.screens add column if not exists touch_idle_s integer not null default 45;
do $$ begin
  alter table public.screens add constraint screens_touch_idle_range check (touch_idle_s between 15 and 300);
exception when duplicate_object then null;
end $$;
grant select (touch_idle_s) on public.screens to authenticated;

alter table public.directories add column if not exists touch_keyboard boolean not null default false;

-- ── screen_state (from 26-people.sql), with the screen's idle time in its details and its version ──
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

  -- The version: anything the screen shows. Tenant and people edits bump the directory's updated_at (triggers in 01
  -- and 26), and building or directory edits bump their own. The screen's own sizes, its WayTuGo mark and its touch
  -- settings count too.
  v_etag := md5(concat_ws('|', s.key, s.name, s.orientation, coalesce(s.directory_id::text, '-'),
                          coalesce(s.identify_until::text, '-'), coalesce(d.updated_at::text, '-'), coalesce(p.updated_at::text, '-'),
                          coalesce(s.sizes::text, '{}'), s.hide_powered_by::text,
                          s.touch::text, coalesce(s.screen_inches::text, '-'), s.touch_idle_s::text));
  if v_etag = p_etag then
    return jsonb_build_object('etag', v_etag, 'not_modified', true);
  end if;

  return jsonb_build_object(
    'etag', v_etag,
    'screen', jsonb_build_object('key', s.key, 'name', s.name, 'orientation', s.orientation, 'identify_until', s.identify_until,
                                 'sizes', coalesce(s.sizes, '{}'::jsonb), 'hide_powered_by', s.hide_powered_by,
                                 'touch', s.touch, 'screen_inches', s.screen_inches, 'touch_idle_s', s.touch_idle_s),
    'dir',  case when d.id is not null then to_jsonb(d) end,
    'prop', case when p.id is not null then to_jsonb(p) end,
    'tenants', case when d.id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('name', t.name, 'suite', t.suite, 'arrow', t.arrow, 'note', t.note, 'sort', t.sort,
        'people', case when not s.touch then '[]'::jsonb else coalesce((
          select jsonb_agg(jsonb_build_object(
                   'first', pe.first_name, 'last', pe.last_name,
                   'title', case when co.show_title then pe.title else '' end,
                   'phone', case when co.show_phone then pe.phone else '' end,
                   'email', case when co.show_email then pe.email else '' end,
                   'suite', pe.suite)
                 order by pe.sort, lower(pe.last_name), lower(pe.first_name))
            from public.people pe join public.companies co on co.id = pe.company_id
           where pe.company_id = t.company_id and co.show_people and pe.show), '[]'::jsonb) end)
        order by t.sort, t.name)
      from public.tenants t where t.directory_id = d.id), '[]'::jsonb) end
  );
end $$;

revoke all on function public.screen_state(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.screen_state(text, text, text, jsonb) to service_role;

notify pgrst, 'reload schema';
