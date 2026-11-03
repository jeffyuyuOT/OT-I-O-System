-- ============================================================
-- Opening Price 匯入:把「有價格的商品」放進批次追蹤的期初批次,並把價格載入期初批次的 Sell price
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
--
-- 規則(每個商品一列 { product_id, price }):
--   * 商品已經有期初批次行  → 更新那一行的成本:unit_cost = price / 1.2
--   * 商品還沒進入批次追蹤、而且目前有庫存 → 建立期初批次行(數量 = 目前庫存,沒有有效期),成本 = price / 1.2
--   * 商品已經有正式進貨批次、但沒有期初批次 → 不動批次(只有價格設定會更新)
--   * 商品沒有庫存、也還沒進入批次追蹤 → 不建立批次(只有價格設定會更新)
-- 期初批次的 margin 固定設為 20%(1.2 = 1 + 20%),所以期初批次的 Sell price = Total price × 1.2 = 匯入的價格。
-- 回傳 { created, updated, skipped_tracked, skipped_no_stock, invalid }
-- ============================================================
create or replace function public.batch_import_opening(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_pid text;
  v_price numeric;
  v_unit numeric;
  v_stock numeric;
  v_item_id text;
  v_created int := 0;
  v_updated int := 0;
  v_skip_tracked int := 0;
  v_skip_stock int := 0;
  v_invalid int := 0;
begin
  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_pid := v_row->>'product_id';
    begin
      v_price := (v_row->>'price')::numeric;
    exception when others then
      v_price := null;
    end;
    if v_pid is null or v_price is null or v_price < 0 then
      v_invalid := v_invalid + 1;
      continue;
    end if;
    v_unit := v_price / 1.2;

    select bi.id into v_item_id from public.batch_items bi
     where bi.batch_id = 'opening' and bi.product_id = v_pid and bi.expiry is null
     limit 1;

    if v_item_id is not null then
      update public.batch_items set unit_cost_base = v_unit, unit_cost_total = v_unit where id = v_item_id;
      v_updated := v_updated + 1;
    elsif exists (select 1 from public.batch_items bi where bi.product_id = v_pid) then
      v_skip_tracked := v_skip_tracked + 1;
    else
      select ps.stock into v_stock from public.product_stock ps where ps.product_id::text = v_pid;
      v_stock := coalesce(v_stock, 0);
      if v_stock > 0 then
        insert into public.batches (id, batch_no, batch_date, is_opening)
        values ('opening', 'OPENING', date '2000-01-01', true)
        on conflict (id) do nothing;
        insert into public.batch_items (id, batch_id, product_id, expiry, qty_in, unit_cost_base, unit_cost_total)
        values (gen_random_uuid()::text, 'opening', v_pid, null, v_stock, v_unit, v_unit);
        v_created := v_created + 1;
      else
        v_skip_stock := v_skip_stock + 1;
      end if;
    end if;
  end loop;

  if v_created + v_updated > 0 then
    update public.batches set margin_pct = 20 where id = 'opening';
  end if;

  return jsonb_build_object('created', v_created, 'updated', v_updated, 'skipped_tracked', v_skip_tracked,
                            'skipped_no_stock', v_skip_stock, 'invalid', v_invalid);
end $$;

revoke all on function public.batch_import_opening(jsonb) from public, anon;
grant execute on function public.batch_import_opening(jsonb) to authenticated;
