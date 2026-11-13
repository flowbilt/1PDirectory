-- DP-14 (V4): the menu board in the viewer. Run after 52-viewer-type.sql, BEFORE uploading the V4 code: SQL Editor ->
-- New query -> paste -> Run. Safe to run again. Then run check-viewer-menu.sql; it should end with ALL 5 CHECKS PASSED
-- (red on purpose).
--
-- Scot (2026-11-13): "let's visit the creation of a menu board configuration section. It would change the style of
-- what's showing by a drop-down choice of Menu Board"; a third display choice in step 1; the templates "a pulldown based
-- on the existing samples/templates"; the visitor changes the name, the logo, the look and a few items; the location
-- type stays. So:
--
--   viewer_boards()        the shops in WayTuGo Templates accounts (organizations.kind = 'templates') with their
--                          published boards: the viewer's Template and Board choices, read live, so a template published
--                          later shows by itself. WayTuGo Samples accounts (real shops fitted for prospects) never show.
--   viewer_board(id)       one of those boards as the phone menu's See the board gets it (31's menu_page, not counted as
--                          an open); 'missing' for any board that isn't a published board in a templates account.
--   viewer_config_problem  52's with the menu board: "kind": "menu", "board" (the board's id, or ""), "items" (what the
--                          visitor typed over the sample items: [{ "name", "price" }], 8 at most), and a menu board's
--                          look being one its template may offer (House, Chalkboard, Light, Dark).
-- All three for the site only (service_role), as 48's are.

-- ─────────────────────────────────────────── the templates and their boards
create or replace function public.viewer_boards() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(t order by t ->> 'name'), '[]'::jsonb) from (
    select jsonb_build_object('id', m.id, 'name', m.name, 'boards', jsonb_agg(jsonb_build_object(
             'id', l.id, 'name', l.name, 'orientation', l.orientation,
             'inches', lv.doc #> '{viewing,inches}', 'turns', (lv.doc ? 'turned'), 'looks', coalesce(lv.doc #> '{theme,looks}', '["house"]'::jsonb))
           order by l.name)) as t
      from public.menus m
      join public.organizations o on o.id = m.org_id and o.kind = 'templates'
      join public.layouts l on l.menu_id = m.id and l.published_version is not null
      join public.layout_versions lv on lv.layout_id = l.id and lv.version = l.published_version
     group by m.id, m.name
  ) x;
$$;
revoke all on function public.viewer_boards() from public, anon, authenticated;
grant execute on function public.viewer_boards() to service_role;

create or replace function public.viewer_board(p_layout uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_code text;
begin
  select l.menu_code into v_code from public.layouts l join public.organizations o on o.id = l.org_id and o.kind = 'templates'
   where l.id = p_layout and l.published_version is not null and l.menu_id is not null;
  if v_code is null then return jsonb_build_object('missing', true); end if;
  return public.menu_page(v_code, false);
end $$;
revoke all on function public.viewer_board(uuid) from public, anon, authenticated;
grant execute on function public.viewer_board(uuid) to service_role;

-- ─────────────────────────────────────────── the rules for the choices (= viewer-sample.mjs configProblem)
create or replace function public.viewer_config_problem(c jsonb) returns text
language plpgsql immutable set search_path = public as $$
declare r jsonb;
begin
  if jsonb_typeof(c) is distinct from 'object' then return 'The choices are an object.'; end if;
  if exists (select 1 from jsonb_object_keys(c) k where k not in ('v', 'kind', 'name', 'subtitle', 'tenants', 'shape', 'weather', 'qr', 'places', 'contacts', 'news', 'look', 'logo', 'photo', 'rows', 'type', 'board', 'items')) then
    return 'Something isn''t one of the viewer''s choices.';
  end if;
  if c -> 'v' is distinct from '1'::jsonb and c -> 'v' is distinct from '2'::jsonb then return 'The choices are version 1 or 2.'; end if;
  if jsonb_typeof(c -> 'kind') is distinct from 'string' or c ->> 'kind' not in ('directory', 'touch', 'menu') then return 'The display is a building directory, a touch directory or a menu board.'; end if;
  if jsonb_typeof(c -> 'name') is distinct from 'string' or char_length(c ->> 'name') > 60
     or jsonb_typeof(c -> 'subtitle') is distinct from 'string' or char_length(c ->> 'subtitle') > 60 then
    return 'The name and subtitle are text of up to 60 characters.';
  end if;
  if jsonb_typeof(c -> 'tenants') is distinct from 'number' or (c ->> 'tenants') !~ '^[0-9]+$' or (c ->> 'tenants')::int not between 4 and 60 then
    return 'The tenants are 4 to 60.';
  end if;
  if jsonb_typeof(c -> 'shape') is distinct from 'string' or c ->> 'shape' not in ('landscape', 'portrait') then return 'The screen is landscape or portrait.'; end if;
  if jsonb_typeof(c -> 'weather') is distinct from 'boolean' or jsonb_typeof(c -> 'qr') is distinct from 'boolean'
     or jsonb_typeof(c -> 'places') is distinct from 'boolean' or jsonb_typeof(c -> 'contacts') is distinct from 'boolean' then
    return 'Each extra is on or off.';
  end if;
  if c ? 'news' and jsonb_typeof(c -> 'news') is distinct from 'boolean' then return 'Each extra is on or off.'; end if;
  if c -> 'v' = '1'::jsonb then
    if c ?| array['look', 'logo', 'photo', 'rows', 'type', 'board', 'items'] or c ->> 'kind' = 'menu' then return 'The look, logo, photo, rows, type, board, items and the menu board are version 2''s.'; end if;
    return null;
  end if;
  if (c ->> 'tenants')::int > 20 then return 'The tenants are 4 to 20.'; end if;
  -- V4: a menu board's look is one its template may offer; a directory's is Dark or Light
  if jsonb_typeof(c -> 'look') is distinct from 'string'
     or (c ->> 'kind' <> 'menu' and c ->> 'look' not in ('dark', 'light'))
     or (c ->> 'kind' = 'menu' and c ->> 'look' not in ('house', 'chalkboard', 'light', 'dark')) then
    return 'The look is Dark or Light (or, on a menu board, House, Chalkboard, Light or Dark).';
  end if;
  if jsonb_typeof(c -> 'logo') is distinct from 'string' or c ->> 'logo' not in ('off', 'sample', 'own')
     or jsonb_typeof(c -> 'photo') is distinct from 'string' or c ->> 'photo' not in ('off', 'sample', 'own') then
    return 'The logo and photo are off, the sample or their own.';
  end if;
  if jsonb_typeof(c -> 'rows') is distinct from 'array' or jsonb_array_length(c -> 'rows') > (c ->> 'tenants')::int then
    return 'The rows are a list, one for each tenant at most.';
  end if;
  for r in select * from jsonb_array_elements(c -> 'rows') loop
    if jsonb_typeof(r) <> 'object' or exists (select 1 from jsonb_object_keys(r) k where k not in ('name', 'suite'))
       or jsonb_typeof(r -> 'name') is distinct from 'string' or jsonb_typeof(r -> 'suite') is distinct from 'string'
       or char_length(r ->> 'name') > 60 or char_length(r ->> 'suite') > 12 then
      return 'Each row is a name of up to 60 characters and a suite of up to 12.';
    end if;
  end loop;
  if c ? 'type' and (jsonb_typeof(c -> 'type') is distinct from 'string'
     or c ->> 'type' not in ('', 'office', 'medical', 'government', 'hospitality', 'retail', 'education', 'restaurant', 'other', 'exploring')) then
    return 'The location type isn''t one of the viewer''s.';
  end if;
  -- V4: the menu board's board and the items typed over its samples
  if c ? 'board' and (jsonb_typeof(c -> 'board') is distinct from 'string'
     or (c ->> 'board' <> '' and c ->> 'board' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    return 'The board is one of WayTuGo''s templates.';
  end if;
  if c ? 'items' then
    if jsonb_typeof(c -> 'items') is distinct from 'array' or jsonb_array_length(c -> 'items') > 8 then return 'The items are a list of 8 at most.'; end if;
    for r in select * from jsonb_array_elements(c -> 'items') loop
      if jsonb_typeof(r) <> 'object' or exists (select 1 from jsonb_object_keys(r) k where k not in ('name', 'price'))
         or jsonb_typeof(r -> 'name') is distinct from 'string' or jsonb_typeof(r -> 'price') is distinct from 'string'
         or char_length(r ->> 'name') > 60 or char_length(r ->> 'price') > 16 then
        return 'Each item is a name of up to 60 characters and a price of up to 16.';
      end if;
    end loop;
  end if;
  return null;
end $$;
revoke all on function public.viewer_config_problem(jsonb) from public, anon, authenticated;
