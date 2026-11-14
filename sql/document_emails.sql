-- ============================================================
-- Invoice / Credit Note 寄給客戶的 email 紀錄
--   · Edge Function send-document-email 寄信成功後寫入(service role)
--   · admin / accountant 可以讀(寄送紀錄分頁、清單上的「已寄」標記)
-- 在 Supabase SQL Editor 執行一次即可(可重複執行)。需要先有 is_accounting_user()。
-- ============================================================
create table if not exists public.document_emails (
  id uuid primary key default gen_random_uuid(),
  doc_type text not null check (doc_type in ('invoice', 'credit_note')),
  doc_id text not null,
  doc_no text,
  to_email text,
  cc_email text,
  subject text,
  body text,
  from_email text,
  reply_to text,
  sent_by_id uuid,
  sent_by text,
  sent_at timestamptz not null default now()
);
create index if not exists document_emails_doc_idx on public.document_emails (doc_type, doc_id, sent_at desc);

alter table public.document_emails enable row level security;
drop policy if exists document_emails_select on public.document_emails;
create policy document_emails_select on public.document_emails for select to authenticated using (public.is_accounting_user());
