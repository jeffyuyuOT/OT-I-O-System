-- ============================================================
-- 商品從「不做批次追蹤」改成「做批次追蹤」時,把還沒有批次的庫存量轉成一個起始批次(成本 = 轉換當下的平均成本)。
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
-- 批次編號 CARRY-YYMMDD-xxxx,沒有有效期,批次日期固定 2000-01-02(FIFO 排序時很舊,會先出)。
-- ============================================================
create or replace function public.batch_carry_over(p_product_id text, p_qty numeric, p_base numeric, p_total numeric)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch text := 'carry-' || gen_random_uuid()::text;
  v_no text;
begin
  if p_product_id is null or p_qty is null or p_qty <= 0 then
    return null;
  end if;
  v_no := 'CARRY-' || to_char(now() at time zone 'Australia/Brisbane', 'YYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);
  insert into public.batches (id, batch_no, batch_date, is_opening, note)
  values (v_batch, v_no, date '2000-01-02', false, 'Carried over from average cost');
  insert into public.batch_items (id, batch_id, product_id, expiry, qty_in, unit_cost_base, unit_cost_total)
  values (gen_random_uuid()::text, v_batch, p_product_id, null, p_qty, p_base, coalesce(p_total, p_base));
  return v_batch;
end $$;

revoke all on function public.batch_carry_over(text, numeric, numeric, numeric) from public, anon;
grant execute on function public.batch_carry_over(text, numeric, numeric, numeric) to authenticated;
