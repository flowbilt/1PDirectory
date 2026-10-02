-- Lobby Directory: remote support with Raspberry Pi Connect, switched on and off from the console (DP-03).
-- Run in Supabase BEFORE uploading the code that uses it: SQL Editor -> New query -> paste -> Run.
-- (The old code never sends the new commands, so this order has no gap.) Safe to run more than once.
--
--   remote_on   the Pi installs Raspberry Pi Connect if it isn't there, switches it on, and returns the sign-in
--               link (shown in the Pi panel) so 1Point can link it to its Raspberry Pi account
--   remote_off  the Pi switches Connect off; nothing stays reachable in between

alter table public.device_commands drop constraint if exists device_commands_command_check;
alter table public.device_commands add constraint device_commands_command_check
  check (command in ('reboot', 'reload', 'screenshot', 'update_agent', 'update_pi', 'wifi_scan', 'wifi_join', 'remote_on', 'remote_off'));

notify pgrst, 'reload schema';
