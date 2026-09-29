-- Confirms 12-alerts.sql is in place. Changes nothing; every column should read true.
select
  exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'alert_recipients') as table_present,
  (select relrowsecurity from pg_class where oid = 'public.alert_recipients'::regclass)                                  as locked,
  not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'alert_recipients')                 as no_policies,
  not has_table_privilege('authenticated', 'public.alert_recipients', 'select')                                        as signed_in_users_cant_read;
