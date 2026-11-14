-- 正式專案「庫存位置分批次」執行完全部 SQL 之後的驗證(只讀)。每一列的 ok 都應該是 true。
select 'table batch_item_locations' as item, to_regclass('public.batch_item_locations') is not null as ok
union all select 'view batch_item_loc_stock', to_regclass('public.batch_item_loc_stock') is not null
union all select 'table location_transfer_log', to_regclass('public.location_transfer_log') is not null
union all select 'column batch_items.note', exists (select 1 from information_schema.columns where table_schema='public' and table_name='batch_items' and column_name='note')
union all select 'function ' || f, exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname = f)
  from unnest(array['batch_set_purchase_locations','batch_tag_locations','batch_transfer_locations','batch_set_item_locations','batch_tag_convert_locations','batch_clamp_purchase_locations','location_log_restore']) as f
union all select 'batch_restore_all has p_locations (4 args)', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='batch_restore_all' and p.pronargs = 4)
union all select 'batch_allocate: opening batch first', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='batch_allocate' and p.prosrc like '%not b.is_opening%')
union all select 'batch_convert: opening batch first', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='batch_convert' and p.prosrc like '%not b.is_opening%');
