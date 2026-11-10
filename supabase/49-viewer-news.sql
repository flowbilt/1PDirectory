-- DP-14 (V1b): the viewer's News headlines extra. Run after 48-viewer.sql, before the code. Safe to run again.
--
-- Scot (2026-11-10): "there should be a news placeholder so when they turn it on they can see the space it takes."
-- The viewer's choices may now say "news": true or false (sample headlines in the information box, where news and
-- places take turns). 48's viewer_config_problem with that one choice more; nothing else changed. Visits kept before
-- this have no "news" and stay as they are.

create or replace function public.viewer_config_problem(c jsonb) returns text
language plpgsql immutable set search_path = public as $$
begin
  if jsonb_typeof(c) is distinct from 'object' then return 'The choices are an object.'; end if;
  if exists (select 1 from jsonb_object_keys(c) k where k not in ('v', 'kind', 'name', 'subtitle', 'tenants', 'shape', 'weather', 'qr', 'places', 'contacts', 'news')) then
    return 'Something isn''t one of the viewer''s choices.';
  end if;
  if c -> 'v' is distinct from '1'::jsonb then return 'The choices are version 1.'; end if;
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
  -- V1b: news (sample headlines); a visit kept before V1b has none
  if c ? 'news' and jsonb_typeof(c -> 'news') is distinct from 'boolean' then return 'Each extra is on or off.'; end if;
  return null;
end $$;
revoke all on function public.viewer_config_problem(jsonb) from public, anon, authenticated;
