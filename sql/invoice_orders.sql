-- ============================================================
-- Invoice ↔ 訂單 連結(開立發票頁:手動新增 Invoice、多張訂單合併成一張 Invoice)
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
-- 前提:已經執行過 sql/invoices_table.sql、sql/invoice_payments.sql、sql/invoice_changes.sql。
--
-- * invoice_orders:一張訂單最多只能連到一張 Invoice(order_id 是主鍵);一張 Invoice 可以連多張訂單。
-- * 觸發器:Invoice 新增時,依 invoices.order_id 與 snapshot.orders 自動建立連結(含備份還原)。
-- * invoice_create_multi():建立「手動 Invoice」(沒有訂單)或「多張訂單合併」的 Invoice。
-- ============================================================
create table if not exists public.invoice_orders (
  order_id   text primary key,
  invoice_id text not null references public.invoices(id) on delete cascade,
  order_no   text
);
create index if not exists invoice_orders_invoice_idx on public.invoice_orders (invoice_id);

alter table public.invoice_orders enable row level security;
drop policy if exists invoice_orders_select on public.invoice_orders;
create policy invoice_orders_select on public.invoice_orders for select to authenticated using (public.is_accounting_user());

create or replace function public.invoice_link_orders() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.order_id is not null then
    insert into public.invoice_orders (order_id, invoice_id, order_no) values (new.order_id, new.id, new.order_no)
    on conflict (order_id) do nothing;
  end if;
  if jsonb_typeof(new.snapshot->'orders') = 'array' then
    insert into public.invoice_orders (order_id, invoice_id, order_no)
    select e->>'id', new.id, e->>'no' from jsonb_array_elements(new.snapshot->'orders') e
     where coalesce(e->>'id', '') <> ''
    on conflict (order_id) do nothing;
  end if;
  return new;
end $$;
drop trigger if exists invoices_link_orders on public.invoices;
create trigger invoices_link_orders after insert on public.invoices for each row execute function public.invoice_link_orders();

-- 既有 Invoice 補上連結
insert into public.invoice_orders (order_id, invoice_id, order_no)
select order_id, id, order_no from public.invoices where order_id is not null
on conflict (order_id) do nothing;

-- p_orders:[{ "id": 訂單id, "no": 訂單編號 }, ...](手動 Invoice 傳空陣列)
create or replace function public.invoice_create_multi(p_snapshot jsonb, p_orders jsonb, p_party_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n bigint; v_no text; v_id text := gen_random_uuid()::text; v_snap jsonb; v_who text; v_orders jsonb := coalesce(p_orders, '[]'::jsonb); v_order_no text;
begin
  if not public.is_accounting_user() then raise exception 'invoice_forbidden'; end if;
  if exists (select 1 from jsonb_array_elements(v_orders) e join public.invoice_orders io on io.order_id = e->>'id') then
    raise exception 'invoice_exists';
  end if;
  select string_agg(e->>'no', ', ') into v_order_no from jsonb_array_elements(v_orders) e;
  select next_no into v_n from public.invoice_counter where id = 1 for update;
  v_no := lpad(v_n::text, 8, '0');
  update public.invoice_counter set next_no = v_n + 1 where id = 1;
  v_snap := p_snapshot || jsonb_build_object('no', v_no, 'id', v_id, 'orders', v_orders);
  select username into v_who from public.profiles where id = auth.uid();
  insert into public.invoices (id, invoice_no, order_id, order_no, party_id, customer, invoice_date, due_date, terms, payment_type, sale_rep,
                               before_tax, tax, total, currency, snapshot, created_by)
  values (v_id, v_no, null, coalesce(v_order_no, ''), nullif(p_party_id, ''), v_snap #>> '{customer,name}', (v_snap->>'date')::date, nullif(v_snap->>'dueDate', '')::date,
          v_snap->>'term', v_snap->>'paymentType', v_snap->>'saleRep',
          (v_snap->>'beforeTax')::numeric, (v_snap->>'tax')::numeric, (v_snap->>'total')::numeric, v_snap->>'currency', v_snap, v_who);
  -- 建立當下已收的金額(Paid Today)記成第一筆收款
  if coalesce(nullif(v_snap->>'paid', '')::numeric, 0) > 0 then
    insert into public.invoice_payments (id, invoice_id, pay_date, amount, method, created_by)
    values (gen_random_uuid()::text, v_id, (v_snap->>'date')::date, least((v_snap->>'paid')::numeric, (v_snap->>'total')::numeric), 'Paid Today', v_who);
  end if;
  perform public.invoice_recalc_paid(v_id);
  return jsonb_build_object('id', v_id, 'invoice_no', v_no);
end $$;

revoke all on function public.invoice_create_multi(jsonb, jsonb, text) from public, anon;
grant execute on function public.invoice_create_multi(jsonb, jsonb, text) to authenticated;

-- 訂單編輯前的檢查:訂單改動後 Invoice 新總額(原總額 + p_delta)不能低於已收款。
-- 倉庫管理員沒有權限直接讀 Invoice,所以用這個函式只回傳「可以 / 不可以」。
create or replace function public.invoice_edit_guard(p_invoice_id text, p_delta numeric)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_total numeric; v_paid numeric;
begin
  select total, coalesce(paid, 0) into v_total, v_paid from public.invoices where id = p_invoice_id;
  if not found then return true; end if;
  return (v_total + coalesce(p_delta, 0)) >= v_paid - 0.004;
end $$;
revoke all on function public.invoice_edit_guard(text, numeric) from public, anon;
grant execute on function public.invoice_edit_guard(text, numeric) to authenticated;
