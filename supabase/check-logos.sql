-- Confirms 15-logos.sql is in place. Changes nothing; every column should read true.
select
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'properties'
          and column_name = 'company_logo' and is_nullable = 'NO')                                 as company_logo_present,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'properties'
          and column_name = 'logo_swap' and is_nullable = 'NO' and column_default = 'false')       as logo_swap_present,
  not exists (select 1 from public.properties where logo_swap)                                     as nothing_swapped_yet;
