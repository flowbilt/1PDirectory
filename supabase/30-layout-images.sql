-- Lobby Directory: pictures for layouts (DP-11, round E1b).
-- Run in Supabase BEFORE uploading the E1b code: SQL Editor -> New query -> paste -> Run. Safe to run more than once.
-- Then run check-layout-images.sql; it should read ALL 8 CHECKS PASSED (red on purpose).
--
-- Decisions (Scot, 2026-10-28):
--   - Pictures live in a Supabase storage bucket ("layout-images", public: they're shown on screens and phone pages),
--     resized in the browser before upload. The site serves them from its own address (/img/..., a pass-through
--     rewrite in netlify.toml), so a picture costs no function time and each screen downloads it once.
--   - A picture's address never changes once made: a new picture is a new file with a new address, never an overwrite.
--   - No picture is deleted while any kept version of any of the account's layouts (or a layout's draft) uses it, so
--     Roll back always works.
--
--   layout_images   one row per picture: the account it belongs to, its KEY (what a layout says: "image": "img:<key>",
--                   lowercase letters, numbers and dashes, unique in the account, fixed once made), a friendly name
--                   (renamable), and the file's path, type, size and dimensions. Written only by the site (/api/layouts),
--                   which checks the file first; signed-in users read their own account's pictures.
--   layout_image_in_use(org, key)   whether any of the account's layouts (draft or kept version) says "img:<key>"
--   layout_image_delete(id)         removes the row only when nothing uses it, returning its path for the site to
--                                   delete the file; otherwise refuses in plain words
--   screen_state    a layout screen's answer gains "images": the pictures its published version uses, key -> path and size

-- ─────────────────────────────────────────── the bucket (public read; only the site's service key uploads)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('layout-images', 'layout-images', true, 1048576, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ─────────────────────────────────────────── pictures
create table if not exists public.layout_images (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete restrict,
  key         text not null check (key ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  name        text not null default '' check (length(name) <= 80),
  path        text not null unique check (path ~ '^[0-9a-f-]{36}/[a-z0-9-]{1,80}\.(webp|jpg|png)$'),
  mime        text not null check (mime in ('image/webp', 'image/jpeg', 'image/png')),
  width       integer not null check (width between 16 and 4096),
  height      integer not null check (height between 16 and 4096),
  bytes       integer not null check (bytes between 1 and 1048576),
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id) on delete set null,
  unique (org_id, key)
);

-- Fixed once made: the key, the file and its account (only the friendly name can change)
create or replace function public.guard_layout_image_update() returns trigger
language plpgsql as $$
begin
  if new.key <> old.key or new.path <> old.path or new.org_id <> old.org_id or new.mime <> old.mime
     or new.width <> old.width or new.height <> old.height or new.bytes <> old.bytes then
    raise exception 'A picture can''t be changed once it''s uploaded (only its name). Upload the new picture instead.'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists layout_images_guard on public.layout_images;
create trigger layout_images_guard before update on public.layout_images for each row execute function public.guard_layout_image_update();

-- Whether any of the account's layouts says "img:<key>" (a draft, or any kept version: so Roll back always works)
create or replace function public.layout_image_in_use(p_org uuid, p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.layouts l where l.org_id = p_org and l.draft::text like '%"img:' || p_key || '"%')
      or exists (select 1 from public.layout_versions v join public.layouts l on l.id = v.layout_id
                  where l.org_id = p_org and v.doc::text like '%"img:' || p_key || '"%');
$$;

-- Removes a picture's row only when nothing uses it; the site then deletes the file at the returned path
create or replace function public.layout_image_delete(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  i public.layout_images%rowtype;
  names text;
begin
  select * into i from public.layout_images where id = p_id;
  if not found then raise exception 'No such picture.' using errcode = 'no_data_found'; end if;
  if public.layout_image_in_use(i.org_id, i.key) then
    select string_agg(distinct l.name, ', ') into names from public.layouts l
     where l.org_id = i.org_id and (l.draft::text like '%"img:' || i.key || '"%'
        or exists (select 1 from public.layout_versions v where v.layout_id = l.id and v.doc::text like '%"img:' || i.key || '"%'));
    raise exception 'The picture "%" is used by %, in its draft or a kept version, so it can''t be removed (Roll back needs it).',
      coalesce(nullif(i.name, ''), i.key), names using errcode = 'check_violation';
  end if;
  delete from public.layout_images where id = p_id;
  return i.path;
end $$;

revoke all on function public.layout_image_delete(uuid) from public, anon, authenticated;
grant execute on function public.layout_image_delete(uuid) to service_role;
revoke all on function public.layout_image_in_use(uuid, text) from public, anon;
grant execute on function public.layout_image_in_use(uuid, text) to authenticated, service_role;

alter table public.layout_images enable row level security;
drop policy if exists layout_image_read on public.layout_images;
create policy layout_image_read on public.layout_images for select to authenticated
  using (public.is_platform_admin() or org_id = public.my_org());
-- Signed-in users: renaming only, and only 1Point in E1b (uploads and removals go through the site, which checks the file)
drop policy if exists layout_image_rename on public.layout_images;
create policy layout_image_rename on public.layout_images for update to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());
revoke insert, update, delete on public.layout_images from authenticated, anon;
grant update (name) on public.layout_images to authenticated;
revoke all on public.layout_images from anon;

-- ─────────────────────────────────────────── screen_state (from 29-layout-engine.sql), with a layout's pictures
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

  -- ── A layout screen (E1a; E1b adds its pictures): the layout's published version and the screen's building ──
  if s.layout_id is not null then
    select * into l from public.layouts where id = s.layout_id;
    if l.published_version is not null then
      select * into lv from public.layout_versions where layout_id = l.id and version = l.published_version;
    end if;
    if s.property_id is not null then select * into p from public.properties where id = s.property_id; end if;
    -- A picture's file never changes once made, so the published version alone fixes which pictures it shows
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
