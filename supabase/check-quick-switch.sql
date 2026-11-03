-- Confirms 42-quick-switch.sql works. Run after 42: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 5 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Taps are tried as signed-in users (the shop's owner and editor, and a stranger), as the menu editor does them.
do $$
declare
  u_owner uuid := gen_random_uuid();
  u_editor uuid := gen_random_uuid();
  u_stranger uuid := gen_random_uuid();
  v_org uuid; v_other uuid; v_menu uuid; r jsonb; v_rev integer;
  fails text[] := '{}';
begin
  insert into public.organizations (name, kind) values ('Quick switch test', 'samples') returning id into v_org;
  insert into public.organizations (name, kind) values ('Quick switch other', 'owner') returning id into v_other;
  insert into auth.users (id, email) values (u_owner, 'qs-owner@example.com'), (u_editor, 'qs-editor@example.com'), (u_stranger, 'qs-stranger@example.com');
  insert into public.profiles (user_id, email, full_name, role, org_id) values
    (u_owner, 'qs-owner@example.com', 'Q Owner', 'org_admin', v_org),
    (u_editor, 'qs-editor@example.com', 'Q Editor', 'org_editor', v_org),
    (u_stranger, 'qs-stranger@example.com', 'Q Stranger', 'org_admin', v_other);
  insert into public.menus (org_id, name, spec, customer_edit)
    values (v_org, 'Quick switch menu', '{"lists": [{"key": "pasta", "name": "Pasta", "kind": "items", "room": 6, "fields": ["name", "price"]}]}', true)
    returning id into v_menu;
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_save(v_menu, 0, '{"lists": {"pasta": {"entries": [{"id": "qs0001", "name": "Baked Ziti", "price": "$16"}, {"id": "qs0002", "name": "Anchovy Pizza", "price": "$24"}]}}}'::jsonb);

  -- 1. The owner taps Sold out on the ziti: just that item, a new revision
  r := public.menu_switch(v_menu, 'pasta', 'qs0001', 'sold', true, current_date);
  perform set_config('role', 'none', true);
  if (select content -> 'lists' -> 'pasta' -> 'entries' -> 0 ->> 'soldOut' from public.menus where id = v_menu) is distinct from to_char(current_date, 'YYYY-MM-DD')
     or (select rev from public.menus where id = v_menu) <> 2 or (select count(*) from public.menu_revisions where menu_id = v_menu) <> 2 then
    fails := fails || '1 sold out not saved as a revision'::text;
  end if;

  -- 2. The editor, on another phone, hides the anchovy pizza right after: both kept
  perform set_config('request.jwt.claims', json_build_object('sub', u_editor, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  r := public.menu_switch(v_menu, 'pasta', 'qs0002', 'hidden', true, current_date);
  perform set_config('role', 'none', true);
  if (select (content -> 'lists' -> 'pasta' -> 'entries' -> 1 ->> 'hidden') is distinct from 'true'
        or (content -> 'lists' -> 'pasta' -> 'entries' -> 0 ->> 'soldOut') is null
        or (content -> 'lists' -> 'pasta' -> 'entries' -> 0 ->> 'price') is distinct from '$16' from public.menus where id = v_menu) then
    fails := fails || '2 the two taps did not both stay'::text;
  end if;

  -- 3. Off again
  perform set_config('role', 'authenticated', true);
  r := public.menu_switch(v_menu, 'pasta', 'qs0002', 'hidden', false, current_date);
  perform set_config('role', 'none', true);
  if (select (content -> 'lists' -> 'pasta' -> 'entries' -> 1) ? 'hidden' from public.menus where id = v_menu) then fails := fails || '3 hide not turned off'::text; end if;

  -- 4. Refused: an item that isn't there, another day, something other than Sold out or Hide
  perform set_config('role', 'authenticated', true);
  begin perform public.menu_switch(v_menu, 'pasta', 'nope01', 'sold', true, current_date); fails := fails || '4 unknown item'::text;
  exception when no_data_found then if sqlerrm not like '%isn''t on the menu any more%' then fails := fails || format('4 message: %s', sqlerrm); end if; end;
  begin perform public.menu_switch(v_menu, 'pasta', 'qs0001', 'sold', true, current_date - 7); fails := fails || '4 another day'::text;
  exception when invalid_parameter_value then null; end;
  begin perform public.menu_switch(v_menu, 'pasta', 'qs0001', 'price', true, current_date); fails := fails || '4 price'::text;
  exception when invalid_parameter_value then null; end;
  perform set_config('role', 'none', true);

  -- 5. Refused: someone in another account; and the shop's own taps once customer editing is off
  perform set_config('request.jwt.claims', json_build_object('sub', u_stranger, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin perform public.menu_switch(v_menu, 'pasta', 'qs0001', 'sold', false, current_date); fails := fails || '5 stranger'::text;
  exception when insufficient_privilege then null; end;
  perform set_config('role', 'none', true);
  update public.menus set customer_edit = false where id = v_menu;
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin perform public.menu_switch(v_menu, 'pasta', 'qs0001', 'sold', false, current_date); fails := fails || '5 customer editing off'::text;
  exception when insufficient_privilege then null; end;
  perform set_config('role', 'none', true);

  if array_length(fails, 1) is null then
    raise exception 'ALL 5 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
