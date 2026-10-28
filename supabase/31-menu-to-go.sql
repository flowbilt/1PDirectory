-- Lobby Directory: "Take this menu with you" (DP-11, round E1c).
-- Run in Supabase: SQL Editor -> New query -> paste -> Run, BEFORE uploading the E1c code. Safe to run more than once.
-- Then run check-menu-to-go.sql; it should end with ALL 7 CHECKS PASSED (red on purpose).
--
-- A layout's QR code opens its menu on a phone at waytugo.com/m/<code> (waytugo.com forwards /m/* to this site, as it
-- does /d/* for Directory to Go). The phone page shows the layout's published version as designed, laid out for a
-- phone, with the blocks on now; links on items open in a new tab; "See the board" shows the board itself.
--
--   layouts.menu_code      every layout gets one, six letters and digits like Directory to Go's (no 0/O, 1/I/L), made
--                          by a trigger (DP-09 round 14c's lesson: never a default a signed-in user would have to run)
--   menu_scans             opens per layout per day (counted like Directory to Go's; nothing about the visitor is kept)
--   menu_page(code, count) server-only: the phone page's content (the published version, its pictures, the building)
--   menu_scan_count(layout) signed-in users with access: opens in the last 30 days and in all
--   screen_state           a layout screen's answer gains the layout's menu code, for the QR block

-- ── The codes ──
create or replace function public.menu_new_code_value() returns text
language plpgsql volatile set search_path = public as $$
declare
  v_alpha constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   -- no 0/O, 1/I/L: easy to read aloud
  v_code  text;
begin
  loop
    v_code := '';
    for i in 1..6 loop v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1); end loop;
    exit when not exists (select 1 from public.layouts where menu_code = v_code);
  end loop;
  return v_code;
end $$;
revoke all on function public.menu_new_code_value() from public, anon, authenticated;

alter table public.layouts add column if not exists menu_code text;
update public.layouts set menu_code = public.menu_new_code_value() where menu_code is null;
alter table public.layouts alter column menu_code set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'layouts_menu_code_key') then
    alter table public.layouts add constraint layouts_menu_code_key unique (menu_code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'layouts_menu_code_shape') then
    alter table public.layouts add constraint layouts_menu_code_shape check (menu_code ~ '^[A-HJKMNP-Z2-9]{6}$');
  end if;
end $$;

-- A new layout gets its code from a trigger with the database's own rights; signed-in users can't set or change it
-- (29's column grants allow only name, family and orientation)
create or replace function public.layouts_menu_new() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.menu_code is null then new.menu_code := public.menu_new_code_value(); end if;
  return new;
end $$;
revoke all on function public.layouts_menu_new() from public, anon, authenticated;
drop trigger if exists layouts_menu_new on public.layouts;
create trigger layouts_menu_new before insert on public.layouts for each row execute function public.layouts_menu_new();

-- ── Opens per day (server only) ──
create table if not exists public.menu_scans (
  layout_id uuid not null references public.layouts(id) on delete cascade,
  day       date not null,
  scans     integer not null default 0,
  primary key (layout_id, day)
);
alter table public.menu_scans enable row level security;   -- no policies: the site's key only
revoke all on public.menu_scans from anon, authenticated;

-- ── The phone page's content ──
-- The building: the one of the most recently seen screen showing the layout, else the account's first by name (its
-- time zone decides which blocks are on now, its name and address head the page).
create or replace function public.menu_page(p_code text, p_count boolean default true) returns jsonb
language plpgsql set search_path = public as $$
declare
  l  public.layouts%rowtype;
  lv public.layout_versions%rowtype;
  p  public.properties%rowtype;
begin
  select * into l from public.layouts where menu_code = upper(coalesce(p_code, ''));
  if not found or l.published_version is null then return jsonb_build_object('missing', true); end if;
  select * into lv from public.layout_versions where layout_id = l.id and version = l.published_version;
  select pr.* into p from public.screens s join public.properties pr on pr.id = s.property_id
   where s.layout_id = l.id order by s.last_seen desc nulls last limit 1;
  if not found then select * into p from public.properties where org_id = l.org_id order by name limit 1; end if;
  if p_count then
    insert into public.menu_scans (layout_id, day, scans) values (l.id, (now() at time zone 'America/Chicago')::date, 1)
      on conflict (layout_id, day) do update set scans = public.menu_scans.scans + 1;
  end if;
  return jsonb_build_object(
    'layout', jsonb_build_object('id', l.id, 'name', l.name, 'orientation', l.orientation, 'version', lv.version, 'doc', lv.doc,
                                 'menu_code', l.menu_code),
    'images', coalesce((
      select jsonb_object_agg(i.key, jsonb_build_object('path', i.path, 'w', i.width, 'h', i.height))
        from public.layout_images i
       where i.org_id = l.org_id and lv.doc::text like '%"img:' || i.key || '"%'), '{}'::jsonb),
    'prop', case when p.id is not null then jsonb_build_object('id', p.id, 'name', p.name, 'address', p.address, 'timezone', p.timezone,
                                                                'lat', p.lat, 'lon', p.lon, 'updated_at', p.updated_at) end);
end $$;
revoke all on function public.menu_page(text, boolean) from public, anon, authenticated;
grant execute on function public.menu_page(text, boolean) to service_role;

create or replace function public.menu_scan_count(p_layout uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not coalesce(public.is_platform_admin() or public.layout_org(p_layout) = public.my_org(), false) then
    raise exception 'That layout doesn''t exist, or you don''t have access to it.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'last30', coalesce((select sum(scans) from public.menu_scans where layout_id = p_layout
                          and day > (now() at time zone 'America/Chicago')::date - 30), 0),
    'total', coalesce((select sum(scans) from public.menu_scans where layout_id = p_layout), 0));
end $$;
revoke all on function public.menu_scan_count(uuid) from public, anon;
grant execute on function public.menu_scan_count(uuid) to authenticated, service_role;

-- ─────────────────────────────────────────── screen_state (from 30-layout-images.sql), with the layout's menu code
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
  l      public.layouts%rowtype;
  lv     public.layout_versions%rowtype;
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

  -- ── A layout screen (E1a; E1b adds its pictures; E1c its menu code): the published version and the screen's building ──
  if s.layout_id is not null then
    select * into l from public.layouts where id = s.layout_id;
    if l.published_version is not null then
      select * into lv from public.layout_versions where layout_id = l.id and version = l.published_version;
    end if;
    if s.property_id is not null then select * into p from public.properties where id = s.property_id; end if;
    -- A picture's file never changes once made, so the published version alone fixes which pictures it shows.
    -- 'menu' marks answers that carry the menu code, so screens that had an answer from before 31 get a fresh one.
    v_etag := md5(concat_ws('|', 'layout', 'menu', s.key, s.name, s.orientation, l.id::text, coalesce(l.published_version::text, '-'),
                            l.name, l.menu_code, coalesce(s.identify_until::text, '-'), coalesce(p.updated_at::text, '-'),
                            s.hide_powered_by::text, s.touch::text, coalesce(s.screen_inches::text, '-'), s.touch_idle_s::text));
    if v_etag = p_etag then
      return jsonb_build_object('etag', v_etag, 'not_modified', true);
    end if;
    return jsonb_build_object(
      'etag', v_etag,
      'kind', 'layout',
      'screen', jsonb_build_object('key', s.key, 'name', s.name, 'orientation', s.orientation, 'identify_until', s.identify_until,
                                   'hide_powered_by', s.hide_powered_by, 'touch', s.touch, 'screen_inches', s.screen_inches,
                                   'touch_idle_s', s.touch_idle_s),
      'layout', jsonb_build_object('id', l.id, 'name', l.name, 'orientation', l.orientation, 'version', lv.version,
                                   'doc', case when lv.version is not null then lv.doc end, 'menu_code', l.menu_code),
      'images', case when lv.version is null then '{}'::jsonb else coalesce((
        select jsonb_object_agg(i.key, jsonb_build_object('path', i.path, 'w', i.width, 'h', i.height))
          from public.layout_images i
         where i.org_id = l.org_id and lv.doc::text like '%"img:' || i.key || '"%'), '{}'::jsonb) end,
      'prop', case when p.id is not null then jsonb_build_object('id', p.id, 'name', p.name, 'address', p.address, 'timezone', p.timezone,
                                                                  'lat', p.lat, 'lon', p.lon, 'updated_at', p.updated_at) end
    );
  end if;

  -- ── A directory screen: exactly as in 28-touch-directory.sql ──
  if s.directory_id is not null then
    select * into d from public.directories where id = s.directory_id;
    if found then select * into p from public.properties where id = d.property_id; end if;
  end if;

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
