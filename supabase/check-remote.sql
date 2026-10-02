-- Confirms 16-remote.sql is in place. Changes nothing; every column should read true.
select
  pg_get_constraintdef((select oid from pg_constraint where conname = 'device_commands_command_check')) like '%remote_on%'  as remote_on_allowed,
  pg_get_constraintdef((select oid from pg_constraint where conname = 'device_commands_command_check')) like '%remote_off%' as remote_off_allowed,
  pg_get_constraintdef((select oid from pg_constraint where conname = 'device_commands_command_check')) like '%wifi_join%'  as wifi_still_allowed;
