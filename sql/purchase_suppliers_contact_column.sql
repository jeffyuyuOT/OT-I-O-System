-- 進貨方管理:新增「聯繫人」欄位(purchase_suppliers.contact)
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行,不影響既有資料。
alter table public.purchase_suppliers add column if not exists contact text;
