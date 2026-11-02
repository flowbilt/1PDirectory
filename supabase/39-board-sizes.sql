-- DP-13 round T1d: a board's sizes: the QR code's size on the glass and the logo's share of its spot. Run after
-- 38-brand.sql. Safe to run again.
--
-- Scot (2026-11-02): the QR code should be sized for the screen (on a 55" it can take less of the board than on a 32"
-- and still read on a phone), and the logo or shop's name sized to fit its spot. A board's look (35's content.boards)
-- may now say "sizes": { "qr": "s" | "m" | "l" (about 7, 10 and 13 cm on the glass), "logo": 60 to 100 (% of its spot) }.
-- 1Point sets them in the menu editor's Board look; anyone else's save or Restore keeps them as they are, with the
-- brand (38).

-- ─────────────────────────────────────────── the rules (35's menu_board_problem, one part more)
create or replace function public.menu_board_problem(p_board jsonb) returns text
language plpgsql immutable set search_path = public as $$
declare k text; v jsonb;
begin
  if jsonb_typeof(p_board) <> 'object' then return 'Each board''s look is { "look", "chalk", "lettering", "frame", "options" }.'; end if;
  if exists (select 1 from jsonb_object_keys(p_board) x where x not in ('look', 'chalk', 'lettering', 'frame', 'options', 'sizes')) then
    return 'A board''s look can say look, chalk, lettering, frame, options and sizes.';
  end if;
  -- T1d (DP-13): the QR code's size on the glass and the logo's share of its spot
  if p_board ? 'sizes' then
    if jsonb_typeof(p_board -> 'sizes') <> 'object' then return 'A board''s sizes are for the QR code and the logo.'; end if;
    for k, v in select * from jsonb_each(p_board -> 'sizes') loop
      if k = 'qr' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('s', 'm', 'l') then return 'The QR code is Small, Medium or Large.'; end if;
      elsif k = 'logo' then
        if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric not between 60 and 100 or (v #>> '{}')::numeric <> floor((v #>> '{}')::numeric) then
          return 'The logo''s size is 60% to 100% of its spot.';
        end if;
      else return 'A board''s sizes are for the QR code and the logo.';
      end if;
    end loop;
  end if;
  if p_board ? 'look' and coalesce(p_board ->> 'look', '') not in ('house', 'chalkboard') then return 'The look is House or Chalkboard.'; end if;
  if p_board ? 'chalk' then
    if jsonb_typeof(p_board -> 'chalk') <> 'object' then return 'The chalk colours are for titles, prices and accents.'; end if;
    for k, v in select * from jsonb_each(p_board -> 'chalk') loop
      if k not in ('titles', 'prices', 'accents') then return 'The chalk colours are for titles, prices and accents.'; end if;
      if jsonb_typeof(v) <> 'string' or v #>> '{}' not in ('white', 'yellow', 'pink', 'blue', 'green', 'orange') then
        return 'Each chalk colour is white, yellow, pink, blue, green or orange.';
      end if;
    end loop;
  end if;
  if p_board ? 'lettering' and coalesce(p_board ->> 'lettering', '') not in ('sign', 'hand') then return 'The lettering is Sign-writer or Chalk hand.'; end if;
  if p_board ? 'frame' and jsonb_typeof(p_board -> 'frame') <> 'boolean' then return 'The frame is on or off.'; end if;
  if p_board ? 'options' then
    if jsonb_typeof(p_board -> 'options') <> 'object' or (select count(*) from jsonb_object_keys(p_board -> 'options')) > 6 then return 'A board has up to 6 options.'; end if;
    for k, v in select * from jsonb_each(p_board -> 'options') loop
      if k !~ '^[a-z0-9][a-z0-9-]{0,39}$' or jsonb_typeof(v) <> 'boolean' then return 'Each option is ticked or not.'; end if;
    end loop;
  end if;
  return null;
end $$;
revoke all on function public.menu_board_problem(jsonb) from public, anon, authenticated;

-- ─────────────────────────────────────────── only 1Point changes them (38's menu_write, one part more)
create or replace function public.menu_write(p_menu uuid, p_base_rev integer, p_content jsonb, p_from integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  m public.menus%rowtype;
  v_admin boolean := coalesce(public.is_platform_admin(), false);
  v_who text; v_rev integer; v_at timestamptz;
  k text; v_boards jsonb; v_b jsonb;
begin
  select * into m from public.menus where id = p_menu for update;
  if not found or not coalesce(v_admin or (m.org_id = public.my_org() and public.my_role() in ('org_admin', 'org_editor')), false) then
    raise exception 'That menu doesn''t exist, or you don''t have access to it.' using errcode = '42501';
  end if;
  if not v_admin and not m.customer_edit then
    raise exception 'WayTuGo keeps this menu up to date for you. Contact WayTuGo for changes.' using errcode = '42501';
  end if;
  if p_base_rev is distinct from m.rev then
    select by_name, saved_at into v_who, v_at from public.menu_revisions where menu_id = m.id and rev = m.rev;
    raise exception 'Someone else saved this menu after you opened it (%, %). Reload to see their changes, then make yours again.',
      coalesce(nullif(v_who, ''), 'another user'), to_char(v_at at time zone 'America/Chicago', 'Mon FMDD at FMHH12:MI AM') using errcode = '40001';
  end if;
  -- T1b (DP-13): the brand is 1Point's: anyone else's save (or Restore) keeps the brand the menu has now
  if not v_admin then
    p_content := coalesce(p_content, '{"lists": {}}'::jsonb) - 'brand';
    if m.content ? 'brand' then p_content := p_content || jsonb_build_object('brand', m.content -> 'brand'); end if;
    -- T1d (DP-13): and each board's sizes (the QR code, the logo) stay as 1Point set them
    v_boards := coalesce(p_content -> 'boards', '{}'::jsonb);
    for k in select jsonb_object_keys(coalesce(m.content -> 'boards', '{}'::jsonb)) union select jsonb_object_keys(v_boards) loop
      v_b := coalesce(v_boards -> k, '{}'::jsonb) - 'sizes';
      if (m.content -> 'boards' -> k) ? 'sizes' then v_b := v_b || jsonb_build_object('sizes', m.content -> 'boards' -> k -> 'sizes'); end if;
      if v_b = '{}'::jsonb then v_boards := v_boards - k; else v_boards := v_boards || jsonb_build_object(k, v_b); end if;
    end loop;
    p_content := p_content - 'boards';
    if v_boards <> '{}'::jsonb then p_content := p_content || jsonb_build_object('boards', v_boards); end if;
  end if;
  select coalesce(nullif(full_name, ''), email, '') into v_who from public.profiles where user_id = auth.uid();
  v_rev := m.rev + 1;
  update public.menus set content = coalesce(p_content, '{"lists": {}}'::jsonb), rev = v_rev, updated_by = auth.uid() where id = m.id;
  insert into public.menu_revisions (menu_id, rev, content, saved_by, by_name, by_1point, restored_from)
    values (m.id, v_rev, coalesce(p_content, '{"lists": {}}'::jsonb), auth.uid(), coalesce(v_who, ''), v_admin, p_from)
    returning saved_at into v_at;
  return jsonb_build_object('rev', v_rev, 'saved_at', v_at);
end $$;
revoke all on function public.menu_write(uuid, integer, jsonb, integer) from public, anon, authenticated;
