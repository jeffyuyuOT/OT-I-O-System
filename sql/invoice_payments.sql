-- ============================================================
-- Invoice 收款記錄(多筆收款)
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
-- 前提:已經執行過 sql/invoices_table.sql(sql/invoice_paid.sql 有沒有執行都可以)。
--
-- * invoice_payments:每筆收款一列(日期、金額、方式、備註、記錄者)。
-- * invoices.paid:這張 Invoice 目前已收總額(由下面的函式自動維持),清單用它算 Balance / 狀態。
-- * 快照裡的 snapshot.paid 也會同步成已收總額,所以 Invoice 本身(PDF / 列印)的 Paid 與 Balance Due 會一致。
-- * 舊的單一 Paid Today 金額會自動轉成一筆收款(日期 = Invoice 日期,方式 = Paid Today)。
-- * 只有 admin / accountant 讀得到;寫入一律走函式(security definer)。
-- ============================================================
alter table public.invoices add column if not exists paid numeric default 0;

create table if not exists public.invoice_payments (
  id          text primary key,
  invoice_id  text not null references public.invoices(id) on delete cascade,
  pay_date    date not null,
  amount      numeric not null check (amount <> 0),   -- 退款 / 轉出是負數(見 credit_notes.sql)
  method      text,
  note        text,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists invoice_payments_invoice_idx on public.invoice_payments (invoice_id);

alter table public.invoice_payments enable row level security;
drop policy if exists invoice_payments_select on public.invoice_payments;
create policy invoice_payments_select on public.invoice_payments for select to authenticated using (public.is_accounting_user());

-- 重算一張 Invoice 的已收總額(invoices.paid + snapshot.paid)
create or replace function public.invoice_recalc_paid(p_invoice_id text)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_sum numeric;
begin
  select coalesce(sum(amount), 0) into v_sum from public.invoice_payments where invoice_id = p_invoice_id;
  update public.invoices
     set paid = v_sum, snapshot = jsonb_set(snapshot, '{paid}', to_jsonb(v_sum), true)
   where id = p_invoice_id;
  return v_sum;
end $$;

-- 新增或修改一筆收款(p_payment_id 為空 = 新增)。總收款不能超過 Invoice 總額。
create or replace function public.invoice_payment_save(p_invoice_id text, p_payment_id text, p_date date, p_amount numeric, p_method text, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_total numeric; v_other numeric; v_who text; v_id text; v_paid numeric;
begin
  if not public.is_accounting_user() then raise exception 'invoice_forbidden'; end if;
  select total into v_total from public.invoices where id = p_invoice_id for update;
  if not found then raise exception 'invoice_not_found'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'invoice_bad_paid'; end if;
  if p_date is null then raise exception 'invoice_bad_date'; end if;
  select coalesce(sum(amount), 0) into v_other from public.invoice_payments
   where invoice_id = p_invoice_id and (p_payment_id is null or id <> p_payment_id);
  if v_other + p_amount > v_total + 0.004 then raise exception 'invoice_bad_paid'; end if;
  select username into v_who from public.profiles where id = auth.uid();
  if p_payment_id is null then
    v_id := gen_random_uuid()::text;
    insert into public.invoice_payments (id, invoice_id, pay_date, amount, method, note, created_by)
    values (v_id, p_invoice_id, p_date, p_amount, nullif(p_method, ''), nullif(p_note, ''), v_who);
  else
    v_id := p_payment_id;
    update public.invoice_payments
       set pay_date = p_date, amount = p_amount, method = nullif(p_method, ''), note = nullif(p_note, '')
     where id = p_payment_id and invoice_id = p_invoice_id;
    if not found then raise exception 'invoice_payment_not_found'; end if;
  end if;
  v_paid := public.invoice_recalc_paid(p_invoice_id);
  return jsonb_build_object('id', v_id, 'paid', v_paid);
end $$;

create or replace function public.invoice_payment_delete(p_payment_id text)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_inv text;
begin
  if not public.is_accounting_user() then raise exception 'invoice_forbidden'; end if;
  delete from public.invoice_payments where id = p_payment_id returning invoice_id into v_inv;
  if v_inv is null then raise exception 'invoice_payment_not_found'; end if;
  return public.invoice_recalc_paid(v_inv);
end $$;

-- 建立 Invoice 時如果快照已有 Paid Today 金額,同時轉成第一筆收款
create or replace function public.invoice_create(p_snapshot jsonb, p_order_id text, p_order_no text, p_party_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n bigint; v_no text; v_id text := gen_random_uuid()::text; v_snap jsonb; v_who text; v_paid numeric;
begin
  if not public.is_accounting_user() then raise exception 'invoice_forbidden'; end if;
  if p_order_id is not null and exists (select 1 from public.invoices where order_id = p_order_id) then
    raise exception 'invoice_exists';
  end if;
  select next_no into v_n from public.invoice_counter where id = 1 for update;
  v_no := lpad(v_n::text, 8, '0');
  update public.invoice_counter set next_no = v_n + 1 where id = 1;
  v_snap := p_snapshot || jsonb_build_object('no', v_no, 'id', v_id);
  select username into v_who from public.profiles where id = auth.uid();
  insert into public.invoices (id, invoice_no, order_id, order_no, party_id, customer, invoice_date, due_date, terms, payment_type, sale_rep,
                               before_tax, tax, total, currency, snapshot, created_by)
  values (v_id, v_no, p_order_id, p_order_no, nullif(p_party_id, ''), v_snap #>> '{customer,name}', (v_snap->>'date')::date, nullif(v_snap->>'dueDate', '')::date,
          v_snap->>'term', v_snap->>'paymentType', v_snap->>'saleRep',
          (v_snap->>'beforeTax')::numeric, (v_snap->>'tax')::numeric, (v_snap->>'total')::numeric, v_snap->>'currency', v_snap, v_who);
  v_paid := coalesce(nullif(v_snap->>'paid', '')::numeric, 0);
  if v_paid > 0 then
    insert into public.invoice_payments (id, invoice_id, pay_date, amount, method, created_by)
    values (gen_random_uuid()::text, v_id, (v_snap->>'date')::date, least(v_paid, (v_snap->>'total')::numeric), coalesce(nullif(v_snap->>'paidMethod', ''), 'Other'), v_who);
  end if;
  perform public.invoice_recalc_paid(v_id);
  return jsonb_build_object('id', v_id, 'invoice_no', v_no);
end $$;

-- 既有 Invoice:舊的 Paid Today 金額轉成一筆收款(只轉一次;已經有收款記錄的不動)
insert into public.invoice_payments (id, invoice_id, pay_date, amount, method, created_by)
select gen_random_uuid()::text, i.id, i.invoice_date, least((i.snapshot->>'paid')::numeric, i.total), 'Paid Today', i.created_by
  from public.invoices i
 where coalesce(nullif(i.snapshot->>'paid', '')::numeric, 0) > 0
   and not exists (select 1 from public.invoice_payments p where p.invoice_id = i.id);
update public.invoices i
   set paid = coalesce((select sum(amount) from public.invoice_payments p where p.invoice_id = i.id), 0)
 where true;
update public.invoices set party_id = null where party_id = '';

-- 備份 / 還原:還原時一併還原收款(舊函式簽章移除,換成多一個 p_payments)
drop function if exists public.invoice_restore_all(jsonb, bigint);
create or replace function public.invoice_restore_all(p_rows jsonb, p_next bigint, p_payments jsonb default '[]'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin_user() then raise exception 'invoice_forbidden'; end if;
  delete from public.invoices where true;   -- 收款會跟著 cascade 刪除
  insert into public.invoices
    select * from jsonb_populate_recordset(null::public.invoices, coalesce(p_rows, '[]'::jsonb));
  insert into public.invoice_payments
    select * from jsonb_populate_recordset(null::public.invoice_payments, coalesce(p_payments, '[]'::jsonb));
  -- 舊版備份(沒有收款資料):把快照裡的 Paid Today 轉成一筆收款
  insert into public.invoice_payments (id, invoice_id, pay_date, amount, method, created_by)
  select gen_random_uuid()::text, i.id, i.invoice_date, least((i.snapshot->>'paid')::numeric, i.total), 'Paid Today', i.created_by
    from public.invoices i
   where coalesce(nullif(i.snapshot->>'paid', '')::numeric, 0) > 0
     and not exists (select 1 from public.invoice_payments p where p.invoice_id = i.id);
  update public.invoices i set paid = coalesce((select sum(amount) from public.invoice_payments p where p.invoice_id = i.id), 0) where true;
  update public.invoice_counter set next_no = greatest(coalesce(p_next, 1), 1) where id = 1;
end $$;

revoke all on function public.invoice_recalc_paid(text) from public, anon, authenticated;
revoke all on function public.invoice_payment_save(text, text, date, numeric, text, text) from public, anon;
revoke all on function public.invoice_payment_delete(text) from public, anon;
revoke all on function public.invoice_create(jsonb, text, text, text) from public, anon;
revoke all on function public.invoice_restore_all(jsonb, bigint, jsonb) from public, anon;
grant execute on function public.invoice_payment_save(text, text, date, numeric, text, text) to authenticated;
grant execute on function public.invoice_payment_delete(text) to authenticated;
grant execute on function public.invoice_create(jsonb, text, text, text) to authenticated;
grant execute on function public.invoice_restore_all(jsonb, bigint, jsonb) to authenticated;
