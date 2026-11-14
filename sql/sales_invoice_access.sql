-- ============================================================
-- 業務(sales)身分可以「建立」Invoice / Credit Note(例如出貨新增訂單時選「Create invoice & submit」)
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
--
-- * 新增 is_invoice_user():admin / accountant / sales。
-- * 只把「建立」用的三個函式(invoice_create、invoice_create_multi、credit_note_create)的權限檢查
--   換成 is_invoice_user();其他(讀取 Invoice 清單、收款、改單…)仍然只有 admin / accountant,
--   不影響 is_accounting_user() 原本管的其他資料(進貨付款、預付款、帳號申請等)。
-- * 同時確認 profiles.role 沒有 CHECK 限制擋掉 'sales'(沒有限制就什麼都不會做)。
-- ============================================================
create or replace function public.is_invoice_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'accountant', 'sales'));
$$;

do $$
declare f text; def text;
begin
  foreach f in array array[
    'public.invoice_create(jsonb, text, text, text)',
    'public.invoice_create_multi(jsonb, jsonb, text)',
    'public.credit_note_create(jsonb, text, text)'
  ] loop
    begin
      def := pg_get_functiondef(f::regprocedure);
      def := replace(def, 'public.is_accounting_user()', 'public.is_invoice_user()');
      execute def;
    exception when undefined_function then
      raise notice '略過(函式不存在):%', f;
    end;
  end loop;
end $$;

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
