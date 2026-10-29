-- DP-13, round E2d: each board's look and options, chosen in the menu editor and kept with the menu.
-- Run after 34-customer-pictures.sql. Safe to run again.
--
-- A menu's content may now say "boards" beside "lists":
--   { "lists": { … }, "boards": { "<layout id>": { "look": "house" | "chalkboard",
--       "chalk": { "titles": "yellow", "prices": "pink", "accents": "blue" }, "lettering": "sign" | "hand",
--       "frame": false, "options": { "coffee-bar": true } } } }
-- Every value is one of the presets (the six chalk colours, two looks, two letterings), so whatever a customer picks
-- passes the board's contrast check. A save of a look is like any menu save: live at once, kept in History, restorable,
-- only while customer editing is on (WayTuGo always), and it moves every board on the menu to its next version.
-- Also: Restore and Add lists from this layout keep the boards' looks (34 and 33 rebuilt content from its lists only).

-- ─────────────────────────────────────────── one board's look, in plain words
create or replace function public.menu_board_problem(p_board jsonb) returns text
language plpgsql immutable set search_path = public as $$
declare k text; v jsonb;
begin
  if jsonb_typeof(p_board) <> 'object' then return 'Each board''s look is { "look", "chalk", "lettering", "frame", "options" }.'; end if;
  if exists (select 1 from jsonb_object_keys(p_board) x where x not in ('look', 'chalk', 'lettering', 'frame', 'options')) then
    return 'A board''s look can say look, chalk, lettering, frame and options.';
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

-- ─────────────────────────────────────────── the lists' rules, as in 33 (renamed; the menu's own check is below)
create or replace function public.menu_lists_problem(p_spec jsonb, p_content jsonb, p_org uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  k text; c jsonb; l jsonb; e jsonb; f text; v_kind text; v_name text; v_at text; v_cap integer; v_room integer; i integer;
  v_ids text[]; v_allowed text[]; w jsonb;
  v_max  constant jsonb := '{"name": 80, "line": 160, "price": 16, "title": 120, "body": 400}';
  v_label constant jsonb := '{"name": "The name", "line": "The description", "price": "The price", "title": "The heading", "body": "The text"}';
begin
  if jsonb_typeof(p_content) <> 'object' or (p_content ? 'lists' and jsonb_typeof(p_content -> 'lists') <> 'object') then
    return 'The menu is { "lists": { … } }.';
  end if;
  if length(p_content::text) > 262144 then return 'This menu is too large (at most 256 KB).'; end if;
  for k, c in select * from jsonb_each(coalesce(p_content -> 'lists', '{}')) loop
    l := null;
    select x into l from jsonb_array_elements(coalesce(p_spec -> 'lists', '[]')) x where x ->> 'key' = k;
    if l is null then return format('There''s no list "%s" on this menu.', k); end if;
    v_kind := l ->> 'kind'; v_name := l ->> 'name';
    v_room := coalesce((l ->> 'room')::int, 1);
    if jsonb_typeof(c) <> 'object' then return format('"%s": each list is { "entries": [ … ] }.', v_name); end if;
    if exists (select 1 from jsonb_object_keys(c) x where x not in ('entries', 'price', 'note')) then return format('"%s" says something a list can''t.', v_name); end if;
    if c ? 'price' and c ->> 'price' <> '' then
      if not coalesce((l ->> 'groupPrice')::boolean, false) then return format('"%s" has no price over the whole list.', v_name); end if;
      if jsonb_typeof(c -> 'price') <> 'string' or length(c ->> 'price') > 24 then return format('"%s": the list''s price is at most 24 characters.', v_name); end if;
    end if;
    if c ? 'note' and c ->> 'note' <> '' then
      if not coalesce((l ->> 'note')::boolean, false) then return format('"%s" has no note.', v_name); end if;
      if jsonb_typeof(c -> 'note') <> 'string' or length(c ->> 'note') > 80 then return format('"%s": the note is at most 80 characters.', v_name); end if;
    end if;
    if c ? 'entries' and jsonb_typeof(c -> 'entries') <> 'array' then return format('"%s": "entries" is a list.', v_name); end if;
    if jsonb_array_length(coalesce(c -> 'entries', '[]')) > v_room then
      return format('"%s" has room for %s; this has %s. More room is a menu expansion: ask WayTuGo.', v_name, v_room, jsonb_array_length(c -> 'entries'));
    end if;
    v_ids := '{}';
    v_allowed := array['id', 'hidden'] || case v_kind when 'items' then array['soldOut'] else '{}'::text[] end
                 || case when coalesce((l ->> 'schedule')::boolean, false) then array['when'] else '{}'::text[] end
                 || case v_kind when 'hours' then array['days', 'open', 'close'] else array(select jsonb_array_elements_text(coalesce(l -> 'fields', '[]'))) end;
    i := 0;
    for e in select * from jsonb_array_elements(coalesce(c -> 'entries', '[]')) loop
      i := i + 1;
      v_at := format('"%s", %s %s%s', v_name, case v_kind when 'hours' then 'line' when 'text' then 'entry' else 'item' end, i,
                     case when jsonb_typeof(e) = 'object' and coalesce(e ->> 'name', e ->> 'title', '') <> '' then format(' ("%s")', left(coalesce(e ->> 'name', e ->> 'title'), 40)) else '' end);
      if jsonb_typeof(e) <> 'object' then return v_at || ': each entry is an object.'; end if;
      for f in select * from jsonb_object_keys(e) loop
        if not f = any(v_allowed) then
          if f = 'when' then return v_at || ': this list has no dates or times (WayTuGo can switch them on).'; end if;
          return format('%s: "%s" isn''t a box on this list (WayTuGo can add one).', v_at, f);
        end if;
      end loop;
      if coalesce(e ->> 'id', '') !~ '^[a-z0-9]{4,12}$' then return v_at || ': its id is 4 to 12 lowercase letters and digits.'; end if;
      if e ->> 'id' = any(v_ids) then return v_at || ': two entries share an id.'; end if;
      v_ids := v_ids || (e ->> 'id');
      if e ? 'hidden' and jsonb_typeof(e -> 'hidden') <> 'boolean' then return v_at || ': "hidden" is true or false.'; end if;
      if e ? 'soldOut' and coalesce(e ->> 'soldOut', '') !~ '^\d{4}-\d{2}-\d{2}$' then return v_at || ': "soldOut" is a day like 2026-10-29.'; end if;
      for f in select x from jsonb_object_keys(e) x where v_max ? x loop
        v_cap := least((v_max ->> f)::int, coalesce((l -> 'caps' ->> f)::int, (v_max ->> f)::int));
        if jsonb_typeof(e -> f) <> 'string' then return format('%s: %s is text.', v_at, lower(v_label ->> f)); end if;
        if length(e ->> f) > v_cap then return format('%s: %s is %s characters; this list has room for %s.', v_at, v_label ->> f, length(e ->> f), v_cap); end if;
      end loop;
      if e ? 'tags' and (jsonb_typeof(e -> 'tags') <> 'array' or jsonb_array_length(e -> 'tags') > 4
          or exists (select 1 from jsonb_array_elements(e -> 'tags') t where t not in ('"new"', '"seasonal"', '"limited"', '"favorite"'))) then
        return v_at || ': tags are New, Seasonal, Limited and Favorite.';
      end if;
      if e ? 'image' and e ->> 'image' <> '' then
        if coalesce(e ->> 'image', '') !~ '^img:[a-z0-9][a-z0-9-]{0,59}$' then return v_at || ': choose a picture from the account''s pictures.'; end if;
        if not exists (select 1 from public.layout_images where org_id = p_org and key = substr(e ->> 'image', 5)) then
          return format('%s: the picture "%s" isn''t in this account''s pictures.', v_at, substr(e ->> 'image', 5));
        end if;
      end if;
      if e ? 'link' and e ->> 'link' <> '' and (jsonb_typeof(e -> 'link') <> 'string' or length(e ->> 'link') > 300 or e ->> 'link' !~* '^https?://[^\s<>"'']+\.[^\s<>"'']+$') then
        return v_at || ': the web link is an address written in full, like https://donutjoescoffee.com.';
      end if;
      if e ? 'when' then
        w := e -> 'when';
        if jsonb_typeof(w) <> 'object' or exists (select 1 from jsonb_object_keys(w) x where x not in ('dates', 'days', 'from', 'to')) then
          return v_at || ': "when" is dates, days and times.';
        end if;
        if w ? 'dates' and (jsonb_typeof(w -> 'dates') <> 'object'
            or exists (select 1 from jsonb_object_keys(w -> 'dates') x where x not in ('from', 'to'))
            or coalesce(w -> 'dates' ->> 'from', '2000-01-01') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(w -> 'dates' ->> 'to', '2000-01-01') !~ '^\d{4}-\d{2}-\d{2}$'
            or (w -> 'dates' ->> 'from') > (w -> 'dates' ->> 'to')) then
          return v_at || ': the dates are a first and last day, like 2026-09-15 and 2026-11-30, the first not after the last.';
        end if;
        if w ? 'days' and (jsonb_typeof(w -> 'days') <> 'array' or jsonb_array_length(w -> 'days') = 0
            or exists (select 1 from jsonb_array_elements(w -> 'days') d where jsonb_typeof(d) <> 'number' or d::text !~ '^[1-7]$')) then
          return v_at || ': choose at least one day, or leave the days out.';
        end if;
        if (w ? 'from' or w ? 'to') and (coalesce(w ->> 'from', '') !~ '^([01]\d|2[0-4]):[0-5]\d$' or coalesce(w ->> 'to', '') !~ '^([01]\d|2[0-4]):[0-5]\d$' or w ->> 'from' = w ->> 'to') then
          return v_at || ': give both times, from and to, like 11:00 and 14:00 (not the same).';
        end if;
      end if;
      if v_kind = 'items' and trim(coalesce(e ->> 'name', '')) = '' then return v_at || ': an item needs a name.'; end if;
      if v_kind = 'text' and trim(coalesce(e ->> 'title', '')) = '' and trim(coalesce(e ->> 'body', '')) = '' then return v_at || ': write something, or remove the entry.'; end if;
      if v_kind = 'hours' then
        if jsonb_typeof(e -> 'days') is distinct from 'array' or jsonb_array_length(e -> 'days') = 0
           or exists (select 1 from jsonb_array_elements(e -> 'days') d where jsonb_typeof(d) <> 'number' or d::text !~ '^[1-7]$') then
          return v_at || ': choose at least one day.';
        end if;
        if coalesce(e ->> 'open', '') !~ '^([01]\d|2[0-4]):[0-5]\d$' or coalesce(e ->> 'close', '') !~ '^([01]\d|2[0-4]):[0-5]\d$' then
          return v_at || ': give an opening and a closing time, like 06:00 and 18:00.';
        end if;
      end if;
    end loop;
  end loop;
  return null;
end $$;
revoke all on function public.menu_lists_problem(jsonb, jsonb, uuid) from public, anon, authenticated;

-- ─────────────────────────────────────────── the menu's check: lists (as before) and now boards
create or replace function public.menu_content_problem(p_spec jsonb, p_content jsonb, p_org uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare k text; b jsonb; v_problem text;
begin
  if jsonb_typeof(p_content) <> 'object' then return 'The menu is { "lists": { … } }.'; end if;
  if exists (select 1 from jsonb_object_keys(p_content) x where x not in ('lists', 'boards')) then return 'The menu can say only "lists" and "boards".'; end if;
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
  return public.menu_lists_problem(p_spec, p_content - 'boards', p_org);
end $$;
revoke all on function public.menu_content_problem(jsonb, jsonb, uuid) from public, anon, authenticated;

-- ─────────────────────────────────────────── Restore keeps the boards' looks (as in 34)
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
  content := coalesce(p_content, '{}'::jsonb) || jsonb_build_object('lists', v_lists);   -- 35: the boards' looks kept
end $$;
revoke all on function public.menu_strip_missing_pictures(jsonb, uuid) from public, anon, authenticated;

-- ─────────────────────────────────────────── Add lists from this layout keeps them too (as in 33)
create or replace function public.menu_add_lists(p_menu uuid, p_lists jsonb, p_content jsonb, p_by uuid, p_layout uuid, p_draft jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  m public.menus%rowtype; v_rev integer; v_who text; k text;
begin
  select * into m from public.menus where id = p_menu for update;
  if not found then raise exception 'No such menu.' using errcode = 'no_data_found'; end if;
  for k in select x ->> 'key' from jsonb_array_elements(p_lists) x loop
    if exists (select 1 from jsonb_array_elements(m.spec -> 'lists') y where y ->> 'key' = k) then
      raise exception 'The menu "%" already has a list "%".', m.name, k using errcode = 'check_violation';
    end if;
  end loop;
  v_rev := m.rev + 1;
  update public.menus set spec = jsonb_build_object('lists', (m.spec -> 'lists') || p_lists),
                          content = m.content || jsonb_build_object('lists', coalesce(m.content -> 'lists', '{}'::jsonb) || coalesce(p_content, '{}'::jsonb)),   -- 35: boards kept
                          rev = v_rev, updated_by = p_by
   where id = m.id;
  select coalesce(nullif(full_name, ''), email, '') into v_who from public.profiles where user_id = p_by;
  insert into public.menu_revisions (menu_id, rev, content, saved_by, by_name, by_1point)
    select m.id, v_rev, content, p_by, coalesce(v_who, ''), true from public.menus where id = m.id;
  if p_layout is not null then
    update public.layouts set menu_id = m.id, draft = coalesce(p_draft, draft), updated_by = p_by where id = p_layout and org_id = m.org_id;
    if not found then raise exception 'No such layout in that menu''s account.' using errcode = 'no_data_found'; end if;
  end if;
  insert into public.audit_log (user_id, action, entity, entity_id, detail)
    values (p_by, 'add menu lists', 'menu', m.id, jsonb_build_object('layout', p_layout, 'lists', (select jsonb_agg(x ->> 'key') from jsonb_array_elements(p_lists) x)));
  return v_rev;
end $$;
revoke all on function public.menu_add_lists(uuid, jsonb, jsonb, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.menu_add_lists(uuid, jsonb, jsonb, uuid, uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
