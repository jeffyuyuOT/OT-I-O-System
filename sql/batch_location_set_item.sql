-- ============================================================
-- 設定既有批次商品行的位置(補登記:例如期初批次、或進貨時沒記位置的批次)
--
-- 需要先執行 batch_location_phase_a.sql、batch_location_phase_b.sql。
-- 在「測試」Supabase 專案(zurktjerrqmjbrhvtibm)的 SQL Editor 執行一次;
-- 正式專案(lstckpzmtacttwbmmbof)等你明說再執行。可重複執行。
--
-- batch_set_item_locations(p_item, p_rows)
--   p_rows: [{ "code": "A-1-2", "qty": 5 }, ...]  qty = 這個位置「目前」放了這個批次多少
--   整組取代這個商品行的位置;加總不得超過商品行目前剩餘量,沒填到的部分算「未分布」。
--   不動庫存分布(product_locations),只是標記「這批貨現在放在哪」。
-- ============================================================

create or replace function public.batch_set_item_locations(p_item text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rem   numeric;
  v_sum   numeric;
  v_row   jsonb;
  v_code  text;
  v_qty   numeric;
  v_mv    numeric;
  v_store numeric;
  v_n     int := 0;
begin
  perform 1 from public.batch_items where id = p_item for update;
  if not found then
    raise exception 'batch_item_not_found';
  end if;

  v_rem := public.batch_item_remaining(p_item);
  select coalesce(sum((r->>'qty')::numeric), 0) into v_sum
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
   where coalesce(trim(r->>'code'), '') <> '' and (r->>'qty')::numeric > 0;
  if v_sum > v_rem + 1e-9 then
    raise exception 'batch_loc_over:%', jsonb_build_object('batch_item_id', p_item, 'remaining', v_rem, 'assigned', v_sum)::text;
  end if;

  delete from public.batch_item_locations where batch_item_id = p_item;

  for v_row in
    select jsonb_build_object('code', trim(r->>'code'), 'qty', sum((r->>'qty')::numeric))
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
     where coalesce(trim(r->>'code'), '') <> '' and (r->>'qty')::numeric > 0
     group by trim(r->>'code')
  loop
    v_code := v_row->>'code';
    v_qty  := (v_row->>'qty')::numeric;
    -- 位置剩餘量 = 存的數量 + 該位置的異動;所以存的數量 = 想要的目前數量 − 該位置已有的異動
    select coalesce(sum(qty), 0) into v_mv from public.batch_movements where batch_item_id = p_item and location_code = v_code;
    v_store := v_qty - v_mv;
    if v_store <= 0 then continue; end if;
    insert into public.batch_item_locations (batch_item_id, location_code, qty) values (p_item, v_code, v_store);
    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('locations', v_n);
end $$;

revoke all on function public.batch_set_item_locations(text, jsonb) from public, anon;
grant execute on function public.batch_set_item_locations(text, jsonb) to authenticated;

-- 驗證用:select proname from pg_proc where proname = 'batch_set_item_locations';
