-- Confirms 03-agent.sql and 04-health.sql are fully in place. Changes nothing.
select
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'devices'
       and column_name in ('serial', 'screen_id', 'key_hash', 'status', 'last_health', 'screenshot', 'alert_state'))  as devices_columns_of_7,
  (select count(*) from information_schema.tables
     where table_schema = 'public' and table_name in ('device_commands', 'device_daily'))                              as other_tables_of_2,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'screens' and column_name = 'identify_until')                       as identify_column_of_1,
  (select count(*) from public.devices)                                                                                  as pis_registered,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname in ('devices', 'device_commands', 'device_daily') and c.relrowsecurity)   as locked_tables_of_3;
