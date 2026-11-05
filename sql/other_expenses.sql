-- ============================================================
-- 其他支出(獨立的支出記錄,例如房租、保險、雜項):會計 → 其他支出 分頁
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
-- 前提:已經執行過 sql/invoices_table.sql(要用裡面的 is_accounting_user())和 sql/purchase_accounting.sql。
--
-- * other_expenses:一筆支出一列(日期、品項、對象(選填)、金額、GST、金額輸入方式、備註)。
-- * 付款記錄沿用 purchase_payments,purchase_id 填 'exp:<支出id>'。
-- * 進貨單裡的「跟此進貨單相關的其他支出」不在這張表,仍存在進貨單內,只是會一起列在這個分頁。
-- * 只有 admin / accountant 讀得到;寫入一律走函式(security definer)。
-- ============================================================
create table if not exists public.other_expenses (
  id          text primary key,
  exp_date    date not null,
  name        text not null,
  payee       text,
  amount      numeric not null check (amount >= 0),
  gst         boolean,
  gst_mode    text not null default 'ex',
  note        text,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists other_expenses_date_idx on public.other_expenses (exp_date);

alter table public.other_expenses enable row level security;
drop policy if exists other_expenses_select on public.other_expenses;
create policy other_expenses_select on public.other_expenses for select to authenticated using (public.is_accounting_user());

create or replace function public.other_expense_save(p_id text, p_date date, p_name text, p_payee text, p_amount numeric, p_gst boolean, p_gst_mode text, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_who text; v_id text;
begin
  if not public.is_accounting_user() then raise exception 'purchase_forbidden'; end if;
  if p_date is null then raise exception 'purchase_bad_date'; end if;
  if p_name is null or btrim(p_name) = '' then raise exception 'expense_bad_name'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'purchase_bad_paid'; end if;
  select username into v_who from public.profiles where id = auth.uid();
  if p_id is null or p_id = '' then
    v_id := gen_random_uuid()::text;
    insert into public.other_expenses (id, exp_date, name, payee, amount, gst, gst_mode, note, created_by)
    values (v_id, p_date, btrim(p_name), nullif(btrim(coalesce(p_payee, '')), ''), p_amount, p_gst, case when p_gst_mode = 'inc' then 'inc' else 'ex' end, nullif(p_note, ''), v_who);
  else
    v_id := p_id;
    update public.other_expenses
       set exp_date = p_date, name = btrim(p_name), payee = nullif(btrim(coalesce(p_payee, '')), ''), amount = p_amount, gst = p_gst,
           gst_mode = case when p_gst_mode = 'inc' then 'inc' else 'ex' end, note = nullif(p_note, ''), updated_at = now()
     where id = p_id;
    if not found then raise exception 'expense_not_found'; end if;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

-- 刪除支出時,連同它的付款記錄一起刪
create or replace function public.other_expense_delete(p_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_accounting_user() then raise exception 'purchase_forbidden'; end if;
  delete from public.purchase_payments where purchase_id = 'exp:' || p_id;
  delete from public.other_expenses where id = p_id;
  if not found then raise exception 'expense_not_found'; end if;
end $$;

-- 備份 / 還原 / 清除全部資料用(付款記錄由 purchase_payments 的備份處理)
create or replace function public.other_expenses_restore_all(p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_accounting_user() then raise exception 'purchase_forbidden'; end if;
  delete from public.other_expenses where true;
  insert into public.other_expenses (id, exp_date, name, payee, amount, gst, gst_mode, note, created_by, created_at, updated_at)
  select r->>'id', (r->>'exp_date')::date, r->>'name', r->>'payee', (r->>'amount')::numeric,
         case when r->>'gst' is null then null else (r->>'gst')::boolean end, coalesce(nullif(r->>'gst_mode', ''), 'ex'), r->>'note', r->>'created_by',
         coalesce(nullif(r->>'created_at', '')::timestamptz, now()), coalesce(nullif(r->>'updated_at', '')::timestamptz, now())
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
end $$;

create or replace function public.other_expenses_clear_all()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_accounting_user() then raise exception 'purchase_forbidden'; end if;
  delete from public.other_expenses where true;
end $$;

grant execute on function public.other_expense_save(text, date, text, text, numeric, boolean, text, text) to authenticated;
grant execute on function public.other_expense_delete(text) to authenticated;
grant execute on function public.other_expenses_restore_all(jsonb) to authenticated;
grant execute on function public.other_expenses_clear_all() to authenticated;
