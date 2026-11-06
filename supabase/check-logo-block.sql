-- Confirms 44-logo-block.sql works. Run after 44: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 3 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Saves are tried as signed-in users (1Point, and the shop's owner), as the menu editor does them.
do $$
declare
  u_admin uuid := gen_random_uuid();
  u_owner uuid := gen_random_uuid();
  v_org uuid; v_menu uuid; v_lay uuid; v_b text; r jsonb;
  fails text[] := '{}';
begin
  insert into public.organizations (name, kind) values ('Logo block test', 'samples') returning id into v_org;
  insert into auth.users (id, email) values (u_admin, 'logoblk-admin@example.com'), (u_owner, 'logoblk-owner@example.com');
  insert into public.profiles (user_id, email, full_name, role, org_id) values
    (u_admin, 'logoblk-admin@example.com', 'T Admin', 'platform_admin', null),
    (u_owner, 'logoblk-owner@example.com', 'T Owner', 'org_admin', v_org);
  insert into public.menus (org_id, name, spec, customer_edit) values (v_org, 'Logo block menu', '{"lists": []}', true) returning id into v_menu;
  insert into public.layouts (org_id, name, orientation, menu_id) values (v_org, 'Logo block board', 'portrait', v_menu) returning id into v_lay;
  v_b := v_lay::text;

  -- 1. 1Point sets the logo block (picture and name, the name below, centred) with the board's other sizes: kept
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 0, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"sizes": {"qr": "m", "qrcode": "board", "logoShow": "both", "logoPlace": "below", "logoAlign": "center"}}'::jsonb)));
  perform set_config('role', 'none', true);
  if (select content -> 'boards' -> v_b -> 'sizes' from public.menus where id = v_menu) is distinct from '{"qr": "m", "qrcode": "board", "logoShow": "both", "logoPlace": "below", "logoAlign": "center"}'::jsonb then fails := fails || '1 not kept'::text; end if;

  -- 2. Only the logo block's own words
  perform set_config('role', 'authenticated', true);
  begin perform public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"sizes": {"logoShow": "everything"}}'::jsonb))); fails := fails || '2 everything'::text;
  exception when check_violation then if sqlerrm not like '%picture, the name or both%' then fails := fails || format('2 message: %s', sqlerrm); end if; end;
  begin perform public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"sizes": {"logoPlace": "above"}}'::jsonb))); fails := fails || '2 above'::text;
  exception when check_violation then null; end;
  begin perform public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"sizes": {"logoAlign": "middle"}}'::jsonb))); fails := fails || '2 middle'::text;
  exception when check_violation then null; end;
  perform set_config('role', 'none', true);

  -- 3. The owner's save keeps it as 1Point set it
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 1, jsonb_build_object('lists', '{}'::jsonb, 'boards', jsonb_build_object(v_b, '{"sizes": {"logoShow": "picture"}}'::jsonb)));
  perform set_config('role', 'none', true);
  if (select content -> 'boards' -> v_b -> 'sizes' from public.menus where id = v_menu) is distinct from '{"qr": "m", "qrcode": "board", "logoShow": "both", "logoPlace": "below", "logoAlign": "center"}'::jsonb then fails := fails || '3 the owner changed them'::text; end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL 3 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
