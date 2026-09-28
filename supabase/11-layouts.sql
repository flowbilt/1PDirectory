-- Lobby Directory: two more screen layouts (DP-02 round 7).
-- Run in Supabase BEFORE uploading the round 7 code: SQL Editor -> New query -> paste -> Run.
-- (The old console never offers the new values, so this order has no gap.) Safe to run more than once.
--
--   portrait-flipped   a portrait TV hung the other way round: the Pi turns the picture 270 degrees instead of 90
--   landscape-flipped  a landscape TV mounted upside down: turned 180 degrees
-- A Pi picks up a change in the console at its next start (Pi -> Reboot Pi).

alter table public.screens drop constraint if exists screens_orientation_check;
alter table public.screens add constraint screens_orientation_check
  check (orientation in ('auto', 'portrait', 'landscape', 'portrait-flipped', 'landscape-flipped'));

notify pgrst, 'reload schema';
