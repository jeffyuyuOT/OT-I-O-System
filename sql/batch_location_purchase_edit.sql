-- ============================================================
-- 編輯進貨單後,批次記的位置跟著數量變動
--
-- 編輯進貨單把某個商品行的數量改少(或整行移除)後,批次記的「進貨時放在各位置的數量」不能超過新數量,
-- 超過的部分依「位置剩餘量多的先扣」減回去;回傳實際減掉的位置清單,前端再把庫存分布(product_locations)同步扣掉。
-- (數量改多不需要處理:多出來的部分算「未分布」。)
--
-- 需要先執行 batch_location_phase_a.sql(請重新執行最新版,編輯進貨單改備註要用)、batch_location_phase_b.sql。
-- 在「測試」Supabase 專案(zurktjerrqmjbrhvtibm)的 SQL Editor 執行一次;
-- 正式專案(lstckpzmtacttwbmmbof)等你明說再執行。可重複執行。
-- ============================================================

create or replace function public.batch_clamp_purchase_locations(p_purchase_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item  record;
  v_loc   record;
  v_sum   numeric;
  v_over  numeric;
  v_cut   numeric;
  v_res   jsonb := '[]'::jsonb;
begin
  for v_item in
    select bi.id, bi.product_id, bi.qty_in
      from public.batch_items bi join public.batches b on b.id = bi.batch_id
     where b.purchase_id = p_purchase_id
  loop
    select coalesce(sum(qty), 0) into v_sum from public.batch_item_locations where batch_item_id = v_item.id;
    v_over := v_sum - v_item.qty_in;
    if v_over <= 1e-9 then continue; end if;
    for v_loc in
      select l.id, l.location_code, l.qty,
             l.qty + coalesce((select sum(m.qty) from public.batch_movements m where m.batch_item_id = l.batch_item_id and m.location_code = l.location_code), 0) as rem
        from public.batch_item_locations l
       where l.batch_item_id = v_item.id
       order by rem desc, l.id desc
    loop
      exit when v_over <= 1e-9;
      v_cut := least(v_over, v_loc.qty);
      if v_cut <= 0 then continue; end if;
      if v_loc.qty - v_cut <= 1e-9 then
        delete from public.batch_item_locations where id = v_loc.id;
      else
        update public.batch_item_locations set qty = qty - v_cut where id = v_loc.id;
      end if;
      v_over := v_over - v_cut;
      v_res := v_res || jsonb_build_object('product_id', v_item.product_id, 'code', v_loc.location_code, 'qty', v_cut);
    end loop;
  end loop;
  return v_res;
end $$;

revoke all on function public.batch_clamp_purchase_locations(text) from public, anon;
grant execute on function public.batch_clamp_purchase_locations(text) to authenticated;

-- 驗證用:select proname from pg_proc where proname = 'batch_clamp_purchase_locations';
