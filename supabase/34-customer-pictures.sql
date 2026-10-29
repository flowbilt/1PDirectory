-- Lobby Directory: customers' own pictures (DP-12, round E2c).
-- Run in Supabase BEFORE uploading the E2c code: SQL Editor -> New query -> paste -> Run. Safe to run more than once.
-- Then run check-customer-pictures.sql; it should end with ALL 8 CHECKS PASSED (red on purpose).
--
-- Scot's decisions (2026-10-29):
--   uploads        an account's Account Admins and Editors add their own pictures in the menu editor (while customer
--                  editing is on for one of its menus), as 1Point does in the Layouts tab. Uploads go through the site,
--                  which reads each file's own bytes before storing it; the rows are still written by the site only.
--   picture_room   at most 100 pictures per account to start; 1Point raises it per account in the console's Accounts
--                  tab (a picture expansion, like a menu expansion). The database refuses the one past it.
--   removing       a picture can't be removed while it's on the boards now: in a menu's lists, or in any layout's
--                  draft or kept version (only 1Point changes layouts, and Roll back needs them). A picture only an
--                  OLD menu save used CAN be removed; restoring that save brings its entries back with an empty picture
--                  box (menu_restore says how many). The site deletes the file from Storage, checks Storage no longer
--                  has it, and only then removes the row (layout_image_check, then layout_image_delete).

-- ─────────────────────────────────────────── the room for pictures, per account
alter table public.organizations add column if not exists picture_room integer not null default 100;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_picture_room_range') then
    alter table public.organizations add constraint organizations_picture_room_range check (picture_room between 0 and 10000);
  end if;
end $$;

create or replace function public.guard_picture_room() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_room integer; v_n integer;
begin
  select picture_room into v_room from public.organizations where id = new.org_id;
  select count(*) into v_n from public.layout_images where org_id = new.org_id;
  if v_n >= coalesce(v_room, 100) then
    raise exception 'This account has % pictures, the most it holds. Remove ones you no longer use, or ask WayTuGo for more room.', v_n
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists layout_images_room on public.layout_images;
create trigger layout_images_room before insert on public.layout_images for each row execute function public.guard_picture_room();

-- ─────────────────────────────────────────── in use = on the boards now (30 and 32 also counted every old menu save)
create or replace function public.layout_image_in_use(p_org uuid, p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.layouts l where l.org_id = p_org and l.draft::text like '%"img:' || p_key || '"%')
      or exists (select 1 from public.layout_versions v join public.layouts l on l.id = v.layout_id
                  where l.org_id = p_org and v.doc::text like '%"img:' || p_key || '"%')
      or exists (select 1 from public.menus m where m.org_id = p_org and m.content::text like '%"img:' || p_key || '"%');
$$;
revoke all on function public.layout_image_in_use(uuid, text) from public, anon;
grant execute on function public.layout_image_in_use(uuid, text) to authenticated, service_role;

-- Refuses, in plain words, while a picture is on the boards; else returns its file's path (the site deletes the file,
-- checks Storage no longer has it, then calls layout_image_delete)
create or replace function public.layout_image_check(p_id uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  i public.layout_images%rowtype;
  v_menus text; v_layouts text;
begin
  select * into i from public.layout_images where id = p_id;
  if not found then raise exception 'That picture is already gone.' using errcode = 'no_data_found'; end if;
  select string_agg(distinct m.name, ', ') into v_menus from public.menus m
   where m.org_id = i.org_id and m.content::text like '%"img:' || i.key || '"%';
  if v_menus is not null then
    raise exception 'The picture "%" is on the boards now (%). Choose another picture for those items first.', coalesce(nullif(i.name, ''), i.key), v_menus
      using errcode = 'check_violation';
  end if;
  select string_agg(distinct l.name, ', ') into v_layouts from public.layouts l
   where l.org_id = i.org_id and (l.draft::text like '%"img:' || i.key || '"%'
      or exists (select 1 from public.layout_versions v where v.layout_id = l.id and v.doc::text like '%"img:' || i.key || '"%'));
  if v_layouts is not null then
    raise exception 'The picture "%" is part of the layout %, so only WayTuGo can take it off. Ask WayTuGo.', coalesce(nullif(i.name, ''), i.key), v_layouts
      using errcode = 'check_violation';
  end if;
  return i.path;
end $$;
revoke all on function public.layout_image_check(uuid) from public, anon, authenticated;
grant execute on function public.layout_image_check(uuid) to service_role;

create or replace function public.layout_image_delete(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_path text;
begin
  v_path := public.layout_image_check(p_id);   -- refuses while it's on the boards
  delete from public.layout_images where id = p_id;
  return v_path;
end $$;
revoke all on function public.layout_image_delete(uuid) from public, anon, authenticated;
grant execute on function public.layout_image_delete(uuid) to service_role;

-- ─────────────────────────────────────────── Restore: entries whose picture has since been removed come back without it
create or replace function public.menu_strip_missing_pictures(p_content jsonb, p_org uuid, out content jsonb, out cleared integer)
language plpgsql stable security definer set search_path = public as $$
declare k text; c jsonb; e jsonb; es jsonb; v_lists jsonb := '{}'::jsonb;
begin
  cleared := 0;
  for k, c in select * from jsonb_each(coalesce(p_content -> 'lists', '{}'::jsonb)) loop
    es := '[]'::jsonb;
    for e in select * from jsonb_array_elements(coalesce(c -> 'entries', '[]'::jsonb)) loop
      if e ? 'image' and coalesce(e ->> 'image', '') <> ''
         and not exists (select 1 from public.layout_images where org_id = p_org and key = substr(e ->> 'image', 5)) then
        e := e - 'image'; cleared := cleared + 1;
      end if;
      es := es || jsonb_build_array(e);
    end loop;
    v_lists := v_lists || jsonb_build_object(k, jsonb_set(c, '{entries}', es));
  end loop;
  content := jsonb_build_object('lists', v_lists);
end $$;
revoke all on function public.menu_strip_missing_pictures(jsonb, uuid) from public, anon, authenticated;

create or replace function public.menu_restore(p_menu uuid, p_rev integer, p_base_rev integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_content jsonb; v_org uuid; s record;
begin
  if not coalesce(public.is_platform_admin() or exists (select 1 from public.menus where id = p_menu and org_id = public.my_org()), false) then
    raise exception 'That menu doesn''t exist, or you don''t have access to it.' using errcode = '42501';
  end if;
  select content into v_content from public.menu_revisions where menu_id = p_menu and rev = p_rev;
  if not found then raise exception 'This menu has no revision %.', p_rev using errcode = 'no_data_found'; end if;
  select org_id into v_org from public.menus where id = p_menu;
  select * into s from public.menu_strip_missing_pictures(v_content, v_org);
  return public.menu_write(p_menu, p_base_rev, s.content, p_rev) || jsonb_build_object('pictures_cleared', s.cleared);
end $$;
revoke all on function public.menu_restore(uuid, integer, integer) from public, anon;
grant execute on function public.menu_restore(uuid, integer, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
