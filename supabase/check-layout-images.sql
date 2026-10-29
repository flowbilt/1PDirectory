-- Confirms 30-layout-images.sql works. Run after 30: SQL Editor -> New query -> paste -> Run.
--
-- It ALWAYS ends with a red error message. That's on purpose: ending with an error undoes everything the
-- test did, so nothing is left behind. Read the message:
--   "ALL 8 CHECKS PASSED"  means everything works.
--   "FAILED: ..."          lists what didn't. Copy the whole message to Claude.
-- What people do in the console (renaming a picture, trying to add or remove one) is tried as signed-in users.
do $$
declare
  u_admin  uuid := gen_random_uuid();
  u_owner  uuid := gen_random_uuid();
  u_other  uuid := gen_random_uuid();
  v_org    uuid;
  v_org2   uuid;
  v_prop   uuid;
  v_lay    uuid;
  v_img    uuid;
  v_img2   uuid;
  v_path   text;
  r        jsonb;
  n        integer;
  doc      jsonb := '{"format":1,"orientation":"portrait","grid":{"cols":12,"rows":24},"blocks":[{"id":"hero","type":"photo","at":{"col":1,"row":1,"w":12,"h":6},"content":{"image":"img:check-hero"}}]}';
  fails    text[] := '{}';
begin
  insert into public.organizations (name) values ('Picture test owner') returning id into v_org;
  insert into public.organizations (name) values ('Picture test stranger') returning id into v_org2;
  insert into public.properties (org_id, name) values (v_org, 'Picture test shop') returning id into v_prop;
  insert into auth.users (id, email) values (u_admin, 'pic-admin@example.com'), (u_owner, 'pic-owner@example.com'), (u_other, 'pic-other@example.com');
  insert into public.profiles (user_id, email, role, org_id) values (u_admin, 'pic-admin@example.com', 'platform_admin', null),
                                                                    (u_owner, 'pic-owner@example.com', 'org_admin', v_org),
                                                                    (u_other, 'pic-other@example.com', 'org_admin', v_org2);

  -- 1. The bucket is there and public, with its limits
  if not exists (select 1 from storage.buckets where id = 'layout-images' and public and file_size_limit = 1048576
                   and allowed_mime_types @> array['image/webp', 'image/jpeg', 'image/png']) then
    fails := fails || '1 the bucket'::text;
  end if;

  -- 2. Pictures as the site adds them; a key is unique in its account, and keys and paths are well formed
  insert into public.layout_images (org_id, key, name, path, mime, width, height, bytes)
    values (v_org, 'check-hero', 'Hero', v_org || '/check-hero-1a2b3c4d.webp', 'image/webp', 1600, 1200, 300000) returning id into v_img;
  insert into public.layout_images (org_id, key, name, path, mime, width, height, bytes)
    values (v_org, 'check-spare', 'Spare', v_org || '/check-spare-5e6f7a8b.webp', 'image/webp', 800, 600, 90000) returning id into v_img2;
  begin
    insert into public.layout_images (org_id, key, path, mime, width, height, bytes) values (v_org, 'check-hero', v_org || '/x-1.webp', 'image/webp', 100, 100, 10);
    fails := fails || '2 two pictures with one key'::text;
  exception when unique_violation then null;
  end;
  begin
    insert into public.layout_images (org_id, key, path, mime, width, height, bytes) values (v_org, 'Bad Key!', v_org || '/y-1.webp', 'image/webp', 100, 100, 10);
    fails := fails || '2 a bad key'::text;
  exception when check_violation then null;
  end;

  -- 3. A picture can't be changed once made (only its name)
  begin
    update public.layout_images set path = v_org || '/other-1.webp' where id = v_img;
    fails := fails || '3 a picture''s file was changed'::text;
  exception when check_violation then null;
  end;

  -- 4. Signed in: 1Point renames; nobody signed in adds or removes one directly; owners see theirs, strangers don't
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  update public.layout_images set name = 'The hero' where id = v_img;
  begin
    insert into public.layout_images (org_id, key, path, mime, width, height, bytes) values (v_org, 'sneaky', v_org || '/sneaky-1.webp', 'image/webp', 100, 100, 10);
    fails := fails || '4 a signed-in user added a picture'::text;
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.layout_images where id = v_img2;
    if found then fails := fails || '4 a signed-in user removed a picture'::text; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.layout_image_delete(v_img2);
    fails := fails || '4 a signed-in user called the delete function'::text;
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  if (select count(*) from public.layout_images where org_id = v_org) <> 2 then fails := fails || '4 the owner can''t see their pictures'::text; end if;
  update public.layout_images set name = 'Owner rename' where id = v_img;
  if (select name from public.layout_images where id = v_img) <> 'The hero' then fails := fails || '4 an owner renamed a picture (1Point only in E1b)'::text; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u_other, 'role', 'authenticated')::text, true);
  if (select count(*) from public.layout_images where org_id = v_org) <> 0 then fails := fails || '4 a stranger sees the pictures'::text; end if;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);

  -- 5. A picture a published version uses can't be removed, in plain words; an unused one can
  insert into public.layouts (org_id, name, orientation) values (v_org, 'Picture test layout', 'portrait') returning id into v_lay;
  perform public.layout_publish(v_lay, doc, '{}', false, '', u_admin);
  if not public.layout_image_in_use(v_org, 'check-hero') or public.layout_image_in_use(v_org, 'check-spare')
     or public.layout_image_in_use(v_org2, 'check-hero') then
    fails := fails || '5 in use worked out wrongly'::text;
  end if;
  begin
    perform public.layout_image_delete(v_img);
    fails := fails || '5 a picture in use was removed'::text;
  exception when check_violation then
    if sqlerrm not like '%Picture test layout%' then fails := fails || format('5 message: %s', sqlerrm); end if;
  end;
  v_path := public.layout_image_delete(v_img2);
  if v_path not like '%/check-spare-5e6f7a8b.webp' or exists (select 1 from public.layout_images where id = v_img2) then
    fails := fails || '5 an unused picture wasn''t removed'::text;
  end if;

  -- 6. Still in use after a newer version drops it (Roll back needs it)
  perform public.layout_publish(v_lay, jsonb_set(doc, '{blocks,0,content}', '{}'), '{}', false, '', u_admin);
  begin
    perform public.layout_image_delete(v_img);
    fails := fails || '6 removed while an older kept version uses it'::text;
  exception when check_violation then null;
  end;

  -- 7. The layout screen's answer carries the pictures its published version uses (key -> path and size), only those
  insert into public.screens (key, name, layout_id, property_id, orientation) values ('picture-test-screen', 'Picture test screen', v_lay, v_prop, 'portrait');
  perform public.layout_rollback(v_lay, 1, u_admin);
  r := public.screen_state('picture-test-screen', null, null, null);
  if r -> 'images' -> 'check-hero' ->> 'path' is distinct from v_org || '/check-hero-1a2b3c4d.webp' or (r -> 'images' -> 'check-hero' ->> 'w')::int <> 1600
     or (select count(*) from jsonb_object_keys(r -> 'images')) <> 1 then
    fails := fails || format('7 images %s', r -> 'images');
  end if;

  -- 8. Permissions: nothing for signed-out visitors; deleting is the site's only
  if has_table_privilege('anon', 'public.layout_images', 'select')
     or has_function_privilege('authenticated', 'public.layout_image_delete(uuid)', 'execute')
     or has_column_privilege('authenticated', 'public.layout_images', 'path', 'update')
     or has_table_privilege('authenticated', 'public.layout_images', 'insert') then
    fails := fails || '8 permissions'::text;
  end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL 8 CHECKS PASSED (this red message is expected: it undoes the test data)';
  else
    raise exception 'FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;
