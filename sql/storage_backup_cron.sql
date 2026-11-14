-- 每天 23:30 布里斯本時間(= 13:30 UTC)呼叫 storage-backup Edge Function(在 daily-backup 之後)。
-- 執行前把 <PROJECT_REF> 換成專案 ref,<BACKUP_SECRET> 換成跟 Edge Function secret 相同的字串。
select cron.schedule(
  'storage-backup-dropbox',
  '30 13 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/storage-backup',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-backup-secret', '<BACKUP_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
-- 停用排程: select cron.unschedule('storage-backup-dropbox');
