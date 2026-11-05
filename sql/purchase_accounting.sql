-- ============================================================
-- 進貨帳務:Purchase List 的付款記錄
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
-- 前提:已經執行過 sql/invoices_table.sql(要用裡面的 is_accounting_user())。
--
-- * purchase_payments:每筆付款一列(日期、金額、方式、備註、記錄者)。purchase_id 對應 purchases.id。
-- * 進貨單本身(金額、GST、是否入會計紀錄)存在 purchases.payload 裡,不需要改 purchases 表。
-- * 只有 admin / accountant 讀得到;寫入一律走函式(security definer)。
-- ============================================================
create table if not exists public.purchase_payments (
  id           text primary key,
  purchase_id  text not null,
  pay_date     date not null,
  amount       numeric not null check (amount <> 0),
  method       text,
  note         text,
  created_by   text,
  created_at   timestamptz not null default now()
);
create index if not exists purchase_payments_purchase_idx on public.purchase_payments (purchase_id);

alter table public.purchase_payments enable row level security;
drop policy if exists purchase_payments_select on public.purchase_payments;
create policy purchase_payments_select on public.purchase_payments for select to authenticated using (public.is_accounting_user());

-- 新增或修改一筆付款(p_payment_id 為空 = 新增)。金額上限由前端依進貨單合計檢查。
create or replace function public.purchase_payment_save(p_purchase_id text, p_payment_id text, p_date date, p_amount numeric, p_method text, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_who text; v_id text;
begin
  if not public.is_accounting_user() then raise exception 'purchase_forbidden'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'purchase_bad_paid'; end if;
  if p_date is null then raise exception 'purchase_bad_date'; end if;
  select username into v_who from public.profiles where id = auth.uid();
  if p_payment_id is null or p_payment_id = '' then
    v_id := gen_random_uuid()::text;
    insert into public.purchase_payments (id, purchase_id, pay_date, amount, method, note, created_by)
    values (v_id, p_purchase_id, p_date, p_amount, nullif(p_method, ''), nullif(p_note, ''), v_who);
  else
    v_id := p_payment_id;
    update public.purchase_payments
       set pay_date = p_date, amount = p_amount, method = nullif(p_method, ''), note = nullif(p_note, '')
     where id = p_payment_id and purchase_id = p_purchase_id;
    if not found then raise exception 'purchase_payment_not_found'; end if;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.purchase_payment_delete(p_payment_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_accounting_user() then raise exception 'purchase_forbidden'; end if;
  delete from public.purchase_payments where id = p_payment_id;
  if not found then raise exception 'purchase_payment_not_found'; end if;
end $$;

-- 備份 / 還原 / 清除全部資料用
create or replace function public.purchase_payments_restore_all(p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_accounting_user() then raise exception 'purchase_forbidden'; end if;
  delete from public.purchase_payments where true;
  insert into public.purchase_payments (id, purchase_id, pay_date, amount, method, note, created_by, created_at)
  select r->>'id', r->>'purchase_id', (r->>'pay_date')::date, (r->>'amount')::numeric, r->>'method', r->>'note', r->>'created_by',
         coalesce(nullif(r->>'created_at', '')::timestamptz, now())
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
end $$;

create or replace function public.purchase_payments_clear_all()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_accounting_user() then raise exception 'purchase_forbidden'; end if;
  delete from public.purchase_payments where true;
end $$;

grant execute on function public.purchase_payment_save(text, text, date, numeric, text, text) to authenticated;
grant execute on function public.purchase_payment_delete(text) to authenticated;
grant execute on function public.purchase_payments_restore_all(jsonb) to authenticated;
grant execute on function public.purchase_payments_clear_all() to authenticated;
