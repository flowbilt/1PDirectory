-- Confirms 10-refused.sql works. Run after 10: SQL Editor -> New query -> paste -> Run.
-- It ALWAYS ends with a red error message (that undoes the test). It should read "ALL 5 CHECKS PASSED".
do $$
declare
  r jsonb; v_dev uuid; fails text[] := '{}';
begin
  insert into public.devices (serial, key_hash) values ('feedc0de00000006', 'hash-a') returning id into v_dev;
  r := public.agent_checkin('feedc0de00000006', 'hash-b', '{}', '{}', null, null);
  if not exists (select 1 from public.devices where id = v_dev and refused_why = 'key' and refused_at is not null) then fails := fails || '1 a new key is recorded as refused'::text; end if;
  r := public.agent_checkin('feedc0de00000006', 'hash-a', '{}', '{}', null, null);
  if r ->> 'refused' is not null or exists (select 1 from public.devices where id = v_dev and (refused_at is not null or refused_why is not null)) then fails := fails || '2 a good check-in clears it'::text; end if;
  update public.devices set key_hash = null, enroll_until = null where id = v_dev;
  r := public.agent_checkin('feedc0de00000006', 'hash-c', '{}', '{}', null, null);
  if not exists (select 1 from public.devices where id = v_dev and refused_why = 'enroll') then fails := fails || '3 a closed window is recorded'::text; end if;
  update public.devices set key_hash = 'hash-a', status = 'revoked' where id = v_dev;
  r := public.agent_checkin('feedc0de00000006', 'hash-a', '{}', '{}', null, null);
  if not exists (select 1 from public.devices where id = v_dev and refused_why = 'revoked') then fails := fails || '4 switched off is recorded'::text; end if;
  if has_function_privilege('authenticated', 'public.agent_checkin(text,text,jsonb,jsonb,text,jsonb)', 'execute') then fails := fails || '5 permissions'::text; end if;
  if cardinality(fails) = 0 then raise exception 'ALL 5 CHECKS PASSED. (This red message is expected; the test data was removed.)';
  else raise exception 'FAILED: %', array_to_string(fails, ' || '); end if;
end $$;
