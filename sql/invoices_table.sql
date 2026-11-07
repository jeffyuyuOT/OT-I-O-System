-- ============================================================
-- Invoice 獨立資料表(會計模組)
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
--
-- * invoices:每張 Invoice 一列(號碼、日期、客戶、金額,以及建立當下的完整內容快照 snapshot)。
-- * invoice_counter:Invoice 號碼計數器(連號,8 位數)。
-- * 只有 admin / accountant 身分讀得到;寫入一律走下面的函式(security definer),取號碼在資料庫裡加鎖,不會重號。
-- ============================================================
create table if not exists public.invoice_counter (
  id      int primary key default 1 check (id = 1),
  next_no bigint not null default 1
);
insert into public.invoice_counter (id, next_no) values (1, 1) on conflict (id) do nothing;

create table if not exists public.invoices (
  id           text primary key,
  invoice_no   text not null unique,
  order_id     text,
  order_no     text,
  party_id     text,
  customer     text,
  invoice_date date not null,
  due_date     date,
  terms        text,
  payment_type text,
  sale_rep     text,
  before_tax   numeric,
  tax          numeric,
  total        numeric,
  currency     text,
  snapshot     jsonb not null,
  created_by   text,
  created_at   timestamptz not null default now()
);
create unique index if not exists invoices_order_uq on public.invoices (order_id) where order_id is not null;
create index if not exists invoices_date_idx on public.invoices (invoice_date);

alter table public.invoice_counter enable row level security;
alter table public.invoices enable row level security;

-- 目前登入的人是不是 admin / accountant
create or replace function public.is_accounting_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'accountant'));
$$;
create or replace function public.is_admin_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
$$;

drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices for select to authenticated using (public.is_accounting_user());

-- 建立 Invoice:加鎖取下一個號碼,存入快照,回傳 { id, invoice_no }
create or replace function public.invoice_create(p_snapshot jsonb, p_order_id text, p_order_no text, p_party_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n bigint; v_no text; v_id text := gen_random_uuid()::text; v_snap jsonb; v_who text;
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
  values (v_id, v_no, p_order_id, p_order_no, p_party_id, v_snap #>> '{customer,name}', (v_snap->>'date')::date, nullif(v_snap->>'dueDate', '')::date,
          v_snap->>'term', v_snap->>'paymentType', v_snap->>'saleRep',
          (v_snap->>'beforeTax')::numeric, (v_snap->>'tax')::numeric, (v_snap->>'total')::numeric, v_snap->>'currency', v_snap, v_who);
  return jsonb_build_object('id', v_id, 'invoice_no', v_no);
end $$;

create or replace function public.invoice_get_next() returns bigint
language plpgsql stable security definer set search_path = public as $$
declare v bigint;
begin
  if not public.is_accounting_user() then raise exception 'invoice_forbidden'; end if;
  select next_no into v from public.invoice_counter where id = 1; return v;
end $$;

create or replace function public.invoice_set_next(p_n bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_accounting_user() then raise exception 'invoice_forbidden'; end if;
  if p_n is null or p_n < 1 then raise exception 'invoice_bad_number'; end if;
  update public.invoice_counter set next_no = p_n where id = 1;
end $$;

-- 備份 / 還原 / 清除全部資料(只有 admin)
create or replace function public.invoice_restore_all(p_rows jsonb, p_next bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin_user() then raise exception 'invoice_forbidden'; end if;
  delete from public.invoices where true;
  insert into public.invoices
    select * from jsonb_populate_recordset(null::public.invoices, coalesce(p_rows, '[]'::jsonb));
  update public.invoice_counter set next_no = greatest(coalesce(p_next, 1), 1) where id = 1;
end $$;
create or replace function public.invoice_clear_all() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin_user() then raise exception 'invoice_forbidden'; end if;
  delete from public.invoices where true;
  update public.invoice_counter set next_no = 1 where id = 1;
end $$;

revoke all on function public.invoice_create(jsonb, text, text, text) from public, anon;
revoke all on function public.invoice_get_next() from public, anon;
revoke all on function public.invoice_set_next(bigint) from public, anon;
revoke all on function public.invoice_restore_all(jsonb, bigint) from public, anon;
revoke all on function public.invoice_clear_all() from public, anon;
grant execute on function public.invoice_create(jsonb, text, text, text) to authenticated;
grant execute on function public.invoice_get_next() to authenticated;
grant execute on function public.invoice_set_next(bigint) to authenticated;
grant execute on function public.invoice_restore_all(jsonb, bigint) to authenticated;
grant execute on function public.invoice_clear_all() to authenticated;
