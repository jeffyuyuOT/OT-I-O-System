-- 批次追蹤 第二期:成本(底價 / 總價 / 原幣別)
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。
-- 可重複執行(add column if not exists / create or replace)。
-- 取代第一期的 batch_save_purchase,多接收每行的:
--   amount        底價總額 (AUD)            → unit_cost_base  = amount / qty
--   total_amount  總價總額 (AUD,含分攤支出) → unit_cost_total = total_amount / qty
--   orig_currency 發票原幣別 (AUD 或空白代表沒有外幣)
--   orig_amount   原幣別總額               → orig_unit_cost = orig_amount / qty
--   fx_rate       1 單位原幣別 = ? AUD

alter table public.batch_items add column if not exists unit_cost_base  numeric;
alter table public.batch_items add column if not exists unit_cost_total numeric;
alter table public.batch_items add column if not exists orig_currency   text;
alter table public.batch_items add column if not exists orig_unit_cost  numeric;
alter table public.batch_items add column if not exists fx_rate         numeric;

create or replace function public.batch_save_purchase(p_purchase_id text, p_date date, p_invoice_no text, p_supplier text, p_items jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_batch   public.batches%rowtype;
  v_lines   jsonb;
  v_line    jsonb;
  v_item    public.batch_items%rowtype;
  v_pid     text;
  v_exp     date;
  v_qty     numeric;
  v_amount  numeric;
  v_total   numeric;
  v_orig    numeric;
  v_cur     text;
  v_fx      numeric;
  v_unit    numeric;
  v_unit_total numeric;
  v_unit_orig  numeric;
  v_rem_after numeric;
  v_stock   numeric;
  v_prod_qty numeric;
  v_opening jsonb := '[]'::jsonb;
  v_new_products text[] := '{}';
begin
  -- 同(商品,有效期)的多行先合併;數量 <= 0 的(例如被 Credit Note 完全抵銷)不進批次
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', s.product_id, 'expiry', s.expiry, 'qty', s.qty, 'amount', s.amount,
           'total_amount', s.total_amount, 'orig_amount', s.orig_amount,
           'orig_currency', s.cur, 'fx_rate', s.fx, 'supplier_lot', s.lot)), '[]'::jsonb)
  into v_lines
  from (
    select e->>'product_id' as product_id,
           nullif(e->>'expiry', '')::date as expiry,
           sum((e->>'qty')::numeric) as qty,
           case when bool_or(nullif(e->>'amount', '') is not null)
                then sum(coalesce(nullif(e->>'amount', '')::numeric, 0)) end as amount,
           case when bool_or(nullif(e->>'total_amount', '') is not null)
                then sum(coalesce(nullif(e->>'total_amount', '')::numeric, 0)) end as total_amount,
           case when bool_or(nullif(e->>'orig_amount', '') is not null)
                then sum(coalesce(nullif(e->>'orig_amount', '')::numeric, 0)) end as orig_amount,
           max(nullif(e->>'orig_currency', '')) as cur,
           max(nullif(e->>'fx_rate', '')::numeric) as fx,
           max(nullif(e->>'supplier_lot', '')) as lot
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e
    group by 1, 2
    having sum((e->>'qty')::numeric) > 0
  ) s;

  -- 取得或建立這張進貨單的批次
  select * into v_batch from public.batches where purchase_id = p_purchase_id for update;
  if not found then
    insert into public.batches (id, batch_no, batch_date, purchase_id, invoice_no, supplier)
    values (gen_random_uuid()::text, public.batch_next_no(p_date), p_date, p_purchase_id, p_invoice_no, p_supplier)
    returning * into v_batch;
  else
    update public.batches
       set batch_date = p_date, invoice_no = p_invoice_no, supplier = p_supplier   -- batch_no 不變
     where id = v_batch.id;
  end if;

  for v_line in select value from jsonb_array_elements(v_lines) loop
    v_pid    := v_line->>'product_id';
    v_exp    := nullif(v_line->>'expiry', '')::date;
    v_qty    := (v_line->>'qty')::numeric;
    v_amount := nullif(v_line->>'amount', '')::numeric;
    v_total  := nullif(v_line->>'total_amount', '')::numeric;
    v_orig   := nullif(v_line->>'orig_amount', '')::numeric;
    v_cur    := nullif(v_line->>'orig_currency', '');
    v_fx     := nullif(v_line->>'fx_rate', '')::numeric;
    v_unit        := case when v_amount is not null and v_qty > 0 then v_amount / v_qty end;
    -- 沒有分攤支出時,總價 = 底價
    v_unit_total  := case when v_total  is not null and v_qty > 0 then v_total  / v_qty else v_unit end;
    v_unit_orig   := case when v_orig   is not null and v_qty > 0 then v_orig   / v_qty end;

    select * into v_item from public.batch_items
     where batch_id = v_batch.id and product_id = v_pid and expiry is not distinct from v_exp
     for update;

    if found then
      v_rem_after := v_qty + coalesce((select sum(m.qty) from public.batch_movements m where m.batch_item_id = v_item.id), 0);
      if v_rem_after < 0 then
        raise exception 'batch_in_use:%', jsonb_build_object('product_id', v_pid, 'expiry', v_exp, 'min_qty', v_qty - v_rem_after)::text;
      end if;
      update public.batch_items
         set qty_in = v_qty,
             unit_cost_base = v_unit,
             unit_cost_total = v_unit_total,      -- 第二期起每次明確寫入(第一期是 coalesce 保留舊值)
             orig_currency = v_cur,
             orig_unit_cost = v_unit_orig,
             fx_rate = v_fx,
             supplier_lot = nullif(v_line->>'supplier_lot', '')
       where id = v_item.id;
    else
      insert into public.batch_items (id, batch_id, product_id, expiry, qty_in, unit_cost_base, unit_cost_total, orig_currency, orig_unit_cost, fx_rate, supplier_lot)
      values (gen_random_uuid()::text, v_batch.id, v_pid, v_exp, v_qty, v_unit, v_unit_total, v_cur, v_unit_orig, v_fx, nullif(v_line->>'supplier_lot', ''));
      v_new_products := array_append(v_new_products, v_pid);
    end if;
  end loop;

  -- 編輯時被移除的行:有出貨紀錄就擋下,沒有就刪掉(multipack 切換進來、qty_in = 0 的行不動)
  for v_item in
    select bi.* from public.batch_items bi
    where bi.batch_id = v_batch.id and bi.qty_in > 0
      and not exists (
        select 1 from jsonb_array_elements(v_lines) l
        where l->>'product_id' = bi.product_id
          and nullif(l->>'expiry', '')::date is not distinct from bi.expiry)
  loop
    if exists (select 1 from public.batch_movements m where m.batch_item_id = v_item.id) then
      raise exception 'batch_in_use:%', jsonb_build_object('product_id', v_item.product_id, 'expiry', v_item.expiry, 'min_qty', 0)::text;
    end if;
    delete from public.batch_items where id = v_item.id;
  end loop;

  -- 期初批次:商品「第一次」進入批次追蹤、而且入庫之前本來就有庫存 → 把當時庫存建成期初批次(無有效期)
  for v_pid in select distinct unnest(v_new_products) loop
    if exists (select 1 from public.batch_items bi where bi.product_id = v_pid and bi.batch_id <> v_batch.id) then
      continue;
    end if;
    select coalesce(sum((l->>'qty')::numeric), 0) into v_prod_qty
      from jsonb_array_elements(v_lines) l where l->>'product_id' = v_pid;
    select ps.stock into v_stock from public.product_stock ps where ps.product_id::text = v_pid;
    v_stock := coalesce(v_stock, 0);
    if v_stock - v_prod_qty > 0 then
      insert into public.batches (id, batch_no, batch_date, is_opening)
      values ('opening', 'OPENING', date '2000-01-01', true)
      on conflict (id) do nothing;
      insert into public.batch_items (id, batch_id, product_id, expiry, qty_in)
      values (gen_random_uuid()::text, 'opening', v_pid, null, v_stock - v_prod_qty);
      v_opening := v_opening || to_jsonb(v_pid);
    end if;
  end loop;

  return jsonb_build_object('batch_id', v_batch.id, 'batch_no', v_batch.batch_no, 'opening_products', v_opening);
end $function$;
