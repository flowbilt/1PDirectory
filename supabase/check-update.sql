-- Confirms 09-update.sql is in place. Changes nothing; it should read true.
select pg_get_constraintdef(oid) like '%update_pi%' as update_pi_allowed
from pg_constraint where conname = 'device_commands_command_check';
