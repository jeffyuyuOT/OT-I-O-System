-- 批次追蹤 第二期(補充):出貨當下的批次單價快照
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
--
-- 每一筆批次異動(batch_movements)寫入時,自動把「當下」的批次單價存進 unit_cost。
-- 之後批次成本被更新(例如報關行正式 invoice 到了、改了其他支出),出貨紀錄裡仍保有當時用的價格。
-- 用 BEFORE INSERT 觸發器完成,不需要改 batch_allocate / batch_return / batch_convert 等函式。
--
-- 注意:執行前就已經存在的異動,無法得知當時的價格,會用「目前」的批次單價補上
-- (所以舊的出貨紀錄不會出現「價格不同」標記)。

alter table public.batch_movements add column if not exists unit_cost numeric;

create or replace function public.batch_movement_cost_snapshot()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if new.unit_cost is null then
    select coalesce(bi.unit_cost_total, bi.unit_cost_base)
      into new.unit_cost
      from public.batch_items bi
     where bi.id = new.batch_item_id;
  end if;
  return new;
end $function$;

drop trigger if exists trg_batch_movement_cost_snapshot on public.batch_movements;
create trigger trg_batch_movement_cost_snapshot
  before insert on public.batch_movements
  for each row execute function public.batch_movement_cost_snapshot();

-- 補上既有異動的快照(用目前批次單價)
update public.batch_movements m
   set unit_cost = coalesce(bi.unit_cost_total, bi.unit_cost_base)
  from public.batch_items bi
 where bi.id = m.batch_item_id
   and m.unit_cost is null;
