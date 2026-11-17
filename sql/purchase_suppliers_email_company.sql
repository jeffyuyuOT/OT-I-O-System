-- 進貨方管理:新增「公司名稱」(company_name)與「Email」(email)。
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行,不影響既有資料。
-- 還沒執行之前,進貨方照常可以儲存,只是公司名稱 / Email 不會被保存。
alter table public.purchase_suppliers add column if not exists company_name text;
alter table public.purchase_suppliers add column if not exists email text;
