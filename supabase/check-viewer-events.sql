-- Confirms 54-viewer-events.sql works. Run after 54: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 8 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- The viewer's calls run as the site (service_role); then as a customer and as 1Point.
do $$
declare
  u_admin uuid := gen_random_uuid(); u_owner uuid := gen_random_uuid(); v_org uuid;
  v1 uuid := gen_random_uuid(); v2 uuid := gen_random_uuid(); v_old uuid := gen_random_uuid(); v_load uuid := gen_random_uuid();
  r record; b jsonb; n int; fails text[] := '{}';
  c jsonb := '{"v": 2, "kind": "directory", "name": "Events test", "subtitle": "", "tenants": 10, "shape": "landscape", "weather": true, "qr": false, "places": false, "contacts": true, "news": false,
               "look": "dark", "logo": "off", "photo": "off", "rows": [], "type": ""}';
begin
  insert into auth.users (id, email) values (u_admin, 'vev-admin@example.com'), (u_owner, 'vev-owner@example.com');
  insert into public.profiles (user_id, email, full_name, role, org_id) values (u_admin, 'vev-admin@example.com', 'V Admin', 'platform_admin', null);
  insert into public.organizations (name, kind) values ('Viewer events customer', 'owner') returning id into v_org;
  insert into public.profiles (user_id, email, role, org_id) values (u_owner, 'vev-owner@example.com', 'org_admin', v_org);

  perform set_config('role', 'service_role', true);
  -- 1. A visit kept as the page loads, before anything is drawn: no choices, the events, device, browser, the page load
  perform public.viewer_record(v1, null, 0, 0, null, '{"page": "/waytugo-viewer", "utm_source": "facebook"}',
    '{"viewer_page_loaded": 1}', null, 'phone', 'facebook', null, 0, v_load);
  select * into r from public.viewer_visits where id = v1;
  if r.id is null or r.config is not null or r.events <> '{"viewer_page_loaded": 1}'::jsonb or r.device <> 'phone' or r.browser <> 'facebook'
     or r.page_load <> v_load or r.init_ms is not null or r.snapshots <> '[]'::jsonb then
    fails := fails || format('1 the load: %s', left(row_to_json(r)::text, 300));
  end if;
  -- 2. Then it fills in: the choices, the events merged by the larger count (an older, smaller count changes nothing),
  --    init_ms and device kept from the first, a later send without choices doesn't clear them
  perform public.viewer_record(v1, c, 40, 9, null, '{}', '{"viewer_page_loaded": 1, "viewer_initialized": 1, "configuration_edited": 3}', null, 'desktop', 'other', 850, 0, null);
  perform public.viewer_record(v1, null, 20, 2, null, '{}', '{"configuration_edited": 1, "full_preview_opened": 2}', null, null, null, 9999, 1, null);
  select * into r from public.viewer_visits where id = v1;
  if r.config ->> 'name' <> 'Events test' or r.seconds <> 40 or r.changes <> 9 or r.init_ms <> 850 or r.device <> 'phone' or r.browser <> 'facebook' or r.failures <> 1
     or r.events <> '{"viewer_page_loaded": 1, "viewer_initialized": 1, "configuration_edited": 3, "full_preview_opened": 2}'::jsonb
     or r.source ->> 'utm_source' <> 'facebook' then
    fails := fails || format('2 merged: %s', left(row_to_json(r)::text, 400));
  end if;
  -- 3. Snapshots: each full-screen opening's choices with the time; the same twice in a row kept once; the last 5
  perform public.viewer_record(v1, c, 41, 9, null, '{}', null, c, null, null, null, null, null);
  perform public.viewer_record(v1, c, 42, 9, null, '{}', null, c, null, null, null, null, null);
  for n in 1..6 loop
    perform public.viewer_record(v1, c, 43, 9, null, '{}', null, c || jsonb_build_object('name', format('Snap %s', n)), null, null, null, null, null);
  end loop;
  select snapshots into b from public.viewer_visits where id = v1;
  if jsonb_array_length(b) <> 5 or b -> 0 -> 'config' ->> 'name' <> 'Snap 2' or b -> 4 -> 'config' ->> 'name' <> 'Snap 6' or (b -> 0 ->> 'at') is null then
    fails := fails || format('3 snapshots: %s', left(b::text, 300));
  end if;
  -- 4. Quotes: opened then sent stays sent; the events say both
  perform public.viewer_record(v1, c, 50, 9, 'started', '{}', '{"quote_form_opened": 1}', null, null, null, null, null, null);
  perform public.viewer_record(v1, c, 51, 9, 'sent', '{}', '{"quote_form_opened": 1, "quote_submitted": 1}', null, null, null, null, null, null);
  perform public.viewer_record(v1, c, 52, 9, 'started', '{}', null, null, null, null, null, null, null);
  select * into r from public.viewer_visits where id = v1;
  if r.quote <> 'sent' or (r.events ->> 'quote_submitted')::int <> 1 or (r.events ->> 'quote_form_opened')::int <> 1 then fails := fails || format('4 quote: %s %s', r.quote, r.events); end if;
  -- 5. Refused, and nothing changes: an event that isn't one, a negative or fractional or huge count, a bad snapshot,
  --    a device or browser that isn't a category, an email in the source
  foreach b in array array['{"clicked_ad": 1}'::jsonb, '{"full_preview_opened": -1}', '{"full_preview_opened": 1.5}', '{"full_preview_opened": 10001}', '{"full_preview_opened": "1"}', '[]'] loop
    begin perform public.viewer_record(v2, c, 1, 1, null, '{}', b, null, null, null, null, null, null); fails := fails || format('5 accepted events %s', b);
    exception when check_violation then null; end;
  end loop;
  begin perform public.viewer_record(v2, c, 1, 1, null, '{}', null, c || '{"email": "a@b.c"}', null, null, null, null, null); fails := fails || '5 accepted a bad snapshot'::text;
  exception when check_violation then null; end;
  begin perform public.viewer_record(v2, c, 1, 1, null, '{}', null, null, 'Mozilla/5.0 (iPhone)', null, null, null, null); fails := fails || '5 accepted a device string'::text;
  exception when check_violation then null; end;
  begin perform public.viewer_record(v2, c, 1, 1, null, '{}', null, null, null, 'safari', null, null, null); fails := fails || '5 accepted a browser name'::text;
  exception when check_violation then null; end;
  begin perform public.viewer_record(v2, c, 1, 1, null, '{"email": "a@b.c"}', null, null, null, null, null, null, null); fails := fails || '5 accepted an email in the source'::text;
  exception when check_violation then null; end;
  if exists (select 1 from public.viewer_visits where id = v2) then fails := fails || '5 something kept'::text; end if;
  -- 6. The code before V5 still works: the six inputs by name, as /api/viewer sends them
  perform public.viewer_record(p_id => v_old, p_config => c || '{"name": "Old code"}', p_seconds => 30, p_changes => 4, p_quote => null, p_source => '{}');
  select * into r from public.viewer_visits where id = v_old;
  if r.config ->> 'name' <> 'Old code' or r.events <> '{}'::jsonb or r.snapshots <> '[]'::jsonb or r.failures <> 0 then fails := fails || format('6 old code: %s', left(row_to_json(r)::text, 300)); end if;
  -- 7. Page loads: kept once per code (a second send changes nothing); refused: a bad source, a device string
  perform public.viewer_page_record(v_load, '{"page": "/waytugo-viewer", "utm_source": "facebook", "utm_campaign": "reel-v1"}', 'phone', 'instagram');
  perform public.viewer_page_record(v_load, '{"page": "/other"}', 'desktop', 'other');
  select count(*) into n from public.viewer_page_loads where id = v_load and source ->> 'utm_campaign' = 'reel-v1' and device = 'phone' and browser = 'instagram';
  if n <> 1 then fails := fails || '7 the page load'::text; end if;
  begin perform public.viewer_page_record(gen_random_uuid(), '{"ip": "203.0.113.9"}', null, null); fails := fails || '7 accepted an IP'::text; exception when check_violation then null; end;
  begin perform public.viewer_page_record(gen_random_uuid(), '{}', 'Android 14', null); fails := fails || '7 accepted a device string'::text; exception when check_violation then null; end;
  perform set_config('role', 'none', true);

  -- 8. A customer signed in reads no visits or page loads and can't call either; 1Point reads both
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  if (select count(*) from public.viewer_page_loads) <> 0 or (select count(*) from public.viewer_visits) <> 0 then fails := fails || '8 a customer reads them'::text; end if;
  begin perform public.viewer_page_record(gen_random_uuid(), '{}', null, null); fails := fails || '8 a customer kept a page load'::text; exception when insufficient_privilege then null; end;
  begin perform public.viewer_record(gen_random_uuid(), c, 1, 1, null, '{}', null, null, null, null, null, null, null); fails := fails || '8 a customer kept a visit'::text; exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  if (select count(*) from public.viewer_page_loads where id = v_load) <> 1 or (select count(*) from public.viewer_visits where id = v1) <> 1 then fails := fails || '8 1Point can''t read them'::text; end if;
  perform set_config('role', 'none', true);

  if array_length(fails, 1) is null then
    raise exception 'ALL 8 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
