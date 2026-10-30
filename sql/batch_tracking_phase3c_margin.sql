-- ============================================================
-- 批次追蹤 第三期:批次 margin(Sell price = Total price × (1 + margin%))
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
-- 批次表只開放讀取,寫入走 RPC,所以 margin 用 batch_set_margin 寫入。
-- ============================================================

alter table public.batches add column if not exists margin_pct numeric;

-- p_only_if_null = true:只在這個批次還沒有 margin 時才寫入(新批次帶入預設值用)
create or replace function public.batch_set_margin(p_batch_id text, p_margin numeric, p_only_if_null boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_margin is null or p_margin < 0 or p_margin > 1000 then
    raise exception 'batch_bad_margin';
  end if;
  update public.batches
     set margin_pct = p_margin
   where id = p_batch_id
     and (not p_only_if_null or margin_pct is null);
end $$;

revoke all on function public.batch_set_margin(text, numeric, boolean) from public, anon;
grant execute on function public.batch_set_margin(text, numeric, boolean) to authenticated;
