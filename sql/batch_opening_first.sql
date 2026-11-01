-- ============================================================
-- 批次分配順序調整:期初批次(OPENING)優先出貨
--
-- 期初批次都沒有登記有效期,原本「沒有有效期的排最後」,結果舊庫存會留到最後才出。
-- 改成:期初批次 → 有有效期的(先到期先出) → 沒有有效期的(依進貨日 FIFO)。
-- 影響 batch_allocate(出貨/核對自動分配)與 batch_convert(multipack 切換自動分配);
-- 手動指定批次不受影響,已分配的出貨紀錄也不會改。
--
-- 在「測試」Supabase 專案(zurktjerrqmjbrhvtibm)的 SQL Editor 執行一次;
-- 正式專案(lstckpzmtacttwbmmbof)等你明說再執行。可重複執行。
-- ============================================================

create or replace function public.batch_allocate(p_tx_ids text[], p_manual jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tx record;
  v_need numeric;
  v_done numeric;
  v_pick jsonb;
  v_bi public.batch_items%rowtype;
  v_take numeric;
  v_rem numeric;
  v_order_no text;
  v_res jsonb := '{}'::jsonb;
begin
  for v_tx in
    select t.id::text as id, t.product_id::text as product_id, t.qty::numeric as qty,
           t.date::date as dt, t.party::text as party, t.order_id::text as order_id
    from public.transactions t
    where t.id::text = any(p_tx_ids) and t.type = 'out' and coalesce(t.conversion, false) = false
    order by t.id::text
  loop
    if not exists (select 1 from public.batch_items where product_id = v_tx.product_id) then
      continue;
    end if;

    select coalesce(-sum(m.qty), 0) into v_done
      from public.batch_movements m where m.tx_id = v_tx.id and m.kind = 'out';
    v_need := v_tx.qty - v_done;
    if v_need <= 0 then continue; end if;

    v_order_no := case when v_tx.order_id is null then null
                       else (select o.payload->>'orderNo' from public.orders o where o.id::text = v_tx.order_id) end;

    -- 手動指定
    for v_pick in select value from jsonb_array_elements(coalesce(p_manual->v_tx.id, '[]'::jsonb)) loop
      exit when v_need <= 0;
      select * into v_bi from public.batch_items
       where id = v_pick->>'batch_item_id' and product_id = v_tx.product_id for update;
      if not found then raise exception 'batch_bad_pick:%', v_pick->>'batch_item_id'; end if;
      v_take := least((v_pick->>'qty')::numeric, v_need);
      v_rem  := public.batch_item_remaining(v_bi.id);
      if v_take > v_rem then
        raise exception 'batch_insufficient:%', jsonb_build_object('batch_item_id', v_bi.id, 'requested', v_take, 'available', v_rem)::text;
      end if;
      if v_take > 0 then
        insert into public.batch_movements (batch_item_id, qty, kind, tx_id, order_id, order_no, mv_date, party)
        values (v_bi.id, -v_take, 'out', v_tx.id, v_tx.order_id, v_order_no, v_tx.dt, v_tx.party);
        v_need := v_need - v_take;
      end if;
    end loop;

    -- 自動分配:期初批次(沒有有效期、視為最舊)先出 → 其餘 FEFO → FIFO
    for v_bi in
      select bi.* from public.batch_items bi
      join public.batches b on b.id = bi.batch_id
      where bi.product_id = v_tx.product_id
      order by (not b.is_opening), (bi.expiry is null), bi.expiry, b.batch_date, b.batch_no
      for update of bi
    loop
      exit when v_need <= 0;
      v_rem := public.batch_item_remaining(v_bi.id);
      continue when v_rem <= 0;
      v_take := least(v_rem, v_need);
      insert into public.batch_movements (batch_item_id, qty, kind, tx_id, order_id, order_no, mv_date, party)
      values (v_bi.id, -v_take, 'out', v_tx.id, v_tx.order_id, v_order_no, v_tx.dt, v_tx.party);
      v_need := v_need - v_take;
    end loop;

    v_res := v_res || jsonb_build_object(v_tx.id, jsonb_build_object('allocated', v_tx.qty - v_need, 'untracked', v_need));
  end loop;
  return v_res;
end $$;

create or replace function public.batch_convert(p_conversion_id text, p_manual jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_out record;
  v_in record;
  v_ratio numeric;
  v_step numeric := 1;
  v_need numeric;
  v_pick jsonb;
  v_bi public.batch_items%rowtype;
  v_take numeric;
  v_rem numeric;
begin
  select t.id::text as id, t.product_id::text as product_id, t.qty::numeric as qty, t.date::date as dt
    into v_out from public.transactions t
   where t.conversion_id::text = p_conversion_id and t.type = 'out' limit 1;
  select t.id::text as id, t.product_id::text as product_id, t.qty::numeric as qty
    into v_in from public.transactions t
   where t.conversion_id::text = p_conversion_id and t.type = 'in' limit 1;
  if v_out.id is null or v_in.id is null then
    raise exception 'batch_convert_tx_missing';
  end if;
  if not exists (select 1 from public.batch_items where product_id = v_out.product_id) then
    return jsonb_build_object('tracked', false);
  end if;

  v_ratio := v_in.qty / v_out.qty;                     -- 換算後數量 / 原本數量
  if v_ratio < 1 then v_step := round(1 / v_ratio); end if;
  v_need := v_out.qty;

  for v_pick in select value from jsonb_array_elements(coalesce(p_manual, '[]'::jsonb)) loop
    exit when v_need <= 0;
    select * into v_bi from public.batch_items
     where id = v_pick->>'batch_item_id' and product_id = v_out.product_id for update;
    if not found then raise exception 'batch_bad_pick:%', v_pick->>'batch_item_id'; end if;
    v_take := least((v_pick->>'qty')::numeric, v_need);
    if v_step > 1 and mod(v_take, v_step) <> 0 then
      raise exception 'batch_convert_step:%', v_step;
    end if;
    v_rem := public.batch_item_remaining(v_bi.id);
    if v_take > v_rem then
      raise exception 'batch_insufficient:%', jsonb_build_object('batch_item_id', v_bi.id, 'requested', v_take, 'available', v_rem)::text;
    end if;
    if v_take > 0 then
      perform public.batch__convert_take(v_bi.id, v_take, v_in.product_id, v_ratio, v_out.id, v_in.id, p_conversion_id, v_out.dt);
      v_need := v_need - v_take;
    end if;
  end loop;

  for v_bi in
    select bi.* from public.batch_items bi
    join public.batches b on b.id = bi.batch_id
    where bi.product_id = v_out.product_id
    order by (not b.is_opening), (bi.expiry is null), bi.expiry, b.batch_date, b.batch_no
    for update of bi
  loop
    exit when v_need <= 0;
    v_rem := public.batch_item_remaining(v_bi.id);
    v_take := least(v_rem, v_need);
    if v_step > 1 then v_take := floor(v_take / v_step) * v_step; end if;
    continue when v_take <= 0;
    perform public.batch__convert_take(v_bi.id, v_take, v_in.product_id, v_ratio, v_out.id, v_in.id, p_conversion_id, v_out.dt);
    v_need := v_need - v_take;
  end loop;

  return jsonb_build_object('tracked', true, 'converted', v_out.qty - v_need, 'untracked', v_need);
end $$;

-- 驗證用:兩個函式內容都應包含 is_opening
-- select proname, prosrc like '%not b.is_opening%' as ok from pg_proc where proname in ('batch_allocate','batch_convert');
