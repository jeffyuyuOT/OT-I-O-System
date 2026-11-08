-- ============================================================
-- 非銷售出庫單 (Non-Sales Outbound Slip):樣品、員工內部使用、捐贈等「拿貨但不是賣給客戶」的領貨單
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
--
-- * non_sales_slips:一張單一列,內容(品項、原因、領貨人…)存 payload jsonb,跟 delivery_notes 同樣做法。
-- * next_nso_no():發號用的序列,回傳整數,前端組成 NSO-0001。
-- * 庫存扣減仍然記在 transactions(type='out' + adj_reason),需要先執行過 sql/stock_adjustment_reason.sql。
-- ============================================================
create table if not exists public.non_sales_slips (
  id          text primary key,
  payload     jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table public.non_sales_slips enable row level security;
drop policy if exists non_sales_slips_all on public.non_sales_slips;
create policy non_sales_slips_all on public.non_sales_slips for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.non_sales_slips to authenticated;

create sequence if not exists public.nso_no_seq start 1;

create or replace function public.next_nso_no()
returns bigint language sql security definer set search_path = public as $$
  select nextval('public.nso_no_seq');
$$;
grant execute on function public.next_nso_no() to authenticated;

-- 「清除全部資料」用:把編號從 1 重新開始
create or replace function public.reset_nso_no_seq()
returns void language sql security definer set search_path = public as $$
  select setval('public.nso_no_seq', 1, false);
$$;
grant execute on function public.reset_nso_no_seq() to authenticated;
