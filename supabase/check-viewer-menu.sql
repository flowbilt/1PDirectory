-- Confirms 53-viewer-menu.sql works. Run after 53: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 5 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Boards are made and published as 1Point; the viewer's calls run as the site (service_role); then as a customer.
do $$
declare
  u_admin uuid := gen_random_uuid(); u_owner uuid := gen_random_uuid();
  v_tpl uuid; v_smp uuid; v_cust uuid; v_mt uuid; v_ms uuid; v_mc uuid; v_lt uuid; v_lt2 uuid; v_ls uuid; v_lc uuid; r jsonb; b jsonb; v_n int;
  v_doc jsonb := '{"format": 1, "orientation": "landscape", "grid": {"cols": 12, "rows": 12}, "viewing": {"inches": 55, "metres": 3}, "theme": {"looks": ["house", "chalkboard"]}, "blocks": [{"id": "t", "type": "text", "at": [1, 1, 12, 12], "content": {"title": "Hi"}}]}';
  fails text[] := '{}';
  c jsonb := '{"v": 2, "kind": "menu", "name": "Viewer menu test", "subtitle": "", "tenants": 10, "shape": "landscape", "weather": true, "qr": false, "places": false, "contacts": true, "news": false,
               "look": "chalkboard", "logo": "sample", "photo": "off", "rows": [], "type": "restaurant", "board": "00000000-0000-4000-8000-000000000000", "items": [{"name": "Cortado", "price": "$4.25"}]}';
begin
  insert into auth.users (id, email) values (u_admin, 'vmenu-admin@example.com'), (u_owner, 'vmenu-owner@example.com');
  insert into public.profiles (user_id, email, full_name, role, org_id) values (u_admin, 'vmenu-admin@example.com', 'V Admin', 'platform_admin', null);
  insert into public.organizations (name, kind) values ('Viewer menu templates', 'templates') returning id into v_tpl;
  insert into public.organizations (name, kind) values ('Viewer menu samples', 'samples') returning id into v_smp;
  insert into public.organizations (name, kind) values ('Viewer menu customer', 'owner') returning id into v_cust;
  insert into public.profiles (user_id, email, role, org_id) values (u_owner, 'vmenu-owner@example.com', 'org_admin', v_cust);
  insert into public.menus (org_id, name, spec) values (v_tpl, 'AAA Viewer Test Template', '{"lists": []}') returning id into v_mt;
  insert into public.menus (org_id, name, spec) values (v_smp, 'Viewer Test Sample Shop', '{"lists": []}') returning id into v_ms;
  insert into public.menus (org_id, name, spec) values (v_cust, 'Viewer Test Customer Shop', '{"lists": []}') returning id into v_mc;
  insert into public.layouts (org_id, name, orientation, draft, menu_id) values (v_tpl, 'Counter board', 'landscape', v_doc, v_mt) returning id into v_lt;
  insert into public.layouts (org_id, name, orientation, draft, menu_id) values (v_tpl, 'Never published', 'landscape', v_doc, v_mt) returning id into v_lt2;
  insert into public.layouts (org_id, name, orientation, draft, menu_id) values (v_smp, 'Sample board', 'landscape', v_doc, v_ms) returning id into v_ls;
  insert into public.layouts (org_id, name, orientation, draft, menu_id) values (v_cust, 'Customer board', 'landscape', v_doc, v_mc) returning id into v_lc;
  perform public.layout_publish(v_lt, v_doc, '{}', false, '', u_admin);
  perform public.layout_publish(v_ls, v_doc, '{}', false, '', u_admin);
  perform public.layout_publish(v_lc, v_doc, '{}', false, '', u_admin);

  perform set_config('role', 'service_role', true);
  -- 1. The templates' published boards are listed, with their size and looks; samples, customers and drafts aren't
  r := public.viewer_boards();
  select t into b from jsonb_array_elements(r) t where t ->> 'id' = v_mt::text;
  if b is null or jsonb_array_length(b -> 'boards') <> 1 or b #>> '{boards,0,name}' <> 'Counter board' or b #>> '{boards,0,inches}' <> '55'
     or b #> '{boards,0,looks}' <> '["house", "chalkboard"]'::jsonb or (b #>> '{boards,0,turns}')::boolean then
    fails := fails || format('1 the template: %s', left(coalesce(b::text, 'none'), 200));
  end if;
  if exists (select 1 from jsonb_array_elements(r) t where t ->> 'id' in (v_ms::text, v_mc::text)) then fails := fails || '1 a sample or customer listed'::text; end if;
  -- 2. A template's board answers; a sample's, a customer's and an unpublished one don't
  if (public.viewer_board(v_lt) ->> 'missing') is not null or public.viewer_board(v_lt) #>> '{layout,name}' <> 'Counter board' then fails := fails || '2 the template board'::text; end if;
  if (public.viewer_board(v_ls) ->> 'missing') is null or (public.viewer_board(v_lc) ->> 'missing') is null or (public.viewer_board(v_lt2) ->> 'missing') is null
     or (public.viewer_board(gen_random_uuid()) ->> 'missing') is null then fails := fails || '2 another board answered'::text; end if;
  -- 3. Not counted as a phone-menu open
  if exists (select 1 from public.menu_scans where layout_id = v_lt) then fails := fails || '3 counted'::text; end if;
  -- 4. A menu board visit is kept; refused: a look it can't have, a bad board, 9 items, a long price, a menu board in version 1
  perform public.viewer_record(gen_random_uuid(), c, 30, 4, null, '{}');
  foreach b in array array[c || '{"look": "neon"}', c || '{"board": "Daybreak"}', c || jsonb_build_object('items', (select jsonb_agg(jsonb_build_object('name', 'x', 'price', '$1')) from generate_series(1, 9))),
    c || '{"items": [{"name": "x", "price": "12345678901234567"}]}', c || '{"items": [{"name": "x", "price": "$1", "picture": "data:"}]}', c || '{"kind": "directory"}',
    '{"v": 1, "kind": "menu", "name": "", "subtitle": "", "tenants": 10, "shape": "landscape", "weather": true, "qr": false, "places": false, "contacts": true}'::jsonb] loop
    begin perform public.viewer_record(gen_random_uuid(), b, 1, 1, null, '{}'); fails := fails || format('4 accepted %s', left(b::text, 70));
    exception when check_violation then null; end;
  end loop;
  perform set_config('role', 'none', true);
  if (select count(*) from public.viewer_visits where config ->> 'name' = 'Viewer menu test') <> 1 then fails := fails || '4 the visit kept'::text; end if;
  -- 5. Signed-in users can't call them
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin perform public.viewer_boards(); fails := fails || '5 a customer listed the templates'::text; exception when insufficient_privilege then null; end;
  begin perform public.viewer_board(v_lt); fails := fails || '5 a customer read a board'::text; exception when insufficient_privilege then null; end;
  perform set_config('role', 'none', true);
  if array_length(fails, 1) is null then
    raise exception 'ALL 5 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
