-- Confirms 48-viewer.sql works. Run after 48: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 6 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- The site's part runs as the site (service_role); 1Point's and a customer's parts as signed-in users.
do $$
declare
  u_admin uuid := gen_random_uuid();
  u_owner uuid := gen_random_uuid();
  v_org uuid; v_id uuid := gen_random_uuid(); v_old uuid := gen_random_uuid(); n int;
  fails text[] := '{}';
  c jsonb := '{"v": 1, "kind": "touch", "name": "Landmark Business Center", "subtitle": "", "tenants": 12, "shape": "portrait", "weather": true, "qr": true, "places": false, "contacts": true}';
begin
  insert into public.organizations (name) values ('Viewer test') returning id into v_org;
  insert into auth.users (id, email) values (u_admin, 'viewer-admin@example.com'), (u_owner, 'viewer-owner@example.com');
  insert into public.profiles (user_id, email, full_name, role, org_id) values
    (u_admin, 'viewer-admin@example.com', 'T Admin', 'platform_admin', null),
    (u_owner, 'viewer-owner@example.com', 'T Owner', 'org_admin', v_org);

  -- 1. The site keeps a visit, then updates it as the visitor goes on (the time and changes only grow)
  perform set_config('role', 'service_role', true);
  perform public.viewer_record(v_id, c, 40, 3, null, '{"page": "/waytugo-viewer", "utm_source": "google", "utm_campaign": "directory-fall"}');
  perform public.viewer_record(v_id, jsonb_set(c, '{tenants}', '20'), 95, 7, null, '{}');
  perform public.viewer_record(v_id, jsonb_set(c, '{tenants}', '20'), 10, 1, null, '{}');
  perform set_config('role', 'none', true);
  select count(*) into n from public.viewer_visits where id = v_id and (config ->> 'tenants')::int = 20 and seconds = 95 and changes = 7 and source ->> 'utm_campaign' = 'directory-fall';
  if n <> 1 then fails := fails || '1 a visit kept and updated'::text; end if;

  -- 2. A quote started, then sent; a later update without it doesn't take it away
  perform set_config('role', 'service_role', true);
  perform public.viewer_record(v_id, c, 120, 8, 'started', '{}');
  perform public.viewer_record(v_id, c, 130, 8, 'sent', '{}');
  perform public.viewer_record(v_id, c, 140, 8, null, '{}');
  perform set_config('role', 'none', true);
  if (select quote from public.viewer_visits where id = v_id) is distinct from 'sent' then fails := fails || '2 the quote kept'::text; end if;

  -- 3. Only real choices and sources: a third display type, 61 tenants, a long name, an unknown choice, a source that
  --    isn't the page or utm_ words (an IP address, say)
  perform set_config('role', 'service_role', true);
  begin perform public.viewer_record(gen_random_uuid(), jsonb_set(c, '{kind}', '"wayfinding"'), 1, 1, null, '{}'); fails := fails || '3 wayfinding'::text; exception when check_violation then null; end;
  begin perform public.viewer_record(gen_random_uuid(), jsonb_set(c, '{tenants}', '61'), 1, 1, null, '{}'); fails := fails || '3 61 tenants'::text; exception when check_violation then null; end;
  begin perform public.viewer_record(gen_random_uuid(), jsonb_set(c, '{name}', to_jsonb(repeat('x', 61))), 1, 1, null, '{}'); fails := fails || '3 a long name'::text; exception when check_violation then null; end;
  begin perform public.viewer_record(gen_random_uuid(), c || '{"email": "a@b.c"}', 1, 1, null, '{}'); fails := fails || '3 an email'::text; exception when check_violation then null; end;
  begin perform public.viewer_record(gen_random_uuid(), c, 1, 1, null, '{"ip": "203.0.113.9"}'); fails := fails || '3 an IP address'::text; exception when check_violation then null; end;
  begin perform public.viewer_record(gen_random_uuid(), c, 1, 1, 'won', '{}'); fails := fails || '3 a quote won'::text; exception when check_violation then null; end;
  perform set_config('role', 'none', true);
  if (select count(*) from public.viewer_visits) <> 1 then fails := fails || '3 a refused visit kept'::text; end if;

  -- 4. A visit more than a day old isn't changed; one more than 400 days old goes when a new one arrives
  insert into public.viewer_visits (id, config, started_at) values (v_old, c, now() - interval '401 days');
  update public.viewer_visits set started_at = now() - interval '2 days' where id = v_id;
  perform set_config('role', 'service_role', true);
  perform public.viewer_record(v_id, jsonb_set(c, '{name}', '"Changed later"'), 999, 99, null, '{}');
  perform public.viewer_record(gen_random_uuid(), c, 5, 1, null, '{}');
  perform set_config('role', 'none', true);
  if (select config ->> 'name' from public.viewer_visits where id = v_id) <> 'Landmark Business Center' then fails := fails || '4 an old visit changed'::text; end if;
  if exists (select 1 from public.viewer_visits where id = v_old) then fails := fails || '4 a visit over 400 days kept'::text; end if;

  -- 5. A customer, signed in, sees none of them and can't write one; nor can a visitor without signing in
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into n from public.viewer_visits;
  if n <> 0 then fails := fails || '5 a customer sees visits'::text; end if;
  begin perform public.viewer_record(gen_random_uuid(), c, 1, 1, null, '{}'); fails := fails || '5 a customer kept one'::text; exception when insufficient_privilege then null; end;
  begin insert into public.viewer_visits (id, config) values (gen_random_uuid(), c); fails := fails || '5 a customer inserted one'::text; exception when insufficient_privilege then null; end;
  perform set_config('role', 'anon', true);
  begin perform public.viewer_record(gen_random_uuid(), c, 1, 1, null, '{}'); fails := fails || '5 anon kept one'::text; exception when insufficient_privilege then null; end;
  perform set_config('role', 'none', true);

  -- 6. 1Point, signed in, sees them and can remove one (its own test visits, say)
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into n from public.viewer_visits;
  delete from public.viewer_visits where id = v_id;
  perform set_config('role', 'none', true);
  if n <> 2 then fails := fails || format('6 1Point sees %s visits, not 2', n); end if;
  if exists (select 1 from public.viewer_visits where id = v_id) then fails := fails || '6 1Point removed one'::text; end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL 6 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
