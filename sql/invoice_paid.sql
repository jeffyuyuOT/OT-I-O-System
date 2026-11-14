-- ============================================================
-- Invoice 的 Paid Today(今天已收金額)
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
-- 前提:已經執行過 sql/invoices_table.sql。
-- 只有 admin / accountant 可以更新;金額存在 Invoice 快照的 paid 欄位。
-- ============================================================
create or replace function public.invoice_set_paid(p_id text, p_paid numeric)
returns void language plpgsql security definer set search_path = public as $$
declare v_total numeric;
begin
  if not public.is_accounting_user() then raise exception 'invoice_forbidden'; end if;
  select total into v_total from public.invoices where id = p_id for update;
  if not found then raise exception 'invoice_not_found'; end if;
  if p_paid is null or p_paid < 0 or p_paid > v_total then raise exception 'invoice_bad_paid'; end if;
  update public.invoices set snapshot = jsonb_set(snapshot, '{paid}', to_jsonb(p_paid), true) where id = p_id;
end $$;

revoke all on function public.invoice_set_paid(text, numeric) from public, anon;
grant execute on function public.invoice_set_paid(text, numeric) to authenticated;
