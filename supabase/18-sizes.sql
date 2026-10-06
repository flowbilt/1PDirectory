-- Lobby Directory: per-screen sizes for the title, both logos and the Welcome line (DP-04 round 4).
-- Run in Supabase BEFORE uploading the round 4 code: SQL Editor -> New query -> paste -> Run.
-- (The old code ignores the new column and function, so this order has no gap.) Safe to run more than once.
-- Then run check-sizes.sql; it should end with ALL 8 CHECKS PASSED (red on purpose).
--
--   screens.sizes     {title, logo, brand, welcome}: each a percentage of the standard size, 100 = as it is today.
--                     Missing = 100, so every screen looks exactly as before until someone moves a slider.
--                     Room for the news panel and other widgets later, without another column.
--   set_screen_sizes  how the editor saves them: anyone who can see the screen (1Point, or the screen's own
--                     account) may change its sizes, and only its sizes. Out-of-range values are clamped,
--                     unknown names ignored.
--   screen_state      (from 05-tuning.sql) now sends the sizes and counts them in the screen's version, so a
--                     change reaches the TV within a minute. Every screen re-downloads once after this runs.

alter table public.screens add column if not exists sizes jsonb not null default '{}'::jsonb;

-- Signed-in users may read the new column like the others (06-trust.sql lists the readable columns)
grant select (sizes) on public.screens to authenticated;

create or replace function public.set_screen_sizes(p_screen uuid, p_sizes jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_dir   uuid;
  v_out   jsonb := '{}'::jsonb;
  v_name  text;
  v_lo    int;
  v_hi    int;
  v_val   numeric;
begin
  select directory_id into v_dir from public.screens where id = p_screen;
  -- coalesce: with no account (or no directory) the comparison is unknown, which must mean no, not maybe
  if not found or not coalesce(public.is_platform_admin() or public.directory_org(v_dir) = public.my_org(), false) then
    raise exception 'That screen doesn''t exist, or you don''t have access to it.' using errcode = '42501';
  end if;
  for v_name, v_lo, v_hi in values ('title', 50, 120), ('logo', 60, 200), ('brand', 60, 250), ('welcome', 80, 160) loop
    if jsonb_typeof(p_sizes -> v_name) = 'number' then
      v_val := round((p_sizes ->> v_name)::numeric);
      v_val := least(v_hi, greatest(v_lo, v_val));
      if v_val <> 100 then v_out := v_out || jsonb_build_object(v_name, v_val::int); end if;   -- 100 = standard, not stored
    end if;
  end loop;
  update public.screens set sizes = v_out where id = p_screen;
  return v_out;
end $$;

revoke all on function public.set_screen_sizes(uuid, jsonb) from public, anon;
grant execute on function public.set_screen_sizes(uuid, jsonb) to authenticated, service_role;

-- 05-tuning.sql's screen_state, with the sizes added to the version and the screen's details. Nothing else changed.
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
  -- and building or directory edits bump their own. The screen's own sizes count too (18-sizes.sql).
  v_etag := md5(concat_ws('|', s.key, s.name, s.orientation, coalesce(s.directory_id::text, '-'),
                          coalesce(s.identify_until::text, '-'), coalesce(d.updated_at::text, '-'), coalesce(p.updated_at::text, '-'),
                          coalesce(s.sizes::text, '{}')));
  if v_etag = p_etag then
    return jsonb_build_object('etag', v_etag, 'not_modified', true);
  end if;

  return jsonb_build_object(
    'etag', v_etag,
    'screen', jsonb_build_object('key', s.key, 'name', s.name, 'orientation', s.orientation, 'identify_until', s.identify_until,
                                 'sizes', coalesce(s.sizes, '{}'::jsonb)),
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
