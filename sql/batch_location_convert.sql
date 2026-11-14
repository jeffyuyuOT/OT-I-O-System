-- ============================================================
-- 庫存位置分批次 (c):批量商品 ⇄ 主商品切換時,位置跟著走
--
-- 規則(使用者):切換出來的商品屬於同一個批次、同樣有效期(batch_convert 已經這樣做),
-- 位置也一樣(箱裝拆散裝,拆的當下放在同一個位置;之後要換位置再轉移)。
--
-- 需要先執行 batch_location_phase_a.sql、batch_location_phase_b.sql。
-- 在「測試」Supabase 專案(zurktjerrqmjbrhvtibm)的 SQL Editor 執行一次;
-- 正式專案(lstckpzmtacttwbmmbof)等你明說再執行。可重複執行。
--
-- batch_tag_convert_locations(p_conversion_id, p_rows)
--   在 batch_convert 完成之後呼叫。
--   p_rows: [{ "batch_item_id": "來源商品的批次行", "code": "A-1" 或 "" (未分布), "qty": 來源商品這次從該位置切換的數量 }, ...]
--   - 來源批次行的 convert_out 異動拆成各位置(位置剩餘量必須夠);
--   - 切換進來的批次行(同批次、同有效期)在同樣位置加上 qty × 換算比例。
-- ============================================================

create or replace function public.batch_tag_convert_locations(p_conversion_id text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_x      text;
  v_xi     public.batch_items%rowtype;
  v_y      text;
  v_tpl    public.batch_movements%rowtype;
  v_out    numeric;
  v_in     numeric;
  v_ratio  numeric;
  v_sum    numeric;
  v_row    jsonb;
  v_code   text;
  v_qty    numeric;
  v_left   numeric;
  v_n      int := 0;
begin
  for v_x in
    select distinct r->>'batch_item_id' from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  loop
    select * into v_xi from public.batch_items where id = v_x;
    if not found then continue; end if;

    select * into v_tpl from public.batch_movements
     where conversion_id = p_conversion_id and batch_item_id = v_x and kind = 'convert_out' order by id limit 1;
    if not found then continue; end if;

    select -coalesce(sum(qty), 0) into v_out from public.batch_movements
     where conversion_id = p_conversion_id and batch_item_id = v_x and kind = 'convert_out';

    -- 切換進來的批次行:同批次、同有效期、不同商品
    select m.batch_item_id into v_y
      from public.batch_movements m join public.batch_items bi on bi.id = m.batch_item_id
     where m.conversion_id = p_conversion_id and m.kind = 'convert_in'
       and bi.batch_id = v_xi.batch_id and bi.expiry is not distinct from v_xi.expiry and bi.product_id <> v_xi.product_id
     limit 1;
    if v_y is null then continue; end if;
    select coalesce(sum(qty), 0) into v_in from public.batch_movements
     where conversion_id = p_conversion_id and batch_item_id = v_y and kind = 'convert_in';
    if v_out <= 0 then continue; end if;
    v_ratio := v_in / v_out;

    select coalesce(sum((r->>'qty')::numeric), 0) into v_sum
      from jsonb_array_elements(p_rows) r where r->>'batch_item_id' = v_x and (r->>'qty')::numeric > 0;
    if abs(v_sum - v_out) > 1e-9 then
      raise exception 'batch_loc_mismatch:%', jsonb_build_object('batch_item_id', v_x, 'moved', v_out, 'assigned', v_sum)::text;
    end if;

    delete from public.batch_movements
     where conversion_id = p_conversion_id and batch_item_id = v_x and kind = 'convert_out';

    for v_row in
      select r from jsonb_array_elements(p_rows) r where r->>'batch_item_id' = v_x and (r->>'qty')::numeric > 0
    loop
      v_code := nullif(trim(v_row->>'code'), '');
      v_qty  := (v_row->>'qty')::numeric;
      if v_code is not null then
        select remaining into v_left from public.batch_item_loc_stock where batch_item_id = v_x and location_code = v_code;
        if v_left is null or v_left + 1e-9 < v_qty then
          raise exception 'batch_loc_insufficient:%', jsonb_build_object('batch_item_id', v_x, 'code', v_code, 'left', coalesce(v_left, 0), 'need', v_qty)::text;
        end if;
      end if;
      insert into public.batch_movements (batch_item_id, qty, kind, tx_id, conversion_id, mv_date, location_code, created_at, unit_cost)
      values (v_x, -v_qty, 'convert_out', v_tpl.tx_id, p_conversion_id, v_tpl.mv_date, v_code, v_tpl.created_at, v_tpl.unit_cost);
      -- 切換進來的批次行放在同樣位置(進貨位置數量 + 這次切換進來的量)
      if v_code is not null then
        insert into public.batch_item_locations (batch_item_id, location_code, qty)
        values (v_y, v_code, v_qty * v_ratio)
        on conflict (batch_item_id, location_code) do update set qty = public.batch_item_locations.qty + excluded.qty;
      end if;
      v_n := v_n + 1;
    end loop;
  end loop;
  return jsonb_build_object('rows', v_n);
end $$;

revoke all on function public.batch_tag_convert_locations(text, jsonb) from public, anon;
grant execute on function public.batch_tag_convert_locations(text, jsonb) to authenticated;

-- 驗證用:select proname from pg_proc where proname = 'batch_tag_convert_locations';
