-- ============================================================
-- 庫存位置分批次 第五階段(e):退貨 / 訂單減量 / 刪除訂單品項,退回原來的批次「與位置」
--
-- 需要先執行 batch_location_phase_a.sql、batch_location_phase_b.sql。
-- 在「測試」Supabase 專案(zurktjerrqmjbrhvtibm)的 SQL Editor 執行一次;
-- 正式專案(lstckpzmtacttwbmmbof)等你明說再執行。可重複執行。
--
-- batch_return_locations(p_tx_ids)
--   在 batch_return 把退回的量記回批次之後呼叫:把這些「退回」異動(還沒有位置的)依這張訂單
--   當初出貨的位置拆回去(原本從哪個位置出的,就退回哪個位置;數量最多的先退)。
--   沒有訂單的退回(例如盤點增加)沒有「原本的位置」,維持未分布。
--   回傳實際退回的位置清單 [{product_id, code, qty}],給前端同步庫存分布。
--   (反核對 / 刪除訂單是直接刪除交易,出貨異動連同位置一起刪掉,批次位置數量自動還原,不需要這個函式。)
-- ============================================================

create or replace function public.batch_return_locations(p_tx_ids text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mv    record;
  v_row   record;
  v_need  numeric;
  v_take  numeric;
  v_res   jsonb := '[]'::jsonb;
  v_plan  jsonb;
  v_p     jsonb;
begin
  for v_mv in
    select m.*, bi.product_id as product_id
      from public.batch_movements m
      join public.batch_items bi on bi.id = m.batch_item_id
     where m.tx_id = any(p_tx_ids) and m.kind = 'return' and m.location_code is null and m.order_id is not null
     order by m.id
  loop
    v_need := v_mv.qty;
    v_plan := '[]'::jsonb;
    for v_row in
      select m2.location_code as code, -sum(m2.qty) as net
        from public.batch_movements m2
       where m2.order_id = v_mv.order_id
         and m2.batch_item_id = v_mv.batch_item_id
         and m2.kind in ('out', 'return')
         and not (m2.kind = 'return' and m2.tx_id = any(p_tx_ids) and m2.location_code is null)
       group by m2.location_code
      having -sum(m2.qty) > 0 and m2.location_code is not null
       order by -sum(m2.qty) desc
    loop
      exit when v_need <= 0;
      v_take := least(v_row.net, v_need);
      v_plan := v_plan || jsonb_build_object('code', v_row.code, 'qty', v_take);
      v_need := v_need - v_take;
    end loop;

    if jsonb_array_length(v_plan) = 0 then continue; end if;

    delete from public.batch_movements where id = v_mv.id;
    for v_p in select value from jsonb_array_elements(v_plan) loop
      insert into public.batch_movements
        (batch_item_id, qty, kind, tx_id, order_id, order_no, conversion_id, mv_date, party, note, location_code, created_at, unit_cost)
      values
        (v_mv.batch_item_id, (v_p->>'qty')::numeric, 'return', v_mv.tx_id, v_mv.order_id, v_mv.order_no, v_mv.conversion_id,
         v_mv.mv_date, v_mv.party, v_mv.note, v_p->>'code', v_mv.created_at, v_mv.unit_cost);
      v_res := v_res || jsonb_build_object('product_id', v_mv.product_id, 'code', v_p->>'code', 'qty', (v_p->>'qty')::numeric);
    end loop;
    if v_need > 1e-9 then
      insert into public.batch_movements
        (batch_item_id, qty, kind, tx_id, order_id, order_no, conversion_id, mv_date, party, note, location_code, created_at, unit_cost)
      values
        (v_mv.batch_item_id, v_need, 'return', v_mv.tx_id, v_mv.order_id, v_mv.order_no, v_mv.conversion_id,
         v_mv.mv_date, v_mv.party, v_mv.note, null, v_mv.created_at, v_mv.unit_cost);
    end if;
  end loop;
  return v_res;
end $$;

revoke all on function public.batch_return_locations(text[]) from public, anon;
grant execute on function public.batch_return_locations(text[]) to authenticated;

-- 驗證用:select proname from pg_proc where proname = 'batch_return_locations';
