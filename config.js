// ============================================================
// ENVIRONMENT CONFIG — this is the ONLY file that should differ
// between the test branch and the main (production) branch.
// Everything else (index.html, future split-out .js files) can
// stay byte-for-byte identical across both.
//
// 正式環境設定(production)
//
// Supabase Dashboard → Project Settings → API
// ============================================================
const SUPABASE_URL = 'https://lstckpzmtacttwbmmbof.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_dBwODRl6OdU-_TVPBi1TKA_Feoq7EDa';

// 是否為測試環境——正式環境固定是 false,畫面上的「(Test Version)」標籤跟分頁標題後綴
// 就會自動不顯示。
const IS_TEST_ENV = false;

// 收據掃描服務(receipt-scan-service)這個倉庫登記用的 API key——warehouses 這張表就在這個
// 專案裡(不是另一個獨立的 Supabase 專案,這點之前的註解寫錯了,已經更正),去 Table Editor
// 查 warehouses 表對應這個正式倉庫的那一列即可。填的是原始 key(不是 hash 過的那份)。
//
// TODO:網址已經確認是正式的了(receiptscan.orangetea.au)。下面這把 key 目前先暫時借用測試
// 環境那把(562f05dd...),純粹是為了實際測一次看看這把 key 對正式的掃描服務有沒有登記過、
// 驗證通不通過——warehouses 表裡目前只看得到「Orange Tea AU」這一筆記錄,測試版當初對應的
// 是另一個臨時的 Cloudflare Tunnel 網址(jade-minimize-arizona-within.trycloudflare.com),
// 不確定是不是同一個掃描服務實例、這把 key 的雜湊值有沒有真的存在這張表裡,還沒實際驗證過。
// 測試結果是能正常掃描,這裡就直接保留不用改;如果驗證失敗(401/403),要回去
// receipt-scan-service 那邊重新產生一把真正登記在這個正式 warehouses 表裡的 key。
const RECEIPT_SCAN_SERVICE_URL = 'https://receiptscan.orangetea.au';
const RECEIPT_SCAN_SERVICE_API_KEY = '562f05dd5941c5a089ecfcf4c371cb83993ef8aad09c68780cae74e0858027e6';

const EMAIL_DOMAIN = 'inventory.local'; // placeholder domain used to turn usernames into login emails
