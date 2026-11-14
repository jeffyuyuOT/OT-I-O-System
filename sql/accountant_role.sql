-- ============================================================
-- 會計(accountant)身分:如果 profiles.role 欄位有 CHECK 限制只允許 admin/order/inventory,這段會把它拿掉(沒有限制就什麼都不會做)
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
-- 另外:invite/invite-user.ts(邀請使用者的 Edge Function)也要重新部署,才能邀請 accountant 身分的帳號。
-- ============================================================
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.profiles'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;
