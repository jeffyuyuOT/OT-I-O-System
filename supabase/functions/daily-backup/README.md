# 每日伺服器端備份(正式版)→ Dropbox,保留 90 天

備份內容(布里斯本日期,放在 `Apps/<你的 App 名稱>/daily/`):
- `YYYY-MM-DD.json.gz`:public schema 所有資料表的完整內容(資料)。
- `YYYY-MM-DD.schema.sql.gz`:資料庫**結構**,可重建空專案:資料表、欄位、約束、索引、函式/RPC、觸發器、視圖、RLS 與政策、資料表與函式權限、序列值、Storage 儲存桶與政策、Realtime、pg_cron 排程。
  含 `x-backup-secret` 的排程會遮蔽密碼並改成註解(要手動重建);結構匯出失敗不影響資料備份,只記在 `backup_log.error`(`schema: ...`)。
每次備份成功後,函式會自動刪除檔名日期超過 90 天的舊檔(兩種檔案都清,可用 secret `RETENTION_DAYS` 調整)。
不含:Storage 裡的檔案本身、登入帳號(auth.users)、Edge Function 程式與 secrets(程式在 repo,secrets 另存密碼管理器)。這是災難復原用的完整快照;日常還原仍用 App 內的備份檔。

## 還原到空專案(演練或災難復原)
1. 建一個新的 Supabase 專案(先啟用需要的 Extensions,例如 pg_cron、pg_net)。
2. 從 Dropbox 下載同一天的兩個檔案。
3. 在自己的電腦(先 `npm i postgres`):
   `node scripts/restore-snapshot.mjs --db-url "<新專案連線字串>" --schema 2026-11-14.schema.sql.gz --data 2026-11-14.json.gz`
   依序執行:結構 PART 1 → 載入資料 → 結構 PART 2,每條語句獨立執行,失敗的會列在最後。目標已有資料表時會中止(確定要繼續才加 `--yes`)。
4. 還原後:重建登入帳號(auth.users;指向它的外鍵為 NOT VALID)、重設 Edge Function 與 secrets、補回被遮蔽的 pg_cron 排程、檢查 Storage 檔案。
5. 本機用模擬資料庫驗證過(結構、資料雜湊、權限、RLS、觸發器皆一致);**請用真正的備份對測試專案演練一次**,看失敗清單。

## 設定步驟(只做正式版)
1. **建立 Dropbox App**:https://www.dropbox.com/developers/apps → Create app → Scoped access → **App folder** → 取名(例如 `OT-Backup`)。
   Permissions 分頁勾選 `files.metadata.write`、`files.metadata.read`、`files.content.write`、`files.content.read` → Submit。(**一定要先設權限,再做下一步**,否則拿到的金鑰沒有這些權限。)
   Settings 分頁記下 **App key**、**App secret**。
2. **取得 refresh token(只做一次)**:
   - 瀏覽器開 `https://www.dropbox.com/oauth2/authorize?client_id=<APP_KEY>&response_type=code&token_access_type=offline`,按 Allow,複製畫面上的 code。
   - 執行:`curl -X POST https://api.dropbox.com/oauth2/token -u <APP_KEY>:<APP_SECRET> -d code=<CODE> -d grant_type=authorization_code`
   - 回傳 JSON 裡的 `refresh_token` 就是要的(不會過期)。code 只能用一次、很快失效。
3. **Supabase SQL Editor** 執行 `sql/backup_log.sql`。
4. **設定 secrets**(Dashboard → Edge Functions → Secrets,或 CLI `supabase secrets set ...`):
   `DROPBOX_APP_KEY`、`DROPBOX_APP_SECRET`、`DROPBOX_REFRESH_TOKEN`、`BACKUP_SECRET`(自己產生一串長亂數);選用 `RETENTION_DAYS`(預設 90)、`BACKUP_FOLDER`(預設 `/daily`)。**測試專案一定要設 `BACKUP_FOLDER=/daily-test`**,否則同日期檔名會覆蓋正式版的備份。
5. **部署**:`supabase functions deploy daily-backup --no-verify-jwt --project-ref <正式版 ref>`(Dashboard 貼程式碼部署時,要把 Verify JWT 關掉)。
6. **手動測試**:
   `curl -X POST https://<ref>.supabase.co/functions/v1/daily-backup -H "x-backup-secret: <BACKUP_SECRET>"`
   應回 `{"ok":true,...}`;Dropbox 的 `Apps/<App 名稱>/daily/` 看得到當天檔案;`select * from backup_log order by id desc;` 有一筆成功紀錄。
7. **分享資料夾**:Dropbox → Apps → 你的 App 資料夾 → Share,只分享給需要的人(備份含客戶、發票、成本資料)。
8. **排程**:啟用 pg_cron、pg_net 後,改好 `sql/daily_backup_cron.sql` 裡的 `<PROJECT_REF>`、`<BACKUP_SECRET>` 再執行。

## 注意
- 單檔上限約 140MB(Dropbox 單次上傳 150MB);超過時備份會失敗並記在 `backup_log`,到時需改用分段上傳。
- 舊檔清理失敗時,備份本身仍算成功,原因記在 `backup_log.error`(ok 仍為 true)。
