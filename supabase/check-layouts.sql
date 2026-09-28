-- Confirms 11-layouts.sql is in place. Changes nothing; it should read true.
select pg_get_constraintdef(oid) like '%portrait-flipped%' and pg_get_constraintdef(oid) like '%landscape-flipped%' as new_layouts_allowed
from pg_constraint where conname = 'screens_orientation_check';
