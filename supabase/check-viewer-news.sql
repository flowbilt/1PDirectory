-- Confirms 49-viewer-news.sql works. Run after 49: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 3 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- Runs as the site (service_role), which is the only one that keeps visits.
do $$
declare
  v_id uuid := gen_random_uuid(); fails text[] := '{}';
  c jsonb := '{"v": 1, "kind": "directory", "name": "News test", "subtitle": "", "tenants": 10, "shape": "landscape", "weather": true, "qr": false, "places": true, "contacts": true}';
begin
  perform set_config('role', 'service_role', true);
  -- 1. A visit with news on is kept
  perform public.viewer_record(v_id, c || '{"news": true}', 30, 2, null, '{}');
  -- 2. A visit without "news" (as before V1b) is still kept
  perform public.viewer_record(gen_random_uuid(), c, 10, 1, null, '{}');
  -- 3. News that isn't on or off is refused
  begin perform public.viewer_record(gen_random_uuid(), c || '{"news": "yes"}', 1, 1, null, '{}'); fails := fails || '3 news yes'::text; exception when check_violation then null; end;
  perform set_config('role', 'none', true);
  if (select config -> 'news' from public.viewer_visits where id = v_id) is distinct from 'true'::jsonb then fails := fails || '1 news kept'::text; end if;
  if (select count(*) from public.viewer_visits where config ->> 'name' = 'News test') <> 2 then fails := fails || '2 both kept'::text; end if;
  if array_length(fails, 1) is null then
    raise exception 'ALL 3 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
