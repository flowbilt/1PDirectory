-- Confirms 51-viewer-v2.sql works. Run after 51: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 4 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Runs as the site (service_role), which is the only one that keeps visits; then as a customer, who reads none.
do $$
declare
  v_id uuid := gen_random_uuid(); fails text[] := '{}'; v_n integer;
  u_owner uuid := gen_random_uuid(); v_org uuid;
  c jsonb := '{"v": 2, "kind": "touch", "name": "V2 test", "subtitle": "", "tenants": 12, "shape": "portrait", "weather": true, "qr": false, "places": false, "contacts": true, "news": true,
               "look": "light", "logo": "own", "photo": "sample", "rows": [{"name": "Acme Dental", "suite": "210"}, {"name": "", "suite": "B"}]}';
  v1 jsonb := '{"v": 1, "kind": "directory", "name": "V2 test", "subtitle": "", "tenants": 40, "shape": "landscape", "weather": true, "qr": false, "places": true, "contacts": true, "news": false}';
  bad jsonb[];
  b jsonb;
begin
  bad := array[
    c || '{"tenants": 21}', c || '{"look": "dim"}', c || '{"logo": "data:image/png;base64,AAAA"}', c || '{"photo": true}',
    c || jsonb_build_object('rows', (select jsonb_agg(jsonb_build_object('name', 'x', 'suite', '1')) from generate_series(1, 13))),
    c || '{"rows": [{"name": "x", "suite": "1", "email": "a@b.c"}]}', c || jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('name', repeat('x', 61), 'suite', ''))),
    c || '{"rows": [{"name": "x", "suite": "1234567890123"}]}', c || '{"rows": "Acme"}', c || '{"v": 3}', v1 || '{"look": "light"}'];
  perform set_config('role', 'service_role', true);
  -- 1. A version 2 visit (Light, their own logo, the sample photo, two rows typed over) is kept as sent
  perform public.viewer_record(v_id, c, 40, 9, null, '{}');
  -- 2. A version 1 visit (before V2, up to 60 tenants) is still kept
  perform public.viewer_record(gen_random_uuid(), v1, 10, 1, null, '{}');
  -- 3. Refused: 21 tenants, an unknown look, a picture itself in place of "own", 13 rows for 12 tenants, more in a row
  --    than a name and a suite, a 61-character name, a 13-character suite, rows that aren't a list, version 3, and
  --    version 2's choices on a version 1 visit
  foreach b in array bad loop
    begin perform public.viewer_record(gen_random_uuid(), b, 1, 1, null, '{}'); fails := fails || format('3 accepted %s', left(b::text, 80));
    exception when check_violation then null; end;
  end loop;
  perform set_config('role', 'none', true);
  if (select config from public.viewer_visits where id = v_id) is distinct from c then fails := fails || '1 not kept as sent'::text; end if;
  if (select count(*) from public.viewer_visits where config ->> 'name' = 'V2 test') <> 2 then fails := fails || '2 both kept'::text; end if;
  -- 4. A customer signed in reads no visits
  insert into public.organizations (name) values ('Viewer v2 test owner') returning id into v_org;
  insert into auth.users (id, email) values (u_owner, 'viewerv2-owner@example.com');
  insert into public.profiles (user_id, email, role, org_id) values (u_owner, 'viewerv2-owner@example.com', 'org_admin', v_org);
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into v_n from public.viewer_visits;
  perform set_config('role', 'none', true);
  if v_n <> 0 then fails := fails || format('4 a customer read %s visits', v_n); end if;
  if array_length(fails, 1) is null then
    raise exception 'ALL 4 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
