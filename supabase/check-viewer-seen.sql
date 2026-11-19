-- Confirms 56-viewer-seen.sql works. Run after 56: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 3 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
do $$
declare
  v1 uuid := gen_random_uuid(); v2 uuid := gen_random_uuid(); fails text[] := '{}'; e jsonb;
begin
  perform set_config('role', 'service_role', true);
  -- 1. A background load: loaded unseen, never seen
  perform public.viewer_record(v1, null, 0, 0, null, '{"utm_source": "meta"}', '{"viewer_page_loaded": 1, "viewer_loaded_unseen": 1}', null, 'phone', 'facebook', null, 0, null);
  select events into e from public.viewer_visits where id = v1;
  if e <> '{"viewer_page_loaded": 1, "viewer_loaded_unseen": 1}'::jsonb then fails := fails || format('1 %s', e); end if;
  -- 2. Then seen (the visitor opened it): kept with the count
  perform public.viewer_record(v1, null, 0, 0, null, '{}', '{"viewer_page_loaded": 1, "viewer_loaded_unseen": 1, "viewer_seen": 1}', null, null, null, null, 0, null);
  select events into e from public.viewer_visits where id = v1;
  if (e ->> 'viewer_seen')::int <> 1 or (e ->> 'viewer_loaded_unseen')::int <> 1 then fails := fails || format('2 %s', e); end if;
  -- 3. The other events still kept, and one that isn't the viewer's still refused
  perform public.viewer_record(v2, null, 0, 0, null, '{}', '{"viewer_page_loaded": 1, "viewer_seen": 1, "directory_email_sent": 1, "full_preview_opened": 2}', null, null, null, null, 0, null);
  if not exists (select 1 from public.viewer_visits where id = v2 and (events ->> 'full_preview_opened')::int = 2) then fails := fails || '3 kept'::text; end if;
  begin perform public.viewer_record(gen_random_uuid(), null, 0, 0, null, '{}', '{"viewer_hidden": 1}', null, null, null, null, 0, null); fails := fails || '3 accepted viewer_hidden'::text;
  exception when check_violation then null; end;
  perform set_config('role', 'none', true);
  if array_length(fails, 1) is null then
    raise exception 'ALL 3 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
