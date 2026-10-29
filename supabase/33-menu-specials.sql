-- Lobby Directory: specials with dates and times, more lists for a menu, and the WayTuGo name (DP-12, round E2b).
-- Run in Supabase BEFORE uploading the E2b code: SQL Editor -> New query -> paste -> Run. Safe to run more than once.
-- Then run check-menu-specials.sql; it should end with ALL 7 CHECKS PASSED (red on purpose).
--
-- Scot's decisions (2026-10-29):
--   schedule        a list WayTuGo sets up with "schedule": true (items or text) lets each entry carry "when": dates
--                   (first and last day), days (1 = Monday to 7 = Sunday) and times (from, to; past midnight works).
--                   Boards and the phone menu show an entry only while its when says so. An entry waiting for its
--                   dates uses up room like any other (room is what's on the list).
--   WayTuGo         customers see the product as WayTuGo, made by 1PointUSA: the database's messages a customer can
--                   see say WayTuGo ("WayTuGo keeps this menu up to date for you…", "…a menu expansion: ask WayTuGo.").
--                   1Point's own screens keep "1Point".
--   menu_add_lists  the site only (1Point's "Add lists from this layout"): more lists on an existing menu, from a
--                   layout's blocks (a second board on the same menu, or blocks not made into lists the first time);
--                   kept as a new revision, made by 1Point.
-- Nothing changes in what screens are sent; a layout's block may now say "showWhen" (the layout format, checked by the
-- site), which needs nothing here.

-- ─────────────────────────────────────────── the lists' settings may say "schedule"
create or replace function public.menu_spec_problem(p_spec jsonb) returns text
language plpgsql immutable set search_path = public as $$
declare
  l jsonb; k text; f text; n integer; v_keys text[] := '{}'; v_kind text; v_max integer;
  v_kinds constant jsonb := '{"items": ["name","line","price","image","tags","link"], "text": ["title","body","link"], "hours": []}';
  v_caps  constant jsonb := '{"name": 80, "line": 160, "price": 16, "title": 120, "body": 400}';
begin
  if jsonb_typeof(p_spec) <> 'object' or jsonb_typeof(p_spec -> 'lists') <> 'array' then return 'The lists are { "lists": [ … ] }.'; end if;
  if exists (select 1 from jsonb_object_keys(p_spec) x where x <> 'lists') then return 'The lists can say only "lists".'; end if;
  if jsonb_array_length(p_spec -> 'lists') > 20 then return 'A menu can have up to 20 lists.'; end if;
  for l in select * from jsonb_array_elements(p_spec -> 'lists') loop
    if jsonb_typeof(l) <> 'object' then return 'Each list is an object.'; end if;
    k := l ->> 'key';
    if k is null or k !~ '^[a-z0-9][a-z0-9-]{0,39}$' then return 'Each list needs a "key": lowercase letters, numbers and dashes, up to 40.'; end if;
    if k = any(v_keys) then return format('Two lists share the key "%s".', k); end if;
    v_keys := v_keys || k;
    if exists (select 1 from jsonb_object_keys(l) x where x not in ('key','name','kind','room','fields','caps','groupPrice','note','hint','schedule')) then
      return format('The list "%s" says something a list can''t (key, name, kind, room, fields, caps, groupPrice, note, hint, schedule).', k);
    end if;
    if jsonb_typeof(l -> 'name') is distinct from 'string' or length(trim(l ->> 'name')) not between 1 and 60 then
      return format('The list "%s" needs a name (up to 60 characters).', k);
    end if;
    v_kind := l ->> 'kind';
    if v_kind is null or not v_kinds ? v_kind then return format('The list "%s": "kind" is items, text or hours.', k); end if;
    v_max := case v_kind when 'items' then 60 when 'text' then 1 else 14 end;
    if l ? 'room' or v_kind <> 'text' then
      if jsonb_typeof(l -> 'room') is distinct from 'number' or (l ->> 'room') !~ '^[0-9]+$' or (l ->> 'room')::int not between 1 and v_max then
        return format('The list "%s": "room" is a whole number from 1 to %s.', k, v_max);
      end if;
    end if;
    if v_kind = 'hours' then
      if l ? 'fields' and l -> 'fields' <> '[]'::jsonb then return format('The hours list "%s" has no "fields".', k); end if;
    else
      if jsonb_typeof(l -> 'fields') is distinct from 'array' or jsonb_array_length(l -> 'fields') = 0 then
        return format('The list "%s": "fields" are the boxes the customer fills.', k);
      end if;
      for f in select * from jsonb_array_elements_text(l -> 'fields') loop
        if not (v_kinds -> v_kind) ? f then return format('The list "%s": "%s" isn''t a box a %s list can have.', k, f, v_kind); end if;
      end loop;
      if v_kind = 'items' and not (l -> 'fields') ? 'name' then return format('The items list "%s" always has "name" among its fields.', k); end if;
    end if;
    if l ? 'caps' then
      if jsonb_typeof(l -> 'caps') <> 'object' then return format('The list "%s": "caps" is { "name": 28 }.', k); end if;
      for f in select * from jsonb_object_keys(l -> 'caps') loop
        if not v_caps ? f or not coalesce(l -> 'fields', '[]') ? f then return format('The list "%s": only its text boxes can have a cap.', k); end if;
        if jsonb_typeof(l -> 'caps' -> f) <> 'number' or (l -> 'caps' ->> f) !~ '^[0-9]+$' or (l -> 'caps' ->> f)::int not between 4 and (v_caps ->> f)::int then
          return format('The list "%s": caps.%s is a whole number from 4 to %s.', k, f, v_caps ->> f);
        end if;
      end loop;
    end if;
    if l ? 'groupPrice' and (jsonb_typeof(l -> 'groupPrice') <> 'boolean' or ((l ->> 'groupPrice')::boolean and v_kind <> 'items')) then
      return format('The list "%s": "groupPrice" is true or false, on an items list.', k);
    end if;
    if l ? 'note' and (jsonb_typeof(l -> 'note') <> 'boolean' or ((l ->> 'note')::boolean and v_kind <> 'hours')) then
      return format('The list "%s": "note" is true or false, on an hours list.', k);
    end if;
    if l ? 'schedule' and (jsonb_typeof(l -> 'schedule') <> 'boolean' or ((l ->> 'schedule')::boolean and v_kind = 'hours')) then
      return format('The list "%s": "schedule" is true or false, on an items or text list.', k);
    end if;
    if l ? 'hint' and (jsonb_typeof(l -> 'hint') <> 'string' or length(l ->> 'hint') > 200) then return format('The list "%s": "hint" is up to 200 characters.', k); end if;
  end loop;
  return null;
end $$;

-- ─────────────────────────────────────────── entries may say "when"; WayTuGo in the messages
create or replace function public.menu_content_problem(p_spec jsonb, p_content jsonb, p_org uuid) returns text
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
  if exists (select 1 from jsonb_object_keys(p_content) x where x <> 'lists') then return 'The menu can say only "lists".'; end if;
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

-- ─────────────────────────────────────────── the one place content changes (32), in WayTuGo's name
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
  select coalesce(nullif(full_name, ''), email, '') into v_who from public.profiles where user_id = auth.uid();
  v_rev := m.rev + 1;
  update public.menus set content = coalesce(p_content, '{"lists": {}}'::jsonb), rev = v_rev, updated_by = auth.uid() where id = m.id;
  insert into public.menu_revisions (menu_id, rev, content, saved_by, by_name, by_1point, restored_from)
    values (m.id, v_rev, coalesce(p_content, '{"lists": {}}'::jsonb), auth.uid(), coalesce(v_who, ''), v_admin, p_from)
    returning saved_at into v_at;
  return jsonb_build_object('rev', v_rev, 'saved_at', v_at);
end $$;

-- More lists on an existing menu (1Point, through the site): the lists' settings and their entries added, a revision
-- kept, and the layout pointed at the menu with its new draft. A key already on the menu is refused (the site picks
-- free ones).
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
                          content = jsonb_build_object('lists', coalesce(m.content -> 'lists', '{}'::jsonb) || coalesce(p_content, '{}'::jsonb)),
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

revoke all on function public.menu_content_problem(jsonb, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.menu_write(uuid, integer, jsonb, integer) from public, anon, authenticated;

notify pgrst, 'reload schema';
