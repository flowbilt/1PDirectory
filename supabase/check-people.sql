-- Confirms 26-people.sql works. Run after 26: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 10 CHECKS PASSED"  means everything works.
--   "FAILED: ..."           lists what didn't. Copy the whole message to Claude.
do $$
declare
  v_org    uuid;
  v_other  uuid;
  v_prop   uuid;
  v_prop2  uuid;
  v_dir    uuid;
  v_dir2   uuid;
  v_dir3   uuid;
  v_scr    uuid;
  v_t1     uuid;
  v_t2     uuid;
  v_co     uuid;
  v_co2    uuid;
  v_n      integer;
  u_owner  uuid := gen_random_uuid();
  u_stray  uuid := gen_random_uuid();
  r        jsonb;
  v_etag   text;
  fails    text[] := '{}';
begin
  -- A made-up owner: one building with two directories (an entrance screen and a directional), a second building,
  -- and a user from another account
  insert into public.organizations (name) values ('People test owner') returning id into v_org;
  insert into public.organizations (name) values ('People test stranger') returning id into v_other;
  insert into public.properties (org_id, name) values (v_org, 'People test building') returning id into v_prop;
  insert into public.properties (org_id, name) values (v_org, 'People test second building') returning id into v_prop2;
  insert into public.directories (property_id, slug, title) values (v_prop, 'people-test-entrance', 'Entrance') returning id into v_dir;
  insert into public.directories (property_id, slug, title) values (v_prop, 'people-test-floor2', 'Floor 2') returning id into v_dir2;
  insert into public.directories (property_id, slug, title) values (v_prop2, 'people-test-other', 'Other') returning id into v_dir3;
  insert into public.screens (directory_id, key, name) values (v_dir, 'people-test-screen', 'People test screen') returning id into v_scr;
  insert into auth.users (id, email) values (u_owner, 'people-owner@example.com'), (u_stray, 'people-stray@example.com');
  insert into public.profiles (user_id, email, role, org_id) values (u_owner, 'people-owner@example.com', 'org_editor', v_org),
                                                                    (u_stray, 'people-stray@example.com', 'org_admin', v_other);
  insert into public.tenants (directory_id, sort, name, suite) values (v_dir, 0, 'Acme Law', '200') returning id into v_t1;
  insert into public.tenants (directory_id, sort, name, suite) values (v_dir2, 0, '  acme   LAW ', '200') returning id into v_t2;
  insert into public.tenants (directory_id, sort, name, suite) values (v_dir3, 0, 'Acme Law', '9');

  -- 1. A tenant gets its building's company by name: the same company in both directories (case and spaces don't
  --    matter), another company in the other building; existing tenants all have one
  select company_id into v_co from public.tenants where id = v_t1;
  if v_co is null or v_co is distinct from (select company_id from public.tenants where id = v_t2)
     or (select company_id from public.tenants where directory_id = v_dir3) = v_co
     or (select count(*) from public.companies where property_id = v_prop) <> 1
     or exists (select 1 from public.tenants where company_id is null) then
    fails := fails || '1 companies by name'::text;
  end if;

  -- 2. Off until the owner turns it on; title is the only detail shown by default
  if (select (show_people, show_title, show_phone, show_email) from public.companies where id = v_co) <> (false, true, false, false) then
    fails := fails || '2 defaults'::text;
  end if;

  -- 3. People: at least a first or last name; sizes kept in bounds
  insert into public.people (company_id, sort, first_name, last_name, title, phone, email) values
    (v_co, 10, 'Bea', 'Zimmer', 'Partner', 'x204', 'bea@acme.example'),
    (v_co, 20, 'Al', 'Young', 'Paralegal', '205-555-0101', 'al@acme.example');
  insert into public.people (company_id, sort, first_name, last_name, show) values (v_co, 30, 'Hidden', 'Person', false);
  begin
    insert into public.people (company_id, first_name, last_name) values (v_co, '  ', '');
    fails := fails || '3 a blank person accepted'::text;
  exception when check_violation then null;
  end;
  begin
    insert into public.people (company_id, first_name, suite) values (v_co, 'Long', repeat('9', 17));
    fails := fails || '3 a 17-character suite accepted'::text;
  exception when check_violation then null;
  end;

  -- 4. A display-only screen never gets people, even with the switch on
  update public.companies set show_people = true where id = v_co;
  r := public.screen_state('people-test-screen', null, null, null);
  if r -> 'tenants' -> 0 -> 'people' <> '[]'::jsonb then fails := fails || format('4 display-only screen: %s', r -> 'tenants'); end if;

  -- 5. A touch screen with the switch off gets none
  update public.screens set touch = true where id = v_scr;
  update public.companies set show_people = false where id = v_co;
  r := public.screen_state('people-test-screen', null, null, null);
  if r -> 'tenants' -> 0 -> 'people' <> '[]'::jsonb then fails := fails || format('5 switch off: %s', r -> 'tenants'); end if;

  -- 6. Switch on: only people ticked Show, in order, with only the details the company shows
  update public.companies set show_people = true where id = v_co;
  r := public.screen_state('people-test-screen', null, null, null) -> 'tenants' -> 0 -> 'people';
  if r <> '[{"first": "Bea", "last": "Zimmer", "title": "Partner", "phone": "", "email": "", "suite": ""},
             {"first": "Al", "last": "Young", "title": "Paralegal", "phone": "", "email": "", "suite": ""}]'::jsonb then
    fails := fails || format('6 switch on: %s', r);
  end if;
  update public.companies set show_title = false, show_phone = true where id = v_co;
  r := public.screen_state('people-test-screen', null, null, null) -> 'tenants' -> 0 -> 'people' -> 0;
  if r ->> 'title' <> '' or r ->> 'phone' <> 'x204' or r ->> 'email' <> '' then fails := fails || format('6 details: %s', r); end if;

  -- 7. A change to a person or to the switches marks the directory as changed (its updated_at, which is in the
  --    screen's version), so the screen fetches it. (Within this one test the clock doesn't move, so the check looks
  --    at the directory row itself being rewritten.)
  v_etag := (select ctid::text from public.directories where id = v_dir);
  update public.companies set show_email = false where id = v_co;    -- unchanged: nothing to do
  if (select ctid::text from public.directories where id = v_dir) <> v_etag then fails := fails || '7 an unchanged switch touched the directory'::text; end if;
  update public.companies set show_email = true where id = v_co;
  if (select ctid::text from public.directories where id = v_dir) = v_etag then fails := fails || '7 the switches didn''t mark the directory'::text; end if;
  update public.companies set show_email = false where id = v_co;
  v_etag := (select string_agg(ctid::text, ',' order by slug) from public.directories where id in (v_dir, v_dir2));
  update public.people set title = 'Senior Partner' where company_id = v_co and first_name = 'Bea';
  -- both directories list the company, so both screens fetch the change
  if (select ctid::text from public.directories where id = v_dir) = split_part(v_etag, ',', 1)
     or (select ctid::text from public.directories where id = v_dir2) = split_part(v_etag, ',', 2) then
    fails := fails || '7 a person''s edit didn''t mark the directory'::text;
  end if;

  -- 8. Renames: while another directory lists the company, a renamed tenant moves to a new company and the people
  --    stay; once it's the only listing, a rename takes the company and its people with it
  update public.tenants set name = 'Acme Legal' where id = v_t1;
  select company_id into v_co2 from public.tenants where id = v_t1;
  if v_co2 = v_co or (select count(*) from public.people where company_id = v_co) <> 3 then fails := fails || '8 shared rename'::text; end if;
  update public.tenants set name = 'Acme Law' where id = v_t1;      -- back together
  delete from public.tenants where id = v_t2;                        -- now the entrance is its only listing
  update public.tenants set name = 'Acme Law Group' where id = v_t1;
  if (select company_id from public.tenants where id = v_t1) <> v_co or (select name from public.companies where id = v_co) <> 'Acme Law Group'
     or (select count(*) from public.people where company_id = v_co) <> 3 then
    fails := fails || '8 rename keeps the people'::text;
  end if;
  -- an upsert of an existing row (how the editor saves) is a rename too, not a new company
  insert into public.tenants (id, directory_id, sort, name, suite) values (v_t1, v_dir, 0, 'Acme Law Partners', '200')
    on conflict (id) do update set name = excluded.name, suite = excluded.suite;
  if (select company_id from public.tenants where id = v_t1) <> v_co
     or exists (select 1 from public.companies where property_id = v_prop and name = 'Acme Law Partners' and id <> v_co) then
    fails := fails || '8 upsert rename'::text;
  end if;

  -- 9. The owner's own users can read the company, flip its switches and edit its people; they can't rename it,
  --    make one, or point a tenant at another company; a stranger sees and changes nothing
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into v_n from public.people where company_id = v_co;
  if v_n <> 3 then fails := fails || format('9 owner sees %s people', v_n); end if;
  update public.companies set show_email = true where id = v_co;
  insert into public.people (company_id, first_name) values (v_co, 'Cy');
  begin
    update public.companies set name = 'Something else' where id = v_co;
    fails := fails || '9 owner renamed the company'::text;
  exception when raise_exception then null;
  end;
  begin
    insert into public.companies (property_id, name) values (v_prop, 'Made by hand');
    fails := fails || '9 owner made a company by hand'::text;
  exception when insufficient_privilege then null;
  end;
  update public.tenants set company_id = v_co2 where id = v_t1;
  perform set_config('request.jwt.claims', json_build_object('sub', u_stray, 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.people;
  if v_n <> 0 or exists (select 1 from public.companies) then fails := fails || '9 stranger sees people or companies'::text; end if;
  update public.companies set show_people = false where id = v_co;
  delete from public.people where company_id = v_co;
  begin
    insert into public.people (company_id, first_name) values (v_co, 'Intruder');
    fails := fails || '9 stranger added a person'::text;
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  if not (select show_email and show_people from public.companies where id = v_co)
     or (select count(*) from public.people where company_id = v_co) <> 4
     or (select company_id from public.tenants where id = v_t1) <> v_co then
    fails := fails || '9 changes'::text;
  end if;

  -- 10. Never anywhere else: the Directory to Go page carries no people, signed-out users can't read the tables,
  --     screen_state stays server-only
  update public.directories set togo_enabled = true where id = v_dir;
  r := public.togo_page((select togo_code from public.directories where id = v_dir));
  if r::text ilike '%Zimmer%' or jsonb_path_exists(r, '$.**.people')
     or has_table_privilege('anon', 'public.people', 'select') or has_table_privilege('anon', 'public.companies', 'select')
     or has_function_privilege('authenticated', 'public.screen_state(text,text,text,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.touch_company(uuid)', 'execute') then
    fails := fails || '10 people elsewhere, or permissions'::text;
  end if;

  if cardinality(fails) = 0 then
    raise exception 'ALL 10 CHECKS PASSED. (This red message is expected; the test data was removed.)';
  else
    raise exception 'FAILED: %', array_to_string(fails, ' || ');
  end if;
end $$;
