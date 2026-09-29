-- Confirms 13-tech.sql works. Run after 13: SQL Editor -> New query -> paste -> Run.
-- It ALWAYS ends with a red error message (that undoes the test). It should read "ALL 8 CHECKS PASSED".
do $$
declare
  r jsonb; v_dev uuid; v_join bigint; v_scan bigint; v_old bigint; fails text[] := '{}';
begin
  insert into public.devices (serial, key_hash) values ('feedc0de00000013', 'hash-a') returning id into v_dev;
  insert into public.device_commands (device_id, command, payload)
    values (v_dev, 'wifi_join', '{"ssid": "Test Net", "psk": "secret-pass", "hidden": false}') returning id into v_join;
  insert into public.device_commands (device_id, command) values (v_dev, 'wifi_scan') returning id into v_scan;
  insert into public.device_commands (device_id, command, payload, created_at)
    values (v_dev, 'wifi_join', '{"ssid": "Old", "psk": "old-password"}', now() - interval '2 hours') returning id into v_old;

  r := public.agent_checkin('feedc0de00000013', 'hash-a', '{}', '{}', null, null);
  if not exists (select 1 from jsonb_array_elements(r -> 'commands') c
                 where (c ->> 'id')::bigint = v_join and c #>> '{payload,ssid}' = 'Test Net' and c #>> '{payload,psk}' = 'secret-pass')
    then fails := fails || '1 the Pi receives the network and its password'::text; end if;
  if exists (select 1 from public.device_commands where id = v_join and payload is not null)
    then fails := fails || '2 the password is gone from the database once handed over'::text; end if;
  if exists (select 1 from jsonb_array_elements(r -> 'commands') c where (c ->> 'id')::bigint = v_scan and c ? 'payload')
    then fails := fails || '3 a command with no payload is sent without one'::text; end if;
  if exists (select 1 from public.device_commands where id = v_old and (status <> 'expired' or payload is not null))
    or exists (select 1 from jsonb_array_elements(r -> 'commands') c where (c ->> 'id')::bigint = v_old)
    then fails := fails || '4 an hour-old join expires, undelivered, and its password is cleared'::text; end if;
  r := public.agent_checkin('feedc0de00000013', 'hash-a', '{}', '{}', null, null);
  if jsonb_array_length(r -> 'commands') <> 0 then fails := fails || '5 delivered once'::text; end if;

  r := public.agent_checkin('feedc0de00000013', 'hash-a', '{}', '{}', null,
         jsonb_build_array(jsonb_build_object('id', v_scan, 'status', 'done', 'result', repeat('x', 5000)),
                           jsonb_build_object('id', v_join, 'status', 'done', 'result', repeat('y', 900))));
  if (select length(result) from public.device_commands where id = v_scan) <> 4000 then fails := fails || '6 a scan keeps up to 4,000 characters'::text; end if;
  if (select length(result) from public.device_commands where id = v_join) <> 500 then fails := fails || '7 other results stay at 500'::text; end if;

  if has_function_privilege('authenticated', 'public.agent_checkin(text,text,jsonb,jsonb,text,jsonb)', 'execute')
     or pg_get_constraintdef((select oid from pg_constraint where conname = 'device_commands_command_check')) not like '%wifi_join%'
    then fails := fails || '8 permissions and the command list'::text; end if;

  if cardinality(fails) = 0 then raise exception 'ALL 8 CHECKS PASSED. (This red message is expected; the test data was removed.)';
  else raise exception 'FAILED: %', array_to_string(fails, ' || '); end if;
end $$;
