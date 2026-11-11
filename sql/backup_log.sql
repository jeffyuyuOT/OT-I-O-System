-- 伺服器端每日備份的執行紀錄(正式版 Supabase 執行一次)
create table if not exists public.backup_log (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  ok boolean not null,
  file text,
  bytes bigint,
  tables int,
  rows bigint,
  error text
);
-- 只有後端(service role / postgres)能讀寫,前端不開放
alter table public.backup_log enable row level security;
