-- ============================================================
-- 批次追蹤 第三期:批次表納入「還原備份」與「清除全部資料」
--
-- 在「測試」Supabase 專案(zurktjerrqmjbrhvtibm)的 SQL Editor 執行一次;
-- 正式專案(lstckpzmtacttwbmmbof)等你明說再執行。可重複執行。
--
-- 批次三張表(batches / batch_items / batch_movements)只開放讀取,寫入一律走 RPC,
-- 所以備份匯出直接讀表,還原與清除則需要下面兩個 RPC:
--   batch_clear_all()                              清空三張批次表
--   batch_restore_all(p_batches, p_items, p_movs)  先清空,再把備份檔裡的批次資料整批寫回
-- ============================================================

create or replace function public.batch_clear_all()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- batch_items / batch_movements 有 on delete cascade,但還是明確全部刪一次
  delete from public.batch_movements;
  delete from public.batch_items;
  delete from public.batches;
end $$;

create or replace function public.batch_restore_all(
  p_batches   jsonb,
  p_items     jsonb,
  p_movements jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b int := 0;
  v_i int := 0;
  v_m int := 0;
begin
  perform public.batch_clear_all();

  if p_batches is not null and jsonb_typeof(p_batches) = 'array' and jsonb_array_length(p_batches) > 0 then
    insert into public.batches
    select * from jsonb_populate_recordset(null::public.batches, p_batches);
    get diagnostics v_b = row_count;
  end if;

  if p_items is not null and jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) > 0 then
    insert into public.batch_items
    select * from jsonb_populate_recordset(null::public.batch_items, p_items);
    get diagnostics v_i = row_count;
  end if;

  -- id 是 identity,不帶入(異動之間沒有互相引用);unit_cost 一併還原,
  -- BEFORE INSERT 的快照觸發器只在 unit_cost 是 null 時才補值,所以備份裡的出貨價格快照會保留。
  if p_movements is not null and jsonb_typeof(p_movements) = 'array' and jsonb_array_length(p_movements) > 0 then
    insert into public.batch_movements
      (batch_item_id, qty, kind, tx_id, order_id, order_no, conversion_id, mv_date, party, note, location_code, created_at, unit_cost)
    select r.batch_item_id, r.qty, r.kind, r.tx_id, r.order_id, r.order_no, r.conversion_id, r.mv_date, r.party, r.note,
           r.location_code, coalesce(r.created_at, now()), r.unit_cost
    from jsonb_populate_recordset(null::public.batch_movements, p_movements) r;
    get diagnostics v_m = row_count;
  end if;

  return jsonb_build_object('batches', v_b, 'items', v_i, 'movements', v_m);
end $$;

revoke all on function public.batch_clear_all()                     from public, anon;
revoke all on function public.batch_restore_all(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.batch_clear_all()                     to authenticated;
grant execute on function public.batch_restore_all(jsonb, jsonb, jsonb) to authenticated;

-- 驗證用:select proname from pg_proc where proname in ('batch_clear_all','batch_restore_all');
