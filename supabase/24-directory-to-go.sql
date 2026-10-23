-- Lobby Directory: the WayTuGo mark, Directory to Go (a QR code to a phone page of the directory) and the
-- building's place lists with headings and pictures (DP-08 round 12).
-- Run in Supabase BEFORE uploading the round 12 code: SQL Editor -> New query -> paste -> Run.
-- (The old code ignores everything here; the new code reads it, so it must exist first.) Safe to run more than once.
-- Then run check-directory-to-go.sql; it should end with ALL 10 CHECKS PASSED (red on purpose).
--
--   screens.hide_powered_by    1Point only (screens stay 1Point-only to write): hides "Powered by WayTuGo" on that
--                              screen, for a customer who pays not to have it. Off by default: the mark shows.
--   directories.togo_enabled   the customer's switch for the Directory to Go QR code (off by default)
--   directories.togo_code      the short code in the link, e.g. waytugo.com/d/K7M2Q9 (6 characters, no 0/O/1/I/L);
--                              every directory gets one now; replaced only through togo_replace_code
--   directories.togo_line      the words beside the code; blank = "Take this directory with you!"
--   togo_scans                 a count per directory per day (Central time) of phone page opens; no personal data;
--                              server-only like the device tables
--   properties.place_lists     the building's lists: [{heading, items: [{name, distance, line, image}]}], up to 5
--                              lists of 12, shown in the information panel's rotation, an empty list never;
--                              the round 11 amenities become the first list ("Nearby")
--   togo_page(code)            server-only, one call: the phone page's content, and +1 scan
--   togo_scan_count(dir)       signed-in users with access to the directory: scans in the last 30 days and in all
--   togo_replace_code(dir)     signed-in users with access: a fresh code (the old link stops working)
--   set_screen_sizes           adds "qr" (70-150%), the code's size
--   screen_state               adds hide_powered_by to the screen's details and its version

-- ── The WayTuGo mark ──
alter table public.screens add column if not exists hide_powered_by boolean not null default false;
grant select (hide_powered_by) on public.screens to authenticated;

-- ── Directory to Go ──
create or replace function public.togo_new_code_value() returns text
language plpgsql volatile set search_path = public as $$
declare
  v_alpha constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   -- no 0/O, 1/I/L: easy to read aloud
  v_code  text;
begin
  loop
    v_code := '';
    for i in 1..6 loop v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1); end loop;
    exit when not exists (select 1 from public.directories where togo_code = v_code);
  end loop;
  return v_code;
end $$;

alter table public.directories add column if not exists togo_enabled boolean not null default false;
alter table public.directories add column if not exists togo_line    text not null default '';
alter table public.directories add column if not exists togo_code    text;
update public.directories set togo_code = public.togo_new_code_value() where togo_code is null;
alter table public.directories alter column togo_code set default public.togo_new_code_value();
alter table public.directories alter column togo_code set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'directories_togo_code_key') then
    alter table public.directories add constraint directories_togo_code_key unique (togo_code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'directories_togo_code_shape') then
    alter table public.directories add constraint directories_togo_code_shape check (togo_code ~ '^[A-HJKMNP-Z2-9]{6}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'directories_togo_line_len') then
    alter table public.directories add constraint directories_togo_line_len check (length(togo_line) <= 80);
  end if;
end $$;

-- The code changes only through togo_replace_code (or 1Point / the server), so a customer can't pick another
-- directory's code or an odd one
create or replace function public.guard_togo_code() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.togo_code is distinct from old.togo_code and auth.uid() is not null and not public.is_platform_admin()
     and coalesce(current_setting('lobby.togo_replace', true), '') <> 'on' then
    raise exception 'The Directory to Go code can only be replaced with Replace the code.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists directories_togo_guard on public.directories;
create trigger directories_togo_guard before update on public.directories for each row execute function public.guard_togo_code();

create table if not exists public.togo_scans (
  directory_id uuid not null references public.directories (id) on delete cascade,
  day          date not null,
  scans        integer not null default 0,
  primary key (directory_id, day)
);
alter table public.togo_scans enable row level security;   -- no policies: server-only
revoke all on public.togo_scans from anon, authenticated;

create or replace function public.togo_page(p_code text) returns jsonb
language plpgsql set search_path = public as $$
declare
  d public.directories%rowtype;
  p public.properties%rowtype;
begin
  select * into d from public.directories where togo_code = upper(coalesce(p_code, ''));
  if not found or not d.togo_enabled then return jsonb_build_object('missing', true); end if;
  select * into p from public.properties where id = d.property_id;
  insert into public.togo_scans (directory_id, day, scans) values (d.id, (now() at time zone 'America/Chicago')::date, 1)
    on conflict (directory_id, day) do update set scans = public.togo_scans.scans + 1;
  return jsonb_build_object(
    'dir', jsonb_build_object('title', d.title, 'subtitle', d.subtitle, 'footer_override', d.footer_override,
                              'amenities_enabled', d.amenities_enabled),
    'prop', jsonb_build_object('name', p.name, 'address', p.address, 'logo', p.logo, 'logo_replaces_name', p.logo_replaces_name,
                               'company_logo', p.company_logo, 'logo_swap', p.logo_swap, 'managed_by', p.managed_by,
                               'leased_by', p.leased_by, 'footer', p.footer, 'place_lists', p.place_lists),
    'tenants', coalesce((select jsonb_agg(jsonb_build_object('name', t.name, 'suite', t.suite, 'note', t.note) order by t.sort, t.name)
                         from public.tenants t where t.directory_id = d.id), '[]'::jsonb));
end $$;
revoke all on function public.togo_page(text) from public, anon, authenticated;
grant execute on function public.togo_page(text) to service_role;

create or replace function public.togo_scan_count(p_directory uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not coalesce(public.is_platform_admin() or public.directory_org(p_directory) = public.my_org(), false) then
    raise exception 'That directory doesn''t exist, or you don''t have access to it.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'last30', coalesce((select sum(scans) from public.togo_scans where directory_id = p_directory
                          and day > (now() at time zone 'America/Chicago')::date - 30), 0),
    'total', coalesce((select sum(scans) from public.togo_scans where directory_id = p_directory), 0));
end $$;
revoke all on function public.togo_scan_count(uuid) from public, anon;
grant execute on function public.togo_scan_count(uuid) to authenticated, service_role;

create or replace function public.togo_replace_code(p_directory uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if not coalesce(public.is_platform_admin() or public.directory_org(p_directory) = public.my_org(), false) then
    raise exception 'That directory doesn''t exist, or you don''t have access to it.' using errcode = '42501';
  end if;
  v_code := public.togo_new_code_value();
  perform set_config('lobby.togo_replace', 'on', true);
  update public.directories set togo_code = v_code where id = p_directory;
  perform set_config('lobby.togo_replace', '', true);
  return v_code;
end $$;
revoke all on function public.togo_replace_code(uuid) from public, anon;
grant execute on function public.togo_replace_code(uuid) to authenticated, service_role;
revoke all on function public.togo_new_code_value() from public, anon, authenticated;

-- ── Place lists (headings and pictures) ──
alter table public.properties add column if not exists place_lists jsonb not null default '[]'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'properties_place_lists_shape') then
    alter table public.properties add constraint properties_place_lists_shape
      check (jsonb_typeof(place_lists) = 'array' and jsonb_array_length(place_lists) <= 5
             and octet_length(place_lists::text) <= 1500000);   -- pictures are kept small by the editor; this is the backstop
  end if;
end $$;
-- Round 11's places become the first list, "Nearby" (once; the amenities column stays for screens not yet reloaded)
update public.properties set place_lists = jsonb_build_array(jsonb_build_object('heading', 'Nearby', 'items', amenities))
  where place_lists = '[]'::jsonb and jsonb_array_length(amenities) > 0;

-- ── The code's size ──
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
  for v_name, v_lo, v_hi in values ('title', 50, 120), ('logo', 60, 200), ('brand', 60, 250), ('welcome', 80, 160),
                                   ('news', 70, 150), ('clock', 70, 150), ('weather', 70, 150), ('contacts', 70, 150),
                                   ('qr', 70, 150) loop
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

-- ── screen_state (from 18-sizes.sql), with hide_powered_by in the screen's details and its version ──
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
  -- and building or directory edits bump their own. The screen's own sizes and its WayTuGo mark count too.
  v_etag := md5(concat_ws('|', s.key, s.name, s.orientation, coalesce(s.directory_id::text, '-'),
                          coalesce(s.identify_until::text, '-'), coalesce(d.updated_at::text, '-'), coalesce(p.updated_at::text, '-'),
                          coalesce(s.sizes::text, '{}'), s.hide_powered_by::text));
  if v_etag = p_etag then
    return jsonb_build_object('etag', v_etag, 'not_modified', true);
  end if;

  return jsonb_build_object(
    'etag', v_etag,
    'screen', jsonb_build_object('key', s.key, 'name', s.name, 'orientation', s.orientation, 'identify_until', s.identify_until,
                                 'sizes', coalesce(s.sizes, '{}'::jsonb), 'hide_powered_by', s.hide_powered_by),
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
