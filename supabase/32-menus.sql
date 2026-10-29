-- Lobby Directory: menus, the customer's own lists (DP-12, round E2a).
-- Run in Supabase BEFORE uploading the E2a code: SQL Editor -> New query -> paste -> Run. Safe to run more than once.
-- Then run check-menus.sql; it should end with ALL 10 CHECKS PASSED (red on purpose).
--
-- WayTuGo builds each board from the company's own layout; the customer edits only the lists on it: items, pictures,
-- specials, descriptions, prices, hours, the announcement and the bottom line (Scot, 2026-10-28). Decisions:
--   menus            one set of lists per account content set ("Donut Joe's menu"), feeding every layout that names it:
--                    the counter board, the 32" chalkboard and outdoor stand, and the phone menu. 1Point sets the lists
--                    up (spec: each list's kind, ROOM and which boxes the customer fills, with a length cap per box);
--                    the content is the customer's. Lists are overbuilt (room for about 40 when the menu has 30); only
--                    filled entries show; going past the room is a paid menu expansion, so the database refuses it.
--                    List headings stay in the layout (1Point; the customer asks the company to change one).
--   customer_edit    1Point can always edit; the customer is the secondary editor. Off for a customer on a full
--                    maintenance plan (1Point enters everything).
--   menu_revisions   every save kept, whole, with who saved it and whether it was 1Point; never changed. Restore saves
--                    an earlier one again as a new revision. Changes go live at once, no approval step.
--   menu_save        signed-in users (the menu editor calls it as the user): 1Point, or the account's admins and
--                    editors while customer_edit is on; refuses a save made over someone else's newer one.
--   menu_restore     the same rights; an earlier revision saved again.
--   menu_create      the site only: 1Point's "Make lists from this layout".
--   layouts.menu_id  the layout's menu (same account); a block says {"list": "<key>"} to show one of its lists.
--   screen_state, menu_page   a layout's answer carries its menu (lists), and the pictures the lists use.
--   layout_image_in_use       a picture a menu uses (now, or in any kept revision) can't be removed, so Restore works.

-- ─────────────────────────────────────────── tables

create table if not exists public.menus (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete restrict,
  name           text not null check (length(trim(name)) between 1 and 80),
  customer_edit  boolean not null default true,
  spec           jsonb not null default '{"lists": []}'::jsonb,
  content        jsonb not null default '{"lists": {}}'::jsonb,
  rev            integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users (id) on delete set null,
  constraint menus_size check (pg_column_size(spec) <= 65536 and pg_column_size(content) <= 262144)
);

create table if not exists public.menu_revisions (
  menu_id        uuid not null references public.menus (id) on delete cascade,
  rev            integer not null check (rev >= 1),
  content        jsonb not null,
  saved_at       timestamptz not null default now(),
  saved_by       uuid references auth.users (id) on delete set null,
  by_name        text not null default '',          -- who, as the history shows it (customers can't read 1Point's profiles)
  by_1point      boolean not null default false,    -- saved by 1Point (the errors-and-omissions line in the terms)
  restored_from  integer,                           -- set when this revision is an earlier one saved again
  primary key (menu_id, rev)
);

alter table public.layouts add column if not exists menu_id uuid references public.menus (id) on delete restrict;
create index if not exists layouts_menu on public.layouts (menu_id) where menu_id is not null;

-- ─────────────────────────────────────────── the rules (public/menu-format.mjs says the same, for the console's messages)

-- The lists 1Point sets up. Returns null when they're fine, else what's wrong in plain words.
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
    if exists (select 1 from jsonb_object_keys(l) x where x not in ('key','name','kind','room','fields','caps','groupPrice','note','hint')) then
      return format('The list "%s" says something a list can''t (key, name, kind, room, fields, caps, groupPrice, note, hint).', k);
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
    if l ? 'hint' and (jsonb_typeof(l -> 'hint') <> 'string' or length(l ->> 'hint') > 200) then return format('The list "%s": "hint" is up to 200 characters.', k); end if;
  end loop;
  return null;
end $$;

-- What a customer saves, against the lists (and the account's pictures). Returns null when fine, else what's wrong.
create or replace function public.menu_content_problem(p_spec jsonb, p_content jsonb, p_org uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  k text; c jsonb; l jsonb; e jsonb; f text; v_kind text; v_name text; v_at text; v_cap integer; v_room integer; i integer;
  v_ids text[]; v_allowed text[];
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
      return format('"%s" has room for %s; this has %s. More room is a menu expansion: ask 1Point.', v_name, v_room, jsonb_array_length(c -> 'entries'));
    end if;
    v_ids := '{}';
    v_allowed := array['id', 'hidden'] || case v_kind when 'items' then array['soldOut'] else '{}'::text[] end
                 || case v_kind when 'hours' then array['days', 'open', 'close'] else array(select jsonb_array_elements_text(coalesce(l -> 'fields', '[]'))) end;
    i := 0;
    for e in select * from jsonb_array_elements(coalesce(c -> 'entries', '[]')) loop
      i := i + 1;
      v_at := format('"%s", %s %s%s', v_name, case v_kind when 'hours' then 'line' when 'text' then 'entry' else 'item' end, i,
                     case when jsonb_typeof(e) = 'object' and coalesce(e ->> 'name', e ->> 'title', '') <> '' then format(' ("%s")', left(coalesce(e ->> 'name', e ->> 'title'), 40)) else '' end);
      if jsonb_typeof(e) <> 'object' then return v_at || ': each entry is an object.'; end if;
      for f in select * from jsonb_object_keys(e) loop
        if not f = any(v_allowed) then return format('%s: "%s" isn''t a box on this list (1Point can add one).', v_at, f); end if;
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
revoke all on function public.menu_content_problem(jsonb, jsonb, uuid) from public, anon, authenticated;

-- Every write to a menu is checked: its lists, then its content against them. A list a published layout shows can't be
-- taken off the menu (the screens would lose it); 1Point changes the layout first.
create or replace function public.guard_menu() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_problem text; v_key text; v_layout text;
begin
  v_problem := public.menu_spec_problem(new.spec);
  if v_problem is not null then raise exception '%', v_problem using errcode = 'check_violation'; end if;
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id then raise exception 'A menu stays with its account.' using errcode = 'check_violation'; end if;
    for v_key in select x ->> 'key' from jsonb_array_elements(old.spec -> 'lists') x
                 except select x ->> 'key' from jsonb_array_elements(new.spec -> 'lists') x loop
      select l.name into v_layout from public.layouts l join public.layout_versions v on v.layout_id = l.id and v.version = l.published_version
       where l.menu_id = new.id and jsonb_path_exists(v.doc, '$.blocks[*].content.list ? (@ == $k)', jsonb_build_object('k', v_key)) limit 1;
      if v_layout is not null then
        raise exception 'The list "%" is shown by the layout "%". Take it off that layout (and publish) first.', v_key, v_layout using errcode = 'check_violation';
      end if;
    end loop;
  end if;
  v_problem := public.menu_content_problem(new.spec, new.content, new.org_id);
  if v_problem is not null then raise exception '%', v_problem using errcode = 'check_violation'; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists menus_guard on public.menus;
create trigger menus_guard before insert or update on public.menus for each row execute function public.guard_menu();

create or replace function public.guard_menu_delete() returns trigger
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  select count(*) into n from public.layouts where menu_id = old.id;
  if n > 0 then raise exception 'The menu "%" feeds % layout(s). Choose no menu for them first.', old.name, n using errcode = 'check_violation'; end if;
  return old;
end $$;
drop trigger if exists menus_delete_guard on public.menus;
create trigger menus_delete_guard before delete on public.menus for each row execute function public.guard_menu_delete();

create or replace function public.menu_revisions_frozen() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.menus where id = old.menu_id) then return old; end if;   -- the menu itself went
  raise exception 'Saved revisions are kept as they were. Restore one to use it again.' using errcode = 'check_violation';
end $$;
drop trigger if exists menu_revisions_frozen on public.menu_revisions;
create trigger menu_revisions_frozen before update or delete on public.menu_revisions for each row execute function public.menu_revisions_frozen();

-- A layout's menu belongs to the same account
create or replace function public.guard_layout_menu() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if new.menu_id is null then return new; end if;
  select org_id into v_org from public.menus where id = new.menu_id;
  if v_org is distinct from new.org_id then
    raise exception 'That menu belongs to a different account from the layout "%".', new.name using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists layouts_menu_guard on public.layouts;
create trigger layouts_menu_guard before insert or update of menu_id, org_id on public.layouts for each row execute function public.guard_layout_menu();

-- ─────────────────────────────────────────── saving (as the signed-in user)

-- The one place a menu's content changes. Rights: 1Point always; the account's admins and editors while the menu's
-- customer_edit is on. p_base_rev is the revision the editor opened; a save over someone else's newer one is refused.
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
    raise exception '1Point keeps this menu up to date for you. Contact 1Point for changes.' using errcode = '42501';
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
revoke all on function public.menu_write(uuid, integer, jsonb, integer) from public, anon, authenticated;

create or replace function public.menu_save(p_menu uuid, p_base_rev integer, p_content jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return public.menu_write(p_menu, p_base_rev, p_content, null);
end $$;

create or replace function public.menu_restore(p_menu uuid, p_rev integer, p_base_rev integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_content jsonb;
begin
  if not coalesce(public.is_platform_admin() or exists (select 1 from public.menus where id = p_menu and org_id = public.my_org()), false) then
    raise exception 'That menu doesn''t exist, or you don''t have access to it.' using errcode = '42501';
  end if;
  select content into v_content from public.menu_revisions where menu_id = p_menu and rev = p_rev;
  if not found then raise exception 'This menu has no revision %.', p_rev using errcode = 'no_data_found'; end if;
  return public.menu_write(p_menu, p_base_rev, v_content, p_rev);
end $$;

revoke all on function public.menu_save(uuid, integer, jsonb) from public, anon;
revoke all on function public.menu_restore(uuid, integer, integer) from public, anon;
grant execute on function public.menu_save(uuid, integer, jsonb) to authenticated, service_role;
grant execute on function public.menu_restore(uuid, integer, integer) to authenticated, service_role;

-- "Make lists from this layout" (1Point, through the site): the menu, its first revision, and the layout pointed at it
create or replace function public.menu_create(p_org uuid, p_name text, p_spec jsonb, p_content jsonb, p_by uuid, p_layout uuid, p_draft jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_who text;
begin
  insert into public.menus (org_id, name, spec, content, rev, updated_by) values (p_org, p_name, p_spec, p_content, 1, p_by) returning id into v_id;
  select coalesce(nullif(full_name, ''), email, '') into v_who from public.profiles where user_id = p_by;
  insert into public.menu_revisions (menu_id, rev, content, saved_by, by_name, by_1point) values (v_id, 1, p_content, p_by, coalesce(v_who, ''), true);
  if p_layout is not null then
    update public.layouts set menu_id = v_id, draft = coalesce(p_draft, draft), updated_by = p_by where id = p_layout and org_id = p_org;
    if not found then raise exception 'No such layout in that account.' using errcode = 'no_data_found'; end if;
  end if;
  insert into public.audit_log (user_id, action, entity, entity_id, detail)
    values (p_by, 'make menu', 'menu', v_id, jsonb_build_object('layout', p_layout));
  return v_id;
end $$;
revoke all on function public.menu_create(uuid, text, jsonb, jsonb, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.menu_create(uuid, text, jsonb, jsonb, uuid, uuid, jsonb) to service_role;

-- ─────────────────────────────────────────── access
alter table public.menus enable row level security;
alter table public.menu_revisions enable row level security;

drop policy if exists menu_read on public.menus;
drop policy if exists menu_write on public.menus;
create policy menu_read on public.menus for select to authenticated using (public.is_platform_admin() or org_id = public.my_org());
-- Setting the lists up (name, spec, who edits) and removing a menu: 1Point. The content changes only through menu_save.
create policy menu_write on public.menus for all to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists menu_revision_read on public.menu_revisions;
create policy menu_revision_read on public.menu_revisions for select to authenticated
  using (public.is_platform_admin() or exists (select 1 from public.menus m where m.id = menu_id and m.org_id = public.my_org()));

revoke insert, update, delete on public.menus from authenticated;
grant insert (org_id, name, spec, customer_edit) on public.menus to authenticated;
grant update (name, spec, customer_edit) on public.menus to authenticated;
grant delete on public.menus to authenticated;
revoke insert, update, delete on public.menu_revisions from authenticated, anon;
revoke all on public.menus, public.menu_revisions from anon;

-- A layout's menu is chosen by 1Point (29's layout_write policy), so the column joins 29's grant
grant update (name, family, orientation, menu_id) on public.layouts to authenticated;

-- ─────────────────────────────────────────── pictures a menu uses stay (30-layout-images.sql, with menus)
create or replace function public.layout_image_in_use(p_org uuid, p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.layouts l where l.org_id = p_org and l.draft::text like '%"img:' || p_key || '"%')
      or exists (select 1 from public.layout_versions v join public.layouts l on l.id = v.layout_id
                  where l.org_id = p_org and v.doc::text like '%"img:' || p_key || '"%')
      or exists (select 1 from public.menus m where m.org_id = p_org and m.content::text like '%"img:' || p_key || '"%')
      or exists (select 1 from public.menu_revisions r join public.menus m on m.id = r.menu_id
                  where m.org_id = p_org and r.content::text like '%"img:' || p_key || '"%');
$$;

create or replace function public.layout_image_delete(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  i public.layout_images%rowtype;
  names text;
begin
  select * into i from public.layout_images where id = p_id;
  if not found then raise exception 'No such picture.' using errcode = 'no_data_found'; end if;
  if public.layout_image_in_use(i.org_id, i.key) then
    select string_agg(distinct n, ', ') into names from (
      select l.name as n from public.layouts l
       where l.org_id = i.org_id and (l.draft::text like '%"img:' || i.key || '"%'
          or exists (select 1 from public.layout_versions v where v.layout_id = l.id and v.doc::text like '%"img:' || i.key || '"%'))
      union
      select m.name from public.menus m
       where m.org_id = i.org_id and (m.content::text like '%"img:' || i.key || '"%'
          or exists (select 1 from public.menu_revisions r where r.menu_id = m.id and r.content::text like '%"img:' || i.key || '"%'))) x;
    raise exception 'The picture "%" is used by %, now or in a kept version, so it can''t be removed (Roll back and Restore need it).',
      coalesce(nullif(i.name, ''), i.key), names using errcode = 'check_violation';
  end if;
  delete from public.layout_images where id = p_id;
  return i.path;
end $$;
revoke all on function public.layout_image_delete(uuid) from public, anon, authenticated;
grant execute on function public.layout_image_delete(uuid) to service_role;

-- ─────────────────────────────────────────── the phone page (31-menu-to-go.sql), with the layout's menu
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

-- ─────────────────────────────────────────── screen_state (from 31-menu-to-go.sql), with the layout's menu
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
  m      public.menus%rowtype;
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

  -- ── A layout screen (E1a; E1b its pictures; E1c its menu code; E2a its menu's lists) ──
  if s.layout_id is not null then
    select * into l from public.layouts where id = s.layout_id;
    if l.published_version is not null then
      select * into lv from public.layout_versions where layout_id = l.id and version = l.published_version;
    end if;
    if l.menu_id is not null then select * into m from public.menus where id = l.menu_id; end if;
    if s.property_id is not null then select * into p from public.properties where id = s.property_id; end if;
    -- A saved menu (or its lists set up anew) gives every screen on it a fresh answer within the minute
    v_etag := md5(concat_ws('|', 'layout', 'menu', s.key, s.name, s.orientation, l.id::text, coalesce(l.published_version::text, '-'),
                            l.name, l.menu_code, coalesce(s.identify_until::text, '-'), coalesce(p.updated_at::text, '-'),
                            s.hide_powered_by::text, s.touch::text, coalesce(s.screen_inches::text, '-'), s.touch_idle_s::text,
                            coalesce(m.id::text, '-'), coalesce(m.rev::text, '-'), coalesce(m.updated_at::text, '-')));
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
                                   'doc', case when lv.version is not null then lv.doc end, 'menu_code', l.menu_code),
      'lists', case when m.id is not null then jsonb_build_object('id', m.id, 'spec', m.spec, 'content', m.content) end,
      'images', case when lv.version is null then '{}'::jsonb else coalesce((
        select jsonb_object_agg(i.key, jsonb_build_object('path', i.path, 'w', i.width, 'h', i.height))
          from public.layout_images i
         where i.org_id = l.org_id and (lv.doc::text || coalesce(m.content::text, '')) like '%"img:' || i.key || '"%'), '{}'::jsonb) end,
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
