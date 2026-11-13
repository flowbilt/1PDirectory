-- DP-14 (D2): Light and Dark for directory screens, and the look by the time of day. Run after 49-viewer-news.sql,
-- BEFORE uploading the D2 code: SQL Editor -> New query -> paste -> Run. Safe to run again. Then run
-- check-directory-look.sql; it should end with ALL 4 CHECKS PASSED (red on purpose).
--
-- Scot (2026-11-13): "Add a light/dark option ... Let's go with light first. Important option and tied to sunrise,
-- sunset as menus are." The customer chooses it in the directory editor, as with the keyboard switch:
--
--   directories.look        'dark' (the original, and the default) or 'light'
--   directories.look_when   null (the look above, all day), or the look by the time of day, the menu boards' shape
--                           (47-light-dark.sql): { "day", "evening", "dayAt", "eveningAt", "sun" }: the day look from
--                           dayAt, the evening look from eveningAt, every day by the building's clock; or at sunrise
--                           and sunset when "sun" is ticked (from the building's location, the weather's lat and lon)
--
-- Both reach the screen with the rest of the directory row (screen_state's to_jsonb(d)), and a save changes the
-- directory's updated_at, so screens pick it up at their next check. Nothing else changes.

alter table public.directories add column if not exists look text not null default 'dark';
alter table public.directories add column if not exists look_when jsonb;

-- The rules for the schedule: a directory has two looks, Dark and Light, so the day look is one and the evening the other
create or replace function public.directory_look_problem(w jsonb) returns text
language plpgsql immutable set search_path = public as $$
begin
  if w is null then return null; end if;
  if jsonb_typeof(w) <> 'object' or exists (select 1 from jsonb_object_keys(w) x where x not in ('day', 'evening', 'dayAt', 'eveningAt', 'sun')) then
    return 'The look by the time of day is a day look, an evening look, their times and the sunrise and sunset tick box.';
  end if;
  if jsonb_typeof(w -> 'day') is distinct from 'string' or jsonb_typeof(w -> 'evening') is distinct from 'string'
     or w ->> 'day' not in ('dark', 'light') or w ->> 'evening' not in ('dark', 'light') then
    return 'The day and evening looks are Light or Dark.';
  end if;
  if w ->> 'day' = w ->> 'evening' then return 'The day look and the evening look are different looks.'; end if;
  if jsonb_typeof(w -> 'dayAt') is distinct from 'string' or jsonb_typeof(w -> 'eveningAt') is distinct from 'string'
     or w ->> 'dayAt' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or w ->> 'eveningAt' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    return 'The day and evening times are times of day, like 06:00 and 17:00.';
  end if;
  if w ->> 'dayAt' = w ->> 'eveningAt' then return 'The day look and the evening look start at different times.'; end if;
  if w ? 'sun' and jsonb_typeof(w -> 'sun') <> 'boolean' then return 'Sunrise and sunset is ticked or not.'; end if;
  return null;
end $$;

create or replace function public.guard_directory_look() returns trigger
language plpgsql set search_path = public as $$
declare p text := public.directory_look_problem(new.look_when);
begin
  if p is not null then raise exception '%', p using errcode = 'check_violation'; end if;
  return new;
end $$;
revoke all on function public.guard_directory_look() from public, anon, authenticated;

drop trigger if exists directories_look_guard on public.directories;
create trigger directories_look_guard before insert or update of look_when on public.directories
  for each row execute function public.guard_directory_look();

do $$ begin
  alter table public.directories add constraint directories_look_known check (look in ('dark', 'light'));
exception when duplicate_object then null;
end $$;
