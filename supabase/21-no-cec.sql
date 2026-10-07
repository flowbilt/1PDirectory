-- Lobby Directory: a per-screen "this display has no HDMI-CEC" setting (DP-05 round 7).
-- Run in Supabase BEFORE uploading the round 7 code: SQL Editor -> New query -> paste -> Run.
-- (The new console and technician page ask for this column, so it must exist first; the old code never asks for it,
-- so this order has no gap.) Safe to run more than once.
--
-- Some displays have no usable HDMI-CEC: most computer monitors and touch displays (the Beetronics 13" touch monitor
-- answers nothing over CEC, proven 2026-10-06). The Pi can't switch them on or ask whether they're on, so it reports
-- "TV not answering", which Health counted as a problem forever. With no_cec set on the screen:
--   Health and its "Need attention" count leave that screen's TV state out (every other check still counts),
--   the console's Pi panel says the display has no HDMI-CEC instead of a warning,
--   the technician page doesn't tell the technician to fix the TV's CEC setting.
-- Nothing changes on the Pi: it still tries to keep the display on (harmless without CEC). Such a display needs its own
-- power-on-after-power-loss setting. Set by 1Point in the console's Screen settings (screens stay 1Point-only to write);
-- readable by signed-in users like the other screen settings.

alter table public.screens add column if not exists no_cec boolean not null default false;

grant select (no_cec) on public.screens to authenticated;

notify pgrst, 'reload schema';
