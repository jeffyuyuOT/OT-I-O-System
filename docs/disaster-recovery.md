# 災難復原手冊(Orange Tea AU 庫存系統)

最後更新:2026-11-14。這份文件只放「步驟與名稱」,**不放任何密碼、金鑰或連線字串**;那些存在密碼管理器。

## 1. 現有備份一覽

| 項目 | 備份在哪 | 頻率 | 說明 |
|---|---|---|---|
| 資料庫資料 | Dropbox `Apps/<App 資料夾>/daily/YYYY-MM-DD.json.gz` | 每天 23:00(布里斯本) | 保留 90 天。**2026-11-14 之前的檔案 JSON 已損壞,不要用來還原。** |
| 資料庫結構(表、RPC 函式、觸發器、RLS、權限、序列、儲存桶、Realtime、排程) | Dropbox `daily/YYYY-MM-DD.schema.sql.gz` | 每天 | 與資料檔配對使用。含 `x-backup-secret` 的排程會被遮蔽,要手動重建。 |
| App 內備份 | 瀏覽器每日備份(settings.js) | 每天 | 第二重保險。 |
| 程式碼 | GitHub `jeffyuyuOT/ot-i-o-system`(`main` 正式、`test` 測試) | 每次推送 | 帳號要開 2FA。 |
| Edge Function 原始碼 | 同上(見第 3 節) | 每次推送 | **改過線上函式後,要把新版放回 repo。** |
| 離線副本 | 每月手動下載一份最新 `.json.gz` + `.schema.sql.gz`,存到 Dropbox 以外的地方 | 每月 | 防止 Dropbox 帳號被入侵時備份一起被刪。 |

**不在任何備份內:** 登入帳號(`auth.users`)、Storage 檔案本身(收據等)、Edge Function secrets 的值。

## 2. 重建順序

1. **建新的 Supabase 專案**(同區域),資料庫密碼只用英文字母與數字,存進密碼管理器。
2. 在 Database → Extensions 啟用 `pg_cron`、`pg_net`。
3. 從 Dropbox 下載**同一天**的兩個檔案(日期要在 2026-11-14 之後)。
4. 在電腦(需 Node.js)執行還原:
   ```
   npm i postgres
   node scripts/restore-snapshot.mjs --db-url "<Session pooler 連線字串,埠 5432>" --schema YYYY-MM-DD.schema.sql.gz --data YYYY-MM-DD.json.gz
   ```
   會依序執行結構(資料前)→ 載入資料 → 結構(資料後),失敗項目列在最後。目標必須是空專案。
   2026-11-14 演練結果:全部成功,表/函式/政策/觸發器/索引/權限數量與正式版一致。
5. **重建登入帳號**:`auth.users` 不在備份內。用 App 的邀請功能(`invite-user`)重新邀請使用者。指向 `auth.users` 的外鍵在還原時是 `NOT VALID`,舊資料裡的使用者 UUID 會對不上新帳號,這是已知缺口。
6. **部署 6 個 Edge Function**(見第 3 節),再設定 secrets(第 4 節)。
7. **重建排程**(pg_cron):執行 `sql/daily_backup_cron.sql`,把 `<PROJECT_REF>` 換成新專案 ref,`<BACKUP_SECRET>` 換成新的亂數(與 Edge Function secret 一致)。排程名稱 `daily-backup-dropbox`。
8. **改 App 設定**:`config.js` 的 `SUPABASE_URL`、`SUPABASE_ANON_KEY` 改成新專案的值(Project Settings → API);正式環境 `IS_TEST_ENV = false`。其他設定與收據掃描服務是獨立專案,不用動。重新部署網站。
9. **Storage**:儲存桶會由結構檔建立,但檔案是空的;收據等檔案目前沒有備份。

## 3. Edge Functions

| 函式 | 原始碼 | Verify JWT | 用途 |
|---|---|---|---|
| `approve-account` | `account-requests/approve-account.ts` | 開 | 管理者核准訂貨帳號申請 |
| `request-account` | `account-requests/request-account.ts` | **關** | 客戶(未登入)申請訂貨帳號 |
| `invite-user` | `invite/invite-user.ts` | 開 | 邀請使用者 |
| `send-document-email` | `invite/send-document-email.ts` | 開 | 寄出單據郵件 |
| `send-purchase-email` | `supabase/functions/send-purchase-email/index.ts` | 開 | 寄採購單/已簽收訂單郵件 |
| `daily-backup` | `supabase/functions/daily-backup/index.ts` | **關** | 每日備份(排程以 `x-backup-secret` 呼叫) |

部署:Dashboard(Edge Functions → Via Editor,貼上原始碼,依表設定 Verify JWT),或 CLI:
```
supabase functions deploy <函式名> --project-ref <ref>                 # Verify JWT 開
supabase functions deploy <函式名> --no-verify-jwt --project-ref <ref> # Verify JWT 關
```
正式專案 ref:`lstckpzmtacttwbmmbof`;測試專案 ref:`zurktjerrqmjbrhvtibm`。

## 4. Secrets(Edge Functions → Secrets;值存密碼管理器,設定後在後台看不到)

| 名稱 | 用在 |
|---|---|
| `RESEND_API_KEY` | approve-account、request-account、invite-user、send-document-email、send-purchase-email |
| `APP_URL`、`TURNSTILE_SECRET` | request-account |
| `DOC_EMAIL_DOMAINS` | send-document-email |
| `DROPBOX_APP_KEY`、`DROPBOX_APP_SECRET`、`DROPBOX_REFRESH_TOKEN` | daily-backup |
| `BACKUP_SECRET` | daily-backup(與 pg_cron 排程裡的值一致) |
| `BACKUP_FOLDER` | 只有測試專案設為 `/daily-test`;**正式專案不要設** |
| `RETENTION_DAYS` | 選用,預設 90 |

`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 由 Supabase 自動提供。
Dropbox refresh token 找不到時,依 `supabase/functions/daily-backup/README.md` 步驟 2 重新取得。

## 5. 重建後的檢查清單

- [ ] `select count(*) from information_schema.tables where table_schema='public'` 等數量與備份當時一致。
- [ ] 手動呼叫 `daily-backup`,回 `ok:true`,Dropbox 出現兩個新檔案,`backup_log` 有新一列。
- [ ] 寄一封測試採購單郵件、邀請一位測試使用者。
- [ ] 客戶申請帳號頁面可送出(`request-account` Verify JWT 為關)。
- [ ] 隔天早上確認排程的備份成功:`select * from backup_log order by id desc limit 3;`

## 6. 日常維護

- **檢查備份檔是否完整**(PowerShell,路徑換成下載的檔案;結果應為 `VALID tables=<表數>`):
  ```
  $f="C:\path\2026-11-14.json.gz"; $null=Add-Type -AssemblyName System.Web.Extensions; $t=(New-Object IO.StreamReader((New-Object IO.Compression.GZipStream([IO.File]::OpenRead($f),[IO.Compression.CompressionMode]::Decompress)))).ReadToEnd(); $s=New-Object System.Web.Script.Serialization.JavaScriptSerializer; $s.MaxJsonLength=[int]::MaxValue; try{$o=$s.DeserializeObject($t);$r="VALID tables="+$o["tables"].Count}catch{$r="INVALID "+$_.Exception.Message}; "RESULT: "+$r.Substring(0,[Math]::Min(200,$r.Length))
  ```
- 每季做一次還原演練(用新的空專案,演練完立刻刪除專案與下載的檔案,檔案含真實客戶與財務資料)。
- 每月下載離線副本。
- 輪替 `BACKUP_SECRET` 時,Edge Function secret 與 pg_cron 排程(`cron.unschedule` 再 `cron.schedule`)要同步更換。
- Edge Function 在後台修改後,把新程式碼放回 repo。

## 7. 已知缺口

- `auth.users` 與 Storage 檔案本身沒有備份。
- Edge Function 的 repo 版本與線上版本:6 個函式已於 2026-11-14 全部與線上比對,內容一致(`send-document-email`、`approve-account`、`request-account` 只差檔尾換行)。改過線上函式後要重新確認。
- 還原演練的驗證是「語句全部成功 + 物件數量一致」,尚未逐項比對函式內容與實際資料列內容。
