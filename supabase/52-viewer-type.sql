-- DP-14 (V3): the viewer's optional location type. Run after 51-viewer-v2.sql, BEFORE uploading the V3 code: SQL Editor
-- -> New query -> paste -> Run. Safe to run again. Then run check-viewer-type.sql; it should end with ALL 3 CHECKS PASSED
-- (red on purpose).
--
-- Scot's brief (2026-11-13), "Optional Industry Selection & Sample Content Personalization": a compact, optional
-- dropdown near the bottom of the viewer ("Make this preview more relevant to you") personalizes the sample names, and
-- the choice is kept with the visit, anonymously, so 1Point can see which markets are interested. A version 2 visit may
-- now say "type": "" (none chosen) or one of office, medical, government, hospitality, retail, education, restaurant,
-- other, exploring (public/viewer-sample.mjs TYPES). It's self-chosen, not a verified industry. 51's
-- viewer_config_problem with that one choice more; nothing else changed. Visits kept before this have no "type"
-- (shown as Not specified).

create or replace function public.viewer_config_problem(c jsonb) returns text
language plpgsql immutable set search_path = public as $$
declare r jsonb;
begin
  if jsonb_typeof(c) is distinct from 'object' then return 'The choices are an object.'; end if;
  if exists (select 1 from jsonb_object_keys(c) k where k not in ('v', 'kind', 'name', 'subtitle', 'tenants', 'shape', 'weather', 'qr', 'places', 'contacts', 'news', 'look', 'logo', 'photo', 'rows', 'type')) then
    return 'Something isn''t one of the viewer''s choices.';
  end if;
  if c -> 'v' is distinct from '1'::jsonb and c -> 'v' is distinct from '2'::jsonb then return 'The choices are version 1 or 2.'; end if;
  if jsonb_typeof(c -> 'kind') is distinct from 'string' or c ->> 'kind' not in ('directory', 'touch') then return 'The display is a building directory or a touch directory.'; end if;
  if jsonb_typeof(c -> 'name') is distinct from 'string' or char_length(c ->> 'name') > 60
     or jsonb_typeof(c -> 'subtitle') is distinct from 'string' or char_length(c ->> 'subtitle') > 60 then
    return 'The name and subtitle are text of up to 60 characters.';
  end if;
  if jsonb_typeof(c -> 'tenants') is distinct from 'number' or (c ->> 'tenants') !~ '^[0-9]+$' or (c ->> 'tenants')::int not between 4 and 60 then
    return 'The tenants are 4 to 60.';
  end if;
  if jsonb_typeof(c -> 'shape') is distinct from 'string' or c ->> 'shape' not in ('landscape', 'portrait') then return 'The screen is landscape or portrait.'; end if;
  if jsonb_typeof(c -> 'weather') is distinct from 'boolean' or jsonb_typeof(c -> 'qr') is distinct from 'boolean'
     or jsonb_typeof(c -> 'places') is distinct from 'boolean' or jsonb_typeof(c -> 'contacts') is distinct from 'boolean' then
    return 'Each extra is on or off.';
  end if;
  if c ? 'news' and jsonb_typeof(c -> 'news') is distinct from 'boolean' then return 'Each extra is on or off.'; end if;
  if c -> 'v' = '1'::jsonb then
    if c ?| array['look', 'logo', 'photo', 'rows', 'type'] then return 'The look, logo, photo, rows and type are version 2''s.'; end if;
    return null;
  end if;
  if (c ->> 'tenants')::int > 20 then return 'The tenants are 4 to 20.'; end if;
  if jsonb_typeof(c -> 'look') is distinct from 'string' or c ->> 'look' not in ('dark', 'light') then return 'The look is Dark or Light.'; end if;
  if jsonb_typeof(c -> 'logo') is distinct from 'string' or c ->> 'logo' not in ('off', 'sample', 'own')
     or jsonb_typeof(c -> 'photo') is distinct from 'string' or c ->> 'photo' not in ('off', 'sample', 'own') then
    return 'The logo and photo are off, the sample or their own.';
  end if;
  if jsonb_typeof(c -> 'rows') is distinct from 'array' or jsonb_array_length(c -> 'rows') > (c ->> 'tenants')::int then
    return 'The rows are a list, one for each tenant at most.';
  end if;
  for r in select * from jsonb_array_elements(c -> 'rows') loop
    if jsonb_typeof(r) <> 'object' or exists (select 1 from jsonb_object_keys(r) k where k not in ('name', 'suite'))
       or jsonb_typeof(r -> 'name') is distinct from 'string' or jsonb_typeof(r -> 'suite') is distinct from 'string'
       or char_length(r ->> 'name') > 60 or char_length(r ->> 'suite') > 12 then
      return 'Each row is a name of up to 60 characters and a suite of up to 12.';
    end if;
  end loop;
  -- V3: the location type ("" when none was chosen)
  if c ? 'type' and (jsonb_typeof(c -> 'type') is distinct from 'string'
     or c ->> 'type' not in ('', 'office', 'medical', 'government', 'hospitality', 'retail', 'education', 'restaurant', 'other', 'exploring')) then
    return 'The location type isn''t one of the viewer''s.';
  end if;
  return null;
end $$;
revoke all on function public.viewer_config_problem(jsonb) from public, anon, authenticated;
