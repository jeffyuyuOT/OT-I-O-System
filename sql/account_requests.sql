-- ============================================================
-- 客戶線上申請訂貨帳號:申請單資料表
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
-- 前提:已經執行過 sql/invoices_table.sql(要用裡面的 is_accounting_user())。
--
-- * 申請單只存在這張表裡:沒有通過審核之前,不會建立任何登入帳號,也不會建立出貨方。
-- * 客戶送出申請、確認 Email 一律走 Edge Function(request-account,用 service role 寫入),
--   前端(沒登入)完全不能直接讀寫這張表。
-- * 只有 admin / accountant 讀得到;拒絕、清除申請走下面的函式。
-- * status: unconfirmed(已送出、還沒點 Email 確認連結)→ pending(已確認,等審核)
--           → approved(已核准,開好帳號) / rejected(已拒絕)
-- ============================================================
create table if not exists public.account_requests (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  status             text not null default 'unconfirmed' check (status in ('unconfirmed','pending','approved','rejected')),
  company_name       text not null,
  abn                text not null,          -- 只存數字(11 碼)
  contact_name       text not null,
  phone              text,
  email              text not null,          -- 一律小寫
  bill_to            text,
  ship_to            text,
  confirm_token_hash text,                   -- 確認連結的 sha256,不存原始連結
  confirmed_at       timestamptz,
  ip_hash            text,                   -- 申請者 IP 的雜湊(只用來限制次數)
  reviewed_by        text,
  reviewed_at        timestamptz,
  reject_reason      text,
  party_id           text,                   -- 核准後對應的出貨方 id
  user_id            uuid                    -- 核准後建立的登入帳號 id
);
create index if not exists account_requests_status_idx on public.account_requests (status, created_at desc);
create index if not exists account_requests_email_idx  on public.account_requests (lower(email));
create index if not exists account_requests_abn_idx    on public.account_requests (abn);
create index if not exists account_requests_ip_idx     on public.account_requests (ip_hash, created_at);

alter table public.account_requests enable row level security;
drop policy if exists account_requests_select on public.account_requests;
create policy account_requests_select on public.account_requests for select to authenticated using (public.is_accounting_user());
-- 不建立 insert / update / delete policy:一般使用者無法直接寫入,只能透過 Edge Function 或下面的函式

-- 拒絕單筆(可附原因)
create or replace function public.account_request_reject(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_who text;
begin
  if not public.is_accounting_user() then raise exception 'account_request_forbidden'; end if;
  select coalesce(username, email) into v_who from public.profiles where id = auth.uid();
  update public.account_requests
     set status = 'rejected', reject_reason = nullif(trim(coalesce(p_reason, '')), ''), reviewed_by = v_who, reviewed_at = now()
   where id = p_id and status in ('pending', 'unconfirmed');
  if not found then raise exception 'account_request_not_found'; end if;
end $$;

-- 批次拒絕(例如一次清掉一堆亂填的申請)
create or replace function public.account_request_bulk_reject(p_ids uuid[], p_reason text)
returns integer language plpgsql security definer set search_path = public as $$
declare v_who text; v_n integer;
begin
  if not public.is_accounting_user() then raise exception 'account_request_forbidden'; end if;
  select coalesce(username, email) into v_who from public.profiles where id = auth.uid();
  update public.account_requests
     set status = 'rejected', reject_reason = nullif(trim(coalesce(p_reason, '')), ''), reviewed_by = v_who, reviewed_at = now()
   where id = any(p_ids) and status in ('pending', 'unconfirmed');
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- 清理:3 天內沒確認 Email 的申請、180 天前已拒絕的申請直接刪除
create or replace function public.account_request_cleanup()
returns integer language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  if not public.is_accounting_user() then raise exception 'account_request_forbidden'; end if;
  delete from public.account_requests
   where (status = 'unconfirmed' and created_at < now() - interval '3 days')
      or (status = 'rejected' and created_at < now() - interval '180 days');
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.account_request_reject(uuid, text) from public, anon;
revoke all on function public.account_request_bulk_reject(uuid[], text) from public, anon;
revoke all on function public.account_request_cleanup() from public, anon;
grant execute on function public.account_request_reject(uuid, text) to authenticated;
grant execute on function public.account_request_bulk_reject(uuid[], text) to authenticated;
grant execute on function public.account_request_cleanup() to authenticated;
