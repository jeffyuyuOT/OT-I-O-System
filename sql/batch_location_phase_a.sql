-- ============================================================
-- 庫存位置分批次 第一階段(a):進貨時記錄每個批次商品行放在哪些位置
--
-- 在「測試」Supabase 專案(zurktjerrqmjbrhvtibm)的 SQL Editor 執行一次;
-- 正式專案(lstckpzmtacttwbmmbof)等你明說再執行。可重複執行。
--
-- 新增:
--   batch_item_locations                      批次商品行 × 位置 的數量(只記有指定位置的;沒指定的 = qty_in − 加總 = 「未分配位置」)
--   batch_set_purchase_locations(...)         進貨單送出後,整批寫入這張進貨單各商品行的位置(取代該行原有的位置)
--   batch_clear_all / batch_restore_all       備份、還原、清除全部資料一併處理新表
-- 第一階段只「記錄與顯示」,出貨分配仍照原本的 FEFO/FIFO,尚未依位置扣。
-- ============================================================

-- 進貨清單「填寫詳細資料」的備註(顯示在批次追蹤商品頁的詳細資料)
alter table public.batch_items add column if not exists note text;

create table if not exists public.batch_item_locations (
  id            bigint generated always as identity primary key,
  batch_item_id text not null references public.batch_items(id) on delete cascade,
  location_code text not null,
  qty           numeric not null check (qty > 0),
  created_at    timestamptz not null default now()
);
create unique index if not exists batch_item_locations_uq on public.batch_item_locations (batch_item_id, location_code);
create index if not exists batch_item_locations_code_idx on public.batch_item_locations (location_code);

alter table public.batch_item_locations enable row level security;
drop policy if exists batch_item_locations_select on public.batch_item_locations;
create policy batch_item_locations_select on public.batch_item_locations for select to authenticated using (true);
grant select on public.batch_item_locations to authenticated;

-- p_rows: [{ "product_id": "...", "expiry": "2026-12-31" 或 "", "locs": [{ "code": "A-1-2", "qty": 5 }, ...] }, ...]
-- 以 purchase_id 找到這張進貨單的批次,再依 (商品, 有效期) 找到商品行;該行的位置整組取代。
-- 位置加總不得超過該行 qty_in,否則整筆擋下(raise exception 'batch_loc_over:...')。
create or replace function public.batch_set_purchase_locations(p_purchase_id text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_id text;
  v_row  jsonb;
  v_item public.batch_items%rowtype;
  v_loc  jsonb;
  v_sum  numeric;
  v_n    int := 0;
begin
  select id into v_batch_id from public.batches where purchase_id = p_purchase_id;
  if v_batch_id is null then
    return jsonb_build_object('lines', 0);
  end if;

  for v_row in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    select * into v_item from public.batch_items
     where batch_id = v_batch_id
       and product_id = v_row->>'product_id'
       and expiry is not distinct from nullif(v_row->>'expiry', '')::date
     for update;
    if not found then continue; end if;

    select coalesce(sum((l->>'qty')::numeric), 0) into v_sum
      from jsonb_array_elements(coalesce(v_row->'locs', '[]'::jsonb)) l
     where coalesce(trim(l->>'code'), '') <> '' and (l->>'qty')::numeric > 0;
    if (v_row ? 'locs') and v_sum > v_item.qty_in + 1e-9 then
      raise exception 'batch_loc_over:%', jsonb_build_object('product_id', v_item.product_id, 'qty_in', v_item.qty_in, 'assigned', v_sum)::text;
    end if;

    if v_row ? 'note' then
      update public.batch_items set note = nullif(trim(v_row->>'note'), '') where id = v_item.id;
    end if;
    -- 只有這一行帶了 locs 才取代位置;只帶 note 的行(例如編輯進貨單只改備註)不動位置
    if v_row ? 'locs' then
      delete from public.batch_item_locations where batch_item_id = v_item.id;
      -- 同代碼的多筆先合併(唯一鍵是 批次行+位置)
      insert into public.batch_item_locations (batch_item_id, location_code, qty)
      select v_item.id, trim(l->>'code'), sum((l->>'qty')::numeric)
        from jsonb_array_elements(coalesce(v_row->'locs', '[]'::jsonb)) l
       where coalesce(trim(l->>'code'), '') <> '' and (l->>'qty')::numeric > 0
       group by trim(l->>'code');
    end if;
    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('lines', v_n);
end $$;

revoke all on function public.batch_set_purchase_locations(text, jsonb) from public, anon;
grant execute on function public.batch_set_purchase_locations(text, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 備份 / 還原 / 清除全部資料:加入新表
-- 還原函式多一個 p_locations 參數(可不帶);先刪掉舊的三參數版本,避免同名函式造成呼叫歧義。
-- ------------------------------------------------------------
create or replace function public.batch_clear_all()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Supabase 預設啟用 pg_safeupdate,沒有 WHERE 的 DELETE 會被擋,所以每個都帶 where。
  delete from public.batch_item_locations where id is not null;
  delete from public.batch_movements      where id is not null;
  delete from public.batch_items          where id is not null;
  delete from public.batches              where id is not null;
end $$;

drop function if exists public.batch_restore_all(jsonb, jsonb, jsonb);

create or replace function public.batch_restore_all(
  p_batches   jsonb,
  p_items     jsonb,
  p_movements jsonb,
  p_locations jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b int := 0;
  v_i int := 0;
  v_m int := 0;
  v_l int := 0;
begin
  perform public.batch_clear_all();

  if p_batches is not null and jsonb_typeof(p_batches) = 'array' and jsonb_array_length(p_batches) > 0 then
    insert into public.batches
    select * from jsonb_populate_recordset(null::public.batches, p_batches);
    get diagnostics v_b = row_count;
  end if;

  if p_items is not null and jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) > 0 then
    insert into public.batch_items
    select * from jsonb_populate_recordset(null::public.batch_items, p_items);
    get diagnostics v_i = row_count;
  end if;

  if p_movements is not null and jsonb_typeof(p_movements) = 'array' and jsonb_array_length(p_movements) > 0 then
    insert into public.batch_movements
      (batch_item_id, qty, kind, tx_id, order_id, order_no, conversion_id, mv_date, party, note, location_code, created_at, unit_cost)
    select r.batch_item_id, r.qty, r.kind, r.tx_id, r.order_id, r.order_no, r.conversion_id, r.mv_date, r.party, r.note,
           r.location_code, coalesce(r.created_at, now()), r.unit_cost
    from jsonb_populate_recordset(null::public.batch_movements, p_movements) r;
    get diagnostics v_m = row_count;
  end if;

  if p_locations is not null and jsonb_typeof(p_locations) = 'array' and jsonb_array_length(p_locations) > 0 then
    insert into public.batch_item_locations (batch_item_id, location_code, qty, created_at)
    select r.batch_item_id, r.location_code, r.qty, coalesce(r.created_at, now())
    from jsonb_populate_recordset(null::public.batch_item_locations, p_locations) r;
    get diagnostics v_l = row_count;
  end if;

  return jsonb_build_object('batches', v_b, 'items', v_i, 'movements', v_m, 'locations', v_l);
end $$;

revoke all on function public.batch_clear_all()                              from public, anon;
revoke all on function public.batch_restore_all(jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.batch_clear_all()                              to authenticated;
grant execute on function public.batch_restore_all(jsonb, jsonb, jsonb, jsonb) to authenticated;

-- 驗證用:
-- select to_regclass('public.batch_item_locations');
-- select proname, pronargs from pg_proc where proname in ('batch_set_purchase_locations','batch_restore_all','batch_clear_all');
