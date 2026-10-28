-- Lobby Directory: layouts, the new kind of screen content (DP-11, round E1a).
-- Run in Supabase BEFORE uploading the E1a code: SQL Editor -> New query -> paste -> Run. Safe to run more than once.
-- Then run check-layout-engine.sql; it should read ALL 10 CHECKS PASSED (red on purpose).
--
-- A screen shows either a directory (as today, untouched) or a LAYOUT: a grid, a theme and blocks, kept as data
-- (expansion-brief.md). Decisions (Scot, 2026-10-28):
--   layouts          belong to an ACCOUNT, not a building, so one layout can later show at many sites. Its
--                    orientation is fixed; the screen's own Orientation wins, so a mismatch is refused.
--   layout_versions  every Publish is kept and never changed. Roll back publishes an old version again as a new one.
--                    The checks (guardrail warnings) at the time are kept with it, and whether 1Point published anyway.
--   screens          layout_id (instead of directory_id) and property_id, the screen's building, which gives a layout
--                    screen its time zone, weather and address. A screen shows a directory or a layout, never both.
-- Publishing goes through the site (/api/layouts), which checks the layout first; signed-in users can't call the
-- publish functions directly, so nothing unchecked reaches a screen. In E1a only 1Point makes and publishes
-- layouts; owners can see their own account's layouts. Customers' content editing comes with E2.
-- Pictures come with E1b; per-site overrides wait for the round that settles the multi-site questions (block ids
-- leave the room).
--
--   screen_state   a layout screen gets {kind: layout, layout: {id, name, version, doc}, prop}; a directory screen's
--                  answer is exactly as before. The layout's published version counts in the screen's version.

-- ─────────────────────────────────────────── tables

create table if not exists public.layouts (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations (id) on delete restrict,
  name               text not null check (length(trim(name)) between 1 and 80),
  family             text not null default 'menu' check (family in ('list', 'schedule', 'menu', 'board')),
  orientation        text not null check (orientation in ('portrait', 'landscape')),
  draft              jsonb not null default '{}'::jsonb,   -- the working copy (the last one checked); E2 and E4 edit it
  published_version  integer,                              -- null: never published, so no screen can show it yet
  published_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users (id) on delete set null,
  constraint layouts_draft_size check (pg_column_size(draft) <= 262144)
);

create table if not exists public.layout_versions (
  layout_id      uuid not null references public.layouts (id) on delete cascade,
  version        integer not null check (version >= 1),
  doc            jsonb not null,
  checks         jsonb not null default '{}'::jsonb,    -- {errors: [], warnings: [...]} when it was published
  overridden     boolean not null default false,        -- 1Point published it with warnings
  note           text not null default '' check (length(note) <= 200),
  rolled_back_from integer,                             -- set when this version is an earlier one published again
  published_at   timestamptz not null default now(),
  published_by   uuid references auth.users (id) on delete set null,
  primary key (layout_id, version),
  constraint layout_versions_size check (pg_column_size(doc) <= 262144)
);

alter table public.screens add column if not exists layout_id uuid references public.layouts (id) on delete restrict;
alter table public.screens add column if not exists property_id uuid references public.properties (id) on delete set null;
alter table public.screens drop constraint if exists screens_one_content;
alter table public.screens add constraint screens_one_content check (directory_id is null or layout_id is null);
create index if not exists screens_layout on public.screens (layout_id) where layout_id is not null;

-- ─────────────────────────────────────────── helpers

create or replace function public.property_org(p uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from public.properties where id = p;
$$;

create or replace function public.layout_org(l uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from public.layouts where id = l;
$$;

-- The shape a screen's Orientation gives it (the Pi turns by it; Automatic is landscape, as on the Pi)
create or replace function public.orientation_shape(o text) returns text
language sql immutable as $$
  select case when o in ('portrait', 'portrait-flipped') then 'portrait' else 'landscape' end;
$$;

create or replace function public.orientation_label(o text) returns text
language sql immutable as $$
  select case o when 'portrait' then 'Portrait' when 'portrait-flipped' then 'Portrait (turned the other way)'
                when 'landscape' then 'Landscape' when 'landscape-flipped' then 'Landscape (upside down)' else 'Automatic' end;
$$;

-- ─────────────────────────────────────────── guard rails
-- A layout screen: its building belongs to the layout's account, and its Orientation matches the layout's. Refused in
-- plain words, so the console can show the message as it is.
create or replace function public.guard_screen_layout() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  l public.layouts%rowtype;
begin
  if new.layout_id is null then return new; end if;
  select * into l from public.layouts where id = new.layout_id;
  if l.published_version is null and (tg_op = 'INSERT' or new.layout_id is distinct from old.layout_id) then
    raise exception 'The layout "%" hasn''t been published yet. Publish it on the Layouts tab first.', l.name
      using errcode = 'check_violation';
  end if;
  if new.property_id is null then
    raise exception 'Choose the building this screen is in. A layout takes its time zone, weather and address from the screen''s building.'
      using errcode = 'check_violation';
  end if;
  if public.property_org(new.property_id) is distinct from l.org_id then
    raise exception 'That building belongs to a different account from the layout "%". Choose one of the layout''s account''s buildings.', l.name
      using errcode = 'check_violation';
  end if;
  if public.orientation_shape(new.orientation) <> l.orientation then
    raise exception 'The layout "%" is %, and this screen''s Orientation is %. Change the screen''s Orientation to % first, or choose a % layout.',
      l.name, l.orientation, public.orientation_label(new.orientation),
      case l.orientation when 'portrait' then 'Portrait' else 'Landscape' end, public.orientation_shape(new.orientation)
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists screens_layout_guard on public.screens;
create trigger screens_layout_guard before insert or update of layout_id, property_id, orientation on public.screens
  for each row execute function public.guard_screen_layout();

-- A layout's account and orientation can't change while a screen shows it; versions are never edited.
create or replace function public.guard_layout_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  if new.orientation <> old.orientation or new.org_id <> old.org_id then
    select count(*) into n from public.screens where layout_id = old.id;
    if n > 0 then
      raise exception 'The layout "%" is shown on % screen(s). Choose something else for those screens first.', old.name, n
        using errcode = 'check_violation';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists layouts_guard on public.layouts;
create trigger layouts_guard before update on public.layouts for each row execute function public.guard_layout_update();

create or replace function public.layout_versions_frozen() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.layouts where id = old.layout_id) then return old; end if;  -- the layout itself went
  raise exception 'Published versions are kept as they were. Publish a new version, or roll back to an earlier one.'
    using errcode = 'check_violation';
end $$;

drop trigger if exists layout_versions_frozen on public.layout_versions;
create trigger layout_versions_frozen before update or delete on public.layout_versions
  for each row execute function public.layout_versions_frozen();

-- A layout that a screen shows can't be removed (screens.layout_id is "on delete restrict"); say so plainly.
create or replace function public.guard_layout_delete() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  select count(*) into n from public.screens where layout_id = old.id;
  if n > 0 then
    raise exception 'The layout "%" is shown on % screen(s). Choose something else for those screens first.', old.name, n
      using errcode = 'check_violation';
  end if;
  return old;
end $$;

drop trigger if exists layouts_delete_guard on public.layouts;
create trigger layouts_delete_guard before delete on public.layouts for each row execute function public.guard_layout_delete();

-- ─────────────────────────────────────────── publish and roll back (the site only)
-- p_by is the signed-in 1Point user the site checked. The doc's orientation must be the layout's.
create or replace function public.layout_publish(p_layout uuid, p_doc jsonb, p_checks jsonb, p_overridden boolean, p_note text, p_by uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  l public.layouts%rowtype;
  v integer;
begin
  select * into l from public.layouts where id = p_layout for update;
  if not found then raise exception 'No such layout.' using errcode = 'no_data_found'; end if;
  if coalesce(p_doc ->> 'orientation', '') <> l.orientation then
    raise exception 'This layout is %, so the layout''s "orientation" must be "%".', l.orientation, l.orientation using errcode = 'check_violation';
  end if;
  select coalesce(max(version), 0) + 1 into v from public.layout_versions where layout_id = p_layout;
  insert into public.layout_versions (layout_id, version, doc, checks, overridden, note, published_by)
    values (p_layout, v, p_doc, coalesce(p_checks, '{}'::jsonb), coalesce(p_overridden, false), left(coalesce(p_note, ''), 200), p_by);
  update public.layouts set draft = p_doc, published_version = v, published_at = now(), updated_by = p_by where id = p_layout;
  insert into public.audit_log (user_id, action, entity, entity_id, detail)
    values (p_by, 'publish layout', 'layout', p_layout, jsonb_build_object('version', v, 'overridden', coalesce(p_overridden, false)));
  return v;
end $$;

create or replace function public.layout_rollback(p_layout uuid, p_version integer, p_by uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  l public.layouts%rowtype;
  old public.layout_versions%rowtype;
  v integer;
begin
  select * into l from public.layouts where id = p_layout for update;
  if not found then raise exception 'No such layout.' using errcode = 'no_data_found'; end if;
  select * into old from public.layout_versions where layout_id = p_layout and version = p_version;
  if not found then raise exception 'This layout has no version %.', p_version using errcode = 'no_data_found'; end if;
  select max(version) + 1 into v from public.layout_versions where layout_id = p_layout;
  insert into public.layout_versions (layout_id, version, doc, checks, overridden, note, rolled_back_from, published_by)
    values (p_layout, v, old.doc, old.checks, old.overridden, format('Rolled back to version %s', p_version), p_version, p_by);
  update public.layouts set draft = old.doc, published_version = v, published_at = now(), updated_by = p_by where id = p_layout;
  insert into public.audit_log (user_id, action, entity, entity_id, detail)
    values (p_by, 'roll back layout', 'layout', p_layout, jsonb_build_object('version', v, 'from', p_version));
  return v;
end $$;

revoke all on function public.layout_publish(uuid, jsonb, jsonb, boolean, text, uuid) from public, anon, authenticated;
revoke all on function public.layout_rollback(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.layout_publish(uuid, jsonb, jsonb, boolean, text, uuid) to service_role;
grant execute on function public.layout_rollback(uuid, integer, uuid) to service_role;

-- ─────────────────────────────────────────── access
alter table public.layouts enable row level security;
alter table public.layout_versions enable row level security;

drop policy if exists layout_read on public.layouts;
drop policy if exists layout_write on public.layouts;
create policy layout_read  on public.layouts for select to authenticated using (public.is_platform_admin() or org_id = public.my_org());
-- Making, renaming and removing layouts: 1Point only in E1a (the draft and versions are written by the site)
create policy layout_write on public.layouts for all to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists layout_version_read on public.layout_versions;
create policy layout_version_read on public.layout_versions for select to authenticated
  using (public.is_platform_admin() or public.layout_org(layout_id) = public.my_org());
-- No insert, update or delete policies: versions are written only by layout_publish and layout_rollback.

-- Signed-in users: the draft is written by the site only (after its checks), and so are the published fields.
revoke insert, update on public.layouts from authenticated;
grant insert (org_id, name, family, orientation) on public.layouts to authenticated;
grant update (name, family, orientation) on public.layouts to authenticated;
revoke insert, update, delete on public.layout_versions from authenticated, anon;
revoke all on public.layouts, public.layout_versions from anon;

-- Screens: the two new columns are readable (06-trust.sql grants columns one by one), and a layout screen is visible
-- to its building's account as a directory screen is to its directory's.
grant select (layout_id, property_id) on public.screens to authenticated;
drop policy if exists screen_read on public.screens;
create policy screen_read on public.screens for select to authenticated
  using (public.is_platform_admin() or public.directory_org(directory_id) = public.my_org() or public.property_org(property_id) = public.my_org());

-- ─────────────────────────────────────────── screen_state (from 28-touch-directory.sql), with layouts
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

  -- ── A layout screen (E1a): the layout's published version and the screen's building ──
  if s.layout_id is not null then
    select * into l from public.layouts where id = s.layout_id;
    if l.published_version is not null then
      select * into lv from public.layout_versions where layout_id = l.id and version = l.published_version;
    end if;
    if s.property_id is not null then select * into p from public.properties where id = s.property_id; end if;
    v_etag := md5(concat_ws('|', 'layout', s.key, s.name, s.orientation, l.id::text, coalesce(l.published_version::text, '-'),
                            l.name, coalesce(s.identify_until::text, '-'), coalesce(p.updated_at::text, '-'),
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
                                   'doc', case when lv.version is not null then lv.doc end),
      'prop', case when p.id is not null then jsonb_build_object('id', p.id, 'name', p.name, 'address', p.address, 'timezone', p.timezone,
                                                                  'lat', p.lat, 'lon', p.lon, 'updated_at', p.updated_at) end
    );
  end if;

  -- ── A directory screen: exactly as in 28-touch-directory.sql ──
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
