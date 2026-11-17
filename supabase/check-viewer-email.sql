-- Confirms 55-viewer-email.sql works. Run after 55: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 6 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- The viewer's calls run as the site (service_role); then as a customer.
do $$
declare
  u_owner uuid := gen_random_uuid(); v_org uuid;
  v1 uuid := gen_random_uuid(); v2 uuid := gen_random_uuid(); v_old uuid := gen_random_uuid();
  h1 text := repeat('a', 64); h2 text := repeat('b', 64); h3 text := repeat('c', 64); h4 text := repeat('d', 64);
  r text; n int; fails text[] := '{}';
  c jsonb := '{"v": 2, "kind": "directory", "name": "Email test", "subtitle": "", "tenants": 10, "shape": "landscape", "weather": true, "qr": false, "places": false, "contacts": true, "news": false,
               "look": "dark", "logo": "off", "photo": "off", "rows": [], "type": ""}';
begin
  insert into auth.users (id, email) values (u_owner, 'vem-owner@example.com');
  insert into public.organizations (name, kind) values ('Viewer email customer', 'owner') returning id into v_org;
  insert into public.profiles (user_id, email, role, org_id) values (u_owner, 'vem-owner@example.com', 'org_admin', v_org);

  perform set_config('role', 'service_role', true);
  delete from public.viewer_email_sends;
  perform public.viewer_record(v1, c, 1, 1, null, '{}', null, null, null, null, null, null, null);
  perform public.viewer_record(v2, c, 1, 1, null, '{}', null, null, null, null, null, null, null);
  -- 1. The settings: off by default, a bad address or a name with <> refused, a limit 1 to 500
  insert into public.viewer_email_settings (id) values (true) on conflict (id) do nothing;
  if (select enabled from public.viewer_email_settings) then fails := fails || '1 on by default'::text; end if;
  begin update public.viewer_email_settings set from_address = 'not an address'; fails := fails || '1 bad from'::text; exception when check_violation then null; end;
  begin update public.viewer_email_settings set from_name = 'A <b>'; fails := fails || '1 bad name'::text; exception when check_violation then null; end;
  begin update public.viewer_email_settings set daily_limit = 501; fails := fails || '1 limit 501'::text; exception when check_violation then null; end;
  -- 2. A send claimed; the same address again within the hour refused; another address fine
  r := public.viewer_email_claim(v1, h1, 50); if r is not null then fails := fails || format('2 first: %s', r); end if;
  r := public.viewer_email_claim(v2, h1, 50); if r is distinct from 'address-limit' then fails := fails || format('2 same address: %s', r); end if;
  r := public.viewer_email_claim(v1, h2, 50); if r is not null then fails := fails || format('2 another: %s', r); end if;
  -- 3. Three a visit
  r := public.viewer_email_claim(v1, h3, 50); if r is not null then fails := fails || format('3 third: %s', r); end if;
  r := public.viewer_email_claim(v1, h4, 50); if r is distinct from 'visit-limit' then fails := fails || format('3 fourth: %s', r); end if;
  -- 4. The daily limit: 3 sent so far (all by v1; v2's was refused), so a limit of 3 stops the next
  r := public.viewer_email_claim(v2, h4, 3); if r is distinct from 'daily-limit' then fails := fails || format('4 daily: %s', r); end if;
  -- 5. A visit that doesn't exist, or a bad fingerprint
  r := public.viewer_email_claim(gen_random_uuid(), h4, 50); if r is distinct from 'visit' then fails := fails || format('5 no visit: %s', r); end if;
  r := public.viewer_email_claim(v2, 'scot@1pointusa.com', 50); if r is distinct from 'bad' then fails := fails || format('5 an address as is: %s', r); end if;
  select count(*) into n from public.viewer_email_sends; if n <> 3 then fails := fails || format('5 three kept, not %s', n); end if;
  -- (a send that failed gives its claim back: the same address may be tried again at once)
  perform public.viewer_email_release(v1, h3);
  r := public.viewer_email_claim(v1, h3, 50); if r is not null then fails := fails || format('5 released: %s', r); end if;
  -- 6. The new event; and a customer reads neither table nor calls the claim
  perform public.viewer_record(v1, c, 2, 1, null, '{}', '{"directory_email_sent": 2}', null, null, null, null, null, null);
  if (select (events ->> 'directory_email_sent')::int from public.viewer_visits where id = v1) <> 2 then fails := fails || '6 the event'::text; end if;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin perform 1 from public.viewer_email_settings; fails := fails || '6 a customer reads the settings'::text; exception when insufficient_privilege then null; end;
  begin perform 1 from public.viewer_email_sends; fails := fails || '6 a customer reads the sends'::text; exception when insufficient_privilege then null; end;
  begin perform public.viewer_email_claim(v1, repeat('e', 64), 50); fails := fails || '6 a customer claimed'::text; exception when insufficient_privilege then null; end;
  begin perform public.viewer_email_release(v1, h1); fails := fails || '6 a customer released'::text; exception when insufficient_privilege then null; end;
  perform set_config('role', 'none', true);

  if array_length(fails, 1) is null then
    raise exception 'ALL 6 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
