-- Confirms 37-sample-menus.sql works. Run after 37: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 4 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- The link is turned off and opened again as a signed-in 1Point user, as the console does it.
do $$
declare
  u_admin uuid := gen_random_uuid();
  v_smp uuid; v_cust uuid; v_ls uuid; v_lc uuid; v_cs text; v_cc text;
  v_doc jsonb := '{"format": 1, "orientation": "landscape", "grid": {"cols": 12, "rows": 12}, "blocks": [{"id": "t", "type": "text", "at": [1, 1, 12, 12], "content": {"title": "Hi"}}]}';
  fails text[] := '{}';
begin
  insert into auth.users (id, email) values (u_admin, 'smenu-admin@example.com');
  insert into public.profiles (user_id, email, full_name, role, org_id) values (u_admin, 'smenu-admin@example.com', 'S Admin', 'platform_admin', null);
  insert into public.organizations (name, kind) values ('Samples menu test', 'samples') returning id into v_smp;
  insert into public.organizations (name, kind) values ('Customer menu test', 'owner') returning id into v_cust;
  insert into public.layouts (org_id, name, orientation, draft) values (v_smp, 'Sample board', 'landscape', v_doc) returning id, menu_code into v_ls, v_cs;
  insert into public.layouts (org_id, name, orientation, draft) values (v_cust, 'Customer board', 'landscape', v_doc) returning id, menu_code into v_lc, v_cc;
  perform public.layout_publish(v_ls, v_doc, '{}', false, '', u_admin);
  perform public.layout_publish(v_lc, v_doc, '{}', false, '', u_admin);

  -- 1. A sample board with no link: no phone menu. A customer's board with none: its phone menu as always
  if (public.menu_page(v_cs, false) ->> 'missing') is null then fails := fails || '1 a sample board with no link answers'::text; end if;
  if (public.menu_page(v_cc, false) ->> 'missing') is not null then fails := fails || '1 a customer''s board'::text; end if;

  -- 2. With an open link (made as 1Point, signed in): the phone menu and the sample page answer
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  insert into public.sample_links (slug, layout_id, days) values ('smenu-test', v_ls, 30);
  perform set_config('role', 'none', true);
  if (public.menu_page(v_cs, false) ->> 'missing') is not null or public.sample_page('smenu-test') ? 'missing' then fails := fails || '2 an open link'::text; end if;

  -- 3. Turned off: the phone menu ends too; opened again: back
  perform set_config('role', 'authenticated', true);
  update public.sample_links set turned_off_at = now() where slug = 'smenu-test';
  perform set_config('role', 'none', true);
  if (public.menu_page(v_cs, false) ->> 'missing') is null then fails := fails || '3 turned off, the phone menu still answers'::text; end if;
  perform set_config('role', 'authenticated', true);
  update public.sample_links set turned_off_at = null, days = 30, expires_at = now() where slug = 'smenu-test';
  perform set_config('role', 'none', true);
  if (public.menu_page(v_cs, false) ->> 'missing') is not null then fails := fails || '3 opened again'::text; end if;

  -- 4. Past its date: ended too
  alter table public.sample_links disable trigger sample_links_guard;
  update public.sample_links set expires_at = now() - interval '1 minute' where slug = 'smenu-test';
  alter table public.sample_links enable trigger sample_links_guard;
  if (public.menu_page(v_cs, false) ->> 'missing') is null then fails := fails || '4 past its date'::text; end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL 4 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
