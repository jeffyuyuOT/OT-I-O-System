-- 每天 23:50 布里斯本時間(= 13:50 UTC)呼叫 backup-watchdog,檢查當天備份是否成功,異常時寄信。
-- 執行前把 <PROJECT_REF> 換成專案 ref,<BACKUP_SECRET> 換成跟 Edge Function secret 相同的字串。
select cron.schedule(
  'backup-watchdog',
  '50 13 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/backup-watchdog',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-backup-secret', '<BACKUP_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
-- 停用排程: select cron.unschedule('backup-watchdog');
