-- 修正 invoice_clear_all:Supabase 的資料庫不允許沒有 WHERE 的 DELETE(錯誤 21000 "DELETE requires a WHERE clause"),
-- 造成「還原預設 / Clear All Data」清不掉 Invoice。加上 where true。可重複執行。
create or replace function public.invoice_clear_all() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin_user() then raise exception 'invoice_forbidden'; end if;
  delete from public.invoices where true;
  update public.invoice_counter set next_no = 1 where id = 1;
end $$;
revoke all on function public.invoice_clear_all() from public, anon;
grant execute on function public.invoice_clear_all() to authenticated;
