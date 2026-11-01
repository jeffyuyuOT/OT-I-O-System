-- 正式專案「庫存位置分批次」上線前檢查(只讀,不改任何資料)。
-- 在正式 Supabase 專案(lstckpzmtacttwbmmbof)的 SQL Editor 執行;每一列的 ok 都應該是 true。
-- 任何一列是 false → 先不要繼續,代表之前的批次追蹤/Sell price 那批 SQL 還沒完整執行。
select 'table batches' as item, to_regclass('public.batches') is not null as ok
union all select 'table batch_items', to_regclass('public.batch_items') is not null
union all select 'table batch_movements', to_regclass('public.batch_movements') is not null
union all select 'view batch_item_stock', to_regclass('public.batch_item_stock') is not null
union all select 'column batches.margin_pct', exists (select 1 from information_schema.columns where table_schema='public' and table_name='batches' and column_name='margin_pct')
union all select 'column batch_movements.unit_cost', exists (select 1 from information_schema.columns where table_schema='public' and table_name='batch_movements' and column_name='unit_cost')
union all select 'column batch_movements.location_code', exists (select 1 from information_schema.columns where table_schema='public' and table_name='batch_movements' and column_name='location_code')
union all select 'column purchase_suppliers.code', exists (select 1 from information_schema.columns where table_schema='public' and table_name='purchase_suppliers' and column_name='code')
union all select 'function ' || f, exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname = f)
  from unnest(array['batch_save_purchase','batch_allocate','batch_return','batch_convert','batch_next_no','batch_item_remaining','batch_clear_all','batch_restore_all','batch_set_margin']) as f;
