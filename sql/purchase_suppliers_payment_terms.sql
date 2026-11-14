-- 進貨方管理:新增「付款天數 Payment terms」(payment_terms,單位:天)。
-- 進貨單沒填付款到期日時,到期日 = 發票日期 + 這個天數。空白 = 沒有設定(不做到期判定)。
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行,不影響既有資料。
alter table public.purchase_suppliers add column if not exists payment_terms integer;
