-- Confirms 23-info-panel.sql works. Run after 23: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 9 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
do $$
declare
  v_org   uuid;
  v_prop  uuid;
  v_dir   uuid;
  v_scr   uuid;
  r       jsonb;
  v_tz    text;
  fails   text[] := '{}';
begin
  -- 1. Existing directories have everything off, existing buildings have no destinations or amenities
  --    (right after 23 runs; once someone ticks one in the editor, this check reports it, which is then expected)
  if exists (select 1 from public.directories where map_enabled or times_enabled or amenities_enabled)
     or exists (select 1 from public.properties where destinations <> '[]'::jsonb or amenities <> '[]'::jsonb) then
    fails := fails || '1 not off by default (fine if someone has already switched one on in the editor)'::text;
  end if;

  -- A test building whose clock is always inside the 6 a.m. to 7 p.m. weekday window: pick a time zone where it's
  -- a weekday at noon-ish right now (searching the whole-hour offsets)
  select tz into v_tz from (values ('Pacific/Kiritimati'),('Pacific/Tongatapu'),('Pacific/Auckland'),('Australia/Brisbane'),('Asia/Tokyo'),
    ('Asia/Shanghai'),('Asia/Bangkok'),('Asia/Dhaka'),('Asia/Karachi'),('Asia/Dubai'),('Europe/Moscow'),('Africa/Cairo'),('Europe/Paris'),('UTC'),
    ('Atlantic/Azores'),('Atlantic/South_Georgia'),('America/Sao_Paulo'),('America/Halifax'),('America/New_York'),('America/Chicago'),
    ('America/Denver'),('America/Los_Angeles'),('America/Anchorage'),('Pacific/Honolulu'),('Pacific/Pago_Pago')) t(tz)
    where extract(isodow from now() at time zone tz) <= 5 and extract(hour from now() at time zone tz) between 8 and 16 limit 1;

  insert into public.organizations (name) values ('Info panel test owner') returning id into v_org;
  insert into public.properties (org_id, name, address, lat, lon, timezone) values (v_org, 'Info panel test building', '1 Test Way', 33.45, -86.75, v_tz) returning id into v_prop;
  insert into public.directories (property_id, slug, title) values (v_prop, 'info-panel-test-dir', 'Info panel test') returning id into v_dir;
  insert into public.screens (directory_id, key, name) values (v_dir, 'info-panel-test-screen', 'Info panel test screen') returning id into v_scr;

  -- 2. Off by default: no claim
  r := public.traffic_claim('info-panel-test-screen', null);
  if r ->> 'off' is distinct from 'switched off' then fails := fails || format('2 off by default: %s', r); end if;

  -- 3. On, but no destinations
  update public.directories set times_enabled = true where id = v_dir;
  r := public.traffic_claim('info-panel-test-screen', null);
  if r ->> 'off' is distinct from 'no destinations' then fails := fails || format('3 no destinations: %s', r); end if;

  -- 4. On with destinations: the claim gives the origin and destinations and records the time
  update public.properties set destinations = '[{"label":"Airport","address":"BHM"},{"label":"BJCC","address":"2100 Richard Arrington Jr Blvd N"}]' where id = v_prop;
  r := public.traffic_claim('info-panel-test-screen', null);
  if v_tz is null then
    fails := fails || '4 no weekday time zone found (run again)'::text;
  elsif (r -> 'origin' ->> 'lat')::float <> 33.45 or jsonb_array_length(r -> 'destinations') <> 2
     or (select traffic_at from public.screens where id = v_scr) is null then
    fails := fails || format('4 claim: %s', r);
  end if;

  -- 5. A second ask within 25 minutes waits (nothing goes to Google)
  r := public.traffic_claim('info-panel-test-screen', null);
  if coalesce((r ->> 'wait')::int, 0) not between 1 and 1500 then fails := fails || format('5 wait: %s', r); end if;

  -- 6. After 25 minutes it may ask again
  update public.screens set traffic_at = now() - interval '26 minutes' where id = v_scr;
  r := public.traffic_claim('info-panel-test-screen', null);
  if r -> 'destinations' is null then fails := fails || format('6 again after 25 min: %s', r); end if;

  -- 7. Outside working hours: a building whose clock says Sunday or night gets "hours" and its time isn't touched
  update public.properties set timezone = (select tz from (values ('Pacific/Kiritimati'),('Asia/Tokyo'),('Asia/Dubai'),('Europe/Paris'),('America/Chicago'),('Pacific/Honolulu'),('Pacific/Pago_Pago')) t(tz)
    where extract(isodow from now() at time zone tz) > 5 or extract(hour from now() at time zone tz) not between 6 and 18 limit 1) where id = v_prop;
  update public.screens set traffic_at = null where id = v_scr;
  if (select timezone from public.properties where id = v_prop) is not null then
    r := public.traffic_claim('info-panel-test-screen', null);
    if r ->> 'off' is distinct from 'hours' or (select traffic_at from public.screens where id = v_scr) is not null then
      fails := fails || format('7 hours: %s', r);
    end if;
  end if;

  -- 8. At most 3 destinations and 20 amenities
  begin
    update public.properties set destinations = '[{},{},{},{}]' where id = v_prop;
    fails := fails || '8 four destinations accepted'::text;
  exception when check_violation then null;
  end;
  begin
    update public.properties set amenities = (select jsonb_agg(jsonb_build_object('name', i)) from generate_series(1, 21) i) where id = v_prop;
    fails := fails || '8 21 amenities accepted'::text;
  exception when check_violation then null;
  end;

  -- 9. Permissions: the claim and traffic_at are server-only; signed-in users can read the switches and lists
  if has_function_privilege('authenticated', 'public.traffic_claim(text,text)', 'execute')
     or has_function_privilege('anon', 'public.traffic_claim(text,text)', 'execute')
     or has_column_privilege('authenticated', 'public.screens', 'traffic_at', 'select')
     or not has_column_privilege('authenticated', 'public.directories', 'times_enabled', 'select')
     or not has_column_privilege('authenticated', 'public.properties', 'amenities', 'update') then
    fails := fails || '9 permissions'::text;
  end if;

  if cardinality(fails) = 0 then
    raise exception 'ALL 9 CHECKS PASSED. (This red message is expected; the test data was removed.)';
  else
    raise exception 'FAILED: %', array_to_string(fails, ' || ');
  end if;
end $$;
