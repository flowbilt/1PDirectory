-- Confirms 36-templates.sql works. Run after 36: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 8 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Sample links are made, changed and refused as signed-in users, as the console does it.
do $$
declare
  u_admin  uuid := gen_random_uuid();
  u_owner  uuid := gen_random_uuid();
  v_tpl    uuid; v_smp uuid; v_cust uuid;
  v_menu   uuid; v_lay uuid; v_lay2 uuid; v_prop uuid; v_new_l uuid := gen_random_uuid(); v_new_l2 uuid := gen_random_uuid();
  r        jsonb; v_code text; v_n integer; v_until timestamptz;
  v_spec   jsonb := '{"lists": [{"key": "specials", "name": "Today''s specials", "kind": "items", "room": 6, "fields": ["name", "price", "image"]}]}';
  v_doc    jsonb := '{"format": 1, "orientation": "landscape", "grid": {"cols": 12, "rows": 12}, "blocks": [{"id": "specials", "type": "items", "at": [1, 1, 12, 12], "content": {"list": "specials"}}]}';
  fails    text[] := '{}';
begin
  -- 1. The two new account types
  insert into public.organizations (name, kind) values ('Templates test', 'templates') returning id into v_tpl;
  insert into public.organizations (name, kind) values ('Samples test', 'samples') returning id into v_smp;
  insert into public.organizations (name, kind) values ('Customer test', 'owner') returning id into v_cust;
  begin
    insert into public.organizations (name, kind) values ('Bad type', 'restaurant');
    fails := fails || '1 any type'::text;
  exception when check_violation then null;
  end;

  insert into auth.users (id, email) values (u_admin, 'tpl-admin@example.com'), (u_owner, 'tpl-owner@example.com');
  insert into public.profiles (user_id, email, full_name, role, org_id) values
    (u_admin, 'tpl-admin@example.com', 'Tpl Admin', 'platform_admin', null),
    (u_owner, 'tpl-owner@example.com', 'Tpl Owner', 'org_admin', v_cust);

  -- a template shop: a picture, a menu using it, two boards (one published), a look for the published one
  insert into public.layout_images (org_id, key, name, path, mime, width, height, bytes)
    values (v_tpl, 'latte', 'Latte', v_tpl::text || '/latte-aaaa1111.webp', 'image/webp', 800, 600, 1000);
  insert into public.menus (org_id, name, spec, content) values (v_tpl, 'Coffee template', v_spec,
    '{"lists": {"specials": {"entries": [{"id": "sp0001", "name": "Latte", "price": "$4", "image": "img:latte"}]}}}') returning id into v_menu;
  insert into public.layouts (org_id, name, orientation, menu_id, draft) values (v_tpl, 'Coffee 55', 'landscape', v_menu, v_doc) returning id into v_lay;
  insert into public.layouts (org_id, name, orientation, menu_id, draft) values (v_tpl, 'Coffee 32 draft', 'landscape', v_menu, v_doc) returning id into v_lay2;
  perform public.layout_publish(v_lay, v_doc, '{}', false, '', u_admin);
  update public.menus set content = content || jsonb_build_object('boards', jsonb_build_object(v_lay::text, '{"look": "chalkboard"}'::jsonb)) where id = v_menu;

  -- 2. shop_copy: into the samples account, the picture's row in its own folder, a building, both boards
  r := public.shop_copy(v_menu, v_smp, 'Salvatore''s sample',
         '{"lists": {"specials": {"entries": [{"id": "sp0001", "name": "Latte", "price": "$4", "image": "img:latte"}]}}}'::jsonb
           || jsonb_build_object('boards', jsonb_build_object(v_new_l::text, '{"look": "chalkboard"}'::jsonb)),
         jsonb_build_array(jsonb_build_object('id', v_new_l, 'from', v_lay, 'name', 'Salvatore''s 55', 'draft', v_doc, 'doc', v_doc),
                           jsonb_build_object('id', v_new_l2, 'from', v_lay2, 'name', 'Salvatore''s 32', 'draft', v_doc, 'doc', null)),
         jsonb_build_array(jsonb_build_object('key', 'latte', 'name', 'Latte', 'path', v_smp::text || '/latte-bbbb2222.webp', 'mime', 'image/webp', 'width', 800, 'height', 600, 'bytes', 1000)),
         '{"name": "Salvatore''s Pizza", "address": "1 Main St", "lat": 33.6, "lon": -86.8, "timezone": "America/Chicago"}', u_admin);
  if (select count(*) from public.layouts where menu_id = (r ->> 'menu_id')::uuid and org_id = v_smp) <> 2
     or (select published_version from public.layouts where id = v_new_l) is distinct from 1
     or (select published_version from public.layouts where id = v_new_l2) is not null
     or (select menu_code from public.layouts where id = v_new_l) = (select menu_code from public.layouts where id = v_lay)
     or (select content -> 'boards' -> v_new_l::text ->> 'look' from public.menus where id = (r ->> 'menu_id')::uuid) is distinct from 'chalkboard'
     or (select rev from public.menus where id = (r ->> 'menu_id')::uuid) <> 1
     or not exists (select 1 from public.menu_revisions where menu_id = (r ->> 'menu_id')::uuid and rev = 1)
     or not exists (select 1 from public.layout_images where org_id = v_smp and key = 'latte')
     or (select name from public.properties where id = (r ->> 'property_id')::uuid and org_id = v_smp) is distinct from 'Salvatore''s Pizza'
     or (select content -> 'lists' -> 'specials' -> 'entries' -> 0 ->> 'name' from public.menus where id = v_menu) is distinct from 'Latte' then
    fails := fails || format('2 copy %s', r);
  end if;
  v_prop := (r ->> 'property_id')::uuid;

  -- 3. Refused, and nothing kept: a picture outside the account's folder, past the account's room, a look naming another board
  begin
    perform public.shop_copy(v_menu, v_cust, 'X', '{"lists": {}}', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'from', v_lay, 'name', 'X', 'draft', v_doc, 'doc', null)),
      jsonb_build_array(jsonb_build_object('key', 'latte', 'name', 'Latte', 'path', v_tpl::text || '/latte-cccc.webp', 'mime', 'image/webp', 'width', 8, 'height', 8, 'bytes', 1)), null, u_admin);
    fails := fails || '3 a picture in another account''s folder'::text;
  exception when check_violation then null;
  end;
  update public.organizations set picture_room = 0 where id = v_cust;
  begin
    perform public.shop_copy(v_menu, v_cust, 'X', '{"lists": {}}', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'from', v_lay, 'name', 'X', 'draft', v_doc, 'doc', null)),
      jsonb_build_array(jsonb_build_object('key', 'latte', 'name', 'Latte', 'path', v_cust::text || '/latte-cccc.webp', 'mime', 'image/webp', 'width', 8, 'height', 8, 'bytes', 1)), null, u_admin);
    fails := fails || '3 past the room'::text;
  exception when check_violation then if sqlerrm not like '%Give it more room under Accounts first.%' then fails := fails || format('3 message: %s', sqlerrm); end if;
  end;
  update public.organizations set picture_room = 100 where id = v_cust;
  begin
    perform public.shop_copy(v_menu, v_cust, 'X', jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_lay::text, '{"look": "house"}'::jsonb)),
      jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'from', v_lay, 'name', 'X', 'draft', v_doc, 'doc', null)), '[]', null, u_admin);
    fails := fails || '3 a look naming another board'::text;
  exception when check_violation then null;
  end;
  if exists (select 1 from public.menus where org_id = v_cust) or exists (select 1 from public.layouts where org_id = v_cust) then fails := fails || '3 something kept'::text; end if;

  -- 4. 1Point (signed in) makes a sample link for the copied board: lower case, 30 days from now; the owner can't see or make one
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  insert into public.sample_links (slug, layout_id, property_id, days) values ('Demo-Salvatores', v_new_l, v_prop, 30);
  begin
    insert into public.sample_links (slug, layout_id, days) values ('demo-unpublished', v_new_l2, 30);
    fails := fails || '4 an unpublished board'::text;
  exception when check_violation then if sqlerrm not like '%Publish the board%' then fails := fails || format('4 message: %s', sqlerrm); end if;
  end;
  begin
    insert into public.sample_links (slug, layout_id, days) values ('demo-long', v_new_l, 120);
    fails := fails || '4 120 days'::text;
  exception when check_violation then null;
  end;
  begin
    insert into public.sample_links (slug, layout_id, property_id, days) values ('demo-wrong-building', v_new_l, (select id from public.properties where org_id <> v_smp limit 1), 30);
    fails := fails || '4 another account''s building'::text;
  exception when check_violation then null;
  end;
  perform set_config('role', 'none', true);
  if (select expires_at::date from public.sample_links where slug = 'demo-salvatores') <> (now() + interval '30 days')::date
     or (select created_by from public.sample_links where slug = 'demo-salvatores') is distinct from u_admin then
    fails := fails || '4 not as made'::text;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  if exists (select 1 from public.sample_links) then fails := fails || '4 the owner sees sample links'::text; end if;
  begin
    insert into public.sample_links (slug, layout_id, days) values ('owner-made', v_new_l, 30);
    fails := fails || '4 the owner made one'::text;
  exception when insufficient_privilege or check_violation then null;
  end;
  perform set_config('role', 'none', true);

  -- 5. The page: the board, the link's building, counted only when asked; the board's phone menu names that building too
  r := public.sample_page('DEMO-salvatores', true);
  if r ->> 'missing' is not null or r -> 'layout' ->> 'id' <> v_new_l::text or r -> 'prop' ->> 'name' <> 'Salvatore''s Pizza'
     or r -> 'sample' ->> 'slug' <> 'demo-salvatores' or r -> 'images' -> 'latte' is null then
    fails := fails || format('5 page %s', left(r::text, 300));
  end if;
  perform public.sample_page('demo-salvatores', false);
  if (select opens from public.sample_links where slug = 'demo-salvatores') <> 1 then fails := fails || '5 opens'::text; end if;
  select menu_code into v_code from public.layouts where id = v_new_l;
  if public.menu_page(v_code, false) -> 'prop' ->> 'name' is distinct from 'Salvatore''s Pizza' then fails := fails || '5 the phone menu''s building'::text; end if;
  if (public.sample_page('no-such-link') ->> 'missing') is null then fails := fails || '5 missing'::text; end if;

  -- 6. 1Point changes the length (from today), turns it off: the page then says it ended; the opens can't be set by hand
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  update public.sample_links set days = 90 where slug = 'demo-salvatores';
  begin
    update public.sample_links set opens = 50 where slug = 'demo-salvatores';
    fails := fails || '6 opens set by hand'::text;
  exception when insufficient_privilege or check_violation then null;
  end;
  begin
    update public.sample_links set layout_id = v_lay where slug = 'demo-salvatores';
    fails := fails || '6 another board'::text;
  exception when insufficient_privilege or check_violation then null;
  end;
  perform set_config('role', 'none', true);
  if (select expires_at::date from public.sample_links where slug = 'demo-salvatores') <> (now() + interval '90 days')::date then fails := fails || '6 90 days'::text; end if;
  perform set_config('role', 'authenticated', true);
  update public.sample_links set turned_off_at = now() where slug = 'demo-salvatores';
  perform set_config('role', 'none', true);
  r := public.sample_page('demo-salvatores', true);
  if (r ->> 'ended') is null or r ? 'layout' then fails := fails || format('6 turned off %s', left(r::text, 200)); end if;
  if (select opens from public.sample_links where slug = 'demo-salvatores') <> 1 then fails := fails || '6 an ended link counted'::text; end if;

  -- 7. Past its date it ends too (set back by the site's own key, as only a test would)
  insert into public.sample_links (slug, layout_id, days) values ('demo-old', v_new_l, 30);
  alter table public.sample_links disable trigger sample_links_guard;
  update public.sample_links set expires_at = now() - interval '1 day' where slug = 'demo-old';
  alter table public.sample_links enable trigger sample_links_guard;
  if (public.sample_page('demo-old') ->> 'ended') is null then fails := fails || '7 past its date'::text; end if;

  -- 8. The functions are the site's alone
  if has_function_privilege('authenticated', 'public.shop_copy(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.sample_page(text, boolean)', 'execute')
     or has_function_privilege('anon', 'public.sample_page(text, boolean)', 'execute')
     or has_table_privilege('anon', 'public.sample_links', 'select') then
    fails := fails || '8 permissions'::text;
  end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL 8 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
