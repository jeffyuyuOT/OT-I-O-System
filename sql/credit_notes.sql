-- ============================================================
-- Credit Note(貸項通知單)
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
-- 前提:已經執行過 invoices_table / invoice_payments / invoice_changes / invoice_orders 四個 SQL。
--
-- * credit_notes:每張 Credit Note 一列(可以連到原 Invoice,也可以單獨記在客戶名下)。
--   total 存「正數」(代表扣減的金額),畫面與文件上用括號顯示成負數。
-- * invoices.credited:連到這張 Invoice 的 Credit Note 總額,Invoice 的未收金額 = 總額 - credited - 已收。
-- * return_status:none(不需退貨入庫)/ pending(待入庫)/ partial(部分入庫)/ done(已入庫)。
-- * Credit Note 只是帳務文件,不動庫存;退貨入庫在「登記進出貨」處理,入庫時可以選對應的 Credit Note。
-- ============================================================
create table if not exists public.credit_note_counter (id int primary key default 1, next_no bigint not null default 1);
insert into public.credit_note_counter (id, next_no) values (1, 1) on conflict (id) do nothing;
alter table public.credit_note_counter enable row level security;

create table if not exists public.credit_notes (
  id            text primary key,
  cn_no         text not null unique,
  invoice_id    text references public.invoices(id) on delete set null,
  invoice_no    text,
  party_id      text,
  customer      text,
  cn_date       date not null,
  before_tax    numeric,
  tax           numeric,
  total         numeric not null,
  currency      text,
  return_status text default 'none',
  snapshot      jsonb not null,
  created_by    text,
  created_at    timestamptz default now()
);
create index if not exists credit_notes_invoice_idx on public.credit_notes (invoice_id);
create index if not exists credit_notes_party_idx on public.credit_notes (party_id);
alter table public.credit_notes enable row level security;
drop policy if exists credit_notes_select on public.credit_notes;
create policy credit_notes_select on public.credit_notes for select to authenticated using (public.is_accounting_user());

alter table public.invoices add column if not exists credited numeric default 0;

create or replace function public.credit_note_recalc(p_invoice_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_invoice_id is null then return; end if;
  update public.invoices set credited = coalesce((select sum(total) from public.credit_notes where invoice_id = p_invoice_id), 0) where id = p_invoice_id;
end $$;

create or replace function public.credit_note_create(p_snapshot jsonb, p_invoice_id text, p_party_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n bigint; v_no text; v_id text := gen_random_uuid()::text; v_snap jsonb; v_who text; v_inv public.invoices%rowtype; v_status text := 'none';
begin
  if not public.is_accounting_user() then raise exception 'invoice_forbidden'; end if;
  if p_invoice_id is not null then
    select * into v_inv from public.invoices where id = p_invoice_id;
    if not found then raise exception 'invoice_not_found'; end if;
  end if;
  select next_no into v_n from public.credit_note_counter where id = 1 for update;
  v_no := 'CN' || lpad(v_n::text, 8, '0');
  update public.credit_note_counter set next_no = v_n + 1 where id = 1;
  v_snap := p_snapshot || jsonb_build_object('no', v_no, 'id', v_id, 'docType', 'credit_note');
  if exists (select 1 from jsonb_array_elements(coalesce(v_snap->'lines', '[]'::jsonb)) l where coalesce((l->>'ret')::boolean, false)) then v_status := 'pending'; end if;
  select username into v_who from public.profiles where id = auth.uid();
  insert into public.credit_notes (id, cn_no, invoice_id, invoice_no, party_id, customer, cn_date, before_tax, tax, total, currency, return_status, snapshot, created_by)
  values (v_id, v_no, p_invoice_id, v_inv.invoice_no, nullif(p_party_id, ''), v_snap #>> '{customer,name}', (v_snap->>'date')::date,
          (v_snap->>'beforeTax')::numeric, (v_snap->>'tax')::numeric, (v_snap->>'total')::numeric, v_snap->>'currency', v_status, v_snap, v_who);
  perform public.credit_note_recalc(p_invoice_id);
  return jsonb_build_object('id', v_id, 'cn_no', v_no);
end $$;

-- 登記進出貨做退貨入庫時,下拉選單用:這個出貨方「待入庫 / 部分入庫」的 Credit Note(倉庫管理員也能用,只回傳退貨品項)
create or replace function public.credit_notes_pending(p_party_id text)
returns table (id text, cn_no text, cn_date date, customer text, items jsonb)
language sql stable security definer set search_path = public as $$
  select c.id, c.cn_no, c.cn_date, c.customer,
         coalesce((select jsonb_agg(jsonb_build_object('productId', l->>'productId', 'name', l->>'desc', 'unit', l->>'unit', 'qty', (l->>'qty')::numeric,
                    'returned', coalesce((c.snapshot->'returned'->>(l->>'productId'))::numeric, 0)))
                   from jsonb_array_elements(c.snapshot->'lines') l where coalesce((l->>'ret')::boolean, false)), '[]'::jsonb)
    from public.credit_notes c
   where c.return_status in ('pending', 'partial') and (p_party_id is null or c.party_id = p_party_id)
   order by c.cn_date desc, c.cn_no desc;
$$;

-- 退貨入庫登記後,記下這張 Credit Note 各商品已入庫的數量;全部入庫就變 done
create or replace function public.credit_note_mark_returned(p_id text, p_items jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare v_snap jsonb; v_ret jsonb; v_it jsonb; v_done boolean; v_status text;
begin
  if auth.uid() is null then raise exception 'invoice_forbidden'; end if;
  select snapshot into v_snap from public.credit_notes where id = p_id for update;
  if not found then raise exception 'credit_note_not_found'; end if;
  v_ret := coalesce(v_snap->'returned', '{}'::jsonb);
  for v_it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_ret := v_ret || jsonb_build_object(v_it->>'productId', coalesce((v_ret->>(v_it->>'productId'))::numeric, 0) + coalesce((v_it->>'qty')::numeric, 0));
  end loop;
  v_snap := v_snap || jsonb_build_object('returned', v_ret);
  select bool_and(coalesce((v_ret->>(l->>'productId'))::numeric, 0) >= (l->>'qty')::numeric) into v_done
    from jsonb_array_elements(v_snap->'lines') l where coalesce((l->>'ret')::boolean, false);
  v_status := case when coalesce(v_done, true) then 'done' else 'partial' end;
  update public.credit_notes set snapshot = v_snap, return_status = v_status where id = p_id;
  return v_status;
end $$;

-- 會計 / 管理員手動改入庫狀態(例如入庫時忘了選 Credit Note,事後確認已入庫;或選錯想退回待入庫)
create or replace function public.credit_note_set_return_status(p_id text, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_accounting_user() then raise exception 'invoice_forbidden'; end if;
  if p_status not in ('pending', 'partial', 'done', 'none') then raise exception 'bad_status'; end if;
  update public.credit_notes set return_status = p_status where id = p_id;
end $$;

-- 訂單編輯前的檢查:要把已開的 Credit Note 扣掉(新總額 - credited 不能低於已收款)
create or replace function public.invoice_edit_guard(p_invoice_id text, p_delta numeric)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_total numeric; v_paid numeric; v_cr numeric;
begin
  select total, coalesce(paid, 0), coalesce(credited, 0) into v_total, v_paid, v_cr from public.invoices where id = p_invoice_id;
  if not found then return true; end if;
  return (v_total - v_cr + coalesce(p_delta, 0)) >= v_paid - 0.004;
end $$;
revoke all on function public.invoice_edit_guard(text, numeric) from public, anon;
grant execute on function public.invoice_edit_guard(text, numeric) to authenticated;

-- 備份 / 還原 / 清除
create or replace function public.credit_notes_restore_all(p_rows jsonb, p_next bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin_user() then raise exception 'invoice_forbidden'; end if;
  delete from public.credit_notes where true;
  insert into public.credit_notes select * from jsonb_populate_recordset(null::public.credit_notes, coalesce(p_rows, '[]'::jsonb));
  update public.credit_note_counter set next_no = greatest(coalesce(p_next, 1), 1) where id = 1;
  update public.invoices i set credited = coalesce((select sum(total) from public.credit_notes c where c.invoice_id = i.id), 0) where true;
end $$;
create or replace function public.credit_notes_clear_all() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin_user() then raise exception 'invoice_forbidden'; end if;
  delete from public.credit_notes where true;
  update public.credit_note_counter set next_no = 1 where id = 1;
end $$;

revoke all on function public.credit_note_recalc(text) from public, anon, authenticated;
revoke all on function public.credit_note_create(jsonb, text, text) from public, anon;
revoke all on function public.credit_notes_pending(text) from public, anon;
revoke all on function public.credit_note_mark_returned(text, jsonb) from public, anon;
revoke all on function public.credit_note_set_return_status(text, text) from public, anon;
revoke all on function public.credit_notes_restore_all(jsonb, bigint) from public, anon;
revoke all on function public.credit_notes_clear_all() from public, anon;
grant execute on function public.credit_note_create(jsonb, text, text) to authenticated;
grant execute on function public.credit_notes_pending(text) to authenticated;
grant execute on function public.credit_note_mark_returned(text, jsonb) to authenticated;
grant execute on function public.credit_note_set_return_status(text, text) to authenticated;
grant execute on function public.credit_notes_restore_all(jsonb, bigint) to authenticated;
grant execute on function public.credit_notes_clear_all() to authenticated;
