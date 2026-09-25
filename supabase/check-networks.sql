-- Confirms 08-networks.sql is in place. Changes nothing; every column should read true.
select
  (select count(*) = 2 from information_schema.tables
     where table_schema = 'public' and table_name in ('wifi_networks', 'prepare_codes'))                    as tables_present,
  (select count(*) = 2 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname in ('wifi_networks', 'prepare_codes') and c.relrowsecurity)   as locked,
  (select count(*) = 0 from pg_policies where schemaname = 'public' and tablename in ('wifi_networks', 'prepare_codes')) as no_policies,
  not has_table_privilege('authenticated', 'public.wifi_networks', 'select')
    and not has_table_privilege('anon', 'public.wifi_networks', 'select')                                  as signed_in_users_cant_read;
