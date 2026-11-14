-- ============================================================
-- Statement(客戶對帳單)存檔與編號
-- 在「測試」Supabase 專案的 SQL Editor 執行一次;正式版等你明說再執行。可重複執行。
-- 前提:已經執行過 credit_notes.sql(需要 is_accounting_user() 與 profiles)。
--
-- * statements:每次「列印 / 存檔」時存一份當時的內容快照(snapshot),並給流水號 ST-0001…
-- * 快照不會因為之後的付款或 Credit Note 改變,日後可以用號碼查回當時寄出的那一份。
-- ============================================================
create table if not exists public.statement_counter (id int primary key default 1, next_no bigint not null default 1);
insert into public.statement_counter (id, next_no) values (1, 1) on conflict (id) do nothing;
alter table public.statement_counter enable row level security;

create table if not exists public.statements (
  id          text primary key,
  st_no       text not null unique,
  party_id    text,
  customer    text,
  as_of       date not null,
  total_due   numeric not null,
  snapshot    jsonb not null,
  created_by  text,
  created_at  timestamptz default now()
);
create index if not exists statements_party_idx on public.statements (party_id);
alter table public.statements enable row level security;
drop policy if exists statements_select on public.statements;
create policy statements_select on public.statements for select to authenticated using (public.is_accounting_user());

create or replace function public.statement_save(p_snapshot jsonb, p_party_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n bigint; v_no text; v_id text := gen_random_uuid()::text; v_who text;
begin
  if not public.is_accounting_user() then raise exception 'invoice_forbidden'; end if;
  select next_no into v_n from public.statement_counter where id = 1 for update;
  v_n := greatest(coalesce(v_n, 1), coalesce((select max(regexp_replace(st_no, '\D', '', 'g')::bigint) from public.statements), 0) + 1);
  v_no := 'ST-' || lpad(v_n::text, 4, '0');
  update public.statement_counter set next_no = v_n + 1 where id = 1;
  select username into v_who from public.profiles where id = auth.uid();
  insert into public.statements (id, st_no, party_id, customer, as_of, total_due, snapshot, created_by)
  values (v_id, v_no, nullif(p_party_id, ''), p_snapshot->>'name', (p_snapshot->>'asOf')::date, coalesce((p_snapshot->>'total')::numeric, 0),
          p_snapshot || jsonb_build_object('stNo', v_no), v_who);
  return jsonb_build_object('id', v_id, 'st_no', v_no);
end $$;
revoke all on function public.statement_save(jsonb, text) from public;
grant execute on function public.statement_save(jsonb, text) to authenticated;

-- 登記付款後標記這份 Statement 已用於收款(只能標一次),之後不能再用它登記付款
alter table public.statements add column if not exists paid_at timestamptz;
create or replace function public.statement_mark_paid(p_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_accounting_user() then raise exception 'invoice_forbidden'; end if;
  update public.statements set paid_at = now() where id = p_id and paid_at is null;
end $$;
revoke all on function public.statement_mark_paid(text) from public;
grant execute on function public.statement_mark_paid(text) to authenticated;
