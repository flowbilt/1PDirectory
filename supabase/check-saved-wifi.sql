-- Confirms 14-saved-wifi.sql is in place. Changes nothing; every column should read true.
select
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'wifi_networks'
          and column_name = 'on_cards' and is_nullable = 'NO' and column_default = 'true')              as column_present,
  not exists (select 1 from public.wifi_networks where on_cards is distinct from true
              and updated_at < now() - interval '1 minute' and label <> '')                          as office_networks_still_on_cards,
  (select relrowsecurity from pg_class where oid = 'public.wifi_networks'::regclass)                  as still_locked;
