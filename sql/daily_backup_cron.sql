-- 每天 23:00 布里斯本時間(= 13:00 UTC)呼叫 daily-backup Edge Function。
-- 先到 Supabase Dashboard → Database → Extensions 啟用 pg_cron 與 pg_net。
-- 執行前把 <PROJECT_REF> 換成正式版專案的 ref,<BACKUP_SECRET> 換成跟 Edge Function secret 相同的字串。
select cron.schedule(
  'daily-backup-dropbox',
  '0 13 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/daily-backup',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-backup-secret', '<BACKUP_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);
-- 查看排程:        select * from cron.job;
-- 查看執行結果:    select * from public.backup_log order by id desc limit 10;
-- 停用排程:        select cron.unschedule('daily-backup-dropbox');
