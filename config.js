// ============================================================
// ENVIRONMENT CONFIG — this is the ONLY file that should differ
// between the test branch and the main (production) branch.
// Everything else (index.html, future split-out .js files) can
// stay byte-for-byte identical across both.
//
// Supabase Dashboard → Project Settings → API
// ============================================================
const SUPABASE_URL = 'https://zurktjerrqmjbrhvtibm.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_VRLmAkNvk9JgatRltsZSXg_JCUObpTK';

// 是否為測試環境——只有這個 config.js 決定,index.html 不用另外改。
// 正式環境的 config.js 要把這裡改成 false,畫面上的「(Test Version)」標籤跟分頁標題
// 就會自動不顯示。
const IS_TEST_ENV = true;

// 獨立收據掃描服務(receipt-scan-service)的網址跟這個倉庫的 API key。這裡固定用具名的
// Cloudflare Tunnel 網域(receiptscan.orangetea.au),不要再用 trycloudflare.com 那種
// quick tunnel 臨時網址——quick tunnel 只要掃描服務那邊重啟就會換一個新網址,舊的立刻失效。
// API key 是這個倉庫在 warehouses 表裡登記的那把原始 key(不是 hash 過的那份)。掃描服務
// 本身跟這個倉庫用的 Supabase 是兩個完全獨立的專案。
const RECEIPT_SCAN_SERVICE_URL = 'https://receiptscan.orangetea.au';
const RECEIPT_SCAN_SERVICE_API_KEY = '562f05dd5941c5a089ecfcf4c371cb83993ef8aad09c68780cae74e0858027e6';

const EMAIL_DOMAIN = 'inventory.local'; // placeholder domain used to turn usernames into login emails
