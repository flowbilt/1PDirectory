-- DP-13 round T0: templates, copying a shop, and sample links. Run after 35-board-looks.sql. Safe to run again.
--
--   Accounts      two more types, for 1Point's own accounts: "templates" (WayTuGo Templates: one example shop per kind of
--                 restaurant) and "samples" (WayTuGo Samples: a template fitted to a prospect before an appointment).
--   shop_copy     a menu with every board on it, and the pictures they use, copied into an account as its own (1Point
--                 only, through /api/shops, which copies the picture files first). Nothing is shared with the original.
--   sample_links  a public link to one published board (waytugo.com/s/<name>), for a prospect: 30, 60 or 90 days, then
--                 it ends; 1Point can turn it off at once. Only 1Point sees or makes them.
--   sample_page   what /api/sample sends for a link (the board as the phone menu's "See the board" gets it), counting opens.
--   menu_page     (31/32) a board on no screen takes its building from its newest sample link, before the account's first.

-- ─────────────────────────────────────────── account types
alter table public.organizations drop constraint if exists organizations_kind_check;
alter table public.organizations add constraint organizations_kind_check check (kind in ('owner', 'manager', 'templates', 'samples'));

-- ─────────────────────────────────────────── sample links
create table if not exists public.sample_links (
  slug           text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  layout_id      uuid not null references public.layouts (id) on delete cascade,
  property_id    uuid references public.properties (id) on delete set null,   -- the building the board names (its clock too)
  days           integer not null default 30 check (days in (30, 60, 90)),
  expires_at     timestamptz not null default now() + interval '30 days',
  turned_off_at  timestamptz,
  opens          integer not null default 0,
  last_open_at   timestamptz,
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users (id) on delete set null
);
create index if not exists sample_links_layout on public.sample_links (layout_id);

-- The length counts from when it's set: a new link, or a new length (or the same one again: the console sends a new
-- expires_at to renew), runs that many days from now. The board must be published; the building is the board's account's.
create or replace function public.guard_sample_link() returns trigger
language plpgsql security definer set search_path = public as $$
declare l public.layouts%rowtype; v_org uuid;
begin
  if tg_op = 'UPDATE' then
    if new.slug <> old.slug or new.layout_id <> old.layout_id or new.created_at <> old.created_at or new.created_by is distinct from old.created_by then
      raise exception 'A sample link keeps its name and its board. Make a new link instead.' using errcode = 'check_violation';
    end if;
    if new.days <> old.days or new.expires_at <> old.expires_at then new.expires_at := now() + make_interval(days => new.days); end if;
    -- the opens are the site's to count (signed-in users may change only the building, the length and turning it off)
  else
    select * into l from public.layouts where id = new.layout_id;
    if not found then raise exception 'No such board.' using errcode = 'check_violation'; end if;
    if l.published_version is null then
      raise exception 'Publish the board "%" first, so the sample has something to show.', l.name using errcode = 'check_violation';
    end if;
    new.slug := lower(new.slug);
    new.expires_at := now() + make_interval(days => new.days);
    new.created_at := now(); new.opens := 0; new.last_open_at := null;
    new.created_by := coalesce(auth.uid(), new.created_by);
  end if;
  if new.property_id is not null then
    select org_id into v_org from public.properties where id = new.property_id;
    if v_org is distinct from (select org_id from public.layouts where id = new.layout_id) then
      raise exception 'Choose a building in the board''s own account.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_sample_link() from public, anon, authenticated;
drop trigger if exists sample_links_guard on public.sample_links;
create trigger sample_links_guard before insert or update on public.sample_links for each row execute function public.guard_sample_link();

alter table public.sample_links enable row level security;
drop policy if exists sample_link_admin on public.sample_links;
create policy sample_link_admin on public.sample_links for all to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());
revoke all on public.sample_links from anon, authenticated;
grant select, delete on public.sample_links to authenticated;
grant insert (slug, layout_id, property_id, days) on public.sample_links to authenticated;
grant update (property_id, days, expires_at, turned_off_at) on public.sample_links to authenticated;

-- ─────────────────────────────────────────── the phone menu's building (31/32's menu_page, one line more)
create or replace function public.menu_page(p_code text, p_count boolean default true) returns jsonb
language plpgsql set search_path = public as $$
declare
  l  public.layouts%rowtype;
  lv public.layout_versions%rowtype;
  p  public.properties%rowtype;
  m  public.menus%rowtype;
begin
  select * into l from public.layouts where menu_code = upper(coalesce(p_code, ''));
  if not found or l.published_version is null then return jsonb_build_object('missing', true); end if;
  select * into lv from public.layout_versions where layout_id = l.id and version = l.published_version;
  if l.menu_id is not null then select * into m from public.menus where id = l.menu_id; end if;
  select pr.* into p from public.screens s join public.properties pr on pr.id = s.property_id
   where s.layout_id = l.id order by s.last_seen desc nulls last limit 1;
  -- T0 (DP-13): a board on no screen yet (a sample) names the building of its newest sample link that's still open
  if not found then
    select pr.* into p from public.sample_links sl join public.properties pr on pr.id = sl.property_id
     where sl.layout_id = l.id and sl.turned_off_at is null and sl.expires_at > now() order by sl.created_at desc limit 1;
  end if;
  if not found then select * into p from public.properties where org_id = l.org_id order by name limit 1; end if;
  if p_count then
    insert into public.menu_scans (layout_id, day, scans) values (l.id, (now() at time zone 'America/Chicago')::date, 1)
      on conflict (layout_id, day) do update set scans = public.menu_scans.scans + 1;
  end if;
  return jsonb_build_object(
    'layout', jsonb_build_object('id', l.id, 'name', l.name, 'orientation', l.orientation, 'version', lv.version, 'doc', lv.doc,
                                 'menu_code', l.menu_code),
    'lists', case when m.id is not null then jsonb_build_object('id', m.id, 'spec', m.spec, 'content', m.content) end,
    'images', coalesce((
      select jsonb_object_agg(i.key, jsonb_build_object('path', i.path, 'w', i.width, 'h', i.height))
        from public.layout_images i
       where i.org_id = l.org_id and (lv.doc::text || coalesce(m.content::text, '')) like '%"img:' || i.key || '"%'), '{}'::jsonb),
    'prop', case when p.id is not null then jsonb_build_object('id', p.id, 'name', p.name, 'address', p.address, 'timezone', p.timezone,
                                                                'lat', p.lat, 'lon', p.lon, 'updated_at', p.updated_at) end);
end $$;
revoke all on function public.menu_page(text, boolean) from public, anon, authenticated;
grant execute on function public.menu_page(text, boolean) to service_role;

-- ─────────────────────────────────────────── a sample link's page
-- { missing } for no such link; { ended, until } once it's turned off or past its date; otherwise menu_page's answer for
-- its board, the link's building, and { sample: { slug, until } }. p_open counts an open (the page's first load only).
create or replace function public.sample_page(p_slug text, p_open boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.sample_links%rowtype; r jsonb; p public.properties%rowtype;
begin
  select * into s from public.sample_links where slug = lower(coalesce(p_slug, ''));
  if not found then return jsonb_build_object('missing', true); end if;
  if s.turned_off_at is not null or s.expires_at <= now() then
    return jsonb_build_object('ended', true, 'until', least(s.expires_at, coalesce(s.turned_off_at, s.expires_at)));
  end if;
  r := public.menu_page((select menu_code from public.layouts where id = s.layout_id), false);
  if r ? 'missing' then return r; end if;
  if s.property_id is not null then
    select * into p from public.properties where id = s.property_id;
    if found then
      r := r || jsonb_build_object('prop', jsonb_build_object('id', p.id, 'name', p.name, 'address', p.address, 'timezone', p.timezone,
                                                              'lat', p.lat, 'lon', p.lon, 'updated_at', p.updated_at));
    end if;
  end if;
  if p_open then update public.sample_links set opens = opens + 1, last_open_at = now() where slug = s.slug; end if;
  return r || jsonb_build_object('sample', jsonb_build_object('slug', s.slug, 'until', s.expires_at));
end $$;
revoke all on function public.sample_page(text, boolean) from public, anon, authenticated;
grant execute on function public.sample_page(text, boolean) to service_role;

-- ─────────────────────────────────────────── copying a shop (1Point, through /api/shops)
-- p_content: the menu's content with its boards' looks under the new boards' ids, and picture keys as in p_images;
-- p_layouts: [{ id (new), from (a board on p_from), name, draft, doc (its published version, as copied; null if none) }];
-- p_images: [{ key, name, path, mime, width, height, bytes }], the files already copied into the account's folder;
-- p_property: null, or { name, address, lat, lon, timezone } for a new building in that account.
-- One transaction: if anything is refused, nothing is kept (the site then removes the copied files).
create or replace function public.shop_copy(p_from uuid, p_org uuid, p_name text, p_content jsonb, p_layouts jsonb, p_images jsonb, p_property jsonb, p_by uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  src public.menus%rowtype; l public.layouts%rowtype; x jsonb; k text;
  v_menu uuid; v_room integer; v_have integer; v_prop uuid; v_who text; v_ids uuid[] := '{}'; v_out jsonb := '[]'::jsonb;
begin
  select * into src from public.menus where id = p_from;
  if not found then raise exception 'No such menu.' using errcode = 'no_data_found'; end if;
  select picture_room into v_room from public.organizations where id = p_org;
  if not found then raise exception 'No such account.' using errcode = 'no_data_found'; end if;
  if jsonb_typeof(p_layouts) <> 'array' or jsonb_array_length(p_layouts) = 0 then
    raise exception 'The menu "%" has no boards to copy.', src.name using errcode = 'check_violation';
  end if;

  -- the pictures: room first, then each file's row in the account (the files are already in its own folder)
  select count(*) into v_have from public.layout_images where org_id = p_org;
  if v_have + jsonb_array_length(coalesce(p_images, '[]'::jsonb)) > v_room then
    raise exception 'That account has room for % pictures and has % already; this shop brings %. Give it more room under Accounts first.',
      v_room, v_have, jsonb_array_length(p_images) using errcode = 'check_violation';
  end if;
  for x in select * from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) loop
    if left(x ->> 'path', 37) <> p_org::text || '/' then raise exception 'A copied picture must be in the account''s own folder.' using errcode = 'check_violation'; end if;
    insert into public.layout_images (org_id, key, name, path, mime, width, height, bytes, created_by)
      values (p_org, x ->> 'key', coalesce(x ->> 'name', ''), x ->> 'path', x ->> 'mime', (x ->> 'width')::int, (x ->> 'height')::int, (x ->> 'bytes')::int, p_by);
  end loop;

  -- the menu, with its first save (its history starts here)
  insert into public.menus (org_id, name, customer_edit, spec, content, rev, updated_by)
    values (p_org, left(trim(p_name), 80), src.customer_edit, src.spec, p_content, 1, p_by) returning id into v_menu;
  select coalesce(nullif(full_name, ''), email, '') into v_who from public.profiles where user_id = p_by;
  insert into public.menu_revisions (menu_id, rev, content, saved_by, by_name, by_1point) values (v_menu, 1, p_content, p_by, coalesce(v_who, ''), true);

  -- every board, published as it was (version 1 of the copy), each with its own new phone-menu code
  for x in select * from jsonb_array_elements(p_layouts) loop
    select * into l from public.layouts where id = (x ->> 'from')::uuid and menu_id = p_from;
    if not found then raise exception 'A board to copy isn''t on the menu "%".', src.name using errcode = 'check_violation'; end if;
    insert into public.layouts (id, org_id, name, family, orientation, draft, menu_id, updated_by)
      values ((x ->> 'id')::uuid, p_org, left(trim(x ->> 'name'), 80), l.family, l.orientation, coalesce(x -> 'draft', '{}'::jsonb), v_menu, p_by);
    if jsonb_typeof(x -> 'doc') = 'object' then
      insert into public.layout_versions (layout_id, version, doc, checks, overridden, note, published_by)
        values ((x ->> 'id')::uuid, 1, x -> 'doc', '{}'::jsonb, false, left('Copied from "' || l.name || '"', 200), p_by);
      update public.layouts set published_version = 1, published_at = now() where id = (x ->> 'id')::uuid;
    end if;
    v_ids := v_ids || (x ->> 'id')::uuid;
    v_out := v_out || jsonb_build_object('id', x ->> 'id', 'from', x ->> 'from', 'name', left(trim(x ->> 'name'), 80));
  end loop;
  -- a board's look in the copy belongs to one of the copy's boards
  for k in select jsonb_object_keys(coalesce(p_content -> 'boards', '{}'::jsonb)) loop
    if not (k::uuid = any (v_ids)) then raise exception 'A board look in the copy names a board that isn''t in it.' using errcode = 'check_violation'; end if;
  end loop;

  if p_property is not null and jsonb_typeof(p_property) = 'object' then
    insert into public.properties (org_id, name, address, lat, lon, timezone, updated_by)
      values (p_org, left(trim(p_property ->> 'name'), 80), left(coalesce(p_property ->> 'address', ''), 200),
              (p_property ->> 'lat')::double precision, (p_property ->> 'lon')::double precision,
              coalesce(nullif(p_property ->> 'timezone', ''), 'America/Chicago'), p_by)
      returning id into v_prop;
  end if;

  insert into public.audit_log (user_id, action, entity, entity_id, detail)
    values (p_by, 'copy shop', 'menu', v_menu, jsonb_build_object('from', p_from, 'org', p_org, 'boards', jsonb_array_length(p_layouts), 'pictures', jsonb_array_length(coalesce(p_images, '[]'::jsonb))));
  return jsonb_build_object('menu_id', v_menu, 'layouts', v_out, 'property_id', v_prop);
end $$;
revoke all on function public.shop_copy(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.shop_copy(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, uuid) to service_role;
