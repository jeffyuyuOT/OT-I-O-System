-- ============================================================
-- 庫存分布紀錄:記錄每一次「轉移位置」(從哪個位置搬到哪個位置、搬了多少、搬的是哪些批次)
-- 顯示在「歷史紀錄 → 庫存分布紀錄」。
--
-- 在「測試」Supabase 專案(zurktjerrqmjbrhvtibm)的 SQL Editor 執行一次;
-- 正式專案(lstckpzmtacttwbmmbof)等你明說再執行。可重複執行。
-- from_code / to_code 為空字串 = 「未分布」。
-- ============================================================

create table if not exists public.location_transfer_log (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  product_id   text not null,
  product_name text,
  unit         text,
  from_code    text not null default '',
  to_code      text not null default '',
  qty          numeric not null,
  actor        text,
  batches      jsonb
);
create index if not exists location_transfer_log_created_idx on public.location_transfer_log (created_at desc);
create index if not exists location_transfer_log_product_idx on public.location_transfer_log (product_id);

alter table public.location_transfer_log enable row level security;
drop policy if exists location_transfer_log_select on public.location_transfer_log;
drop policy if exists location_transfer_log_insert on public.location_transfer_log;
create policy location_transfer_log_select on public.location_transfer_log for select to authenticated using (true);
create policy location_transfer_log_insert on public.location_transfer_log for insert to authenticated with check (true);
grant select, insert on public.location_transfer_log to authenticated;

-- 驗證用:select to_regclass('public.location_transfer_log');
