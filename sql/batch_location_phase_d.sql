-- ============================================================
-- 庫存位置分批次 第四階段(d):轉移位置時,批次記的位置跟著搬
--
-- 需要先執行 batch_location_phase_a.sql、batch_location_phase_b.sql。
-- 在「測試」Supabase 專案(zurktjerrqmjbrhvtibm)的 SQL Editor 執行一次;
-- 正式專案(lstckpzmtacttwbmmbof)等你明說再執行。可重複執行。
--
-- batch_transfer_locations(p_rows)
--   p_rows: [{ "batch_item_id": "...", "from_code": "A-1" 或 "" (未分布), "to_code": "B-2" 或 "" (未分布), "qty": 5 }, ...]
--   這是倉庫內換位置(不是出貨):批次商品行總剩餘量不變,只是改放哪個位置。
--   來源位置(或未分布)剩餘量必須夠,否則整筆擋下(batch_loc_insufficient)。
-- ============================================================

create or replace function public.batch_transfer_locations(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row  jsonb;
  v_item text;
  v_from text;
  v_to   text;
  v_qty  numeric;
  v_left numeric;
  v_new  numeric;
  v_n    int := 0;
begin
  for v_row in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_item := v_row->>'batch_item_id';
    v_from := nullif(trim(v_row->>'from_code'), '');
    v_to   := nullif(trim(v_row->>'to_code'), '');
    v_qty  := (v_row->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    if v_from is not distinct from v_to then continue; end if;

    perform 1 from public.batch_items where id = v_item for update;
    if not found then continue; end if;

    if v_from is not null then
      select remaining into v_left from public.batch_item_loc_stock
       where batch_item_id = v_item and location_code = v_from;
    else
      -- 未分布剩餘量 = 商品行剩餘量 − 各位置剩餘量加總
      select public.batch_item_remaining(v_item) - coalesce((select sum(remaining) from public.batch_item_loc_stock where batch_item_id = v_item), 0)
        into v_left;
    end if;
    if v_left is null or v_left + 1e-9 < v_qty then
      raise exception 'batch_loc_insufficient:%', jsonb_build_object('batch_item_id', v_item, 'code', coalesce(v_from, ''), 'left', coalesce(v_left, 0), 'need', v_qty)::text;
    end if;

    -- 來源:位置數量扣掉(扣到 0 以下就刪除這筆位置紀錄);來源是未分布不用動
    if v_from is not null then
      update public.batch_item_locations set qty = qty - v_qty
       where batch_item_id = v_item and location_code = v_from
       returning qty into v_new;
      if v_new is not null and v_new <= 1e-9 then
        delete from public.batch_item_locations where batch_item_id = v_item and location_code = v_from;
      end if;
    end if;
    -- 目的地:加到目的位置;目的地是未分布不用動(未分布會自動變多)
    if v_to is not null then
      insert into public.batch_item_locations (batch_item_id, location_code, qty)
      values (v_item, v_to, v_qty)
      on conflict (batch_item_id, location_code) do update set qty = public.batch_item_locations.qty + excluded.qty;
    end if;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('rows', v_n);
end $$;

revoke all on function public.batch_transfer_locations(jsonb) from public, anon;
grant execute on function public.batch_transfer_locations(jsonb) to authenticated;

-- 驗證用:select proname from pg_proc where proname = 'batch_transfer_locations';
