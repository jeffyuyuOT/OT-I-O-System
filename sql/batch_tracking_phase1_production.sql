-- ============================================================
-- Batch tracking(批次追蹤)第一期:資料表 + RPC(完整版,已含補丁 1)
--
-- 執行方式:到 Supabase 專案的 SQL Editor 整份貼上執行一次。
-- 測試專案(zurktjerrqmjbrhvtibm)已經跑過舊版 + 補丁;正式專案(lstckpzmtacttwbmmbof)跑這份即可。
-- 可重複執行(create if not exists / create or replace),重跑不會壞資料。
-- 不會動到既有資料表的資料,只在 transactions 加一個「刪除時清掉批次扣除紀錄」的 trigger。
-- ============================================================

-- ------------------------------------------------------------
-- 1. 資料表
-- ------------------------------------------------------------

-- 批次主檔:一張(勾選追蹤的)進貨單 = 一個批次。另外有一個固定的「期初批次」(id='opening')。
create table if not exists public.batches (
  id          text primary key,
  batch_no    text not null unique,            -- YYMMDD-NNN;期初批次固定是 OPENING。建立後不再改
  batch_date  date not null,                   -- 進貨單日期(FIFO 排序用);期初批次固定 2000-01-01(永遠最舊)
  purchase_id text,                            -- 對應 purchases.id(payload JSON 裡的 id),期初批次是 null
  is_opening  boolean not null default false,
  invoice_no  text,
  supplier    text,
  note        text,
  created_at  timestamptz not null default now()
);
create unique index if not exists batches_purchase_uq on public.batches (purchase_id) where purchase_id is not null;
create index if not exists batches_date_idx on public.batches (batch_date);

-- 批次內的商品行:唯一鍵 = (批次, 商品, 有效期)。同商品同有效期合併、不同有效期分行。
-- 金額一律是 AUD;第二期(其他支出/海外採購)會填 unit_cost_total 與原幣欄位,這裡先預留。
create table if not exists public.batch_items (
  id              text primary key,
  batch_id        text not null references public.batches(id) on delete cascade,
  product_id      text not null,
  expiry          date,                        -- null = 沒有有效期
  qty_in          numeric not null default 0,  -- 進貨單入庫量(multipack 切換進來的行是 0,數量靠 movement)
  unit_cost_base  numeric,                     -- 商品本身單價(AUD)
  unit_cost_total numeric,                     -- 含其他支出的單價(AUD)——第二期才會填,沒有其他支出時 = base
  orig_currency   text,                        -- 第二期:收據原幣別
  orig_unit_cost  numeric,                     -- 第二期:原幣單價
  fx_rate         numeric,                     -- 第二期:1 原幣 = ? AUD
  supplier_lot    text,                        -- 供應商批號(選填)
  created_at      timestamptz not null default now()
);
create unique index if not exists batch_items_uq
  on public.batch_items (batch_id, product_id, coalesce(expiry, date '0001-01-01'));
create index if not exists batch_items_product_idx on public.batch_items (product_id);

-- 批次數量異動(扣除/退回/切換/調整)。qty 帶正負號:出貨 = 負、退回 = 正。
-- 「進貨入庫」不在這裡,是 batch_items.qty_in;某天的剩餘量 = (批次日期 <= 該天 ? qty_in : 0) + 該天以前的 movement 加總。
create table if not exists public.batch_movements (
  id            bigint generated always as identity primary key,
  batch_item_id text not null references public.batch_items(id) on delete cascade,
  qty           numeric not null,
  kind          text not null check (kind in ('out','return','convert_out','convert_in','adjust')),
  tx_id         text,                          -- 對應 transactions.id。該筆交易被刪除時,trigger 會連帶刪掉這裡的紀錄 → 庫存自動還原
  order_id      text,
  order_no      text,
  conversion_id text,
  mv_date       date not null,
  party         text,                          -- 出貨方/客戶(追溯 recall 用)
  note          text,
  location_code text,                          -- 預留給之後的庫存位置功能,第一期不用
  created_at    timestamptz not null default now()
);
create index if not exists batch_movements_item_idx  on public.batch_movements (batch_item_id);
create index if not exists batch_movements_tx_idx    on public.batch_movements (tx_id);
create index if not exists batch_movements_order_idx on public.batch_movements (order_id);
create index if not exists batch_movements_conv_idx  on public.batch_movements (conversion_id);

-- ------------------------------------------------------------
-- 2. 剩餘量
-- ------------------------------------------------------------
create or replace function public.batch_item_remaining(p_item text)
returns numeric language sql stable as $$
  select bi.qty_in + coalesce((select sum(m.qty) from public.batch_movements m where m.batch_item_id = bi.id), 0)
  from public.batch_items bi where bi.id = p_item
$$;

create or replace view public.batch_item_stock with (security_invoker = true) as
select bi.id as batch_item_id,
       bi.qty_in + coalesce(sum(m.qty), 0) as remaining
from public.batch_items bi
left join public.batch_movements m on m.batch_item_id = bi.id
group by bi.id;

-- ------------------------------------------------------------
-- 3. 交易被刪除時,連帶清掉對應的批次扣除紀錄
--    (App 的「反核對/刪除訂單/刪除訂單品項」本來就是刪 transactions,這樣批次剩餘量會自動還原)
-- ------------------------------------------------------------
create or replace function public.batch_cleanup_on_tx_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.batch_movements where tx_id = old.id::text;
  return old;
end $$;

drop trigger if exists trg_batch_cleanup_on_tx_delete on public.transactions;
create trigger trg_batch_cleanup_on_tx_delete
  after delete on public.transactions
  for each row execute function public.batch_cleanup_on_tx_delete();

-- ------------------------------------------------------------
-- 4. 批次號:YYMMDD-NNN,日期取進貨單日期,同一天流水號遞增
-- ------------------------------------------------------------
create or replace function public.batch_next_no(p_date date)
returns text language plpgsql set search_path = public as $$
declare
  v_prefix text := to_char(p_date, 'YYMMDD');
  v_n int;
begin
  perform pg_advisory_xact_lock(hashtext('batch_no_' || v_prefix));
  select coalesce(max(split_part(batch_no, '-', 2)::int), 0) + 1 into v_n
  from public.batches
  where not is_opening and batch_no like v_prefix || '-%';
  return v_prefix || '-' || lpad(v_n::text, 3, '0');
end $$;

-- ------------------------------------------------------------
-- 5. 進貨單 → 批次(新增與編輯共用,可重複呼叫)
--    p_items: [{product_id, expiry('YYYY-MM-DD'或空), qty, amount(AUD總額,可空), supplier_lot(可空)}, ...]
--    必須在這張進貨單的 transactions 已經寫入之後呼叫(期初批次要用到目前庫存)。
--    編輯時:數量不能低於該行已經出貨的量,也不能移除已有出貨的行,否則 raise 'batch_in_use:{json}'。
-- ------------------------------------------------------------
create or replace function public.batch_save_purchase(
  p_purchase_id text, p_date date, p_invoice_no text, p_supplier text, p_items jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_batch   public.batches%rowtype;
  v_lines   jsonb;
  v_line    jsonb;
  v_item    public.batch_items%rowtype;
  v_pid     text;
  v_exp     date;
  v_qty     numeric;
  v_amount  numeric;
  v_unit    numeric;
  v_rem_after numeric;
  v_stock   numeric;
  v_prod_qty numeric;
  v_opening jsonb := '[]'::jsonb;
  v_new_products text[] := '{}';
begin
  -- 同(商品,有效期)的多行先合併;數量 <= 0 的(例如被 Credit Note 完全抵銷)不進批次
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', s.product_id, 'expiry', s.expiry, 'qty', s.qty, 'amount', s.amount, 'supplier_lot', s.lot)), '[]'::jsonb)
  into v_lines
  from (
    select e->>'product_id' as product_id,
           nullif(e->>'expiry', '')::date as expiry,
           sum((e->>'qty')::numeric) as qty,
           case when bool_or(nullif(e->>'amount', '') is not null)
                then sum(coalesce(nullif(e->>'amount', '')::numeric, 0)) end as amount,
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
    v_unit   := case when v_amount is not null and v_qty > 0 then v_amount / v_qty end;

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
             unit_cost_total = coalesce(unit_cost_total, v_unit),
             supplier_lot = nullif(v_line->>'supplier_lot', '')
       where id = v_item.id;
    else
      insert into public.batch_items (id, batch_id, product_id, expiry, qty_in, unit_cost_base, unit_cost_total, supplier_lot)
      values (gen_random_uuid()::text, v_batch.id, v_pid, v_exp, v_qty, v_unit, v_unit, nullif(v_line->>'supplier_lot', ''));
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
end $$;

-- ------------------------------------------------------------
-- 6. 出貨分配(核對訂單、手動出貨、直接出貨、盤點減少、訂單加量…所有 type='out' 的交易)
--    在交易已經寫入之後呼叫。伺服器端為準:
--      先套用手動指定(p_manual = {"<tx_id>": [{"batch_item_id":"...","qty":n}, ...]}),
--      剩下的自動分配:有有效期的先到期先出,接著沒有有效期的依進貨日 FIFO(期初批次最舊);
--      一筆出貨可跨多個批次。所有批次加起來還是不夠的部分 = 「未追蹤」(不報錯,回傳在 untracked)。
--    手動指定超過該批剩餘量 → raise 'batch_insufficient:{json}'。
--    從沒有批次紀錄的商品直接略過(完全走舊流程)。
-- ------------------------------------------------------------
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

    -- 自動分配(FEFO → FIFO)
    for v_bi in
      select bi.* from public.batch_items bi
      join public.batches b on b.id = bi.batch_id
      where bi.product_id = v_tx.product_id
      order by (bi.expiry is null), bi.expiry, b.batch_date, b.batch_no
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

-- ------------------------------------------------------------
-- 7. 入庫/退回(type='restock':訂單刪品項、訂單改少量、盤點增加)
--    有 order_id 的:退回「這張訂單當初從哪些批次扣的」(扣最多的批次優先退),退不完的部分算未追蹤;
--    沒有訂單的(例如盤點增加):只有在 p_manual 指定了批次才入批次,沒指定就是未追蹤。
-- ------------------------------------------------------------
create or replace function public.batch_return(p_tx_ids text[], p_manual jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tx record;
  v_need numeric;
  v_row record;
  v_pick jsonb;
  v_bi public.batch_items%rowtype;
  v_take numeric;
  v_order_no text;
  v_res jsonb := '{}'::jsonb;
begin
  for v_tx in
    select t.id::text as id, t.product_id::text as product_id, t.qty::numeric as qty,
           t.date::date as dt, t.party::text as party, t.order_id::text as order_id
    from public.transactions t
    where t.id::text = any(p_tx_ids) and t.type = 'restock' and coalesce(t.conversion, false) = false
    order by t.id::text
  loop
    if not exists (select 1 from public.batch_items where product_id = v_tx.product_id) then
      continue;
    end if;
    select v_tx.qty - coalesce(sum(m.qty), 0) into v_need
      from public.batch_movements m where m.tx_id = v_tx.id and m.kind = 'return';
    if v_need <= 0 then continue; end if;

    v_order_no := case when v_tx.order_id is null then null
                       else (select o.payload->>'orderNo' from public.orders o where o.id::text = v_tx.order_id) end;

    -- 手動指定的退回批次優先(例如載入已完成訂單減少數量時,使用者選了要退回哪一批)
    for v_pick in select value from jsonb_array_elements(coalesce(p_manual->v_tx.id, '[]'::jsonb)) loop
      exit when v_need <= 0;
      select * into v_bi from public.batch_items
       where id = v_pick->>'batch_item_id' and product_id = v_tx.product_id for update;
      if not found then raise exception 'batch_bad_pick:%', v_pick->>'batch_item_id'; end if;
      v_take := least((v_pick->>'qty')::numeric, v_need);
      if v_take > 0 then
        insert into public.batch_movements (batch_item_id, qty, kind, tx_id, order_id, order_no, mv_date, party)
        values (v_bi.id, v_take, 'return', v_tx.id, v_tx.order_id, v_order_no, v_tx.dt, v_tx.party);
        v_need := v_need - v_take;
      end if;
    end loop;

    -- 其餘依這張訂單原本出貨的批次自動退回(數量最多的先退)
    if v_tx.order_id is not null then
      for v_row in
        select m.batch_item_id, -sum(m.qty) as net
        from public.batch_movements m
        join public.batch_items bi on bi.id = m.batch_item_id
        where m.order_id = v_tx.order_id and m.kind in ('out', 'return') and bi.product_id = v_tx.product_id
        group by m.batch_item_id
        having -sum(m.qty) > 0
        order by -sum(m.qty) desc
      loop
        exit when v_need <= 0;
        v_take := least(v_row.net, v_need);
        insert into public.batch_movements (batch_item_id, qty, kind, tx_id, order_id, order_no, mv_date, party)
        values (v_row.batch_item_id, v_take, 'return', v_tx.id, v_tx.order_id, v_order_no, v_tx.dt, v_tx.party);
        v_need := v_need - v_take;
      end loop;
    end if;

    v_res := v_res || jsonb_build_object(v_tx.id, jsonb_build_object('returned', v_tx.qty - v_need, 'untracked', v_need));
  end loop;
  return v_res;
end $$;

-- ------------------------------------------------------------
-- 8. 批量商品 ↔ 主商品切換:同一批次內「一出一進」,有效期照搬,批次號不變。
--    在切換的兩筆交易(同一個 conversion_id)已寫入之後呼叫。
--    p_manual: [{"batch_item_id":"...","qty":n}, ...](來源商品要從哪幾行扣,可省略 = 自動 FEFO/FIFO)
--    換成「大單位」(例如罐 → 箱)時,每個批次扣的量必須是換算比例的整數倍,否則整箱無法歸屬單一批次;
--    自動分配時湊不成整數倍的尾數會留在「未追蹤」,回傳 untracked。
-- ------------------------------------------------------------
create or replace function public.batch__convert_take(
  p_bi_id text, p_take numeric, p_to_product text, p_ratio numeric,
  p_out_tx text, p_in_tx text, p_conv text, p_date date
) returns void
language plpgsql set search_path = public as $$
declare
  v_bi public.batch_items%rowtype;
  v_to_id text;
begin
  select * into v_bi from public.batch_items where id = p_bi_id;
  select id into v_to_id from public.batch_items
   where batch_id = v_bi.batch_id and product_id = p_to_product and expiry is not distinct from v_bi.expiry
   for update;
  if v_to_id is null then
    v_to_id := gen_random_uuid()::text;
    insert into public.batch_items (id, batch_id, product_id, expiry, qty_in, unit_cost_base, unit_cost_total, supplier_lot)
    values (v_to_id, v_bi.batch_id, p_to_product, v_bi.expiry, 0,
            v_bi.unit_cost_base / p_ratio, v_bi.unit_cost_total / p_ratio, v_bi.supplier_lot);
  end if;
  insert into public.batch_movements (batch_item_id, qty, kind, tx_id, conversion_id, mv_date)
  values (v_bi.id, -p_take, 'convert_out', p_out_tx, p_conv, p_date);
  insert into public.batch_movements (batch_item_id, qty, kind, tx_id, conversion_id, mv_date)
  values (v_to_id, p_take * p_ratio, 'convert_in', p_in_tx, p_conv, p_date);
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
    order by (bi.expiry is null), bi.expiry, b.batch_date, b.batch_no
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

-- ------------------------------------------------------------
-- 9. 「未分配出貨」清單:屬於已追蹤商品、但還沒(完整)分配到批次的出貨交易。
--    批次追蹤頁用它提供「補分配」入口(例如分配那一步剛好斷線)。只算該商品第一個一般批次之後的出貨。
-- ------------------------------------------------------------
create or replace view public.batch_unallocated_tx with (security_invoker = true) as
select t.id::text as tx_id, t.product_id::text as product_id, t.qty::numeric - coalesce(a.qty, 0) as unallocated,
       t.date::date as tx_date, t.order_id::text as order_id, t.party::text as party
from public.transactions t
join (
  select bi.product_id, min(b.batch_date) as first_date
  from public.batch_items bi join public.batches b on b.id = bi.batch_id
  where not b.is_opening
  group by bi.product_id
) tp on tp.product_id = t.product_id::text
left join (
  select tx_id, sum(-qty) as qty from public.batch_movements where kind = 'out' group by tx_id
) a on a.tx_id = t.id::text
where t.type = 'out' and coalesce(t.conversion, false) = false
  and t.date::date >= tp.first_date
  and t.qty::numeric - coalesce(a.qty, 0) > 0;

-- ------------------------------------------------------------
-- 10. 權限:資料表只開放讀取;寫入一律走上面的 RPC(security definer)
-- ------------------------------------------------------------
alter table public.batches          enable row level security;
alter table public.batch_items      enable row level security;
alter table public.batch_movements  enable row level security;

drop policy if exists batches_select         on public.batches;
drop policy if exists batch_items_select     on public.batch_items;
drop policy if exists batch_movements_select on public.batch_movements;
create policy batches_select         on public.batches         for select to authenticated using (true);
create policy batch_items_select     on public.batch_items     for select to authenticated using (true);
create policy batch_movements_select on public.batch_movements for select to authenticated using (true);

grant select on public.batches, public.batch_items, public.batch_movements,
                public.batch_item_stock, public.batch_unallocated_tx to authenticated;

revoke all on function public.batch_save_purchase(text, date, text, text, jsonb) from public, anon;
revoke all on function public.batch_allocate(text[], jsonb)                      from public, anon;
revoke all on function public.batch_return(text[], jsonb)                        from public, anon;
revoke all on function public.batch_convert(text, jsonb)                         from public, anon;
revoke all on function public.batch_next_no(date)                                from public, anon;
revoke all on function public.batch_item_remaining(text)                         from public, anon;
revoke all on function public.batch__convert_take(text, numeric, text, numeric, text, text, text, date) from public, anon;
grant execute on function public.batch_save_purchase(text, date, text, text, jsonb) to authenticated;
grant execute on function public.batch_allocate(text[], jsonb)                      to authenticated;
grant execute on function public.batch_return(text[], jsonb)                        to authenticated;
grant execute on function public.batch_convert(text, jsonb)                         to authenticated;
grant execute on function public.batch_item_remaining(text)                         to authenticated;

-- ------------------------------------------------------------
-- 驗證用(執行完後可以跑,看資料表/函式都建好了):
--   select table_name from information_schema.tables where table_schema='public' and table_name like 'batch%';
--   select proname from pg_proc where proname like 'batch%';
-- ------------------------------------------------------------
