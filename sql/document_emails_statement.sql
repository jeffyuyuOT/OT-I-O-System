-- ============================================================
-- Statement 也可以 email 給客戶:document_emails 的 doc_type 加上 'statement'
-- 在 Supabase SQL Editor 執行一次即可(可重複執行)。先測試版,再正式版。
-- ============================================================
alter table public.document_emails drop constraint if exists document_emails_doc_type_check;
alter table public.document_emails add constraint document_emails_doc_type_check
  check (doc_type in ('invoice', 'credit_note', 'statement'));
