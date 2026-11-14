-- ============================================================
-- 庫存位置分批次 第二階段(b):出貨依「批次 × 位置」分配
--
-- 需要先執行 batch_location_phase_a.sql。
-- 在「測試」Supabase 專案(zurktjerrqmjbrhvtibm)的 SQL Editor 執行一次;
-- 正式專案(lstckpzmtacttwbmmbof)等你明說再執行。可重複執行。
--
-- 新增:
--   batch_item_loc_stock          視圖:每個(批次商品行, 位置)目前剩餘量
--                                 = 進貨時記的位置數量 + 該位置的出貨/退回異動(batch_movements.location_code)
--                                 沒有位置的部分(「未分布」)= 商品行剩餘量 − 各位置剩餘量加總,由前端計算
--   batch_tag_locations(tx, rows) 出貨異動分配完批次之後,把這筆交易在每個批次商品行扣的量拆到各位置
--                                 (同一商品行的出貨異動整組取代;加總必須等於原本扣的量,位置剩餘量必須夠)
-- ============================================================

create or replace view public.batch_item_loc_stock with (security_invoker = true) as
select l.batch_item_id,
       l.location_code,
       l.qty + coalesce((select sum(m.qty) from public.batch_movements m
                          where m.batch_item_id = l.batch_item_id and m.location_code = l.location_code), 0) as remaining
from public.batch_item_locations l;

grant select on public.batch_item_loc_stock to authenticated;

-- p_rows: [{ "batch_item_id": "...", "code": "A-1-2" 或 "" (未分布), "qty": 5 }, ...]  (qty 為正數 = 這次扣的量)
create or replace function public.batch_tag_locations(p_tx_id text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item   text;
  v_tpl    public.batch_movements%rowtype;
  v_total  numeric;
  v_new    numeric;
  v_row    jsonb;
  v_code   text;
  v_qty    numeric;
  v_left   numeric;
  v_n      int := 0;
begin
  for v_item in
    select distinct r->>'batch_item_id' from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  loop
    -- 這筆交易在這個商品行目前的出貨異動(通常一筆;之前已經拆過的話是多筆)
    select * into v_tpl from public.batch_movements
     where tx_id = p_tx_id and batch_item_id = v_item and kind = 'out'
     order by id limit 1;
    if not found then continue; end if;

    select -coalesce(sum(qty), 0) into v_total from public.batch_movements
     where tx_id = p_tx_id and batch_item_id = v_item and kind = 'out';

    select coalesce(sum((r->>'qty')::numeric), 0) into v_new
      from jsonb_array_elements(p_rows) r
     where r->>'batch_item_id' = v_item and (r->>'qty')::numeric > 0;

    if abs(v_new - v_total) > 1e-9 then
      raise exception 'batch_loc_mismatch:%', jsonb_build_object('batch_item_id', v_item, 'moved', v_total, 'assigned', v_new)::text;
    end if;

    delete from public.batch_movements
     where tx_id = p_tx_id and batch_item_id = v_item and kind = 'out';

    for v_row in
      select r from jsonb_array_elements(p_rows) r
       where r->>'batch_item_id' = v_item and (r->>'qty')::numeric > 0
    loop
      v_code := nullif(trim(v_row->>'code'), '');
      v_qty  := (v_row->>'qty')::numeric;
      if v_code is not null then
        select remaining into v_left from public.batch_item_loc_stock
         where batch_item_id = v_item and location_code = v_code;
        if v_left is null or v_left + 1e-9 < v_qty then
          raise exception 'batch_loc_insufficient:%', jsonb_build_object('batch_item_id', v_item, 'code', v_code, 'left', coalesce(v_left, 0), 'need', v_qty)::text;
        end if;
      end if;
      insert into public.batch_movements
        (batch_item_id, qty, kind, tx_id, order_id, order_no, conversion_id, mv_date, party, note, location_code, created_at, unit_cost)
      values
        (v_item, -v_qty, 'out', v_tpl.tx_id, v_tpl.order_id, v_tpl.order_no, v_tpl.conversion_id, v_tpl.mv_date, v_tpl.party, v_tpl.note,
         v_code, v_tpl.created_at, v_tpl.unit_cost);
      v_n := v_n + 1;
    end loop;
  end loop;

  return jsonb_build_object('movements', v_n);
end $$;

revoke all on function public.batch_tag_locations(text, jsonb) from public, anon;
grant execute on function public.batch_tag_locations(text, jsonb) to authenticated;

-- 驗證用:
-- select to_regclass('public.batch_item_loc_stock');
-- select proname from pg_proc where proname = 'batch_tag_locations';
