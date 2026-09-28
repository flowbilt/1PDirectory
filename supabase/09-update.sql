-- Lobby Directory: the "Update Pi" command (DP-02 round 5).
-- Run in Supabase BEFORE uploading the round 5 code: SQL Editor -> New query -> paste -> Run.
-- (The old code never sends update_pi, so this order has no gap.) Safe to run more than once.
--
-- Update Pi: the Pi downloads the latest setup from the site and re-applies it in place (keeping its identity,
-- key and Wi-Fi), installs Raspberry Pi OS updates, reports the result, then restarts.

alter table public.device_commands drop constraint if exists device_commands_command_check;
alter table public.device_commands add constraint device_commands_command_check
  check (command in ('reboot', 'reload', 'screenshot', 'update_agent', 'update_pi'));

notify pgrst, 'reload schema';
