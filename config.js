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

// 獨立收據掃描服務(receipt-scan-service)的網址跟這個倉庫的 API key——部署到正式環境時,
// 網址要換成 Cloudflare 上設的網域,API key 是這個倉庫在 warehouses 表裡登記的那把原始 key
// (不是 hash 過的那份)。掃描服務本身跟這個倉庫用的 Supabase 是兩個完全獨立的專案。
const RECEIPT_SCAN_SERVICE_URL = 'https://receiptscan.orangetea.au';
const RECEIPT_SCAN_SERVICE_API_KEY = '562f05dd5941c5a089ecfcf4c371cb83993ef8aad09c68780cae74e0858027e6';

const EMAIL_DOMAIN = 'inventory.local'; // placeholder domain used to turn usernames into login emails
