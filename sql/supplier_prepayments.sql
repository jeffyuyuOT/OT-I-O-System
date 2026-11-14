-- ============================================================
-- 供應商預付款(貨還沒到先付的錢)
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
-- 前提:已經執行過 sql/invoices_table.sql(is_accounting_user())與 sql/purchase_accounting.sql(purchase_payments)。
--
-- * supplier_prepayments:每筆預付款一列(金額為正 = 付給供應商;負數 = 供應商退回預付款)。
--   可連結一份進貨預估紀錄(forecast_id / forecast_name,預估紀錄存在 app_data,所以只存 id 與名稱快照)。
-- * prepayment_applications:預付款抵扣進貨單的紀錄;抵扣時會同時在 purchase_payments 新增一筆付款(方式 Prepayment),
--   那筆付款被刪除時,抵扣紀錄跟著刪除(on delete cascade),預付款餘額自動回復。
-- * 只有 admin / accountant 讀得到;寫入一律走函式(security definer)。
-- ============================================================
create table if not exists public.supplier_prepayments (
  id             text primary key,
  party_id       text,
  party_name     text not null,
  pay_date       date not null,
  amount         numeric not null check (amount <> 0),
  method         text,
  note           text,
  forecast_id    text,
  forecast_name  text,
  created_by     text,
  created_at     timestamptz not null default now()
);
create index if not exists supplier_prepayments_party_idx on public.supplier_prepayments (party_name);

create table if not exists public.prepayment_applications (
  id                   text primary key,
  prepayment_id        text not null references public.supplier_prepayments(id),
  purchase_id          text not null,
  purchase_payment_id  text not null references public.purchase_payments(id) on delete cascade,
  apply_date           date not null,
  amount               numeric not null check (amount > 0),
  created_by           text,
  created_at           timestamptz not null default now()
);
create index if not exists prepayment_applications_pp_idx on public.prepayment_applications (prepayment_id);
create index if not exists prepayment_applications_purchase_idx on public.prepayment_applications (purchase_id);

alter table public.supplier_prepayments enable row level security;
alter table public.prepayment_applications enable row level security;
drop policy if exists supplier_prepayments_select on public.supplier_prepayments;
create policy supplier_prepayments_select on public.supplier_prepayments for select to authenticated using (public.is_accounting_user());
drop policy if exists prepayment_applications_select on public.prepayment_applications;
create policy prepayment_applications_select on public.prepayment_applications for select to authenticated using (public.is_accounting_user());

-- 新增或修改預付款(p_id 為空 = 新增)。負數(退回)的金額不能超過該供應商目前的預付款餘額。
create or replace function public.prepayment_save(
  p_id text, p_party_id text, p_party_name text, p_date date, p_amount numeric,
  p_method text, p_note text, p_forecast_id text, p_forecast_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_who text; v_id text; v_bal numeric; v_old numeric := 0;
begin
  if not public.is_accounting_user() then raise exception 'prepayment_forbidden'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'prepayment_bad_amount'; end if;
  if p_date is null then raise exception 'prepayment_bad_date'; end if;
  if coalesce(trim(p_party_name), '') = '' then raise exception 'prepayment_bad_party'; end if;
  select username into v_who from public.profiles where id = auth.uid();
  if p_id is not null and p_id <> '' then
    select amount into v_old from public.supplier_prepayments where id = p_id;
    if not found then raise exception 'prepayment_not_found'; end if;
  end if;
  -- 該供應商的餘額(不含正在修改的這一筆)= 所有預付款 − 已抵扣
  select coalesce(sum(s.amount), 0) - coalesce((select sum(a.amount) from public.prepayment_applications a join public.supplier_prepayments s2 on s2.id = a.prepayment_id where s2.party_name = p_party_name), 0)
    into v_bal from public.supplier_prepayments s where s.party_name = p_party_name and s.id <> coalesce(p_id, '');
  if v_bal + p_amount < -0.004 then raise exception 'prepayment_exceeds'; end if;
  -- 已經有抵扣的預付款,金額不能改得比已抵扣的少
  if p_id is not null and p_id <> '' and p_amount < coalesce((select sum(amount) from public.prepayment_applications where prepayment_id = p_id), 0) - 0.004 then
    raise exception 'prepayment_in_use';
  end if;
  if p_id is null or p_id = '' then
    v_id := gen_random_uuid()::text;
    insert into public.supplier_prepayments (id, party_id, party_name, pay_date, amount, method, note, forecast_id, forecast_name, created_by)
    values (v_id, nullif(p_party_id, ''), trim(p_party_name), p_date, p_amount, nullif(p_method, ''), nullif(p_note, ''), nullif(p_forecast_id, ''), nullif(p_forecast_name, ''), v_who);
  else
    v_id := p_id;
    update public.supplier_prepayments
       set party_id = nullif(p_party_id, ''), party_name = trim(p_party_name), pay_date = p_date, amount = p_amount,
           method = nullif(p_method, ''), note = nullif(p_note, ''), forecast_id = nullif(p_forecast_id, ''), forecast_name = nullif(p_forecast_name, '')
     where id = p_id;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

-- 刪除預付款:已經有抵扣的不能刪(要先刪掉進貨單上那筆付款)
create or replace function public.prepayment_delete(p_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_accounting_user() then raise exception 'prepayment_forbidden'; end if;
  if exists (select 1 from public.prepayment_applications where prepayment_id = p_id) then raise exception 'prepayment_in_use'; end if;
  delete from public.supplier_prepayments where id = p_id;
end $$;

-- 用預付款抵扣一張進貨單:同時在 purchase_payments 新增一筆付款(方式 Prepayment)與抵扣紀錄。
-- 金額不能超過這筆預付款的剩餘金額;不能超過進貨單金額的檢查由前端做(跟一般付款一樣)。
create or replace function public.prepayment_apply(p_prepayment_id text, p_purchase_id text, p_date date, p_amount numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_who text; v_pp public.supplier_prepayments%rowtype; v_used numeric; v_pay text; v_app text;
begin
  if not public.is_accounting_user() then raise exception 'prepayment_forbidden'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'prepayment_bad_amount'; end if;
  if p_date is null then raise exception 'prepayment_bad_date'; end if;
  select * into v_pp from public.supplier_prepayments where id = p_prepayment_id for update;
  if not found then raise exception 'prepayment_not_found'; end if;
  if v_pp.amount <= 0 then raise exception 'prepayment_bad_amount'; end if;
  select coalesce(sum(amount), 0) into v_used from public.prepayment_applications where prepayment_id = p_prepayment_id;
  if v_pp.amount - v_used + 0.004 < p_amount then raise exception 'prepayment_exceeds'; end if;
  select username into v_who from public.profiles where id = auth.uid();
  v_pay := gen_random_uuid()::text; v_app := gen_random_uuid()::text;
  insert into public.purchase_payments (id, purchase_id, pay_date, amount, method, note, created_by)
  values (v_pay, p_purchase_id, p_date, p_amount, 'Prepayment', coalesce(v_pp.forecast_name, 'Prepayment') || ' (paid ' || to_char(v_pp.pay_date, 'DD/MM/YYYY') || ')', v_who);
  insert into public.prepayment_applications (id, prepayment_id, purchase_id, purchase_payment_id, apply_date, amount, created_by)
  values (v_app, p_prepayment_id, p_purchase_id, v_pay, p_date, p_amount, v_who);
  return jsonb_build_object('payment_id', v_pay, 'application_id', v_app);
end $$;

revoke all on function public.prepayment_save(text, text, text, date, numeric, text, text, text, text) from public;
revoke all on function public.prepayment_delete(text) from public;
revoke all on function public.prepayment_apply(text, text, date, numeric) from public;
grant execute on function public.prepayment_save(text, text, text, date, numeric, text, text, text, text) to authenticated;
grant execute on function public.prepayment_delete(text) to authenticated;
grant execute on function public.prepayment_apply(text, text, date, numeric) to authenticated;
