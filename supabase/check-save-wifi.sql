-- Confirms 20-save-wifi.sql works. Run after 20: SQL Editor -> New query -> paste -> Run.
-- It ALWAYS ends with a red error message (that undoes the test). It should read "ALL 9 CHECKS PASSED".
do $$
declare
  r jsonb; v_org uuid; v_prop uuid; v_dir uuid; v_scr uuid; v_dev uuid; v_user uuid := gen_random_uuid();
  v_bad bigint; v_good bigint; v_again bigint; v_plain bigint; v_old bigint; v_nets int;
  fails text[] := '{}';
begin
  insert into auth.users (id, email) values (v_user, 'save-wifi-test@example.com');
  insert into public.organizations (name) values ('Save Wi-Fi test owner') returning id into v_org;
  insert into public.properties (org_id, name) values (v_org, 'Save Wi-Fi Test Building') returning id into v_prop;
  insert into public.directories (property_id, slug, title) values (v_prop, 'save-wifi-test-dir', 'Test') returning id into v_dir;
  insert into public.screens (directory_id, key, name) values (v_dir, 'save-wifi-test-screen', 'Test screen') returning id into v_scr;
  insert into public.devices (serial, key_hash, screen_id) values ('feedc0de00000020', 'hash-20', v_scr) returning id into v_dev;
  select count(*) into v_nets from public.wifi_networks;

  -- A wrong password with Save ticked, and the right one, both queued now
  insert into public.device_commands (device_id, command, created_by, payload, save)
    values (v_dev, 'wifi_join', v_user, '{"ssid": "Test 20 Net", "psk": "wrong-pass-1", "hidden": false}', '{"ssid": "Test 20 Net", "psk": "wrong-pass-1", "hidden": false}')
    returning id into v_bad;
  insert into public.device_commands (device_id, command, created_by, payload, save)
    values (v_dev, 'wifi_join', v_user, '{"ssid": "Test 20 Net", "psk": "right-pass-1", "hidden": true}', '{"ssid": "Test 20 Net", "psk": "right-pass-1", "hidden": true}')
    returning id into v_good;
  insert into public.device_commands (device_id, command, created_by, payload, save, created_at)
    values (v_dev, 'wifi_join', v_user, '{"ssid": "Test 20 Old", "psk": "old-pass-12"}', '{"ssid": "Test 20 Old", "psk": "old-pass-12"}', now() - interval '2 hours')
    returning id into v_old;

  -- 1. The handover: the Pi gets the payload, never save; payload cleared, save kept until the result
  r := public.agent_checkin('feedc0de00000020', 'hash-20', '{}', '{}', null, null);
  if exists (select 1 from jsonb_array_elements(r -> 'commands') c where c ? 'save')
     or exists (select 1 from public.device_commands where id in (v_bad, v_good) and (payload is not null or save is null))
    then fails := fails || '1 the handover keeps save on the server only'::text; end if;

  -- 2. An hour-old join expires and its save goes with it
  if exists (select 1 from public.device_commands where id = v_old and (status <> 'expired' or save is not null))
    then fails := fails || '2 an expired join keeps nothing'::text; end if;

  -- 3. A refused password: nothing saved, save cleared, the result says so
  -- 4. The join that worked: saved, labelled with the building, off cards, hidden kept, the result says so
  r := public.agent_checkin('feedc0de00000020', 'hash-20', '{}', '{}', null, jsonb_build_array(
         jsonb_build_object('id', v_bad, 'status', 'failed', 'result', 'Couldn''t join Test 20 Net: the password was refused. Still on OfficeNet.'),
         jsonb_build_object('id', v_good, 'status', 'done', 'result', 'Joined Test 20 Net; the directory site is reachable through it.')));
  if (select result from public.device_commands where id = v_bad) not like '%Still on OfficeNet. Nothing was saved.'
     or exists (select 1 from public.device_commands where id = v_bad and save is not null)
     or exists (select 1 from public.wifi_networks where psk = 'wrong-pass-1')
    then fails := fails || '3 a failed join saves nothing'::text; end if;
  if not exists (select 1 from public.wifi_networks where ssid = 'Test 20 Net' and psk = 'right-pass-1' and hidden
                 and not on_cards and label = 'Save Wi-Fi Test Building' and updated_by = v_user)
     or (select result from public.device_commands where id = v_good) <> 'Joined Test 20 Net; the directory site is reachable through it. Saved for other screens: other Pis can join Test 20 Net with one tap.'
     or exists (select 1 from public.device_commands where id = v_good and save is not null)
    then fails := fails || '4 a join that worked is saved and says so'::text; end if;

  -- 5. The audit log names the network and the Pi, never the password
  if not exists (select 1 from public.audit_log where action = 'save wifi from field' and user_id = v_user
                 and detail ->> 'ssid' = 'Test 20 Net' and detail ->> 'serial' = 'feedc0de00000020')
     or exists (select 1 from public.audit_log where detail::text like '%right-pass-1%')
    then fails := fails || '5 the audit log names the network only'::text; end if;

  -- 6. Joined again with a new password, after the office put it on cards: one entry, new password, still on cards
  update public.wifi_networks set on_cards = true where ssid = 'Test 20 Net';
  insert into public.device_commands (device_id, command, created_by, payload, save)
    values (v_dev, 'wifi_join', v_user, '{"ssid": "Test 20 Net", "psk": "newer-pass-2"}', '{"ssid": "Test 20 Net", "psk": "newer-pass-2", "hidden": false}')
    returning id into v_again;
  r := public.agent_checkin('feedc0de00000020', 'hash-20', '{}', '{}', null, null);
  r := public.agent_checkin('feedc0de00000020', 'hash-20', '{}', '{}', null, jsonb_build_array(
         jsonb_build_object('id', v_again, 'status', 'done', 'result', 'Joined Test 20 Net; the directory site is reachable through it.')));
  if (select count(*) from public.wifi_networks where ssid = 'Test 20 Net') <> 1
     or not exists (select 1 from public.wifi_networks where ssid = 'Test 20 Net' and psk = 'newer-pass-2' and on_cards)
     or (select result from public.device_commands where id = v_again) not like '%The saved password is updated: other Pis can join Test 20 Net with one tap.'
    then fails := fails || '6 saving again updates the one entry, keeping its card setting'::text; end if;

  -- 7. A join without Save ticked saves nothing and its result is unchanged
  insert into public.device_commands (device_id, command, payload) values (v_dev, 'wifi_join', '{"ssid": "Test 20 Plain", "psk": "plain-pass-1"}')
    returning id into v_plain;
  r := public.agent_checkin('feedc0de00000020', 'hash-20', '{}', '{}', null, null);
  r := public.agent_checkin('feedc0de00000020', 'hash-20', '{}', '{}', null, jsonb_build_array(
         jsonb_build_object('id', v_plain, 'status', 'done', 'result', 'Joined Test 20 Plain; the directory site is reachable through it.')));
  if exists (select 1 from public.wifi_networks where ssid = 'Test 20 Plain')
     or (select result from public.device_commands where id = v_plain) <> 'Joined Test 20 Plain; the directory site is reachable through it.'
     or (select count(*) from public.wifi_networks) <> v_nets + 1
    then fails := fails || '7 a join without Save saves nothing'::text; end if;

  -- 8. Save only ever rides on a join
  begin
    insert into public.device_commands (device_id, command, save) values (v_dev, 'reboot', '{"ssid": "x"}');
    fails := fails || '8 save on a reboot was accepted'::text;
  exception when check_violation then null;
  end;

  -- 9. Still server-only: device_commands keeps row-level security with no policies (so signed-in users read
  --    nothing from it), and the check-in is the site's alone
  if not (select relrowsecurity from pg_class where oid = 'public.device_commands'::regclass)
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'device_commands')
     or has_function_privilege('authenticated', 'public.agent_checkin(text,text,jsonb,jsonb,text,jsonb)', 'execute')
    then fails := fails || '9 permissions'::text; end if;

  if cardinality(fails) = 0 then raise exception 'ALL 9 CHECKS PASSED. (This red message is expected; the test data was removed.)';
  else raise exception 'FAILED: %', array_to_string(fails, ' || '); end if;
end $$;
