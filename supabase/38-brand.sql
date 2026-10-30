-- DP-13 round T1b: the shop's brand, kept with the menu. Run after 37-sample-menus.sql. Safe to run again.
--
-- A menu's content may now say "brand": { "name", "logo", "colours", "fonts" }: the shop's name (in place of the
-- template's on every board), a logo picture from the account, five colours (bg, ink, accent, panel, highlight; each
-- like #3b2620) and two fonts (display, body; WayTuGo's fonts only). Every board on the menu, the phone menu and sample
-- links draw it (public/layout-format.mjs applyBrand). Only 1Point sets it (Scot, 2026-10-30: the customer provides
-- it on request, 1Point sets it up and sends the final design for their approval): anyone else's save or Restore
-- keeps the brand the menu has. Copying a shop (36's shop_copy) copies it with the menu.

-- ─────────────────────────────────────────── the brand's rules (public/menu-format.mjs brandProblem says the same)
create or replace function public.menu_brand_problem(p_brand jsonb, p_org uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare k text; v jsonb;
begin
  if jsonb_typeof(p_brand) <> 'object' then return 'The brand is { "name", "logo", "colours", "fonts" }.'; end if;
  if exists (select 1 from jsonb_object_keys(p_brand) x where x not in ('name', 'logo', 'colours', 'fonts')) then
    return 'The brand can say name, logo, colours and fonts.';
  end if;
  if p_brand ? 'name' and (jsonb_typeof(p_brand -> 'name') <> 'string' or length(trim(p_brand ->> 'name')) = 0 or length(p_brand ->> 'name') > 60) then
    return 'The shop''s name is 1 to 60 characters.';
  end if;
  if p_brand ? 'logo' then
    if jsonb_typeof(p_brand -> 'logo') <> 'string' or (p_brand ->> 'logo') !~ '^img:[a-z0-9][a-z0-9-]{0,59}$' then return 'The logo is one of the account''s pictures.'; end if;
    if not exists (select 1 from public.layout_images where org_id = p_org and key = substr(p_brand ->> 'logo', 5)) then
      return format('There''s no picture "%s" in this account for the logo.', substr(p_brand ->> 'logo', 5));
    end if;
  end if;
  if p_brand ? 'colours' then
    if jsonb_typeof(p_brand -> 'colours') <> 'object' then return 'The brand''s colours are background, text, accent, dark panel and highlight.'; end if;
    for k, v in select * from jsonb_each(p_brand -> 'colours') loop
      if k not in ('bg', 'ink', 'accent', 'panel', 'highlight') then return 'The brand''s colours are background, text, accent, dark panel and highlight.'; end if;
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^#[0-9a-fA-F]{6}$' then return 'Each brand colour is a colour like #3b2620.'; end if;
    end loop;
  end if;
  if p_brand ? 'fonts' then
    if jsonb_typeof(p_brand -> 'fonts') <> 'object' then return 'The brand''s fonts are for headings and body text.'; end if;
    for k, v in select * from jsonb_each(p_brand -> 'fonts') loop
      if k not in ('display', 'body') then return 'The brand''s fonts are for headings and body text.'; end if;
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('Instrument Sans', 'Lora', 'Oswald', 'Bebas Neue', 'Alfa Slab One', 'Fraunces',
                                                            'Playfair Display', 'Pacifico', 'Crimson Pro', 'Caveat Brush') then
        return format('"%s" isn''t one of WayTuGo''s fonts.', v #>> '{}');
      end if;
    end loop;
  end if;
  return null;
end $$;
revoke all on function public.menu_brand_problem(jsonb, uuid) from public, anon, authenticated;

-- ─────────────────────────────────────────── a menu may say "brand" (35's menu_content_problem, one part more)
create or replace function public.menu_content_problem(p_spec jsonb, p_content jsonb, p_org uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare k text; b jsonb; v_problem text;
begin
  if jsonb_typeof(p_content) <> 'object' then return 'The menu is { "lists": { … } }.'; end if;
  if exists (select 1 from jsonb_object_keys(p_content) x where x not in ('lists', 'boards', 'brand')) then return 'The menu can say only "lists", "boards" and "brand".'; end if;
  -- T1b (DP-13): the shop's brand
  if p_content ? 'brand' then
    v_problem := public.menu_brand_problem(p_content -> 'brand', p_org);
    if v_problem is not null then return 'Brand: ' || v_problem; end if;
  end if;
  if p_content ? 'boards' then
    if jsonb_typeof(p_content -> 'boards') <> 'object' or (select count(*) from jsonb_object_keys(p_content -> 'boards')) > 20 then
      return 'Board look: "boards" is { "<layout id>": { … } }, up to 20.';
    end if;
    for k, b in select * from jsonb_each(p_content -> 'boards') loop
      if k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return 'Board look: each board is named by its layout''s id.'; end if;
      v_problem := public.menu_board_problem(b);
      if v_problem is not null then return 'Board look: ' || v_problem; end if;
    end loop;
  end if;
  return public.menu_lists_problem(p_spec, p_content - 'boards' - 'brand', p_org);
end $$;
revoke all on function public.menu_content_problem(jsonb, jsonb, uuid) from public, anon, authenticated;

-- ─────────────────────────────────────────── only 1Point changes it (33's menu_write, one part more)
create or replace function public.menu_write(p_menu uuid, p_base_rev integer, p_content jsonb, p_from integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  m public.menus%rowtype;
  v_admin boolean := coalesce(public.is_platform_admin(), false);
  v_who text; v_rev integer; v_at timestamptz;
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
