-- Lobby Directory: a second logo per building (DP-03 round 5).
-- Run in Supabase BEFORE uploading the round 5 code: SQL Editor -> New query -> paste -> Run.
-- (The old code doesn't read these columns, so this order has no gap.) Safe to run more than once.
--
--   company_logo  the owner's or manager's logo (e.g. Barber Companies), as a data URL like logo; '' = none
--   logo_swap     false: the building's logo (or name) at the top, the company logo in a strip at the bottom
--                 true:  the company logo at the top, the building's logo in the bottom strip
-- Owners edit both in the editor, like the building logo (properties' existing row-level security covers them).

alter table public.properties add column if not exists company_logo text not null default '';
alter table public.properties add column if not exists logo_swap boolean not null default false;

notify pgrst, 'reload schema';
