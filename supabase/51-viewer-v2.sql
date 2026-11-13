-- DP-14 (V2): the viewer's version 2 choices. Run after 50-directory-look.sql, BEFORE uploading the V2 code: SQL Editor
-- -> New query -> paste -> Run. Safe to run again. Then run check-viewer-v2.sql; it should end with ALL 4 CHECKS PASSED
-- (red on purpose).
--
-- Scot (2026-11-12/13): "lower the amount of tenants available on the slider to 20 - Keep the default names, but allow
-- them to replace them and only show as many spots as they have the slider set for"; "Same as the others ...
-- placeholders but they can edit"; "allowing them to add their own building image and logo, and have a placeholder
-- image for both"; "Add a light/dark option. This will follow sunrise/sunset but that can just be noted."
--
-- A visit's choices may now be version 2 (public/viewer-sample.mjs normalizeConfig and configProblem, the same rules):
--   tenants  4 to 20
--   look     'dark' or 'light'
--   logo     'off', 'sample' (WayTuGo's placeholder) or 'own' (the visitor's own: shown only in their browser, never
--   photo    sent or kept; only the word "own" is)
--   rows     what the visitor typed over the sample tenants: [{ "name", "suite" }], one per row shown at most, names up
--            to 60 characters and suites up to 12
-- Version 1 (visits before V2) is unchanged: 4 to 60 tenants and none of the four above. 49's viewer_config_problem
-- with version 2 added; nothing else changed.

create or replace function public.viewer_config_problem(c jsonb) returns text
language plpgsql immutable set search_path = public as $$
declare r jsonb;
begin
  if jsonb_typeof(c) is distinct from 'object' then return 'The choices are an object.'; end if;
  if exists (select 1 from jsonb_object_keys(c) k where k not in ('v', 'kind', 'name', 'subtitle', 'tenants', 'shape', 'weather', 'qr', 'places', 'contacts', 'news', 'look', 'logo', 'photo', 'rows')) then
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
  -- V2
  if c -> 'v' = '1'::jsonb then
    if c ?| array['look', 'logo', 'photo', 'rows'] then return 'The look, logo, photo and rows are version 2''s.'; end if;
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
  return null;
end $$;
revoke all on function public.viewer_config_problem(jsonb) from public, anon, authenticated;
