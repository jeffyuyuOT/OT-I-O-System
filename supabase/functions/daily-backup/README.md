# 每日伺服器端備份(正式版)→ Cloudflare R2,保留 90 天

備份內容:public schema 所有資料表的完整內容(gzip JSON,檔名 `daily/YYYY-MM-DD.json.gz`,布里斯本日期)。
不含:Storage 裡的收據檔案、登入帳號(auth.users)。這是災難復原用的完整資料庫快照;日常還原仍用 App 內的備份檔。

## 設定步驟(只做正式版)
1. **Cloudflare R2**:建立私有 bucket(例如 `ot-backup`)→ Settings → Object lifecycle rules → 新增規則:前綴 `daily/`,**90 天後刪除**。
   再到 R2 → Manage API tokens 建立 token(權限 Object Read & Write,只限這個 bucket),記下 Access Key ID、Secret、以及 Account ID。
2. **Supabase SQL Editor** 執行 `sql/backup_log.sql`。
3. **設定 secrets**(Dashboard → Edge Functions → Secrets,或 CLI `supabase secrets set ...`):
   `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET`、`BACKUP_SECRET`(自己產生一串長亂數)。
4. **部署**:`supabase functions deploy daily-backup --no-verify-jwt --project-ref <正式版 ref>`(Dashboard 貼程式碼部署時,要把 Verify JWT 關掉)。
5. **手動測試**:
   `curl -X POST https://<ref>.supabase.co/functions/v1/daily-backup -H "x-backup-secret: <BACKUP_SECRET>"`
   應回 `{"ok":true,...}`;R2 bucket 看得到當天檔案;`select * from backup_log order by id desc;` 有一筆成功紀錄。
6. **排程**:啟用 pg_cron、pg_net 後,改好 `sql/daily_backup_cron.sql` 裡的 `<PROJECT_REF>`、`<BACKUP_SECRET>` 再執行。
