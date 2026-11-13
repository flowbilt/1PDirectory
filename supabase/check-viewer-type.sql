-- Confirms 52-viewer-type.sql works. Run after 52: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 3 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Runs as the site (service_role), which is the only one that keeps visits.
do $$
declare
  v_id uuid := gen_random_uuid(); fails text[] := '{}'; b jsonb;
  c jsonb := '{"v": 2, "kind": "directory", "name": "Type test", "subtitle": "", "tenants": 10, "shape": "landscape", "weather": true, "qr": false, "places": false, "contacts": true, "news": false,
               "look": "dark", "logo": "off", "photo": "off", "rows": []}';
begin
  perform set_config('role', 'service_role', true);
  -- 1. A visit with a location type is kept; one with none chosen ("") and one from before V3 (no type) too
  perform public.viewer_record(v_id, c || '{"type": "medical"}', 30, 4, null, '{}');
  perform public.viewer_record(gen_random_uuid(), c || '{"type": ""}', 10, 1, null, '{}');
  perform public.viewer_record(gen_random_uuid(), c, 10, 1, null, '{}');
  -- 2. Refused: an unknown type, a type that isn't text, a type on a version 1 visit
  foreach b in array array[c || '{"type": "casino"}', c || '{"type": 3}',
    '{"v": 1, "kind": "directory", "name": "Type test", "subtitle": "", "tenants": 10, "shape": "landscape", "weather": true, "qr": false, "places": false, "contacts": true, "type": "office"}'::jsonb] loop
    begin perform public.viewer_record(gen_random_uuid(), b, 1, 1, null, '{}'); fails := fails || format('2 accepted %s', left(b::text, 60));
    exception when check_violation then null; end;
  end loop;
  perform set_config('role', 'none', true);
  if (select config ->> 'type' from public.viewer_visits where id = v_id) is distinct from 'medical' then fails := fails || '1 type kept'::text; end if;
  -- 3. All three kept
  if (select count(*) from public.viewer_visits where config ->> 'name' = 'Type test') <> 3 then fails := fails || '3 three kept'::text; end if;
  if array_length(fails, 1) is null then
    raise exception 'ALL 3 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
