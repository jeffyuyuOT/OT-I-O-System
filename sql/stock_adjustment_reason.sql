-- ============================================================
-- 庫存調整原因(階段二):transactions 加 adj_reason 欄位
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
--
-- * adj_reason 存原因代碼(wastage_expired / wastage_damaged / sample / internal_use /
--   stocktake_gain / stocktake_loss / return_supplier / donation_writeoff / other),
--   只有「庫存調整」產生的進出貨紀錄會有值,其他紀錄維持空白。
-- * 會計報表(階段三)用這個欄位統計耗損等;進出貨紀錄的備註文字仍照常寫入。
-- ============================================================
alter table public.transactions add column if not exists adj_reason text;
create index if not exists transactions_adj_reason_idx on public.transactions (adj_reason) where adj_reason is not null;
